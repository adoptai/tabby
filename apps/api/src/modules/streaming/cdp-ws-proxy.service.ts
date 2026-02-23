import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { IncomingMessage, Server } from 'http';
import { Socket } from 'net';
import { URL } from 'url';
import { Repository } from 'typeorm';
import WebSocket, { WebSocketServer } from 'ws';
import { SessionEntity } from '../../entities';
import { StreamTokenService } from './stream-token.service';
import {
  CDP_ALLOWED_COMMANDS,
  CDP_ALLOWED_EVENTS,
  CDP_LIMITS,
  CDP_PORTS,
  sanitizeScreencastParams,
} from '@browser-hitl/shared';

/**
 * CDP WebSocket Proxy Service.
 *
 * Handles HTTP upgrade on /cdp-ws path. Connects the browser viewer to the
 * worker pod's CDP relay server with message-level filtering.
 *
 * Security model:
 * - Token resolution + validation (same as VncWsProxyService)
 * - NO pipe() — every message is individually inspected
 * - Client -> Backend: only CDP_ALLOWED_COMMANDS forwarded
 * - Backend -> Client: only CDP_ALLOWED_EVENTS + matching RPC responses forwarded
 * - Frame size validation: reject > 64KB
 * - Target.* domain commands rejected
 */
@Injectable()
export class CdpWsProxyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CdpWsProxyService.name);
  private readonly namespace = process.env.WORKER_NAMESPACE || 'browser-hitl';
  private readonly cdpPort = CDP_PORTS.CDP_RELAY;
  private readonly cdpServiceDomain =
    process.env.CDP_SERVICE_DOMAIN || `${this.namespace}.svc.cluster.local`;
  private readonly trackedSockets = new Set<WebSocket>();
  private wss: WebSocketServer | null = null;
  private httpServer: Server | null = null;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly streamTokenService: StreamTokenService,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
  ) {}

  onModuleInit(): void {
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer() as Server;
    this.httpServer = httpServer;

    // Create WebSocket server in no-server mode (handle upgrades manually)
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', this.handleUpgrade);
    this.logger.log('Attached HTTP upgrade handler for /cdp-ws proxy');
  }

  async onModuleDestroy(): Promise<void> {
    for (const socket of this.trackedSockets) {
      socket.terminate();
    }
    this.trackedSockets.clear();
    if (this.wss) {
      this.wss.close();
    }
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    const url = this.parseUrl(request.url);
    if (!url || url.pathname !== '/cdp-ws') {
      return;
    }

    void this.proxyUpgrade(request, socket, head, url);
  };

  private async proxyUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
    url: URL,
  ): Promise<void> {
    try {
      const token = this.resolveStreamToken(url, request);
      const sessionId = url.searchParams.get('session_id');
      if (!token || !sessionId) {
        this.rejectUpgrade(socket, 400, 'Missing token or session_id');
        return;
      }

      const validation = await this.streamTokenService.validateToken(token);
      if (!validation.valid) {
        this.rejectUpgrade(socket, 401, validation.reason);
        return;
      }
      if (validation.payload.session_id !== sessionId) {
        this.rejectUpgrade(socket, 401, 'Token is not valid for this session');
        return;
      }

      const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
      if (!session) {
        this.rejectUpgrade(socket, 404, 'Session not found');
        return;
      }
      if (session.state === 'TERMINATED') {
        this.rejectUpgrade(socket, 409, 'Cannot open stream for TERMINATED session');
        return;
      }
      if (!session.pod_name) {
        this.rejectUpgrade(socket, 409, 'Session pod is not ready');
        return;
      }

      // Complete the WebSocket upgrade
      this.wss!.handleUpgrade(request, socket, head, (clientWs) => {
        this.handleConnection(clientWs, session);
      });
    } catch (error) {
      this.logger.error(`Unhandled cdp-ws proxy error: ${(error as Error).message}`);
      this.rejectUpgrade(socket, 502, 'Failed to initialize stream connection');
    }
  }

  private handleConnection(clientWs: WebSocket, session: SessionEntity): void {
    this.trackSocket(clientWs);

    const serviceName = `${session.pod_name}-cdp`;
    const backendHost = `${serviceName}.${this.cdpServiceDomain}`;
    const backendUrl = `ws://${backendHost}:${this.cdpPort}`;

    const backendWs = new WebSocket(backendUrl);
    this.trackSocket(backendWs);

    const pendingIds = new Set<number>();

    backendWs.on('error', (err) => {
      this.logger.warn(
        `CDP proxy backend error for session ${session.id} (${backendUrl}): ${err.message}`,
      );
      clientWs.close(1011, 'Backend connection error');
    });

    backendWs.on('close', () => {
      clientWs.close(1001, 'Backend disconnected');
    });

    clientWs.on('error', (err) => {
      this.logger.warn(`CDP proxy client error for session ${session.id}: ${err.message}`);
      backendWs.close();
    });

    clientWs.on('close', () => {
      backendWs.close();
    });

    // Client -> Backend (inbound filter)
    clientWs.on('message', (data: Buffer | string) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');

      // Frame size check
      if (Buffer.byteLength(raw, 'utf8') > CDP_LIMITS.MAX_FRAME_SIZE_BYTES) {
        clientWs.close(1009, 'Frame too large');
        return;
      }

      let msg: { id?: number; method?: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw);
      } catch {
        clientWs.close(1003, 'Invalid JSON');
        return;
      }

      // Reject Target.* domain (session targeting attack)
      if (typeof msg.method === 'string' && msg.method.startsWith('Target.')) {
        clientWs.close(1008, 'Target domain commands are not allowed');
        return;
      }

      // Command whitelist check
      if (!msg.method || !CDP_ALLOWED_COMMANDS.has(msg.method)) {
        clientWs.close(1008, `Command not allowed: ${msg.method || 'unknown'}`);
        return;
      }

      // Sanitize screencast params
      if (msg.method === 'Page.startScreencast' && msg.params) {
        msg.params = sanitizeScreencastParams(msg.params);
      }

      // Track pending request IDs
      if (typeof msg.id === 'number') {
        pendingIds.add(msg.id);
      }

      if (backendWs.readyState === WebSocket.OPEN) {
        backendWs.send(JSON.stringify(msg));
      }
    });

    // Backend -> Client (outbound filter)
    backendWs.on('message', (data: Buffer | string) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');

      let msg: { id?: number; method?: string };
      try {
        msg = JSON.parse(raw);
      } catch {
        return; // Drop unparseable frames
      }

      // Allow JSON-RPC responses matching pending request IDs
      if (typeof msg.id === 'number') {
        if (pendingIds.has(msg.id)) {
          pendingIds.delete(msg.id);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(raw);
          }
        }
        return;
      }

      // Allow whitelisted events only
      if (typeof msg.method === 'string' && CDP_ALLOWED_EVENTS.has(msg.method)) {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(raw);
        }
        return;
      }

      // Drop everything else
    });
  }

  private parseUrl(url?: string): URL | null {
    if (!url) {
      return null;
    }
    try {
      return new URL(url, 'http://localhost');
    } catch {
      return null;
    }
  }

  private rejectUpgrade(socket: Socket, statusCode: number, message: string): void {
    if (socket.destroyed) {
      return;
    }

    const statusText = this.toHttpStatusText(statusCode);
    const body = `${message}\n`;
    const response = [
      `HTTP/1.1 ${statusCode} ${statusText}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(body)}`,
      '',
      body,
    ].join('\r\n');

    socket.end(response);
  }

  private toHttpStatusText(statusCode: number): string {
    switch (statusCode) {
      case 400: return 'Bad Request';
      case 401: return 'Unauthorized';
      case 404: return 'Not Found';
      case 409: return 'Conflict';
      case 502: return 'Bad Gateway';
      default: return 'Error';
    }
  }

  private trackSocket(ws: WebSocket): void {
    this.trackedSockets.add(ws);
    ws.once('close', () => {
      this.trackedSockets.delete(ws);
    });
  }

  private resolveStreamToken(url: URL, request: IncomingMessage): string | null {
    const queryToken = url.searchParams.get('token');
    if (queryToken) {
      return queryToken;
    }

    const rawProtocols = request.headers['sec-websocket-protocol'];
    const protocolHeader = Array.isArray(rawProtocols) ? rawProtocols.join(',') : rawProtocols || '';
    if (!protocolHeader) {
      return null;
    }

    const protocols = protocolHeader
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    for (const protocol of protocols) {
      if (protocol.startsWith('token.')) {
        const token = protocol.slice('token.'.length).trim();
        if (token.length > 0) {
          return token;
        }
      }
    }

    return null;
  }
}
