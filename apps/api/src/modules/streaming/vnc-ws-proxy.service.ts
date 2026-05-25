import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { REDIS_TTL } from '@browser-hitl/shared';
import { HttpAdapterHost } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { IncomingMessage, Server } from 'http';
import { connect as connectSocket, Socket } from 'net';
import { URL } from 'url';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { SessionEntity } from '../../entities';
import { StreamTokenService } from './stream-token.service';
import { parseCookie } from '../../common/utils/cookie';

@Injectable()
export class VncWsProxyService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VncWsProxyService.name);
  private readonly namespace = process.env.WORKER_NAMESPACE || 'browser-hitl';
  private readonly novncPort = parseInt(process.env.NOVNC_PORT || '6080', 10);
  private readonly novncPath = process.env.NOVNC_UPSTREAM_PATH || '/websockify';
  private readonly novncServiceDomain =
    process.env.NOVNC_SERVICE_DOMAIN || `${this.namespace}.svc.cluster.local`;
  private readonly trackedSockets = new Set<Socket>();
  private httpServer: Server | null = null;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly streamTokenService: StreamTokenService,
    private readonly jwtService: JwtService,
    @InjectRepository(SessionEntity)
    private readonly sessionRepo: Repository<SessionEntity>,
  ) {}

  onModuleInit(): void {
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer() as Server;
    this.httpServer = httpServer;
    httpServer.on('upgrade', this.handleUpgrade);
    this.logger.log('Attached HTTP upgrade handler for /vnc-ws proxy');
  }

  async onModuleDestroy(): Promise<void> {
    for (const socket of this.trackedSockets) {
      socket.destroy();
    }
    this.trackedSockets.clear();
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
  ): void => {
    const url = this.parseUrl(request.url);
    if (!url || url.pathname !== '/vnc-ws') {
      return;
    }

    void this.proxyUpgrade(request, clientSocket, head, url);
  };

  private async proxyUpgrade(
    request: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
    url: URL,
  ): Promise<void> {
    this.trackSocket(clientSocket);

    try {
      const token = this.resolveStreamToken(url, request);
      const sessionId = url.searchParams.get('session_id');
      if (!token || !sessionId) {
        this.rejectUpgrade(clientSocket, 400, 'Missing token or session_id');
        return;
      }

      const validation = await this.streamTokenService.validateToken(token);
      if (!validation.valid) {
        this.rejectUpgrade(clientSocket, 401, validation.reason);
        return;
      }
      if (validation.payload.session_id !== sessionId) {
        this.rejectUpgrade(clientSocket, 401, 'Token is not valid for this session');
        return;
      }

      if (await this.streamTokenService.isStreamRevoked(sessionId)) {
        this.rejectUpgrade(clientSocket, 401, 'Stream access has been revoked');
        return;
      }

      const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
      if (!session) {
        this.rejectUpgrade(clientSocket, 404, 'Session not found');
        return;
      }
      if (session.state === 'TERMINATED') {
        this.rejectUpgrade(clientSocket, 409, 'Cannot open stream for TERMINATED session');
        return;
      }
      if (!session.pod_name) {
        this.rejectUpgrade(clientSocket, 409, 'Session pod is not ready');
        return;
      }

      // C-2: The tabby_vnc cookie is MANDATORY when the session has an owner_user_id.
      // Stream token alone is not sufficient — it can appear in logs, Referer headers,
      // or browser history. The cookie is HttpOnly and set only after OAuth/email-gate.
      // Sessions without owner_user_id are unaffected by this block.
      if (session.owner_user_id) {
        const cookieHeader = Array.isArray(request.headers.cookie)
          ? request.headers.cookie.join('; ')
          : request.headers.cookie || '';
        const vncCookie = parseCookie(cookieHeader, 'tabby_vnc');
        if (!vncCookie) {
          this.rejectUpgrade(clientSocket, 401, 'VNC access cookie required');
          return;
        }
        try {
          const vncPayload = this.jwtService.verify<{ owner_user_id: string; type: string }>(vncCookie);
          if (
            vncPayload.type !== 'vnc_access'
            || vncPayload.owner_user_id !== session.owner_user_id
          ) {
            this.rejectUpgrade(clientSocket, 403, 'VNC cookie owner mismatch');
            return;
          }
        } catch {
          this.rejectUpgrade(clientSocket, 401, 'Invalid VNC access cookie');
          return;
        }
      }

      const serviceName = `${session.pod_name}-novnc`;
      const backendHost = `${serviceName}.${this.novncServiceDomain}`;
      const backendSocket = connectSocket(this.novncPort, backendHost);
      this.trackSocket(backendSocket);

      let backendConnected = false;
      backendSocket.once('connect', () => {
        backendConnected = true;
        backendSocket.setTimeout(0);

        const upgradeRequest = this.buildUpstreamUpgradeRequest(request, backendHost);
        backendSocket.write(upgradeRequest);
        if (head.length > 0) {
          backendSocket.write(head);
        }

        clientSocket.pipe(backendSocket);
        backendSocket.pipe(clientSocket);

        const ttlMs = REDIS_TTL.STREAM_TOKEN_SECONDS * 1000;
        const expiryTimer = setTimeout(() => {
          this.logger.log(`Stream token expired for session ${sessionId}, closing connection`);
          clientSocket.destroy();
          backendSocket.destroy();
        }, ttlMs);
        clientSocket.once('close', () => clearTimeout(expiryTimer));
        backendSocket.once('close', () => clearTimeout(expiryTimer));

        const revokeInterval = setInterval(async () => {
          if (await this.streamTokenService.isStreamRevoked(sessionId)) {
            this.logger.log(`Stream access revoked for session ${sessionId}, closing connection`);
            clearInterval(revokeInterval);
            clientSocket.destroy();
            backendSocket.destroy();
          }
        }, 30_000);
        clientSocket.once('close', () => clearInterval(revokeInterval));
        backendSocket.once('close', () => clearInterval(revokeInterval));
      });

      backendSocket.setTimeout(10000);
      backendSocket.once('timeout', () => {
        if (!backendConnected) {
          this.rejectUpgrade(clientSocket, 502, 'Timed out connecting to stream backend');
        } else {
          clientSocket.destroy();
        }
        backendSocket.destroy();
      });

      backendSocket.once('error', (error) => {
        if (!backendConnected) {
          this.logger.warn(
            `Failed to connect noVNC upstream for session ${sessionId} (${backendHost}:${this.novncPort}): ${error.message}`,
          );
          this.rejectUpgrade(clientSocket, 502, 'Unable to connect to stream backend');
          return;
        }
        clientSocket.destroy();
      });

      clientSocket.once('error', () => {
        backendSocket.destroy();
      });
    } catch (error) {
      this.logger.error(`Unhandled vnc-ws proxy error: ${(error as Error).message}`);
      this.rejectUpgrade(clientSocket, 502, 'Failed to initialize stream connection');
    }
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

  private buildUpstreamUpgradeRequest(
    request: IncomingMessage,
    backendHost: string,
  ): string {
    const lines: string[] = [`GET ${this.novncPath} HTTP/1.1`];
    lines.push(`Host: ${backendHost}:${this.novncPort}`);

    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const headerName = request.rawHeaders[i];
      const headerValue = request.rawHeaders[i + 1];

      if (!headerName || typeof headerValue === 'undefined') {
        continue;
      }

      const lower = headerName.toLowerCase();
      if (lower === 'host' || lower === 'cookie' || lower === 'authorization') {
        continue;
      }

      lines.push(`${headerName}: ${headerValue}`);
    }

    lines.push('', '');
    return lines.join('\r\n');
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
      case 400:
        return 'Bad Request';
      case 401:
        return 'Unauthorized';
      case 404:
        return 'Not Found';
      case 409:
        return 'Conflict';
      case 502:
        return 'Bad Gateway';
      default:
        return 'Error';
    }
  }

  private trackSocket(socket: Socket): void {
    this.trackedSockets.add(socket);
    socket.once('close', () => {
      this.trackedSockets.delete(socket);
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
