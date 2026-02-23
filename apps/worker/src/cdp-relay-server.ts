import { WebSocketServer, WebSocket } from 'ws';
import {
  CDP_ALLOWED_COMMANDS,
  CDP_ALLOWED_EVENTS,
  CDP_LIMITS,
  CDP_PORTS,
  sanitizeScreencastParams,
} from '@browser-hitl/shared';

/**
 * CDP Relay Server — Worker-side WebSocket relay between API and Chromium's CDP.
 *
 * Security model:
 * - Pins to a single page session fetched from Chromium's /json endpoint
 * - Inbound: Only forwards commands in CDP_ALLOWED_COMMANDS
 * - Outbound: Only forwards events in CDP_ALLOWED_EVENTS + JSON-RPC responses
 * - Validates JSON parse of every frame; rejects frames > 64KB
 * - Sanitizes Page.startScreencast params to enforce limits
 * - Rejects Target.* domain commands (session targeting)
 */
export class CdpRelayServer {
  private wss: WebSocketServer | null = null;
  private pageWsUrl: string | null = null;

  /**
   * Fetch the first page's WebSocket debugger URL from Chromium's /json endpoint.
   */
  async resolvePageTarget(): Promise<string> {
    const jsonUrl = `http://127.0.0.1:${CDP_PORTS.CDP_INTERNAL}/json`;
    const maxAttempts = 30;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(jsonUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const targets = await response.json() as Array<{ type: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) {
          this.pageWsUrl = page.webSocketDebuggerUrl;
          console.log(`CDP relay: resolved page target ${this.pageWsUrl}`);
          return this.pageWsUrl;
        }
        throw new Error('No page target found');
      } catch (err) {
        if (attempt === maxAttempts) {
          throw new Error(`Failed to resolve CDP page target after ${maxAttempts} attempts: ${err}`);
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Start the relay WebSocket server on the given port.
   */
  async start(port: number = CDP_PORTS.CDP_RELAY): Promise<void> {
    await this.resolvePageTarget();

    this.wss = new WebSocketServer({ host: '0.0.0.0', port });
    console.log(`CDP relay server listening on 0.0.0.0:${port}`);

    this.wss.on('connection', (clientWs: WebSocket) => {
      this.handleClient(clientWs);
    });
  }

  stop(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  private handleClient(clientWs: WebSocket): void {
    if (!this.pageWsUrl) {
      clientWs.close(1011, 'No CDP page target available');
      return;
    }

    const chromiumWs = new WebSocket(this.pageWsUrl);
    const pendingIds = new Set<number>();
    let pageEnabled = false;

    chromiumWs.on('open', () => {
      // Enable Page domain (required for screencast)
      if (!pageEnabled) {
        const enableMsg = JSON.stringify({ id: -1, method: 'Page.enable', params: {} });
        chromiumWs.send(enableMsg);
        pageEnabled = true;
      }
    });

    chromiumWs.on('error', (err) => {
      console.error(`CDP relay: chromium WS error: ${err.message}`);
      clientWs.close(1011, 'Backend connection error');
    });

    chromiumWs.on('close', () => {
      clientWs.close(1001, 'Backend disconnected');
    });

    clientWs.on('error', (err) => {
      console.error(`CDP relay: client WS error: ${err.message}`);
      chromiumWs.close();
    });

    clientWs.on('close', () => {
      chromiumWs.close();
    });

    // Client -> Chromium (inbound filter)
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

      // Track pending request IDs for response matching
      if (typeof msg.id === 'number') {
        pendingIds.add(msg.id);
      }

      if (chromiumWs.readyState === WebSocket.OPEN) {
        chromiumWs.send(JSON.stringify(msg));
      }
    });

    // Chromium -> Client (outbound filter)
    chromiumWs.on('message', (data: Buffer | string) => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');

      let msg: { id?: number; method?: string };
      try {
        msg = JSON.parse(raw);
      } catch {
        return; // Drop unparseable frames silently
      }

      // Allow JSON-RPC responses matching pending request IDs
      if (typeof msg.id === 'number') {
        if (msg.id === -1) {
          // Internal Page.enable response — don't forward
          return;
        }
        if (pendingIds.has(msg.id)) {
          pendingIds.delete(msg.id);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(raw);
          }
          return;
        }
        // Unknown response ID — drop
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
}
