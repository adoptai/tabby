import { Injectable, Logger } from '@nestjs/common';
import {
  BrowserStreamProvider,
  StreamHandle,
  InputEvent,
  StreamMetrics,
  PORTS,
} from '@browser-hitl/shared';
import { StreamTokenService } from './stream-token.service';

/**
 * V1 BrowserStreamProvider backed by noVNC / websockify.
 *
 * Each worker pod runs a noVNC sidecar on port 6080. The controller
 * stores the pod name in the sessions table so we can construct the
 * correct URL.  In this first iteration input delivery is handled
 * natively by the VNC protocol (sendInput is therefore a no-op).
 */
@Injectable()
export class VncStreamProvider implements BrowserStreamProvider {
  private readonly logger = new Logger(VncStreamProvider.name);

  /**
   * In-memory map tracking which sessions are actively streaming.
   * Key: sessionId, Value: StreamHandle with start timestamp.
   *
   * For a production HA deployment this should be replaced with Redis,
   * but for V1 (single API replica) an in-process Map is fine.
   */
  private readonly activeStreams = new Map<string, StreamHandle>();

  constructor(private readonly streamTokenService: StreamTokenService) {}

  // ----------------------------------------------------------------
  // BrowserStreamProvider implementation
  // ----------------------------------------------------------------

  async startStream(sessionId: string): Promise<StreamHandle> {
    const handle: StreamHandle = {
      sessionId,
      startedAt: new Date().toISOString(),
    };

    this.activeStreams.set(sessionId, handle);
    this.logger.log(`Stream started for session ${sessionId}`);

    return handle;
  }

  async stopStream(sessionId: string): Promise<void> {
    this.activeStreams.delete(sessionId);
    this.logger.log(`Stream stopped for session ${sessionId}`);
  }

  /**
   * Generate a signed, short-lived URL for the noVNC viewer.
   *
   * The URL points at the API gateway which will proxy through to the
   * correct worker pod's noVNC sidecar (port 6080).
   */
  async getStreamUrl(
    sessionId: string,
    userId: string,
  ): Promise<{ url: string; expires_at: string }> {
    const token = await this.streamTokenService.generateToken(sessionId, userId);
    const baseUrl = this.resolvePublicBaseUrl();
    const url = `${baseUrl}/vnc/${sessionId}#token=${encodeURIComponent(token)}`;

    const expiresAt = new Date(Date.now() + 600 * 1000); // 10 minutes

    this.logger.log(`Stream URL generated for session ${sessionId}, user ${userId}`);

    return {
      url,
      expires_at: expiresAt.toISOString(),
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

  /**
   * Send a user-input event to the browser session.
   *
   * V1 no-op: noVNC handles keyboard/mouse input natively through
   * the VNC protocol over the WebSocket connection.
   */
  async sendInput(sessionId: string, _event: InputEvent): Promise<void> {
    this.logger.debug(
      `sendInput called for session ${sessionId} -- no-op in VNC mode`,
    );
    // Intentional no-op for V1
  }

  async isStreaming(sessionId: string): Promise<boolean> {
    return this.activeStreams.has(sessionId);
  }

  /**
   * Return basic stream metrics.
   *
   * V1 stub: actual FPS / latency metrics require integration with
   * the noVNC sidecar's stats endpoint, which will come in a later
   * phase.
   */
  async getStreamMetrics(sessionId: string): Promise<StreamMetrics> {
    const connected = this.activeStreams.has(sessionId);
    return {
      fps: connected ? 30 : 0,
      latencyMs: connected ? 0 : -1,
      connected,
    };
  }
}
