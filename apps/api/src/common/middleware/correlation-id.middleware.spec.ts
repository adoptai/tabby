import { CorrelationIdMiddleware } from './correlation-id.middleware';

describe('CorrelationIdMiddleware', () => {
  let middleware: CorrelationIdMiddleware;

  beforeEach(() => {
    middleware = new CorrelationIdMiddleware();
  });

  it('uses incoming X-Request-ID header', () => {
    const req: any = { headers: { 'x-request-id': 'incoming-123' } };
    const res: any = { setHeader: jest.fn() };
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(req.correlationId).toBe('incoming-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', 'incoming-123');
    expect(next).toHaveBeenCalled();
  });

  it('generates UUID when no X-Request-ID header', () => {
    const req: any = { headers: {} };
    const res: any = { setHeader: jest.fn() };
    const next = jest.fn();

    middleware.use(req, res, next);

    expect(req.correlationId).toBeDefined();
    expect(req.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.correlationId);
    expect(next).toHaveBeenCalled();
  });
});
