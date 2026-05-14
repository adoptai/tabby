import {
  BadRequestException,
  Body,
  Controller,
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
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { SessionEntity, InterventionEntity, IdentityProviderEntity, UserEntity } from '../../entities';
import { StreamTokenService } from './stream-token.service';
import { Request, Response } from 'express';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'crypto';
import { Not, IsNull } from 'typeorm';
import { Throttle } from '@nestjs/throttler';
import { parseCookie } from '../../common/utils/cookie';

/** Module-level constant — avoids repeating the env-read inline everywhere. */
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'http://localhost:18080';

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

    // Extract sessionId from the resolved URL (pattern: /vnc/{sessionId}?token=...)
    const sessionIdMatch = url.match(/\/vnc\/([0-9a-f-]{36})/i);
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
          ) {
            res.redirect(302, url);
            return;
          }
        } catch {
          // Invalid cookie — fall through to OAuth redirect
        }
      }

      // No valid cookie: redirect to OAuth login with post_login set to this short-link.
      // No fallback to the bootstrap-admin tenant — each tenant must configure its own IdP.
      if (session) {
        const idp = await this.idpRepo.findOne({
          where: { enabled: true, auth_url: Not(IsNull()) },
        });
        if (idp) {
          const postLogin = `/s/${shortId}`;
          res.redirect(302, `${PUBLIC_BASE_URL}/auth/oauth/${idp.id}/login?post_login=${encodeURIComponent(postLogin)}`);
          return;
        }
      }
    }

    // No session context or no OAuth configured: redirect directly
    res.redirect(302, url);
  }
}

@ApiTags('Streaming - CDP')
@Controller('cdp')
export class CdpStreamingController {
  constructor(
    private readonly streamTokenService: StreamTokenService,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
  ) {}

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

  @Get(':sessionId')
  async openStream(
    @Param('sessionId') sessionId: string,
    @Res() res: Response,
    @Query('token') token?: string,
  ): Promise<void> {
    if (token) {
      const result = this.streamTokenService.verifyToken(token);
      if (!result.valid) {
        throw new UnauthorizedException(result.reason);
      }
      if (result.payload.session_id !== sessionId) {
        throw new UnauthorizedException('Token is not valid for this session');
      }
    }

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    if (session.state === 'TERMINATED') {
      throw new BadRequestException('Cannot open stream for TERMINATED session');
    }

    const page = this.renderCdpViewerPage(sessionId, token);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).send(page);
  }

  private renderCdpViewerPage(sessionId: string, token?: string): string {
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
      #fps { font-size: 12px; color: #6ee7b7; margin-left: auto; }
      #screen { display: flex; justify-content: center; align-items: center; width: 100%; height: calc(100% - 45px); overflow: hidden; }
      canvas { max-width: 100%; max-height: 100%; }
      #reconnect { display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #1e293b; padding: 24px; border-radius: 8px; text-align: center; }
      #reconnect button { margin-top: 12px; padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; }
    </style>
  </head>
  <body>
    <div id="toolbar">
      <strong>Browser HITL Stream (CDP)</strong>
      <span id="state">Connecting...</span>
      <span id="fps"></span>
    </div>
    <div id="screen">
      <canvas id="canvas"></canvas>
    </div>
    <div id="reconnect">
      <p>Connection lost</p>
      <button onclick="connect()">Reconnect</button>
    </div>
    <script>
      const stateEl = document.getElementById('state');
      const fpsEl = document.getElementById('fps');
      const canvas = document.getElementById('canvas');
      const ctx = canvas.getContext('2d');
      const reconnectEl = document.getElementById('reconnect');
      const sessionId = ${JSON.stringify(sessionId)};
      const initialToken = ${JSON.stringify(token)};

      let ws = null;
      let cmdId = 1;
      let frameCount = 0;
      let lastFpsUpdate = Date.now();

      function resolveToken() {
        const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
        const hp = new URLSearchParams(hash);
        const qp = new URLSearchParams(window.location.search);
        return hp.get('token') || qp.get('token') || initialToken;
      }

      function connect() {
        reconnectEl.style.display = 'none';
        const token = resolveToken();
        if (!token) {
          stateEl.textContent = 'Missing stream token';
          return;
        }

        const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const url = proto + '://' + window.location.host + '/cdp-ws?session_id=' + encodeURIComponent(sessionId) + '&token=' + encodeURIComponent(token);
        ws = new WebSocket(url);

        ws.onopen = function() {
          stateEl.textContent = 'Connected';
          // Start screencast
          ws.send(JSON.stringify({
            id: cmdId++,
            method: 'Page.startScreencast',
            params: { format: 'jpeg', quality: 60, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }
          }));
        };

        ws.onmessage = function(event) {
          try {
            const msg = JSON.parse(event.data);
            if (msg.method === 'Page.screencastFrame') {
              renderFrame(msg.params);
              // Acknowledge frame
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
          stateEl.textContent = 'Disconnected';
          reconnectEl.style.display = 'block';
        };

        ws.onerror = function() {
          stateEl.textContent = 'Connection error';
        };
      }

      function renderFrame(params) {
        const img = new Image();
        img.onload = function() {
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
          }
          ctx.drawImage(img, 0, 0);
          frameCount++;
          const now = Date.now();
          if (now - lastFpsUpdate >= 1000) {
            fpsEl.textContent = frameCount + ' fps';
            frameCount = 0;
            lastFpsUpdate = now;
          }
        };
        img.src = 'data:image/jpeg;base64,' + params.data;
      }

      // Mouse events
      canvas.addEventListener('mousedown', function(e) { sendMouse('mousePressed', e); });
      canvas.addEventListener('mouseup', function(e) { sendMouse('mouseReleased', e); });
      canvas.addEventListener('mousemove', function(e) { sendMouse('mouseMoved', e); });

      function sendMouse(type, e) {
        if (!ws || ws.readyState !== 1) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = Math.round((e.clientX - rect.left) * scaleX);
        const y = Math.round((e.clientY - rect.top) * scaleY);
        const button = e.button === 0 ? 'left' : e.button === 1 ? 'middle' : 'right';
        ws.send(JSON.stringify({
          id: cmdId++,
          method: 'Input.dispatchMouseEvent',
          params: { type: type, x: x, y: y, button: button, clickCount: 1 }
        }));
      }

      // Keyboard events
      document.addEventListener('keydown', function(e) { sendKey('keyDown', e); });
      document.addEventListener('keyup', function(e) { sendKey('keyUp', e); });

      function sendKey(type, e) {
        if (!ws || ws.readyState !== 1) return;
        // Prevent browser default for most keys when canvas is focused
        if (document.activeElement === canvas || document.activeElement === document.body) {
          e.preventDefault();
        }
        ws.send(JSON.stringify({
          id: cmdId++,
          method: 'Input.dispatchKeyEvent',
          params: {
            type: type === 'keyDown' ? 'keyDown' : 'keyUp',
            key: e.key,
            code: e.code,
            text: type === 'keyDown' && e.key.length === 1 ? e.key : undefined,
            modifiers: (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
          }
        }));
      }

      // Prevent context menu on canvas
      canvas.addEventListener('contextmenu', function(e) { e.preventDefault(); });

      // Initial connection
      connect();
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
    private readonly jwtService: JwtService,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
    @InjectRepository(InterventionEntity)
    private readonly interventionRepo: Repository<InterventionEntity>,
    @InjectRepository(IdentityProviderEntity)
    private readonly idpRepo: Repository<IdentityProviderEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  @Get('assets/*')
  async getNoVncAsset(@Req() req: Request, @Res() res: Response): Promise<void> {
    const rawAssetPath = (req.params as Record<string, string | undefined>)['0'] || 'rfb.js';
    const assetPath = this.normalizeNoVncAssetPath(rawAssetPath);
    const cacheKey = `core:${assetPath}`;
    const cached = StreamingController.noVncAssetCache.get(cacheKey);
    const asset = cached ?? await this.loadNoVncAsset('core', assetPath);

    if (!cached) {
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
    let pendingInput = session.pending_input_request as Record<string, unknown> | null;
    if (!pendingInput && (session.state === 'LOGIN_IN_PROGRESS' || session.state === 'LOGIN_NEEDED')) {
      const latestIntervention = await this.interventionRepo.findOne({
        where: { session_id: sessionId },
        order: { started_at: 'DESC' },
      });
      pendingInput = latestIntervention?.input_request_metadata ?? null;
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

    const ownerUser = await this.userRepo.findOne({ where: { id: session.owner_user_id } });
    if (!ownerUser || ownerUser.email?.toLowerCase() !== email) {
      throw new ForbiddenException(denyMsg);
    }

    const vncPayload = {
      sub: ownerUser.id,
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

  @Get(':sessionId')
  async openStream(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Query('token') token?: string,
  ): Promise<void> {
    if (token) {
      const result = this.streamTokenService.verifyToken(token);
      if (!result.valid) {
        throw new UnauthorizedException(result.reason);
      }
      if (result.payload.session_id !== sessionId) {
        throw new UnauthorizedException('Token is not valid for this session');
      }
    }

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      throw new NotFoundException('Session not found');
    }
    if (session.state === 'TERMINATED') {
      throw new BadRequestException('Cannot open stream for TERMINATED session');
    }

    // ── Auth gate ──────────────────────────────────────────────────────────
    if (session.owner_user_id) {
      const cookieToken = parseCookie(req.headers.cookie, 'tabby_vnc');

      if (!cookieToken) {
        // No cookie — go through OAuth / email gate.
        return this.redirectToAuth(res, sessionId, token, session);
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
        return this.redirectToAuth(res, sessionId, token, session);
      }
    }
    // ── End auth gate ──────────────────────────────────────────────────────

    const page = this.renderViewerPage(sessionId, token);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).send(page);
  }

  /**
   * Redirect to OAuth login (or email gate fallback) when a valid tabby_vnc
   * cookie is absent.  Extracted from openStream to keep that method readable.
   *
   * M-4: The stream token is NOT included in the post_login URL that travels
   * through the IdP.  Instead it is stored in the OAuth Redis state alongside
   * the PKCE verifier and recovered in handleOauthCallback, so it never appears
   * in IdP server logs or browser Referer headers.
   */
  private async redirectToAuth(
    res: Response,
    sessionId: string,
    token: string | undefined,
    session: SessionEntity,
  ): Promise<void> {
    let idp = await this.idpRepo.findOne({
      where: { enabled: true, auth_url: Not(IsNull()) },
    });
    // No fallback to the bootstrap-admin tenant — each tenant must have its own
    // IdP configured. Without one the email gate is offered instead.

    if (idp) {
      if (token) {
        // Token in query param — redirect directly to OAuth.
        // The stream token is passed as stream_token and stored in Redis state
        // so it does NOT appear in the IdP redirect URI (M-4).
        const params = new URLSearchParams({
          post_login: `/vnc/${sessionId}`,
          stream_token: token,
        });
        res.redirect(302, `${PUBLIC_BASE_URL}/auth/oauth/${idp.id}/login?${params.toString()}`);
        return;
      }
      // No query token — serve bridge page to extract #fragment token client-side,
      // then redirect to OAuth. The bridge page passes the token via stream_token param.
      const oauthLoginUrl = `${PUBLIC_BASE_URL}/auth/oauth/${idp.id}/login`;
      const nonce = randomBytes(16).toString('base64');
      res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'`);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      const bridge = `<!doctype html><html><head><meta charset="utf-8"><title>Authenticating...</title></head><body><p>Redirecting to login...</p><script nonce="${nonce}">
var h=window.location.hash.charAt(0)==='#'?window.location.hash.slice(1):window.location.hash;
var t=new URLSearchParams(h).get('token')||'';
var p=new URLSearchParams({post_login:'/vnc/'+${JSON.stringify(sessionId)}});
if(t)p.set('stream_token',t);
window.location.href='${oauthLoginUrl}?'+p.toString();
</script></body></html>`;
      res.status(200).send(bridge);
      return;
    }

    // No OAuth configured: render email gate fallback
    const emailGatePage = this.renderEmailGatePage(sessionId, token);
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).send(emailGatePage.replace('<script>', `<script nonce="${nonce}">`));
  }

  private renderEmailGatePage(sessionId: string, token?: string): string {
    // sessionId is guaranteed to be a UUID by ParseUUIDPipe on the caller.
    // JSON.stringify is used for all values injected into script context to
    // prevent XSS even if input validation is bypassed.
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
      <button id="submitBtn" onclick="verify()">Continue</button>
      <div id="msg"></div>
    </div>
    <script>
      var SESSION_ID = ${JSON.stringify(sessionId)};
      var STREAM_TOKEN = ${JSON.stringify(token ?? '')};
      // Also check URL fragment for stream token (server never sees #fragment)
      if (!STREAM_TOKEN) {
        var h = window.location.hash.charAt(0) === '#' ? window.location.hash.slice(1) : window.location.hash;
        STREAM_TOKEN = new URLSearchParams(h).get('token') || '';
      }

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
        fetch('/vnc/' + SESSION_ID + '/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email }),
          credentials: 'same-origin',
        })
          .then(function(r) {
            if (r.ok) {
              var dest = '/vnc/' + SESSION_ID;
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

  private renderViewerPage(sessionId: string, token?: string): string {
    // sessionId is guaranteed UUID by ParseUUIDPipe. JSON.stringify is used
    // for all values injected into data-attributes and script context.
    const safeSessionId = sessionId.replace(/"/g, '');
    const safeToken = (token ?? '').replace(/"/g, '');
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
    </style>
  </head>
  <body>
    <div id="toolbar">
      <strong>Browser HITL Stream</strong>
      <span id="state">Connecting...</span>
    </div>
    <div id="screen"></div>

    <!-- HITL panel: operator clicks "Mark as Resolved" to unblock the worker -->
    <div id="hitl-panel" style="
      position: fixed; top: 8px; right: 8px; z-index: 9999;
      padding: 10px 14px; background: rgba(15,23,42,0.9); color: white;
      border-radius: 8px; font: 13px/1.4 system-ui, sans-serif;
      max-width: 280px;
    ">
      <div id="hitl-status">Checking session…</div>
      <button id="resolveBtn" disabled style="
        margin-top: 8px; padding: 8px 14px; background: #22c55e; color: white;
        border: none; border-radius: 6px; font-weight: 600; width: 100%; opacity: 0.5;
        cursor: pointer;
      ">Mark as Resolved</button>
    </div>

    <!-- config: server injects sessionId + stream token as data-attributes -->
    <div id="hitl-config"
      data-session-id="${safeSessionId}"
      data-stream-token="${safeToken}"
      style="display:none"
    ></div>

    <script>
      (function () {
        // Only render the HITL panel when this VNC page was opened from the
        // MCP flow ("?from=mcp"). Copilot, CE and other surfaces have their
        // own resolve UI; if the user clicks "Mark as Resolved" inside VNC
        // for those surfaces, the worker advances but the originating UI is
        // left waiting forever. Default-hide is the safe choice.
        var rawHash = window.location.hash.charAt(0) === '#'
          ? window.location.hash.slice(1) : window.location.hash;
        var fromParam = new URLSearchParams(window.location.search).get('from')
          || new URLSearchParams(rawHash).get('from');
        if (fromParam !== 'mcp') {
          var panel = document.getElementById('hitl-panel');
          if (panel) panel.style.display = 'none';
          return;
        }

        var cfg = document.getElementById('hitl-config');
        var SESSION_ID = cfg.getAttribute('data-session-id');
        // Stream token may be updated from URL hash/query after page load (same
        // logic the module script uses). We resolve it lazily inside each fetch.
        function resolveToken() {
          var stored = cfg.getAttribute('data-stream-token');
          if (stored) return stored;
          var hash = window.location.hash.startsWith('#')
            ? window.location.hash.slice(1) : window.location.hash;
          return new URLSearchParams(hash).get('token') ||
            new URLSearchParams(window.location.search).get('token') || '';
        }

        // step_index from the latest hitl-state poll. Backend falls back to
        // the most recent intervention.input_request_metadata when the session
        // pending_input_request was cleared by the controller, so the value
        // stays correct throughout LOGIN_IN_PROGRESS. Null = no step known —
        // button stays disabled to prevent submitting to the wrong key.
        var currentStepIndex = null;
        // Track which step_index the user has already resolved in this viewer
        // session, so the button stays disabled after one click and only
        // re-enables when the worker advances to a NEW step (sequential HITL
        // like Salesforce password → OTP). Prevents duplicate submissions.
        var resolvedStepIndex = null;

        // Set of session states (from packages/shared/src/enums.ts SessionState)
        // where it makes sense to let the user click "Mark as Resolved":
        //   - LOGIN_NEEDED       → worker is blocked waiting for the human.
        //   - LOGIN_IN_PROGRESS  → controller transitioned but the worker may
        //                          still be waiting on input; user clicks to
        //                          confirm once login is done.
        // All other states (STARTING, HEALTHY, UNHEALTHY, FAILED, TERMINATED)
        // disable the button — clicking does nothing useful and prevents the
        // user from spamming submits with no effect.
        var ENABLE_STATES = { LOGIN_NEEDED: 1, LOGIN_IN_PROGRESS: 1 };

        function setEnabled(btn, enabled) {
          btn.disabled = !enabled;
          btn.style.opacity = enabled ? '1' : '0.5';
          btn.style.cursor = enabled ? 'pointer' : 'not-allowed';
          if (enabled) {
            btn.textContent = 'Mark as Resolved';
            btn.style.background = '#22c55e';
          }
        }

        function refreshState() {
          var tok = resolveToken();
          if (!tok) return;
          fetch('/vnc/' + SESSION_ID + '/hitl-state?token=' + encodeURIComponent(tok))
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (s) {
              if (!s) return;
              var btn = document.getElementById('resolveBtn');
              var status = document.getElementById('hitl-status');
              var pending = s.pending_input_request;
              var state = s.state || 'unknown';

              // Always update sticky step_index when pending is observed.
              if (pending && pending.step_index != null) {
                currentStepIndex = pending.step_index;
              }

              if (state === 'HEALTHY') {
                status.textContent = 'Session healthy — no pending input.';
                setEnabled(btn, false);
                return;
              }
              if (state === 'FAILED') {
                status.textContent = 'Session FAILED: ' + (s.error || 'unknown');
                setEnabled(btn, false);
                return;
              }
              if (state === 'TERMINATED') {
                status.textContent = 'Session ended.';
                setEnabled(btn, false);
                return;
              }
              if (state === 'STARTING') {
                status.textContent = 'Session is starting — login will be required once the browser is ready.';
                setEnabled(btn, false);
                return;
              }
              if (state === 'UNHEALTHY') {
                status.textContent = 'Session is recovering automatically — please wait.';
                setEnabled(btn, false);
                return;
              }

              // LOGIN_NEEDED or LOGIN_IN_PROGRESS — actionable.
              if (ENABLE_STATES[state]) {
                if (pending && pending.step_index != null) {
                  var type = pending.input_type || 'confirm';
                  var msg = pending.message || pending.label || 'Input needed';
                  status.textContent = 'Step ' + pending.step_index + ' (' + type + '): ' + msg;
                  // Only re-enable if this is a NEW step (or first one).
                  // Prevents the user from clicking again on the same step.
                  if (resolvedStepIndex === null || pending.step_index !== resolvedStepIndex) {
                    setEnabled(btn, true);
                  } else {
                    setEnabled(btn, false);
                    btn.textContent = 'Resolved ✓';
                    btn.style.background = '#16a34a';
                  }
                } else {
                  // No step_index resolved yet — button must stay disabled
                  // because submitting with a default would write to the
                  // wrong human_input Redis key and the worker would never
                  // see it.
                  status.textContent = state === 'LOGIN_IN_PROGRESS'
                    ? 'Login in progress — waiting for current step…'
                    : 'Login required — waiting for input details…';
                  setEnabled(btn, false);
                }
                return;
              }

              // Unknown state: be conservative, disable.
              status.textContent = 'State: ' + state + ' — waiting…';
              setEnabled(btn, false);
            })
            .catch(function () {});
        }

        document.getElementById('resolveBtn').addEventListener('click', function () {
          // Refuse the click if we never observed a step_index. Posting with
          // a default would write to the wrong human_input Redis key and the
          // worker would silently miss the input. setEnabled(false) at this
          // point is a defense-in-depth — the button should already be disabled.
          if (currentStepIndex === null) return;
          var tok = resolveToken();
          if (!tok) return;
          var btn = document.getElementById('resolveBtn');
          btn.disabled = true;
          btn.textContent = 'Resolving…';
          fetch('/vnc/' + SESSION_ID + '/hitl-resolve?token=' + encodeURIComponent(tok), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'confirm', value: 'resolved', step_index: currentStepIndex }),
          })
            .then(function (res) {
              if (!res.ok) {
                btn.textContent = 'Failed — retry';
                btn.disabled = false;
                return;
              }
              btn.textContent = 'Resolved ✓';
              btn.style.background = '#16a34a';
              // Mark this step as resolved so refreshState() doesn't re-enable
              // the button until the worker advances to a different step_index.
              resolvedStepIndex = currentStepIndex;
              setTimeout(refreshState, 1500);
            })
            .catch(function () {
              btn.textContent = 'Failed — retry';
              btn.disabled = false;
            });
        });

        refreshState();
        setInterval(refreshState, 3000);
      })();
    </script>

    <script type="module">
      import RFB from '/vnc/assets/rfb.js';

      const stateEl = document.getElementById('state');
      const sessionId = ${JSON.stringify(sessionId)};
      const initialToken = ${JSON.stringify(token)};
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
      const hashParams = new URLSearchParams(hash);
      const queryParams = new URLSearchParams(window.location.search);
      const token = hashParams.get('token') || queryParams.get('token') || initialToken;

      if (!token) {
        stateEl.textContent = 'Missing stream token';
        throw new Error('Missing stream token');
      }

      // Keep the hitl-config data-attribute in sync so the HITL panel's
      // resolveToken() picks up a token even when it arrives via URL hash.
      if (token) {
        document.getElementById('hitl-config').setAttribute('data-stream-token', token);
      }

      const wsUrl = proto + '://' + window.location.host + '/vnc-ws?session_id=' + encodeURIComponent(sessionId);
      const wsProtocols = ['binary', 'token.' + token];

      const rfb = new RFB(document.getElementById('screen'), wsUrl, { wsProtocols });
      rfb.scaleViewport = true;
      rfb.resizeSession = true;
      rfb.background = '#0b1020';

      rfb.addEventListener('connect', () => {
        stateEl.textContent = 'Connected';
      });

      rfb.addEventListener('disconnect', (event) => {
        stateEl.textContent = 'Disconnected (' + (event.detail?.clean ? 'clean' : 'error') + ')';
      });

      // Clipboard paste: operator presses Ctrl+V in browser → text is pasted into the VNC session.
      //
      // noVNC registers its keydown handler on the canvas (bubble phase). We register on
      // document in capture phase, so our handler fires first. We stop propagation to
      // prevent noVNC from forwarding Ctrl+V to the remote before the clipboard is ready.
      // We do NOT call preventDefault(), so the browser still fires the paste event.
      // In the paste handler we: (1) set the remote clipboard via ClientCutText, then
      // (2) manually send Ctrl+V key events so the remote app triggers its paste action.
      document.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'v') {
          event.stopPropagation();
          // Do NOT preventDefault — browser must fire the paste event so we can read clipboardData
        }
      }, true);

      document.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return;
        event.preventDefault();
        event.stopPropagation();
        // 1. Set the remote X11 clipboard
        rfb.clipboardPasteFrom(text);
        // 2. Send Ctrl+V to the remote so the focused app pastes it
        //    XK_Control_L = 0xffe3, XK_v = 0x76
        rfb.sendKey(0xffe3, 'ControlLeft', true);
        rfb.sendKey(0x76, 'KeyV', true);
        rfb.sendKey(0x76, 'KeyV', false);
        rfb.sendKey(0xffe3, 'ControlLeft', false);
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
