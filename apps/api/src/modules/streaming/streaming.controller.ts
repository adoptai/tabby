import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  InternalServerErrorException,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { SessionEntity, ApplicationEntity, InterventionEntity, IdentityProviderEntity, UserEntity } from '../../entities';
import { StreamTokenService } from './stream-token.service';
import { RecordingStore } from '../recording/recording.store';
import { AppsService } from '../apps/apps.service';
import { Request, Response } from 'express';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'crypto';
import { Not, IsNull, MoreThan } from 'typeorm';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/roles.guard';
import { parseCookie } from '../../common/utils/cookie';

/** Module-level constant — avoids repeating the env-read inline everywhere. */
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'http://localhost:18080').replace(/\/+$/, '');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the email the gate should match for a session owner.
 *
 * owner_user_id is a users.id uuid for password/OAuth users, but
 * agent_assertion token-exchange stores the raw federated identity —
 * typically an email — and never provisions a users row. Querying
 * users.id (uuid column) with an email throws a Postgres cast error,
 * so only uuid-shaped owners hit the table; email-shaped owners match
 * directly.
 */
async function resolveOwnerEmail(
  userRepo: Repository<UserEntity>,
  ownerUserId: string,
): Promise<string | null> {
  if (UUID_RE.test(ownerUserId)) {
    const ownerUser = await userRepo.findOne({ where: { id: ownerUserId } });
    return ownerUser?.email?.toLowerCase() ?? null;
  }
  if (ownerUserId.includes('@')) {
    return ownerUserId.toLowerCase();
  }
  return null;
}

/**
 * Does a verified stream token prove the viewer IS the session owner?
 *
 * Stream tokens minted through the owner's own authenticated call (e.g.
 * POST /sessions/:id/short-link with a user-scoped token-exchange JWT)
 * carry that caller's identity as `user_id`, prefixed `federated:` for
 * token-exchange users. When it matches the session owner, the OAuth /
 * email gate adds nothing — the token already proves the same identity
 * the gate would ask for — so the viewer cookie is minted directly.
 * Tokens minted by other consumers (e.g. `agent:{profile}` from
 * session-status) do NOT match and still go through the gate.
 */
function streamTokenProvesOwner(tokenUserId: string | undefined, ownerUserId: string): boolean {
  if (!tokenUserId) return false;
  const normalized = tokenUserId.replace(/^federated:/, '').toLowerCase();
  return normalized === ownerUserId.toLowerCase();
}

/**
 * Cookie-minting body shared by both viewers' POST :sessionId/verify-token.
 *
 * The stream token travels in the URL FRAGMENT (M-4: never sent to the
 * server), so the page GET cannot auto-pass the gate — the gate page's
 * script posts the fragment token here instead. When the token was minted
 * by the session owner's own authenticated call, it proves the identity
 * the email gate would ask for, so the viewer cookie is set without
 * prompting. Any mismatch falls back to the manual gate (403).
 */
async function verifyStreamTokenForOwner(
  streamTokenService: StreamTokenService,
  sessionRepo: Repository<SessionEntity>,
  idpRepo: Repository<IdentityProviderEntity>,
  jwtService: JwtService,
  sessionId: string,
  token: string | undefined,
  res: Response,
): Promise<{ status: string }> {
  const denyMsg = 'Access denied';
  if (!token) throw new BadRequestException('token is required');

  // When an OAuth IdP is configured, verify-token must not mint cookies —
  // OAuth is the sole authentication path. This endpoint is only valid
  // as an email-gate fallback when no IdP exists.
  const hasIdp = !!(await idpRepo.findOne({ where: { enabled: true, auth_url: Not(IsNull()) } }));
  if (hasIdp) throw new ForbiddenException('OAuth authentication required');

  const result = streamTokenService.verifyToken(token);
  if (!result.valid || result.payload.session_id !== sessionId) {
    throw new ForbiddenException(denyMsg);
  }

  const session = await sessionRepo.findOne({ where: { id: sessionId } });
  if (!session || !session.owner_user_id) throw new ForbiddenException(denyMsg);
  if (!streamTokenProvesOwner(result.payload.user_id, session.owner_user_id)) {
    throw new ForbiddenException(denyMsg);
  }

  const vncToken = jwtService.sign({
    sub: session.owner_user_id,
    tenant_id: session.tenant_id,
    type: 'vnc_access',
    owner_user_id: session.owner_user_id,
    jti: randomUUID(),
  }, { expiresIn: 3600 });
  const isHttps = PUBLIC_BASE_URL.startsWith('https://') || process.env.NODE_ENV === 'production';
  res.cookie('tabby_vnc', vncToken, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    maxAge: 3600 * 1000,
    path: '/',
  });

  return { status: 'ok' };
}

/**
 * Redirect to OAuth login (or email gate fallback) when a valid tabby_vnc cookie is absent.
 * Shared by VNC and CDP viewers — pass `prefix` to control which path is used.
 *
 * M-4: The stream token is NOT included in the post_login URL that travels through the IdP.
 * Instead it is stored in the OAuth Redis state alongside the PKCE verifier and recovered in
 * handleOauthCallback, so it never appears in IdP server logs or browser Referer headers.
 */
function extractExtraQuery(req: Request): string | undefined {
  const params = new URLSearchParams(req.url.split('?')[1] || '');
  params.delete('token');
  const qs = params.toString();
  return qs || undefined;
}

async function redirectToAuth(
  res: Response,
  sessionId: string,
  token: string | undefined,
  idpRepo: Repository<IdentityProviderEntity>,
  prefix: 'vnc' | 'cdp',
  extraQuery?: string,
): Promise<void> {
  const idp = await idpRepo.findOne({ where: { enabled: true, auth_url: Not(IsNull()) } });

  if (idp) {
    if (token) {
      const postLogin = `/${prefix}/${sessionId}${extraQuery ? `?${extraQuery}` : ''}`;
      const params = new URLSearchParams({ post_login: postLogin, stream_token: token });
      res.redirect(302, `${PUBLIC_BASE_URL}/auth/oauth/${idp.id}/login?${params.toString()}`);
      return;
    }
    const oauthLoginUrl = `${PUBLIC_BASE_URL}/auth/oauth/${idp.id}/login`;
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    const escapedId = JSON.stringify(sessionId);
    const escapedPrefix = JSON.stringify(prefix);
    const escapedExtra = JSON.stringify(extraQuery || '');
    // OAuth is the security gate — always redirect to IdP, never auto-pass.
    // The stream token (fragment) is forwarded as stream_token so the OAuth
    // callback can reconstruct the final URL with the token after login.
    // verify-token auto-pass is intentionally kept only on the email-gate
    // fallback (no IdP configured) where it replaces manual email entry.
    const bridge = `<!doctype html><html><head><meta charset="utf-8"><title>Authenticating...</title></head><body><p>Redirecting to login...</p><script nonce="${nonce}">
var h=window.location.hash.charAt(0)==='#'?window.location.hash.slice(1):window.location.hash;
var t=new URLSearchParams(h).get('token')||'';
var EXTRA=${escapedExtra};
var postLogin='/'+${escapedPrefix}+'/'+${escapedId}+(EXTRA?'?'+EXTRA:'');
var p=new URLSearchParams({post_login:postLogin});
if(t)p.set('stream_token',t);
window.location.href='${oauthLoginUrl}?'+p.toString();
</script></body></html>`;
    res.status(200).send(bridge);
    return;
  }

  // No OAuth configured: render email gate fallback.
  // sessionId is guaranteed to be a UUID by ParseUUIDPipe on the caller.
  // JSON.stringify is used for all values injected into script context.
  const emailGatePage = renderEmailGatePage(sessionId, token, prefix);
  const nonce = randomBytes(16).toString('base64');
  res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'`);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('x-content-type-options', 'nosniff');
  res.status(200).send(emailGatePage.replace('<script>', `<script nonce="${nonce}">`));
}

function renderEmailGatePage(sessionId: string, token: string | undefined, prefix: 'vnc' | 'cdp'): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Verify Access</title>
    <link rel="icon" href="data:," />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: #0b1020; color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; display: flex; align-items: center; justify-content: center; }
      .card { background: #111827; border: 1px solid #1e293b; border-radius: 12px; padding: 32px; max-width: 380px; width: 100%; }
      h2 { margin: 0 0 8px; font-size: 20px; }
      p { margin: 0 0 20px; color: #94a3b8; font-size: 14px; }
      input[type="email"] { width: 100%; box-sizing: border-box; padding: 10px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #f8fafc; font-size: 15px; outline: none; }
      input[type="email"]:focus { border-color: #3b82f6; }
      button { margin-top: 14px; width: 100%; padding: 10px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-size: 15px; font-weight: 600; cursor: pointer; }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
      #msg { margin-top: 10px; font-size: 13px; color: #f87171; min-height: 18px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>Verify your identity</h2>
      <p>Enter the email address associated with this session to view the browser stream.</p>
      <input type="email" id="emailInput" placeholder="you@example.com" autocomplete="email" />
      <button id="submitBtn">Continue</button>
      <div id="msg"></div>
    </div>
    <script>
      var SESSION_ID = ${JSON.stringify(sessionId)};
      var GATE_PREFIX = ${JSON.stringify(prefix)};
      var STREAM_TOKEN = ${JSON.stringify(token ?? '')};
      // Also check URL fragment for stream token (server never sees #fragment)
      if (!STREAM_TOKEN) {
        var h = window.location.hash.charAt(0) === '#' ? window.location.hash.slice(1) : window.location.hash;
        STREAM_TOKEN = new URLSearchParams(h).get('token') || '';
      }

      // A stream token minted by the session owner's own authenticated call
      // proves the identity this gate would ask for — try it first and only
      // show the email form when the server rejects it.
      if (STREAM_TOKEN) {
        document.getElementById('msg').style.color = '#94a3b8';
        document.getElementById('msg').textContent = 'Verifying access…';
        fetch('/' + GATE_PREFIX + '/' + SESSION_ID + '/verify-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: STREAM_TOKEN }),
          credentials: 'same-origin',
        })
          .then(function(r) {
            if (r.ok) {
              window.location.reload();
            } else {
              document.getElementById('msg').style.color = '';
              document.getElementById('msg').textContent = '';
            }
          })
          .catch(function() {
            document.getElementById('msg').style.color = '';
            document.getElementById('msg').textContent = '';
          });
      }

      document.getElementById('submitBtn').addEventListener('click', verify);
      document.getElementById('emailInput').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') verify();
      });

      function verify() {
        var email = document.getElementById('emailInput').value.trim();
        if (!email) return;
        var btn = document.getElementById('submitBtn');
        var msg = document.getElementById('msg');
        btn.disabled = true;
        msg.textContent = '';
        var PREFIX = ${JSON.stringify(prefix)};
        fetch('/' + PREFIX + '/' + SESSION_ID + '/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email }),
          credentials: 'same-origin',
        })
          .then(function(r) {
            if (r.ok) {
              var dest = '/' + PREFIX + '/' + SESSION_ID;
              if (STREAM_TOKEN) dest += '?token=' + encodeURIComponent(STREAM_TOKEN);
              window.location.href = dest;
            } else {
              r.json().catch(function() { return {}; }).then(function(d) {
                msg.textContent = d.message || 'Access denied. Please check your email.';
              });
              btn.disabled = false;
            }
          })
          .catch(function() {
            msg.textContent = 'Network error. Please try again.';
            btn.disabled = false;
          });
      }
    </script>
  </body>
</html>`;
}

@Controller('s')
export class ShortLinkController {
  constructor(
    private readonly streamTokenService: StreamTokenService,
    private readonly jwtService: JwtService,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(IdentityProviderEntity)
    private readonly idpRepo: Repository<IdentityProviderEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  @Get(':shortId')
  async redirect(
    @Param('shortId') shortId: string,
    @Req() req: Request,
    @Res() res: any,
  ): Promise<void> {
    const url = await this.streamTokenService.resolveShortLink(shortId);
    if (!url) {
      res.status(404).send('Link expired or not found');
      return;
    }

    // Extract sessionId from the resolved URL (pattern: /vnc/{id} or /cdp/{id})
    const sessionIdMatch = url.match(/\/(?:vnc|cdp)\/([0-9a-f-]{36})/i);
    if (sessionIdMatch) {
      const sessionId = sessionIdMatch[1];
      const cookieToken = parseCookie(req.headers.cookie, 'tabby_vnc');

      const session = await this.sessionRepo.findOne({ where: { id: sessionId } });

      if (cookieToken) {
        try {
          const vncPayload = this.jwtService.verify<{ owner_user_id: string; type: string; tenant_id: string }>(cookieToken);
          // M-5: Validate both owner_user_id AND tenant_id.
          if (
            vncPayload.type === 'vnc_access'
            && session
            && vncPayload.owner_user_id === session.owner_user_id
            && vncPayload.tenant_id === session.tenant_id
          ) {
            res.redirect(302, url);
            return;
          }
        } catch {
          // Invalid cookie — fall through to OAuth redirect
        }
      }

      // No valid cookie: redirect to the stored viewer URL (which carries the
      // #token fragment) rather than jumping straight to the IdP. The viewer's
      // openStream → bridge page attempts verify-token first, so an owner-minted
      // stream token (e.g. from the harness's own short-link call) auto-passes
      // without an OAuth round-trip, and only non-owner-proving tokens fall
      // through to the IdP. Previously this branch went directly to OAuth, which
      // never exposed the fragment token to the client and so defeated the
      // auto-pass — forcing OAuth (and its tenant resolution) even for the owner.
    }

    // No valid cookie, no session context, or no OAuth configured: redirect to
    // the stored viewer URL and let the viewer page resolve auth.
    res.redirect(302, url);
  }
}

@ApiTags('Streaming - CDP')
@Controller('cdp')
export class CdpStreamingController {
  constructor(
    private readonly streamTokenService: StreamTokenService,
    private readonly jwtService: JwtService,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(IdentityProviderEntity)
    private readonly idpRepo: Repository<IdentityProviderEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  @Get(':sessionId/auth')
  async authorize(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Query('token') token?: string,
  ): Promise<{ authorized: true; session_id: string }> {
    if (!token) {
      throw new UnauthorizedException('Missing stream token');
    }
    const result = this.streamTokenService.verifyToken(token);
    if (!result.valid) {
      throw new UnauthorizedException(result.reason);
    }
    if (result.payload.session_id !== sessionId) {
      throw new UnauthorizedException('Token is not valid for this session');
    }
    return { authorized: true, session_id: sessionId };
  }

  @Get(':sessionId/clear-cdp-auth')
  async clearCdpAuth(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Res() res: Response,
  ): Promise<void> {
    res.clearCookie('tabby_vnc', { path: '/' });
    res.redirect(302, `/cdp/${sessionId}`);
  }

  @Post(':sessionId/verify-email')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(200)
  async verifyCdpEmail(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: { email?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: string }> {
    const email = (body?.email || '').trim().toLowerCase();
    if (!email) throw new BadRequestException('email is required');

    const denyMsg = 'Access denied';
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) throw new ForbiddenException(denyMsg);
    if (!session.owner_user_id) throw new ForbiddenException(denyMsg);

    // agent_assertion sessions carry the federated identity (often an email)
    // in owner_user_id; users.id is a uuid, so querying it with that value
    // throws a Postgres cast error. Match email-form owners directly.
    const ownerEmail = await resolveOwnerEmail(this.userRepo, session.owner_user_id);
    if (!ownerEmail || ownerEmail !== email) throw new ForbiddenException(denyMsg);

    const vncToken = this.jwtService.sign({
      sub: session.owner_user_id,
      tenant_id: session.tenant_id,
      type: 'vnc_access',
      owner_user_id: session.owner_user_id,
      jti: randomUUID(),
    }, { expiresIn: 3600 });

    const isHttps = PUBLIC_BASE_URL.startsWith('https://') || process.env.NODE_ENV === 'production';
    res.cookie('tabby_vnc', vncToken, {
      httpOnly: true,
      secure: isHttps,
      sameSite: 'lax',
      maxAge: 3600 * 1000,
      path: '/',
    });

    return { status: 'ok' };
  }

  @Post(':sessionId/verify-token')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(200)
  async verifyCdpToken(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: { token?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: string }> {
    return verifyStreamTokenForOwner(
      this.streamTokenService, this.sessionRepo, this.idpRepo, this.jwtService, sessionId, body?.token, res,
    );
  }

  @SkipThrottle()
  @Get(':sessionId')
  async openStream(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query('token') token?: string,
  ): Promise<void> {
    let tokenUserId: string | undefined;
    if (token) {
      const result = this.streamTokenService.verifyToken(token);
      if (!result.valid) throw new UnauthorizedException(result.reason);
      if (result.payload.session_id !== sessionId) throw new UnauthorizedException('Token is not valid for this session');
      tokenUserId = result.payload.user_id;
    }

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.state === 'TERMINATED') throw new BadRequestException('Cannot open stream for TERMINATED session');

    // ── Auth gate (same pattern as VNC): cookie is the sole identity proof. ──
    if (session.owner_user_id) {
      const cookieToken = parseCookie(req.headers.cookie, 'tabby_vnc');

      if (!cookieToken) {
        return redirectToAuth(res, sessionId, token, this.idpRepo, 'cdp', extractExtraQuery(req));
      }

      let cookieValid = false;
      try {
        const vncPayload = this.jwtService.verify<{ owner_user_id: string; type: string; tenant_id: string }>(cookieToken);
        if (
          vncPayload.type === 'vnc_access'
          && vncPayload.owner_user_id === session.owner_user_id
          && vncPayload.tenant_id === session.tenant_id
        ) {
          cookieValid = true;
        } else if (vncPayload.type === 'vnc_access') {
          const errorPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Access Denied</title><link rel="icon" href="data:,"><style>html,body{margin:0;padding:0;height:100%;background:#0b1020;color:#f8fafc;font-family:ui-sans-serif,system-ui,sans-serif;display:flex;align-items:center;justify-content:center}.card{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:32px;max-width:400px;width:100%;text-align:center}h2{margin:0 0 8px;font-size:20px;color:#f87171}p{margin:0 0 16px;color:#94a3b8;font-size:14px;line-height:1.5}a{display:inline-block;margin-top:4px;padding:10px 20px;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600}a:hover{background:#2563eb}</style></head><body><div class="card"><h2>Access Denied</h2><p>You are logged in as a different user than the owner of this session.</p><a href="/cdp/${sessionId}/clear-cdp-auth">Try with a different account</a></div></body></html>`;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.status(403).send(errorPage);
          return;
        }
      } catch {
        // Invalid/expired cookie — redirect to auth
      }

      if (!cookieValid) {
        return redirectToAuth(res, sessionId, token, this.idpRepo, 'cdp', extractExtraQuery(req));
      }
    }
    // ── End auth gate ────────────────────────────────────────────────────────

    const page = this.renderCdpViewerPage(sessionId, session.app_id, token);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).send(page);
  }

  private renderCdpViewerPage(sessionId: string, appId: string, token?: string): string {
    const safeSessionId = sessionId.replace(/"/g, '');
    const safeToken = (token ?? '').replace(/"/g, '');
    const safeAppId = appId.replace(/"/g, '');
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CDP Stream ${sessionId}</title>
    <link rel="icon" href="data:," />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: #0b1020; color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; }
      #toolbar { height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid #1e293b; background: #111827; }
      #state { font-size: 12px; color: #93c5fd; }
      #screen { display: flex; justify-content: center; align-items: center; width: 100%; height: calc(100% - 45px); overflow: hidden; }
      canvas { max-width: 100%; max-height: 100%; }
      #reconnect { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #1e293b; padding: 24px; border-radius: 8px; text-align: center; }
      #reconnect button { margin-top: 12px; padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; }
      #side-panel { position: fixed; top: 44px; right: 0; bottom: 0; width: 300px; background: #111827; border-left: 1px solid #1e293b; box-shadow: -4px 0 24px rgba(0,0,0,0.4); transform: translateX(100%); transition: transform 280ms cubic-bezier(0.4,0,0.2,1); will-change: transform; z-index: 9000; display: flex; flex-direction: column; overflow: visible; }
      #side-panel[aria-expanded="true"] { transform: translateX(0); }
      #panel-toggle { position: absolute; left: -36px; top: 50%; transform: translateY(-50%); width: 36px; height: 56px; background: #111827; border: 1px solid #1e293b; border-right: none; border-radius: 8px 0 0 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-size: 14px; padding: 0; }
      #panel-toggle:hover { background: #1e293b; color: #f8fafc; }
      #panel-content { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; font-size: 13px; color: #e2e8f0; }
      .psec { display: flex; flex-direction: column; gap: 8px; }
      .psec--bottom { margin-top: auto; padding-top: 16px; border-top: 1px solid #1e293b; }
      details > summary { list-style: none; cursor: pointer; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; padding: 4px 0; user-select: none; display: flex; align-items: center; gap: 6px; }
      details > summary::marker, details > summary::-webkit-details-marker { display: none; }
      details > summary::before { content: '▶'; font-size: 9px; transition: transform 200ms; }
      details[open] > summary::before { transform: rotate(90deg); }
      .psec input[type="password"] { width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #f8fafc; font-size: 13px; outline: none; }
      .psec input[type="password"]:focus { border-color: #3b82f6; }
      .pbtn { padding: 9px 14px; color: white; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; width: 100%; }
      .pbtn:disabled { opacity: 0.5; cursor: not-allowed; }
      .pbtn-blue { background: #3b82f6; } .pbtn-blue:hover:not(:disabled) { background: #2563eb; }
      .pbtn-green { background: #22c55e; } .pbtn-green:hover:not(:disabled) { background: #16a34a; }
      .pbtn-red { background: #dc2626; } .pbtn-red:hover:not(:disabled) { background: #b91c1c; }
      .srow { display: flex; justify-content: space-between; font-size: 12px; color: #94a3b8; }
      .sval { color: #f8fafc; font-size: 12px; }
      #clip-status { font-size: 11px; color: #6ee7b7; min-height: 16px; }
      #restart-confirm { display: none; margin-top: 8px; padding: 10px; background: rgba(220,38,38,0.1); border-radius: 6px; }
      #restart-confirm p { margin: 0 0 8px; font-size: 12px; color: #f87171; }
      .restart-warning { font-size: 11px; color: #fbbf24; line-height: 1.5; padding: 8px 10px; background: rgba(251,191,36,0.06); border: 1px solid rgba(251,191,36,0.18); border-radius: 6px; }
      @media (prefers-reduced-motion: reduce) { #side-panel { transition: none; } }
    </style>
  </head>
  <body>
    <div id="toolbar">
      <strong>Browser HITL Stream (CDP)</strong>
      <span id="state">Connecting...</span>
    </div>
    <div id="screen">
      <canvas id="canvas"></canvas>
    </div>
    <div id="reconnect">
      <p>Connection lost</p>
      <button onclick="connect()">Reconnect</button>
    </div>

    <div id="side-panel" role="complementary" aria-label="Session tools" aria-expanded="false">
      <button id="panel-toggle" aria-label="Toggle session tools">&#9664;</button>
      <div id="panel-content" inert>
        <section id="hitl-section" class="psec" style="display:none">
          <div id="hitl-status" role="status" aria-live="polite" style="font-size:13px;line-height:1.5">Checking session…</div>
          <button id="resolveBtn" class="pbtn pbtn-green" disabled>Mark as Resolved</button>
        </section>
        <section id="recording-section" class="psec" style="display:none">
          <div style="font-size:13px;line-height:1.5">
            <span style="color:#f87171;font-weight:600">&#9679; REC</span> &mdash; this session is being recorded.
            Drive the browser to complete the flow, then finish to export it to NoUI.
          </div>
          <button id="finishRecordingBtn" class="pbtn pbtn-green">Finish &amp; export</button>
          <div id="recording-status" role="status" aria-live="polite" style="font-size:12px;color:#94a3b8;margin-top:6px"></div>
        </section>
        <details open>
          <summary>Clipboard</summary>
          <div class="psec">
            <input id="clip-input" type="password" placeholder="Paste text here, then Ctrl+V in browser" autocomplete="off" />
            <button id="clip-send" class="pbtn pbtn-blue">Send to browser clipboard</button>
            <div id="clip-status"></div>
          </div>
        </details>
        <details>
          <summary>Session Status</summary>
          <div class="psec">
            <div class="srow"><span>State</span><span class="sval" id="st-state">—</span></div>
            <div class="srow"><span>Health</span><span class="sval" id="st-health">—</span></div>
            <div class="srow"><span>Interventions</span><span class="sval" id="st-interventions">—</span></div>
            <div class="srow"><span>Retries</span><span class="sval" id="st-retries">—</span></div>
            <div class="srow"><span>Uptime</span><span class="sval" id="st-uptime">—</span></div>
          </div>
        </details>
        <div class="psec psec--bottom">
          <div class="restart-warning">⚠ Only use this if your session is stuck. Make sure to resolve any active HITL step before restarting.</div>
          <button id="restart-btn" class="pbtn pbtn-red">Restart Session</button>
          <div id="restart-confirm">
            <p>This will terminate the current session.</p>
            <button id="restart-yes" class="pbtn pbtn-red">Yes, restart</button>
          </div>
        </div>
      </div>
    </div>

    <div id="panel-config" style="display:none"
      data-session-id="${safeSessionId}"
      data-stream-token="${safeToken}"
      data-app-id="${safeAppId}">
    </div>

    <script>
      var stateEl = document.getElementById('state');
      var canvas = document.getElementById('canvas');
      var ctx = canvas.getContext('2d');
      var reconnectEl = document.getElementById('reconnect');
      var sidePanel = document.getElementById('side-panel');
      var sessionId = ${JSON.stringify(sessionId)};
      var initialToken = ${JSON.stringify(token)};

      var ws = null;
      var cmdId = 1;
      var autoRetryCount = 0;
      var AUTO_RETRY_MAX = 20; // ~60s total at 3s intervals

      function resolveToken() {
        var hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
        var hp = new URLSearchParams(hash);
        var qp = new URLSearchParams(window.location.search);
        return hp.get('token') || qp.get('token') || initialToken;
      }

      function connect() {
        reconnectEl.style.display = 'none';
        var token = resolveToken();
        if (!token) {
          stateEl.textContent = 'Missing stream token';
          return;
        }
        // Keep panel-config in sync for tokens arriving via URL hash
        document.getElementById('panel-config').setAttribute('data-stream-token', token);

        var proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        var url = proto + '://' + window.location.host + '/cdp-ws?session_id=' + encodeURIComponent(sessionId) + '&token=' + encodeURIComponent(token);
        ws = new WebSocket(url);

        ws.onopen = function() {
          stateEl.textContent = 'Connected';
          autoRetryCount = 0;
          ws.send(JSON.stringify({
            id: cmdId++,
            method: 'Page.startScreencast',
            params: { format: 'jpeg', quality: 60, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }
          }));
        };

        ws.onmessage = function(event) {
          try {
            var msg = JSON.parse(event.data);
            if (msg.method === 'Page.screencastFrame') {
              renderFrame(msg.params);
              ws.send(JSON.stringify({
                id: cmdId++,
                method: 'Page.screencastFrameAck',
                params: { sessionId: msg.params.sessionId }
              }));
            }
          } catch (e) {
            console.error('CDP message error:', e);
          }
        };

        ws.onclose = function() {
          if (autoRetryCount < AUTO_RETRY_MAX) {
            autoRetryCount++;
            stateEl.textContent = 'Connecting… (' + autoRetryCount + ')';
            setTimeout(connect, 3000);
          } else {
            stateEl.textContent = 'Disconnected';
            reconnectEl.style.display = 'block';
          }
        };

        ws.onerror = function() {
          stateEl.textContent = 'Connection error';
        };
      }

      function renderFrame(params) {
        var img = new Image();
        img.onload = function() {
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
          }
          ctx.drawImage(img, 0, 0);
        };
        img.src = 'data:image/jpeg;base64,' + params.data;
      }

      // Mouse events
      canvas.addEventListener('mousedown', function(e) { sendMouse('mousePressed', e); });
      canvas.addEventListener('mouseup', function(e) { sendMouse('mouseReleased', e); });
      canvas.addEventListener('mousemove', function(e) { sendMouse('mouseMoved', e); });

      function sendMouse(type, e) {
        if (!ws || ws.readyState !== 1) return;
        var rect = canvas.getBoundingClientRect();
        var scaleX = canvas.width / rect.width;
        var scaleY = canvas.height / rect.height;
        var x = Math.round((e.clientX - rect.left) * scaleX);
        var y = Math.round((e.clientY - rect.top) * scaleY);
        var button = e.button === 0 ? 'left' : e.button === 1 ? 'middle' : 'right';
        ws.send(JSON.stringify({
          id: cmdId++,
          method: 'Input.dispatchMouseEvent',
          params: { type: type, x: x, y: y, button: button, clickCount: 1 }
        }));
      }

      // Keyboard events — skip when focus is inside the side panel
      document.addEventListener('keydown', function(e) { sendKey('keyDown', e); });
      document.addEventListener('keyup', function(e) { sendKey('keyUp', e); });

      var KEY_VK = {
        'Backspace':8,'Tab':9,'Enter':13,'Escape':27,'Space':32,
        'PageUp':33,'PageDown':34,'End':35,'Home':36,
        'ArrowLeft':37,'ArrowUp':38,'ArrowRight':39,'ArrowDown':40,
        'Delete':46,'F1':112,'F2':113,'F3':114,'F4':115,'F5':116,
        'F6':117,'F7':118,'F8':119,'F9':120,'F10':121,'F11':122,'F12':123,
      };

      // VK_OEM_* codes for punctuation. charCodeAt would collide with control
      // VKs — '.'(46) is VK_DELETE, '-'(45) is VK_INSERT, ','(44) — so the
      // remote browser executed Delete/Insert instead of typing the char.
      var PUNCT_VK = {
        ';':186,'=':187,',':188,'-':189,'.':190,'/':191,'\`':192,
        '[':219,'\\\\':220,']':221,"'":222,
        ':':186,'+':187,'<':188,'_':189,'>':190,'?':191,'~':192,
        '{':219,'|':220,'}':221,'"':222,
      };

      function vkForKey(key) {
        if (key.length !== 1) return KEY_VK[key] || 0;
        var c = key.toUpperCase();
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) return c.charCodeAt(0);
        // Unknown printable char: vk 0 is safe — the text param still types it.
        return PUNCT_VK[key] || 0;
      }

      function sendKey(type, e) {
        if (!ws || ws.readyState !== 1) return;
        // Never send keys while an input inside the side panel is focused
        var activeEl = document.activeElement;
        if (activeEl && sidePanel && sidePanel.contains(activeEl)) return;

        var onCanvas = activeEl === canvas || activeEl === document.body || !activeEl;

        // Mac Command → Ctrl: translate Cmd+{v,c,a,x,z} to Ctrl+key for remote browser.
        // Shift is preserved so Cmd+Shift+Z → Ctrl+Shift+Z (redo).
        if (type === 'keyDown' && e.metaKey && onCanvas && 'vcaxz'.indexOf(e.key.toLowerCase()) >= 0) {
          e.preventDefault();
          var vk0 = e.key.toUpperCase().charCodeAt(0);
          var mods0 = 2 | (e.shiftKey ? 8 : 0); // Ctrl + optional Shift
          ws.send(JSON.stringify({ id: cmdId++, method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: e.key, code: e.code, windowsVirtualKeyCode: vk0, nativeVirtualKeyCode: vk0, modifiers: mods0 } }));
          ws.send(JSON.stringify({ id: cmdId++, method: 'Input.dispatchKeyEvent', params: { type: 'keyUp', key: e.key, code: e.code, windowsVirtualKeyCode: vk0, nativeVirtualKeyCode: vk0, modifiers: mods0 } }));
          return;
        }
        // Skip keyUp for Cmd shortcuts (already sent synthetic keyUp above)
        if (type === 'keyUp' && e.metaKey && onCanvas && 'vcaxz'.indexOf(e.key.toLowerCase()) >= 0) {
          return;
        }

        if (onCanvas) e.preventDefault();
        var vk = vkForKey(e.key);
        ws.send(JSON.stringify({
          id: cmdId++,
          method: 'Input.dispatchKeyEvent',
          params: {
            type: type === 'keyDown' ? 'keyDown' : 'keyUp',
            key: e.key,
            code: e.code,
            text: type === 'keyDown' && e.key.length === 1 ? e.key : undefined,
            windowsVirtualKeyCode: vk,
            nativeVirtualKeyCode: vk,
            modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
          }
        }));
      }

      canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });

      connect();

      // ── Side panel ────────────────────────────────────────────────────────────
      (function() {
        var panel = document.getElementById('side-panel');
        var toggle = document.getElementById('panel-toggle');
        var content = document.getElementById('panel-content');

        toggle.addEventListener('click', function() {
          var open = panel.getAttribute('aria-expanded') === 'true';
          panel.setAttribute('aria-expanded', String(!open));
          toggle.innerHTML = open ? '&#9664;' : '&#9654;';
          if (open) content.setAttribute('inert', ''); else content.removeAttribute('inert');
        });
        panel.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') {
            panel.setAttribute('aria-expanded', 'false');
            toggle.innerHTML = '&#9664;';
            content.setAttribute('inert', '');
            toggle.focus();
          }
          e.stopPropagation();
        });
        panel.addEventListener('keyup', function(e) { e.stopPropagation(); });
        panel.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        panel.addEventListener('mouseup', function(e) { e.stopPropagation(); });

        var cfg = document.getElementById('panel-config');
        var SESSION_ID = cfg.dataset.sessionId;
        var TOKEN = cfg.dataset.streamToken || '';
        if (!TOKEN) {
          var h0 = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
          TOKEN = new URLSearchParams(h0).get('token') || new URLSearchParams(window.location.search).get('token') || '';
        }
        var fromMcp = new URLSearchParams(window.location.search).get('from') === 'mcp';
        if (fromMcp) document.getElementById('hitl-section').style.display = '';
        var recordingMode = new URLSearchParams(window.location.search).get('mode') === 'recording';
        if (recordingMode) {
          var recSection = document.getElementById('recording-section');
          if (recSection) recSection.style.display = '';
        }

        var currentStepIndex = null;
        var resolvedStepIndex = null;
        var sessionTerminated = false;

        var statusEl = document.getElementById('hitl-status');
        var resolveBtn = document.getElementById('resolveBtn');
        var stState = document.getElementById('st-state');
        var stHealth = document.getElementById('st-health');
        var stInterventions = document.getElementById('st-interventions');
        var stRetries = document.getElementById('st-retries');
        var stUptime = document.getElementById('st-uptime');
        var restartBtn = document.getElementById('restart-btn');
        var restartConfirm = document.getElementById('restart-confirm');
        var restartYes = document.getElementById('restart-yes');
        var tokenExpired = false;

        function poll() {
          if (sessionTerminated || tokenExpired || !TOKEN) return;
          fetch('/vnc/' + SESSION_ID + '/panel-state?token=' + encodeURIComponent(TOKEN))
            .then(function(r) {
              if (r.status === 401) { tokenExpired = true; return null; }
              return r.ok ? r.json() : null;
            })
            .then(function(data) {
              if (!data) return;
              stState.textContent = data.state || '—';
              stHealth.textContent = data.health_result_type || '—';
              stInterventions.textContent = data.intervention_count != null ? String(data.intervention_count) : '—';
              stRetries.textContent = data.retry_count != null ? String(data.retry_count) : '—';
              if (data.started_at) {
                stUptime.textContent = Math.round((Date.now() - new Date(data.started_at).getTime()) / 60000) + 'm';
              }
              if (data.state === 'TERMINATED') { sessionTerminated = true; handleTerminated(); return; }
              if (fromMcp && data.state === 'HEALTHY') { window.close(); }
              if (!fromMcp) return;
              var pending = data.pending_input_request;
              if (pending && pending.step_index != null) {
                currentStepIndex = pending.step_index;
                statusEl.textContent = 'Step ' + pending.step_index + ' (' + (pending.input_type || 'confirm') + '): ' + (pending.message || pending.label || 'Input needed');
                if (resolvedStepIndex === null || pending.step_index !== resolvedStepIndex) {
                  resolveBtn.disabled = false; resolveBtn.style.opacity = '1'; resolveBtn.style.cursor = 'pointer';
                  resolveBtn.textContent = 'Mark as Resolved'; resolveBtn.style.background = '#22c55e';
                } else {
                  resolveBtn.disabled = true; resolveBtn.style.opacity = '0.5';
                  resolveBtn.textContent = 'Resolved ✓'; resolveBtn.style.background = '#16a34a';
                }
              } else {
                statusEl.textContent = data.state === 'LOGIN_IN_PROGRESS' ? 'Login in progress — waiting…'
                  : data.state === 'LOGIN_NEEDED' ? 'Login required — waiting for input…' : 'State: ' + (data.state || '—');
                resolveBtn.disabled = true; resolveBtn.style.opacity = '0.5';
              }
            }).catch(function() {});
        }

        resolveBtn.addEventListener('click', function() {
          if (resolveBtn.disabled || currentStepIndex === null || !TOKEN) return;
          resolveBtn.disabled = true; resolveBtn.textContent = 'Resolving…';
          fetch('/vnc/' + SESSION_ID + '/hitl-resolve?token=' + encodeURIComponent(TOKEN), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'confirm', value: 'resolved', step_index: currentStepIndex }),
          }).then(function(r) {
            if (!r.ok) { resolveBtn.disabled = false; resolveBtn.textContent = 'Failed — retry'; return; }
            resolveBtn.textContent = 'Resolved ✓'; resolveBtn.style.background = '#16a34a';
            resolvedStepIndex = currentStepIndex;
            setTimeout(poll, 1500);
          }).catch(function() { resolveBtn.disabled = false; resolveBtn.textContent = 'Failed — retry'; });
        });

        restartBtn.addEventListener('click', function() {
          restartConfirm.style.display = 'block'; restartBtn.style.display = 'none';
        });
        restartYes.addEventListener('click', function() {
          if (!TOKEN) return;
          restartYes.disabled = true; restartYes.textContent = 'Restarting…';
          fetch('/vnc/' + SESSION_ID + '/restart?token=' + encodeURIComponent(TOKEN), { method: 'POST' })
            .then(function(r) {
              if (!r.ok) { restartYes.disabled = false; restartYes.textContent = 'Failed — try again'; }
            }).catch(function() { restartYes.disabled = false; restartYes.textContent = 'Failed — try again'; });
        });

        function handleTerminated() {
          content.innerHTML = '<div class="psec" style="padding:24px 0;text-align:center">'
            + '<div style="font-size:15px;font-weight:600;margin-bottom:8px">Session terminated</div>'
            + '<div id="successor-status" style="color:#94a3b8;font-size:13px">Looking for new session…</div>'
            + '</div>';
          panel.setAttribute('aria-expanded', 'true');
          toggle.innerHTML = '&#9654;';
          content.removeAttribute('inert');
          pollForSuccessor();
        }

        function pollForSuccessor() {
          if (!TOKEN) return;
          fetch('/vnc/' + SESSION_ID + '/successor?token=' + encodeURIComponent(TOKEN))
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(data) {
              var el = document.getElementById('successor-status');
              if (!el) return;
              if (data && data.url) {
                var url = data.url;
                if (fromMcp && url.indexOf('from=mcp') === -1) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'from=mcp';
                el.innerHTML = '<div style="margin-bottom:8px;font-weight:600">New session ready!</div>'
                  + '<a href="' + url + '" style="display:inline-block;padding:10px 20px;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">Open new session</a>'
                  + '<div style="margin-top:10px;font-size:11px;color:#64748b;line-height:1.5">If the browser does not appear right away, wait a few seconds and reload the page.</div>';
              } else { setTimeout(pollForSuccessor, 3000); }
            }).catch(function() { setTimeout(pollForSuccessor, 3000); });
        }

        // CDP clipboard: Input.insertText types directly into the focused element
        var clipInput = document.getElementById('clip-input');
        var clipSend = document.getElementById('clip-send');
        var clipStatus = document.getElementById('clip-status');

        function sendClipboard() {
          var text = clipInput.value;
          if (!text || !ws || ws.readyState !== 1) return;
          ws.send(JSON.stringify({ id: cmdId++, method: 'Input.insertText', params: { text: text } }));
          clipStatus.textContent = 'Sent ✓';
          setTimeout(function() { clipStatus.textContent = ''; }, 2000);
        }
        clipInput.addEventListener('paste', function() { setTimeout(sendClipboard, 0); });
        clipInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') sendClipboard();
          e.stopPropagation();
        });
        clipInput.addEventListener('keyup', function(e) { e.stopPropagation(); });
        clipSend.addEventListener('click', sendClipboard);

        // ── Recording: "Finish & export" ──────────────────────────────────────
        var finishBtn = document.getElementById('finishRecordingBtn');
        var recStatus = document.getElementById('recording-status');
        if (finishBtn) {
          finishBtn.addEventListener('click', function() {
            if (!TOKEN) return;
            finishBtn.disabled = true; finishBtn.textContent = 'Exporting…';
            fetch('/vnc/' + SESSION_ID + '/recording-stop?token=' + encodeURIComponent(TOKEN), {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            }).then(function(r) { return r.ok ? r.json() : null; })
              .then(function(d) {
                if (!d) { finishBtn.disabled = false; finishBtn.textContent = 'Failed — retry'; return; }
                finishBtn.textContent = 'Recording complete ✓'; finishBtn.style.background = '#16a34a';
                recStatus.textContent = 'Captured ' + d.har_entries + ' requests and ' + d.events
                  + ' interactions. You can return to NoUI.';
              }).catch(function() { finishBtn.disabled = false; finishBtn.textContent = 'Failed — retry'; });
          });
        }

        // ── Keep the stream token fresh (single-use token expires in ~10 min) ──
        // The recording lives server-side in the worker pod, so refreshing the
        // token keeps the viewer + Finish button working across the TTL boundary.
        window.__streamToken = TOKEN;
        function refreshToken() {
          if (sessionTerminated || !TOKEN) return;
          fetch('/vnc/' + SESSION_ID + '/refresh-token?token=' + encodeURIComponent(TOKEN), { method: 'POST' })
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(d) {
              if (d && d.token) {
                TOKEN = d.token; tokenExpired = false; window.__streamToken = d.token;
                cfg.setAttribute('data-stream-token', d.token);
              }
            }).catch(function() {});
        }
        setInterval(refreshToken, 8 * 60 * 1000);

        poll();
        setInterval(poll, 3000);
      })();
    </script>
  </body>
</html>`;
  }

}

@ApiTags('Streaming')
@Controller('vnc')
export class StreamingController {
  private static readonly noVncAssetCache = new Map<string, { body: string; contentType: string }>();
  private static readonly noVncRootBaseUrl = 'https://cdn.jsdelivr.net/gh/novnc/noVNC@v1.5.0';

  constructor(
    private readonly streamTokenService: StreamTokenService,
    private readonly recordingStore: RecordingStore,
    private readonly appsService: AppsService,
    private readonly jwtService: JwtService,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(InterventionEntity)
    private readonly interventionRepo: Repository<InterventionEntity>,
    @InjectRepository(IdentityProviderEntity)
    private readonly idpRepo: Repository<IdentityProviderEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  @SkipThrottle()
  @Get('assets/*')
  async getNoVncAsset(@Req() req: Request, @Res() res: Response): Promise<void> {
    const rawAssetPath = (req.params as Record<string, string | undefined>)['0'] || 'rfb.js';
    const assetPath = this.normalizeNoVncAssetPath(rawAssetPath);
    const cacheKey = `core:${assetPath}`;
    const cached = StreamingController.noVncAssetCache.get(cacheKey);
    const asset = cached ?? await this.loadNoVncAsset('core', assetPath);

    if (!cached) {
      if (StreamingController.noVncAssetCache.size >= 50) {
        const firstKey = StreamingController.noVncAssetCache.keys().next().value;
        if (firstKey !== undefined) StreamingController.noVncAssetCache.delete(firstKey);
      }
      StreamingController.noVncAssetCache.set(cacheKey, asset);
    }

    res.setHeader('content-type', asset.contentType);
    res.setHeader('cache-control', 'public, max-age=86400, immutable');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).send(asset.body);
  }

  @Get('vendor/*')
  async getNoVncVendorAsset(@Req() req: Request, @Res() res: Response): Promise<void> {
    const rawAssetPath = (req.params as Record<string, string | undefined>)['0'] || '';
    const assetPath = this.normalizeNoVncAssetPath(rawAssetPath);
    const cacheKey = `vendor:${assetPath}`;
    const cached = StreamingController.noVncAssetCache.get(cacheKey);
    const asset = cached ?? await this.loadNoVncAsset('vendor', assetPath);

    if (!cached) {
      if (StreamingController.noVncAssetCache.size >= 50) {
        const firstKey = StreamingController.noVncAssetCache.keys().next().value;
        if (firstKey !== undefined) StreamingController.noVncAssetCache.delete(firstKey);
      }
      StreamingController.noVncAssetCache.set(cacheKey, asset);
    }

    res.setHeader('content-type', asset.contentType);
    res.setHeader('cache-control', 'public, max-age=86400, immutable');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).send(asset.body);
  }

  @Get(':sessionId/auth')
  async authorize(
    @Param('sessionId') sessionId: string,
    @Query('token') token?: string,
  ): Promise<{ authorized: true; session_id: string }> {
    if (!token) {
      throw new UnauthorizedException('Missing stream token');
    }

    const result = this.streamTokenService.verifyToken(token);
    if (!result.valid) {
      throw new UnauthorizedException(result.reason);
    }
    if (result.payload.session_id !== sessionId) {
      throw new UnauthorizedException('Token is not valid for this session');
    }

    return { authorized: true, session_id: sessionId };
  }

  /**
   * Stream-token-authenticated proxy: returns session state + pending_input_request
   * for the HITL panel rendered inside the noVNC viewer page.
   */
  @Get(':sessionId/hitl-state')
  async getHitlState(
    @Param('sessionId') sessionId: string,
    @Query('token') token?: string,
  ): Promise<{ state: string; pending_input_request: Record<string, unknown> | null }> {
    if (!token) {
      throw new UnauthorizedException('Missing stream token');
    }
    const result = this.streamTokenService.verifyToken(token);
    if (!result.valid) {
      throw new UnauthorizedException(result.reason);
    }
    if (result.payload.session_id !== sessionId) {
      throw new UnauthorizedException('Token is not valid for this session');
    }

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    // The controller clears session.pending_input_request once it transitions
    // to LOGIN_IN_PROGRESS (state-machine.service.ts:268). The worker is still
    // blocked on the original step_index waiting for input on the matching
    // Redis key. Fall back to the latest intervention's input_request_metadata
    // so the resolve button can POST the correct step_index — same pattern
    // used by AgentService.getSessionStatus.
    // Skip the fallback when the worker auto-resolved the HITL (login detected
    // via URL pattern match) — the DSL is still running but human input is no
    // longer needed.
    let pendingInput = session.pending_input_request as Record<string, unknown> | null;
    if (!pendingInput && (session.state === 'LOGIN_IN_PROGRESS' || session.state === 'LOGIN_NEEDED')) {
      const autoResolved = await this.streamTokenService.isHitlAutoResolved(sessionId);
      if (!autoResolved) {
        const latestIntervention = await this.interventionRepo.findOne({
          where: { session_id: sessionId },
          order: { started_at: 'DESC' },
        });
        pendingInput = latestIntervention?.input_request_metadata ?? null;
      }
    }

    return {
      state: session.state,
      pending_input_request: pendingInput,
    };
  }

  /**
   * Stream-token-authenticated proxy: writes a human-input value to Redis
   * so the worker can unblock the current DSL step.
   */
  @Post(':sessionId/hitl-resolve')
  @HttpCode(200)
  async resolveHitl(
    @Param('sessionId') sessionId: string,
    @Query('token') token?: string,
    @Body() body?: { type?: string; value?: string; step_index?: number },
  ): Promise<{ status: 'delivered' }> {
    if (!token) {
      throw new UnauthorizedException('Missing stream token');
    }
    const result = this.streamTokenService.verifyToken(token);
    if (!result.valid) {
      throw new UnauthorizedException(result.reason);
    }
    if (result.payload.session_id !== sessionId) {
      throw new UnauthorizedException('Token is not valid for this session');
    }

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Session not found');
    }

    const stepIndex = body?.step_index ?? 0;
    const inputType = body?.type ?? 'confirm';
    const value = body?.value ?? 'resolved';

    await this.streamTokenService.writeHumanInput(sessionId, stepIndex, inputType, value);

    return { status: 'delivered' };
  }

  /**
   * "Finish & export" button in the recording viewer. Stream-token-authed.
   * Drains the recording bundle from the worker (synchronous flush) and
   * persists it encrypted for NoUI to pull via GET /recording/sessions/:id/bundle.
   */
  @SkipThrottle()
  @Post(':sessionId/recording-stop')
  @HttpCode(200)
  async stopRecording(
    @Param('sessionId') sessionId: string,
    @Query('token') token?: string,
  ): Promise<{ status: 'stopped'; har_entries: number; events: number; url_events: number }> {
    if (!token) {
      throw new UnauthorizedException('Missing stream token');
    }
    const result = this.streamTokenService.verifyToken(token);
    if (!result.valid) {
      throw new UnauthorizedException(result.reason);
    }
    if (result.payload.session_id !== sessionId) {
      throw new UnauthorizedException('Token is not valid for this session');
    }

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    if (!session.pod_name) {
      throw new ConflictException('Session has no active worker pod');
    }

    const bundle = await this.recordingStore.drainFromWorker(session.pod_name, sessionId);
    await this.recordingStore.persist(session.tenant_id, sessionId, bundle);

    // Cleanup: deactivate the (throwaway) recording app so its pod is torn down
    // (desired_session_count -> 0). The session row + persisted bundle survive
    // for NoUI to pull via GET /recording/sessions/:id/bundle. Best-effort —
    // never fail the stop on a cleanup error.
    if (session.app_id) {
      try {
        await this.appsService.deactivate(session.app_id, session.tenant_id, `recording:${sessionId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`Recording cleanup (deactivate app ${session.app_id}) failed: ${msg}`);
      }
    }

    return {
      status: 'stopped',
      har_entries: bundle.har?.log?.entries?.length ?? 0,
      events: bundle.click_events?.length ?? 0,
      url_events: bundle.url_events?.length ?? 0,
    };
  }

  /**
   * Re-mint a fresh stream token for an in-progress recording so the viewer
   * survives past the 10-minute single-use token TTL without losing the
   * server-side recording (which lives in the worker pod, not the connection).
   */
  @SkipThrottle()
  @Post(':sessionId/refresh-token')
  @HttpCode(200)
  async refreshStreamToken(
    @Param('sessionId') sessionId: string,
    @Query('token') token?: string,
  ): Promise<{ token: string; expires_at: string }> {
    if (!token) {
      throw new UnauthorizedException('Missing stream token');
    }
    const result = this.streamTokenService.verifyToken(token);
    if (!result.valid) {
      throw new UnauthorizedException(result.reason);
    }
    if (result.payload.session_id !== sessionId) {
      throw new UnauthorizedException('Token is not valid for this session');
    }

    const fresh = await this.streamTokenService.generateToken(sessionId, result.payload.user_id);
    return { token: fresh, expires_at: new Date(Date.now() + 600 * 1000).toISOString() };
  }

  /**
   * Email gate: the session owner must have been auto-provisioned (allow_auto_provision=true
   * on the IdP) before this endpoint can succeed. Federated users whose owner_user_id is an
   * external sub but who have no local user row must authenticate via OAuth instead.
   */
  @Get(':sessionId/clear-vnc-auth')
  async clearVncAuth(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Res() res: Response,
  ): Promise<void> {
    res.clearCookie('tabby_vnc', { path: '/' });
    res.redirect(302, `/vnc/${sessionId}`);
  }

  @Post(':sessionId/verify-email')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(200)
  async verifyEmail(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: { email?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: string }> {
    const email = (body?.email || '').trim().toLowerCase();
    if (!email) throw new BadRequestException('email is required');

    const denyMsg = 'Access denied';

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) throw new ForbiddenException(denyMsg);
    if (!session.owner_user_id) throw new ForbiddenException(denyMsg);

    // agent_assertion sessions carry the federated identity (often an email)
    // in owner_user_id; users.id is a uuid, so querying it with that value
    // throws a Postgres cast error. Match email-form owners directly.
    const ownerEmail = await resolveOwnerEmail(this.userRepo, session.owner_user_id);
    if (!ownerEmail || ownerEmail !== email) {
      throw new ForbiddenException(denyMsg);
    }

    const vncPayload = {
      sub: session.owner_user_id,
      tenant_id: session.tenant_id,
      type: 'vnc_access',
      owner_user_id: session.owner_user_id,
      jti: randomUUID(),
    };
    const vncToken = this.jwtService.sign(vncPayload, { expiresIn: 3600 });

    // Cookie domain is intentionally omitted: scopes to the exact API host.
    // In the two-host topology (tabby-api.* + tabby-admin.*) this is correct —
    // the VNC viewer is served from the API host, so the cookie is only sent there.
    const isHttps = PUBLIC_BASE_URL.startsWith('https://') || process.env.NODE_ENV === 'production';
    res.cookie('tabby_vnc', vncToken, {
      httpOnly: true,
      secure: isHttps,
      sameSite: 'lax',
      maxAge: 3600 * 1000,
      path: '/',
    });

    return { status: 'ok' };
  }

  /**
   * Unified panel-state polling endpoint for the side panel (both VNC and CDP viewers).
   * Returns session state, HITL info, and diagnostic counters in one call.
   * Authenticated via stream token (same as hitl-state).
   */
  @SkipThrottle()
  @Get(':sessionId/panel-state')
  async getPanelState(
    @Param('sessionId') sessionId: string,
    @Query('token') token?: string,
  ): Promise<{
    state: string;
    health_result_type: string | null;
    restart_requested: boolean;
    pending_input_request: Record<string, unknown> | null;
    intervention_count: number;
    retry_count: number;
    last_health_check: Date | null;
    started_at: Date;
    app_id: string;
  }> {
    if (!token) throw new UnauthorizedException('Missing stream token');
    const result = this.streamTokenService.verifyToken(token);
    if (!result.valid) throw new UnauthorizedException(result.reason);
    if (result.payload.session_id !== sessionId) throw new UnauthorizedException('Token is not valid for this session');
    if (await this.streamTokenService.isStreamRevoked(sessionId)) throw new UnauthorizedException('Stream access has been revoked');

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');

    let pendingInput = session.pending_input_request as Record<string, unknown> | null;
    if (!pendingInput && (session.state === 'LOGIN_IN_PROGRESS' || session.state === 'LOGIN_NEEDED')) {
      const autoResolved = await this.streamTokenService.isHitlAutoResolved(sessionId);
      if (!autoResolved) {
        const latestIntervention = await this.interventionRepo.findOne({
          where: { session_id: sessionId },
          order: { started_at: 'DESC' },
        });
        pendingInput = latestIntervention?.input_request_metadata ?? null;
      }
    }

    return {
      state: session.state,
      health_result_type: session.health_result_type,
      restart_requested: session.restart_requested,
      pending_input_request: pendingInput,
      intervention_count: session.intervention_count,
      retry_count: session.retry_count,
      last_health_check: session.last_health_check,
      started_at: session.started_at,
      app_id: session.app_id,
    };
  }

  /**
   * Request a session restart. Sets the restart_requested flag; the controller
   * handles pod termination + recreation on the next reconcile cycle (≤15s).
   * Authenticated via stream token so the viewer page can call it directly.
   */
  @Post(':sessionId/restart')
  @HttpCode(200)
  async restartSession(
    @Param('sessionId') sessionId: string,
    @Query('token') token?: string,
  ): Promise<{ message: string; session_id: string; app_id: string }> {
    if (!token) throw new UnauthorizedException('Missing stream token');
    const result = this.streamTokenService.verifyToken(token);
    if (!result.valid) throw new UnauthorizedException(result.reason);
    if (result.payload.session_id !== sessionId) throw new UnauthorizedException('Token is not valid for this session');
    if (await this.streamTokenService.isStreamRevoked(sessionId)) throw new UnauthorizedException('Stream access has been revoked');

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.state === 'TERMINATED') throw new BadRequestException('Cannot restart a TERMINATED session');

    await this.sessionRepo.update(sessionId, { restart_requested: true });

    return { message: 'Restart requested', session_id: sessionId, app_id: session.app_id };
  }

  @Delete(':sessionId/stream-access')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async revokeStreamAccess(
    @Param('sessionId') sessionId: string,
    @Req() req: any,
  ): Promise<{ message: string; session_id: string }> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');

    if (!['Admin', 'Editor'].includes(req.user.role) && session.owner_user_id && req.user.owner_user_id !== session.owner_user_id) {
      throw new ForbiddenException('You can only revoke stream access for your own sessions');
    }

    await this.streamTokenService.revokeStreamAccess(sessionId);

    return { message: 'Stream access revoked', session_id: sessionId };
  }

  /**
   * Find the replacement session created after a restart.
   * Returns the new session's viewer URL when ready, 404 while still provisioning.
   * Authenticated via stream token (uses token's user_id to generate the new stream token).
   */
  @Get(':sessionId/successor')
  async getSuccessor(
    @Param('sessionId') sessionId: string,
    @Query('token') token?: string,
  ): Promise<{ session_id: string; url: string }> {
    if (!token) throw new UnauthorizedException('Missing stream token');
    const result = this.streamTokenService.verifyToken(token);
    if (!result.valid) throw new UnauthorizedException(result.reason);
    if (result.payload.session_id !== sessionId) throw new UnauthorizedException('Token is not valid for this session');
    if (await this.streamTokenService.isStreamRevoked(sessionId)) throw new UnauthorizedException('Stream access has been revoked');

    const originalSession = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!originalSession) throw new NotFoundException('Session not found');

    // Only valid once the original session has terminated; prevents session discovery
    // by callers who haven't requested a restart yet.
    if (originalSession.state !== 'TERMINATED') {
      throw new NotFoundException('No successor session yet');
    }

    // Find a non-terminated session for the same app that was created AFTER the original.
    // STARTING is excluded: the pod isn't accepting connections yet. The client polls every
    // 3s, so it picks up the session as soon as it reaches HEALTHY (pod + relay both up).
    // The started_at > original.started_at filter prevents returning a pre-existing sibling
    // session in multi-session apps where desired_session_count > 1.
    const newSession = await this.sessionRepo.findOne({
      where: [
        { app_id: originalSession.app_id, state: 'HEALTHY' as any, started_at: MoreThan(originalSession.started_at) },
        { app_id: originalSession.app_id, state: 'UNHEALTHY' as any, started_at: MoreThan(originalSession.started_at) },
        { app_id: originalSession.app_id, state: 'LOGIN_NEEDED' as any, started_at: MoreThan(originalSession.started_at) },
        { app_id: originalSession.app_id, state: 'LOGIN_IN_PROGRESS' as any, started_at: MoreThan(originalSession.started_at) },
        { app_id: originalSession.app_id, state: 'FAILED' as any, started_at: MoreThan(originalSession.started_at) },
      ],
      order: { started_at: 'DESC' },
    });

    if (!newSession) {
      throw new NotFoundException('No successor session yet');
    }

    const newToken = await this.streamTokenService.generateToken(newSession.id, result.payload.user_id);

    const app = await this.appRepo.findOne({ where: { id: originalSession.app_id } });
    const policy = app?.browser_policy as Record<string, unknown> | null;
    const mode = typeof policy?.streaming_mode === 'string' ? policy.streaming_mode.toLowerCase() : 'vnc';
    const base = PUBLIC_BASE_URL.replace(/\/+$/, '');
    const url = `${base}/${mode}/${newSession.id}#token=${encodeURIComponent(newToken)}`;

    return { session_id: newSession.id, url };
  }

  @Post(':sessionId/verify-token')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(200)
  async verifyVncToken(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Body() body: { token?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ status: string }> {
    return verifyStreamTokenForOwner(
      this.streamTokenService, this.sessionRepo, this.idpRepo, this.jwtService, sessionId, body?.token, res,
    );
  }

  @SkipThrottle()
  @Get(':sessionId')
  async openStream(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query('token') token?: string,
  ): Promise<void> {
    let tokenUserId: string | undefined;
    if (token) {
      const result = this.streamTokenService.verifyToken(token);
      if (!result.valid) {
        throw new UnauthorizedException(result.reason);
      }
      if (result.payload.session_id !== sessionId) {
        throw new UnauthorizedException('Token is not valid for this session');
      }
      tokenUserId = result.payload.user_id;
    }

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    if (session.state === 'TERMINATED') {
      throw new BadRequestException('Cannot open stream for TERMINATED session');
    }

    // ── Auth gate ──────────────────────────────────────────────────────────
    // ── Auth gate: cookie is the sole identity proof. No token auto-pass. ──
    if (session.owner_user_id) {
      const cookieToken = parseCookie(req.headers.cookie, 'tabby_vnc');

      if (!cookieToken) {
        return redirectToAuth(res, sessionId, token, this.idpRepo, 'vnc', extractExtraQuery(req));
      }

      let cookieValid = false;
      try {
        const vncPayload = this.jwtService.verify<{ owner_user_id: string; type: string; tenant_id: string }>(cookieToken);
        // Cookie must match both owner_user_id AND tenant_id to prevent cross-tenant access.
        if (
          vncPayload.type === 'vnc_access'
          && vncPayload.owner_user_id === session.owner_user_id
          && vncPayload.tenant_id === session.tenant_id
        ) {
          cookieValid = true;
        } else if (vncPayload.type === 'vnc_access') {
          // Valid JWT but wrong user or wrong tenant — show 403 immediately.
          const errorPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access Denied</title><link rel="icon" href="data:,"><style>html,body{margin:0;padding:0;height:100%;background:#0b1020;color:#f8fafc;font-family:ui-sans-serif,system-ui,sans-serif;display:flex;align-items:center;justify-content:center}.card{background:#111827;border:1px solid #1e293b;border-radius:12px;padding:32px;max-width:400px;width:100%;text-align:center}h2{margin:0 0 8px;font-size:20px;color:#f87171}p{margin:0 0 16px;color:#94a3b8;font-size:14px;line-height:1.5}a{display:inline-block;margin-top:4px;padding:10px 20px;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600}a:hover{background:#2563eb}.hint{margin-top:16px;color:#64748b;font-size:12px}</style></head><body><div class="card"><h2>Access Denied</h2><p>You are logged in as a different user than the owner of this session.</p><a href="/vnc/${sessionId}/clear-vnc-auth">Try with a different account</a><p class="hint">You may need to log out of the platform first before signing in with a different account.</p></div></body></html>`;
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.status(403).send(errorPage);
          return;
        }
      } catch {
        // Invalid/expired cookie — redirect to OAuth/email gate.
      }

      if (!cookieValid) {
        return redirectToAuth(res, sessionId, token, this.idpRepo, 'vnc', extractExtraQuery(req));
      }
    }
    // ── End auth gate ──────────────────────────────────────────────────────

    const page = this.renderViewerPage(sessionId, session.app_id, token);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).send(page);
  }

  private renderViewerPage(sessionId: string, appId: string, token?: string): string {
    const safeSessionId = sessionId.replace(/"/g, '');
    const safeToken = (token ?? '').replace(/"/g, '');
    const safeAppId = appId.replace(/"/g, '');
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Session Stream ${sessionId}</title>
    <link rel="icon" href="data:," />
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: #0b1020; color: #f8fafc; font-family: ui-sans-serif, system-ui, sans-serif; }
      #toolbar { height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 12px; border-bottom: 1px solid #1e293b; background: #111827; }
      #state { font-size: 12px; color: #93c5fd; }
      #screen { width: 100%; height: calc(100% - 45px); }
      #side-panel { position: fixed; top: 44px; right: 0; bottom: 0; width: 300px; background: #111827; border-left: 1px solid #1e293b; box-shadow: -4px 0 24px rgba(0,0,0,0.4); transform: translateX(100%); transition: transform 280ms cubic-bezier(0.4,0,0.2,1); will-change: transform; z-index: 9000; display: flex; flex-direction: column; overflow: visible; }
      #side-panel[aria-expanded="true"] { transform: translateX(0); }
      #panel-toggle { position: absolute; left: -36px; top: 50%; transform: translateY(-50%); width: 36px; height: 56px; background: #111827; border: 1px solid #1e293b; border-right: none; border-radius: 8px 0 0 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #94a3b8; font-size: 14px; padding: 0; }
      #panel-toggle:hover { background: #1e293b; color: #f8fafc; }
      #panel-content { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; font-size: 13px; color: #e2e8f0; }
      .psec { display: flex; flex-direction: column; gap: 8px; }
      .psec--bottom { margin-top: auto; padding-top: 16px; border-top: 1px solid #1e293b; }
      details > summary { list-style: none; cursor: pointer; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; padding: 4px 0; user-select: none; display: flex; align-items: center; gap: 6px; }
      details > summary::marker, details > summary::-webkit-details-marker { display: none; }
      details > summary::before { content: '▶'; font-size: 9px; transition: transform 200ms; }
      details[open] > summary::before { transform: rotate(90deg); }
      .psec input[type="password"] { width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #f8fafc; font-size: 13px; outline: none; }
      .psec input[type="password"]:focus { border-color: #3b82f6; }
      .pbtn { padding: 9px 14px; color: white; border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; width: 100%; }
      .pbtn:disabled { opacity: 0.5; cursor: not-allowed; }
      .pbtn-blue { background: #3b82f6; } .pbtn-blue:hover:not(:disabled) { background: #2563eb; }
      .pbtn-green { background: #22c55e; } .pbtn-green:hover:not(:disabled) { background: #16a34a; }
      .pbtn-red { background: #dc2626; } .pbtn-red:hover:not(:disabled) { background: #b91c1c; }
      .srow { display: flex; justify-content: space-between; font-size: 12px; color: #94a3b8; }
      .sval { color: #f8fafc; font-size: 12px; }
      #clip-status { font-size: 11px; color: #6ee7b7; min-height: 16px; }
      #restart-confirm { display: none; margin-top: 8px; padding: 10px; background: rgba(220,38,38,0.1); border-radius: 6px; }
      #restart-confirm p { margin: 0 0 8px; font-size: 12px; color: #f87171; }
      .restart-warning { font-size: 11px; color: #fbbf24; line-height: 1.5; padding: 8px 10px; background: rgba(251,191,36,0.06); border: 1px solid rgba(251,191,36,0.18); border-radius: 6px; }
      @media (prefers-reduced-motion: reduce) { #side-panel { transition: none; } }
    </style>
  </head>
  <body>
    <div id="toolbar">
      <strong>Browser HITL Stream</strong>
      <span id="state">Connecting...</span>
    </div>
    <div id="screen"></div>

    <div id="side-panel" role="complementary" aria-label="Session tools" aria-expanded="false">
      <button id="panel-toggle" aria-label="Toggle session tools">&#9664;</button>
      <div id="panel-content" inert>
        <section id="hitl-section" class="psec" style="display:none">
          <div id="hitl-status" role="status" aria-live="polite" style="font-size:13px;line-height:1.5">Checking session…</div>
          <button id="resolveBtn" class="pbtn pbtn-green" disabled>Mark as Resolved</button>
        </section>
        <section id="recording-section" class="psec" style="display:none">
          <div style="font-size:13px;line-height:1.5">
            <span style="color:#f87171;font-weight:600">&#9679; REC</span> &mdash; this session is being recorded.
            Drive the browser to complete the flow, then finish to export it to NoUI.
          </div>
          <button id="finishRecordingBtn" class="pbtn pbtn-green">Finish &amp; export</button>
          <div id="recording-status" role="status" aria-live="polite" style="font-size:12px;color:#94a3b8;margin-top:6px"></div>
        </section>
        <details open>
          <summary>Clipboard</summary>
          <div class="psec">
            <input id="clip-input" type="password" placeholder="Paste text here, then Ctrl+V in VNC" autocomplete="off" />
            <button id="clip-send" class="pbtn pbtn-blue">Send to VNC clipboard</button>
            <div id="clip-status"></div>
          </div>
        </details>
        <details>
          <summary>Session Status</summary>
          <div class="psec">
            <div class="srow"><span>State</span><span class="sval" id="st-state">—</span></div>
            <div class="srow"><span>Health</span><span class="sval" id="st-health">—</span></div>
            <div class="srow"><span>Interventions</span><span class="sval" id="st-interventions">—</span></div>
            <div class="srow"><span>Retries</span><span class="sval" id="st-retries">—</span></div>
            <div class="srow"><span>Uptime</span><span class="sval" id="st-uptime">—</span></div>
          </div>
        </details>
        <div class="psec psec--bottom">
          <div class="restart-warning">⚠ Only use this if your session is stuck. Make sure to resolve any active HITL step before restarting.</div>
          <button id="restart-btn" class="pbtn pbtn-red">Restart Session</button>
          <div id="restart-confirm">
            <p>This will terminate the current session.</p>
            <button id="restart-yes" class="pbtn pbtn-red">Yes, restart</button>
          </div>
        </div>
      </div>
    </div>

    <div id="panel-config" style="display:none"
      data-session-id="${safeSessionId}"
      data-stream-token="${safeToken}"
      data-app-id="${safeAppId}">
    </div>

    <script>
      (function() {
        // ── Panel toggle ──────────────────────────────────────────────────────
        var panel = document.getElementById('side-panel');
        var toggle = document.getElementById('panel-toggle');
        var content = document.getElementById('panel-content');
        toggle.addEventListener('click', function() {
          var open = panel.getAttribute('aria-expanded') === 'true';
          panel.setAttribute('aria-expanded', String(!open));
          toggle.innerHTML = open ? '&#9664;' : '&#9654;';
          if (open) content.setAttribute('inert', ''); else content.removeAttribute('inert');
        });
        panel.addEventListener('keydown', function(e) {
          if (e.key === 'Escape') {
            panel.setAttribute('aria-expanded', 'false');
            toggle.innerHTML = '&#9664;';
            content.setAttribute('inert', '');
            toggle.focus();
          }
          e.stopPropagation();
        });
        panel.addEventListener('keyup', function(e) { e.stopPropagation(); });
        panel.addEventListener('mousedown', function(e) { e.stopPropagation(); });
        panel.addEventListener('mouseup', function(e) { e.stopPropagation(); });

        // ── Config ────────────────────────────────────────────────────────────
        var cfg = document.getElementById('panel-config');
        var SESSION_ID = cfg.dataset.sessionId;
        var TOKEN = cfg.dataset.streamToken || '';
        if (!TOKEN) {
          var h0 = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
          TOKEN = new URLSearchParams(h0).get('token') || new URLSearchParams(window.location.search).get('token') || '';
        }
        var fromMcp = new URLSearchParams(window.location.search).get('from') === 'mcp';
        if (fromMcp) document.getElementById('hitl-section').style.display = '';
        var recordingMode = new URLSearchParams(window.location.search).get('mode') === 'recording';
        if (recordingMode) {
          var recSection = document.getElementById('recording-section');
          if (recSection) recSection.style.display = '';
        }

        var currentStepIndex = null;
        var resolvedStepIndex = null;
        var sessionTerminated = false;

        var statusEl = document.getElementById('hitl-status');
        var resolveBtn = document.getElementById('resolveBtn');
        var stState = document.getElementById('st-state');
        var stHealth = document.getElementById('st-health');
        var stInterventions = document.getElementById('st-interventions');
        var stRetries = document.getElementById('st-retries');
        var stUptime = document.getElementById('st-uptime');
        var restartBtn = document.getElementById('restart-btn');
        var restartConfirm = document.getElementById('restart-confirm');
        var restartYes = document.getElementById('restart-yes');
        var tokenExpired = false;

        // ── Poll panel-state ──────────────────────────────────────────────────
        function poll() {
          if (sessionTerminated || tokenExpired || !TOKEN) return;
          fetch('/vnc/' + SESSION_ID + '/panel-state?token=' + encodeURIComponent(TOKEN))
            .then(function(r) {
              if (r.status === 401) { tokenExpired = true; return null; }
              return r.ok ? r.json() : null;
            })
            .then(function(data) {
              if (!data) return;
              stState.textContent = data.state || '—';
              stHealth.textContent = data.health_result_type || '—';
              stInterventions.textContent = data.intervention_count != null ? String(data.intervention_count) : '—';
              stRetries.textContent = data.retry_count != null ? String(data.retry_count) : '—';
              if (data.started_at) {
                stUptime.textContent = Math.round((Date.now() - new Date(data.started_at).getTime()) / 60000) + 'm';
              }
              if (data.state === 'TERMINATED') { sessionTerminated = true; handleTerminated(); return; }
              if (fromMcp && data.state === 'HEALTHY') { window.close(); }
              if (!fromMcp) return;
              var pending = data.pending_input_request;
              if (pending && pending.step_index != null) {
                currentStepIndex = pending.step_index;
                statusEl.textContent = 'Step ' + pending.step_index + ' (' + (pending.input_type || 'confirm') + '): ' + (pending.message || pending.label || 'Input needed');
                if (resolvedStepIndex === null || pending.step_index !== resolvedStepIndex) {
                  resolveBtn.disabled = false; resolveBtn.style.opacity = '1'; resolveBtn.style.cursor = 'pointer';
                  resolveBtn.textContent = 'Mark as Resolved'; resolveBtn.style.background = '#22c55e';
                } else {
                  resolveBtn.disabled = true; resolveBtn.style.opacity = '0.5';
                  resolveBtn.textContent = 'Resolved ✓'; resolveBtn.style.background = '#16a34a';
                }
              } else {
                statusEl.textContent = data.state === 'LOGIN_IN_PROGRESS' ? 'Login in progress — waiting…'
                  : data.state === 'LOGIN_NEEDED' ? 'Login required — waiting for input…' : 'State: ' + (data.state || '—');
                resolveBtn.disabled = true; resolveBtn.style.opacity = '0.5';
              }
            }).catch(function() {});
        }

        // ── Resolve HITL ──────────────────────────────────────────────────────
        resolveBtn.addEventListener('click', function() {
          if (resolveBtn.disabled || currentStepIndex === null || !TOKEN) return;
          resolveBtn.disabled = true; resolveBtn.textContent = 'Resolving…';
          fetch('/vnc/' + SESSION_ID + '/hitl-resolve?token=' + encodeURIComponent(TOKEN), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'confirm', value: 'resolved', step_index: currentStepIndex }),
          }).then(function(r) {
            if (!r.ok) { resolveBtn.disabled = false; resolveBtn.textContent = 'Failed — retry'; return; }
            resolveBtn.textContent = 'Resolved ✓'; resolveBtn.style.background = '#16a34a';
            resolvedStepIndex = currentStepIndex;
            setTimeout(poll, 1500);
          }).catch(function() { resolveBtn.disabled = false; resolveBtn.textContent = 'Failed — retry'; });
        });

        // ── Restart ───────────────────────────────────────────────────────────
        restartBtn.addEventListener('click', function() {
          restartConfirm.style.display = 'block'; restartBtn.style.display = 'none';
        });
        restartYes.addEventListener('click', function() {
          if (!TOKEN) return;
          restartYes.disabled = true; restartYes.textContent = 'Restarting…';
          fetch('/vnc/' + SESSION_ID + '/restart?token=' + encodeURIComponent(TOKEN), { method: 'POST' })
            .then(function(r) {
              if (!r.ok) { restartYes.disabled = false; restartYes.textContent = 'Failed — try again'; }
            }).catch(function() { restartYes.disabled = false; restartYes.textContent = 'Failed — try again'; });
        });

        // ── Handle TERMINATED ─────────────────────────────────────────────────
        function handleTerminated() {
          content.innerHTML = '<div class="psec" style="padding:24px 0;text-align:center">'
            + '<div style="font-size:15px;font-weight:600;margin-bottom:8px">Session terminated</div>'
            + '<div id="successor-status" style="color:#94a3b8;font-size:13px">Looking for new session…</div>'
            + '</div>';
          panel.setAttribute('aria-expanded', 'true');
          toggle.innerHTML = '&#9654;';
          content.removeAttribute('inert');
          pollForSuccessor();
        }

        function pollForSuccessor() {
          if (!TOKEN) return;
          fetch('/vnc/' + SESSION_ID + '/successor?token=' + encodeURIComponent(TOKEN))
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(data) {
              var el = document.getElementById('successor-status');
              if (!el) return;
              if (data && data.url) {
                var url = data.url;
                if (fromMcp && url.indexOf('from=mcp') === -1) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'from=mcp';
                el.innerHTML = '<div style="margin-bottom:8px;font-weight:600">New session ready!</div>'
                  + '<a href="' + url + '" style="display:inline-block;padding:10px 20px;background:#3b82f6;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px">Open new session</a>'
                  + '<div style="margin-top:10px;font-size:11px;color:#64748b;line-height:1.5">If the browser does not appear right away, wait a few seconds and reload the page.</div>';
              } else { setTimeout(pollForSuccessor, 3000); }
            }).catch(function() { setTimeout(pollForSuccessor, 3000); });
        }

        // ── Recording: "Finish & export" ──────────────────────────────────────
        var finishBtn = document.getElementById('finishRecordingBtn');
        var recStatus = document.getElementById('recording-status');
        if (finishBtn) {
          finishBtn.addEventListener('click', function() {
            if (!TOKEN) return;
            finishBtn.disabled = true; finishBtn.textContent = 'Exporting…';
            fetch('/vnc/' + SESSION_ID + '/recording-stop?token=' + encodeURIComponent(TOKEN), {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            }).then(function(r) { return r.ok ? r.json() : null; })
              .then(function(d) {
                if (!d) { finishBtn.disabled = false; finishBtn.textContent = 'Failed — retry'; return; }
                finishBtn.textContent = 'Recording complete ✓'; finishBtn.style.background = '#16a34a';
                recStatus.textContent = 'Captured ' + d.har_entries + ' requests and ' + d.events
                  + ' interactions. You can return to NoUI.';
              }).catch(function() { finishBtn.disabled = false; finishBtn.textContent = 'Failed — retry'; });
          });
        }

        // ── Keep the stream token fresh (single-use token expires in ~10 min) ──
        // The recording lives server-side in the worker pod, so refreshing the
        // token keeps the viewer + Finish button working across the TTL boundary.
        window.__streamToken = TOKEN;
        function refreshToken() {
          if (sessionTerminated || !TOKEN) return;
          fetch('/vnc/' + SESSION_ID + '/refresh-token?token=' + encodeURIComponent(TOKEN), { method: 'POST' })
            .then(function(r) { return r.ok ? r.json() : null; })
            .then(function(d) {
              if (d && d.token) {
                TOKEN = d.token; tokenExpired = false; window.__streamToken = d.token;
                cfg.setAttribute('data-stream-token', d.token);
              }
            }).catch(function() {});
        }
        setInterval(refreshToken, 8 * 60 * 1000);

        poll();
        setInterval(poll, 3000);
      })();

    </script>

    <script type="module">
      import RFB from '/vnc/assets/rfb.js';

      const stateEl = document.getElementById('state');
      const sessionId = ${JSON.stringify(sessionId)};
      const initialToken = ${JSON.stringify(token)};
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
      const token = new URLSearchParams(hash).get('token') || new URLSearchParams(window.location.search).get('token') || initialToken;

      if (!token) {
        stateEl.textContent = 'Missing stream token';
        throw new Error('Missing stream token');
      }

      // Keep panel-config in sync for tokens arriving via URL hash
      document.getElementById('panel-config').setAttribute('data-stream-token', token);

      const wsUrl = proto + '://' + window.location.host + '/vnc-ws?session_id=' + encodeURIComponent(sessionId);
      const rfb = new RFB(document.getElementById('screen'), wsUrl, { wsProtocols: ['binary', 'token.' + token] });
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.background = '#0b1020';
      // Trade server CPU (now uncapped) for fewer bytes over the slow transport:
      // max zlib compression, JPEG quality kept legible for login forms.
      rfb.qualityLevel = 6;
      rfb.compressionLevel = 9;
      window.rfb = rfb;

      rfb.addEventListener('connect', () => { stateEl.textContent = 'Connected'; });
      rfb.addEventListener('disconnect', (e) => {
        stateEl.textContent = 'Disconnected (' + (e.detail?.clean ? 'clean' : 'error') + ')';
      });

      // Side panel clipboard: paste text → sends to VNC remote clipboard → user Ctrl+V inside VNC
      const clipInput = document.getElementById('clip-input');
      const clipSend = document.getElementById('clip-send');
      const clipStatus = document.getElementById('clip-status');

      function sendClipboard() {
        const text = clipInput.value;
        if (!text || !window.rfb) return;
        window.rfb.clipboardPasteFrom(text);
        clipStatus.textContent = 'Sent ✓';
        setTimeout(() => { clipStatus.textContent = ''; }, 2000);
      }
      clipInput.addEventListener('paste', () => { setTimeout(sendClipboard, 0); });
      clipInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { sendClipboard(); window.rfb.focus(); }
        e.stopPropagation();
      });
      clipInput.addEventListener('keyup', (e) => { e.stopPropagation(); });
      clipSend.addEventListener('click', () => { sendClipboard(); window.rfb.focus(); });

      // Mac Command → Ctrl: translate common shortcuts when canvas/body has focus.
      // Shift is preserved so Cmd+Shift+Z → Ctrl+Shift+Z (redo).
      // Skips when the side panel input is focused so Cmd+V pastes normally into it.
      document.addEventListener('keydown', (event) => {
        if (!event.metaKey) return;
        const el = document.activeElement;
        if (el && el.tagName !== 'CANVAS' && el !== document.body) return;
        const key = event.key.toLowerCase();
        if (!'vcaxz'.includes(key)) return;
        event.preventDefault();
        event.stopPropagation();
        const keysym = key.charCodeAt(0);
        if (event.shiftKey) window.rfb.sendKey(0xffe1, 'ShiftLeft', true);
        window.rfb.sendKey(0xffe3, 'ControlLeft', true);
        window.rfb.sendKey(keysym, 'Key' + key.toUpperCase(), true);
        window.rfb.sendKey(keysym, 'Key' + key.toUpperCase(), false);
        window.rfb.sendKey(0xffe3, 'ControlLeft', false);
        if (event.shiftKey) window.rfb.sendKey(0xffe1, 'ShiftLeft', false);
      }, true);
    </script>
  </body>
</html>`;
  }

  private normalizeNoVncAssetPath(assetPath: string): string {
    const normalized = assetPath.replace(/^\/+/, '').trim() || 'rfb.js';
    if (!/^[A-Za-z0-9._/-]+$/.test(normalized) || normalized.includes('..')) {
      throw new BadRequestException('Invalid noVNC asset path');
    }
    return normalized;
  }

  private async loadNoVncAsset(
    section: 'core' | 'vendor',
    assetPath: string,
  ): Promise<{ body: string; contentType: string }> {
    try {
      const modulePath = require.resolve(`@novnc/novnc/${section}/${assetPath}`);
      const body = await readFile(modulePath, 'utf8');
      return {
        body,
        contentType: this.resolveNoVncAssetContentType(assetPath),
      };
    } catch {
      const upstream = await fetch(`${StreamingController.noVncRootBaseUrl}/${section}/${assetPath}`);
      if (!upstream.ok) {
        if (upstream.status === 404) {
          throw new NotFoundException(`noVNC ${section} asset not found: ${assetPath}`);
        }
        throw new InternalServerErrorException(`Failed to fetch noVNC ${section} asset (${upstream.status})`);
      }

      const body = await upstream.text();
      const contentType = upstream.headers.get('content-type') || this.resolveNoVncAssetContentType(assetPath);
      return { body, contentType };
    }
  }

  private resolveNoVncAssetContentType(assetPath: string): string {
    if (assetPath.endsWith('.js')) return 'application/javascript; charset=utf-8';
    if (assetPath.endsWith('.css')) return 'text/css; charset=utf-8';
    if (assetPath.endsWith('.json')) return 'application/json; charset=utf-8';
    if (assetPath.endsWith('.svg')) return 'image/svg+xml';
    if (assetPath.endsWith('.png')) return 'image/png';
    if (assetPath.endsWith('.wasm')) return 'application/wasm';
    return 'text/plain; charset=utf-8';
  }
}
