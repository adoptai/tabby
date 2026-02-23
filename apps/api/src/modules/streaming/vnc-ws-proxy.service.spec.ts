import { VncWsProxyService } from './vnc-ws-proxy.service';

describe('VncWsProxyService token resolution', () => {
  function makeService(): VncWsProxyService {
    return new VncWsProxyService(
      { httpAdapter: { getHttpServer: () => ({ on: jest.fn(), off: jest.fn() }) } } as any,
      {} as any,
      {} as any,
    );
  }

  it('uses query token when present', () => {
    const service = makeService();
    const token = (service as any).resolveStreamToken(
      new URL('http://localhost/vnc-ws?session_id=s1&token=query-token'),
      { headers: {} },
    );
    expect(token).toBe('query-token');
  });

  it('falls back to sec-websocket-protocol token', () => {
    const service = makeService();
    const token = (service as any).resolveStreamToken(
      new URL('http://localhost/vnc-ws?session_id=s1'),
      { headers: { 'sec-websocket-protocol': 'binary, token.jwt-token-value' } },
    );
    expect(token).toBe('jwt-token-value');
  });

  it('returns null when no token exists', () => {
    const service = makeService();
    const token = (service as any).resolveStreamToken(
      new URL('http://localhost/vnc-ws?session_id=s1'),
      { headers: { 'sec-websocket-protocol': 'binary, base64' } },
    );
    expect(token).toBeNull();
  });
});
