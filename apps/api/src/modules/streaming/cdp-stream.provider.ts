import { Injectable, Logger } from '@nestjs/common';
import {
  BrowserStreamProvider,
  StreamHandle,
  InputEvent,
  StreamMetrics,
} from '@browser-hitl/shared';
import { StreamTokenService } from './stream-token.service';

/**
 * CDP BrowserStreamProvider backed by Chrome DevTools Protocol screencast.
 *
 * Each worker pod runs a CDP relay server on port 9223. The API proxies
 * WebSocket connections to the relay via CdpWsProxyService.
 * Input delivery uses Input.dispatch*Event CDP commands via the same
 * WebSocket connection (handled client-side in the viewer).
 */
@Injectable()
export class CdpStreamProvider implements BrowserStreamProvider {
  private readonly logger = new Logger(CdpStreamProvider.name);

  /**
   * In-memory map tracking which sessions are actively streaming.
   * For HA deployment this should move to Redis.
   */
  private readonly activeStreams = new Map<string, StreamHandle>();

  constructor(private readonly streamTokenService: StreamTokenService) {}

  async startStream(sessionId: string): Promise<StreamHandle> {
    const handle: StreamHandle = {
      sessionId,
      startedAt: new Date().toISOString(),
    };

    this.activeStreams.set(sessionId, handle);
    this.logger.log(`CDP stream started for session ${sessionId}`);

    return handle;
  }

  async stopStream(sessionId: string): Promise<void> {
    this.activeStreams.delete(sessionId);
    this.logger.log(`CDP stream stopped for session ${sessionId}`);
  }

  async getStreamUrl(
    sessionId: string,
    userId: string,
  ): Promise<{ url: string; expires_at: string }> {
    const token = await this.streamTokenService.generateToken(sessionId, userId);
    const baseUrl = this.resolvePublicBaseUrl();
    const url = `${baseUrl}/cdp/${sessionId}#token=${encodeURIComponent(token)}`;

    const expiresAt = new Date(Date.now() + 600 * 1000); // 10 minutes

    this.logger.log(`CDP stream URL generated for session ${sessionId}, user ${userId}`);

    return {
      url,
      expires_at: expiresAt.toISOString(),
    };
  }

  /**
   * Input delivery is handled client-side via CDP Input.dispatch*Event
   * commands sent through the WebSocket connection, so this is a no-op.
   */
  async sendInput(sessionId: string, _event: InputEvent): Promise<void> {
    this.logger.debug(
      `sendInput called for session ${sessionId} -- no-op in CDP mode (handled client-side)`,
    );
  }

  async isStreaming(sessionId: string): Promise<boolean> {
    return this.activeStreams.has(sessionId);
  }

  async getStreamMetrics(sessionId: string): Promise<StreamMetrics> {
    const connected = this.activeStreams.has(sessionId);
    return {
      fps: connected ? 15 : 0, // CDP screencast typically runs at 10-15 fps
      latencyMs: connected ? 0 : -1,
      connected,
    };
  }

  private resolvePublicBaseUrl(): string {
    const configuredBase = (process.env.PUBLIC_BASE_URL || process.env.EXTERNAL_BASE_URL || '')
      .trim()
      .replace(/\/+$/, '');
    if (configuredBase.length > 0) {
      try {
        const parsed = new URL(configuredBase);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new Error('PUBLIC_BASE_URL must be http(s)');
        }
        return `${parsed.protocol}//${parsed.host}`;
      } catch (error) {
        this.logger.warn(`Invalid PUBLIC_BASE_URL "${configuredBase}", falling back: ${error}`);
      }
    }

    const host = (process.env.STREAM_HOST || process.env.API_HOST || 'localhost').trim();
    const protocol = (process.env.STREAM_PROTOCOL || '').trim()
      || (process.env.NODE_ENV === 'production' ? 'https' : 'http');
    return `${protocol}://${host}`;
  }
}
