import { WsAdapter } from '@nestjs/platform-ws';
import * as http from 'http';

/**
 * Keep Nest ws gateway routing for known paths (/events) but do not
 * destroy unknown upgrade requests. This allows the VNC proxy to own
 * /vnc-ws upgrades on the same HTTP server.
 */
export class PermissiveWsAdapter extends WsAdapter {
  protected ensureHttpServerExists(
    port: number,
    httpServer: http.Server = http.createServer(),
  ): http.Server {
    if (this.httpServersRegistry.has(port)) {
      return this.httpServersRegistry.get(port);
    }

    this.httpServersRegistry.set(port, httpServer);
    httpServer.on('upgrade', (request, socket, head) => {
      try {
        const baseUrl = `ws://${request.headers.host || 'localhost'}/`;
        const pathname = new URL(request.url || '/', baseUrl).pathname;
        const wsServersCollection = this.wsServersRegistry.get(port) || [];

        for (const wsServer of wsServersCollection) {
          if (pathname !== wsServer.path) {
            continue;
          }

          wsServer.handleUpgrade(request, socket, head, (ws: any) => {
            wsServer.emit('connection', ws, request);
          });
          return;
        }

        // Unknown upgrade path: leave socket untouched so other listeners can handle it.
      } catch (err) {
        socket.end(`HTTP/1.1 400\r\n${(err as Error).message}`);
      }
    });

    return httpServer;
  }
}
