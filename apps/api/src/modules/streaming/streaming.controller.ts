import {
  BadRequestException,
  Controller,
  Get,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SessionEntity } from '../../entities';
import { StreamTokenService } from './stream-token.service';
import { Request, Response } from 'express';
import { readFile } from 'node:fs/promises';

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
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
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

    const page = this.renderViewerPage(sessionId, token);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('pragma', 'no-cache');
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).send(page);
  }

  private renderViewerPage(sessionId: string, token?: string): string {
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
