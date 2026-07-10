import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus, BadRequestException, NotFoundException, ForbiddenException, InternalServerErrorException } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';
import { TabbyDomainException, BatonConflictException, NoHealthySessionException, CredentialDecryptException } from '../exceptions/domain.exceptions';
import * as Sentry from '@sentry/node';

jest.mock('@sentry/node', () => ({
  withScope: jest.fn((cb) => cb({
    setTag: jest.fn(),
    setExtra: jest.fn(),
  })),
  captureException: jest.fn(),
}));

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  const mockRequest = (overrides: Record<string, any> = {}) => ({
    method: 'GET',
    url: '/test',
    path: '/test',
    headers: { accept: 'application/json' },
    correlationId: 'test-corr-id',
    user: { tenant_id: 'tenant-1' },
    ...overrides,
  });

  const mockResponse = () => {
    const res: any = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
    };
    return res;
  };

  const mockHost = (req: any, res: any) => ({
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as any);

  beforeEach(async () => {
    filter = new GlobalExceptionFilter();
    jest.clearAllMocks();
  });

  it('returns { error: { code, message } } for NotFoundException', () => {
    const req = mockRequest();
    const res = mockResponse();
    const exception = new NotFoundException('App not found');

    filter.catch(exception, mockHost(req, res));

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'NOT_FOUND', message: 'App not found' },
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('returns { error: { code, message } } for ForbiddenException', () => {
    const req = mockRequest();
    const res = mockResponse();
    const exception = new ForbiddenException('Access denied');

    filter.catch(exception, mockHost(req, res));

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'FORBIDDEN', message: 'Access denied' },
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('handles validation errors with array messages', () => {
    const req = mockRequest();
    const res = mockResponse();
    const exception = new BadRequestException({
      message: ['email must be an email', 'password should not be empty'],
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, mockHost(req, res));

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'email must be an email',
        details: {
          validation_errors: ['email must be an email', 'password should not be empty'],
        },
      },
    });
  });

  it('captures 5xx to Sentry with correlation ID and tenant', () => {
    const req = mockRequest();
    const res = mockResponse();
    const exception = new InternalServerErrorException('Something broke');

    filter.catch(exception, mockHost(req, res));

    expect(res.status).toHaveBeenCalledWith(500);
    expect(Sentry.withScope).toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();

    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.request_id).toBe('test-corr-id');
  });

  it('does not include request_id in 4xx responses', () => {
    const req = mockRequest();
    const res = mockResponse();
    const exception = new NotFoundException('Not found');

    filter.catch(exception, mockHost(req, res));

    const body = res.json.mock.calls[0][0];
    expect(body.request_id).toBeUndefined();
  });

  it('captures non-HttpException as 500', () => {
    const req = mockRequest();
    const res = mockResponse();
    const exception = new Error('Unexpected crash');

    filter.catch(exception, mockHost(req, res));

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
        request_id: 'test-corr-id',
      }),
    );
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  it('handles TabbyDomainException with domainCode', () => {
    const req = mockRequest();
    const res = mockResponse();
    const exception = new BatonConflictException('Baton is held by another user', {
      baton_state: 'HUMAN_CONTROL',
    });

    filter.catch(exception, mockHost(req, res));

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'BATON_CONFLICT',
        message: 'Baton is held by another user',
        details: { baton_state: 'HUMAN_CONTROL' },
      },
    });
  });

  it('handles NoHealthySessionException', () => {
    const req = mockRequest();
    const res = mockResponse();
    const exception = new NoHealthySessionException('No healthy session available', {
      profile_id: 'prof-1',
    });

    filter.catch(exception, mockHost(req, res));

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        code: 'NO_HEALTHY_SESSION',
        message: 'No healthy session available',
        details: { profile_id: 'prof-1' },
      },
    });
  });

  it('captures CredentialDecryptException to Sentry (5xx)', () => {
    const req = mockRequest();
    const res = mockResponse();
    const exception = new CredentialDecryptException({ artifact_id: 'art-1' });

    filter.catch(exception, mockHost(req, res));

    expect(res.status).toHaveBeenCalledWith(500);
    expect(Sentry.captureException).toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('CREDENTIAL_DECRYPT_FAILED');
    expect(body.request_id).toBe('test-corr-id');
  });

  it('does not double-send if headers already sent', () => {
    const req = mockRequest();
    const res = mockResponse();
    res.headersSent = true;
    const exception = new NotFoundException('Not found');

    filter.catch(exception, mockHost(req, res));

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('renders HTML for streaming routes when Accept is text/html', () => {
    const req = mockRequest({
      path: '/vnc/some-session-id',
      headers: { accept: 'text/html' },
    });
    const res = mockResponse();
    const exception = new ForbiddenException('Access denied');

    filter.catch(exception, mockHost(req, res));

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalled();
    const html = res.send.mock.calls[0][0];
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Access denied');
    expect(res.json).not.toHaveBeenCalled();
  });

  it('returns JSON for streaming routes when Accept is application/json', () => {
    const req = mockRequest({
      path: '/vnc/some-session-id',
      headers: { accept: 'application/json' },
    });
    const res = mockResponse();
    const exception = new NotFoundException('Session not found');

    filter.catch(exception, mockHost(req, res));

    expect(res.json).toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('preserves extra fields from ConflictException object body', () => {
    const req = mockRequest();
    const res = mockResponse();
    const exception = new HttpException(
      { message: 'HITL pause active', retry_after_seconds: 180 },
      HttpStatus.CONFLICT,
    );

    filter.catch(exception, mockHost(req, res));

    expect(res.status).toHaveBeenCalledWith(409);
    const body = res.json.mock.calls[0][0];
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toBe('HITL pause active');
    expect(body.error.details).toEqual({ retry_after_seconds: 180 });
  });
});
