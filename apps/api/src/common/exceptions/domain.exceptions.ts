import { HttpException, HttpStatus } from '@nestjs/common';

export class TabbyDomainException extends HttpException {
  public readonly domainCode: string;

  constructor(
    domainCode: string,
    message: string,
    statusCode: number,
    details?: Record<string, unknown>,
  ) {
    super({ message, code: domainCode, ...(details ? { details } : {}) }, statusCode);
    this.domainCode = domainCode;
  }
}

export class BatonConflictException extends TabbyDomainException {
  constructor(message: string, details?: Record<string, unknown>) {
    super('BATON_CONFLICT', message, HttpStatus.CONFLICT, details);
  }
}

export class SessionStateException extends TabbyDomainException {
  constructor(message: string, currentState: string, expectedStates: string[]) {
    super('SESSION_STATE_INVALID', message, HttpStatus.BAD_REQUEST, {
      current_state: currentState,
      expected_states: expectedStates,
    });
  }
}

export class NoHealthySessionException extends TabbyDomainException {
  constructor(message: string, details?: Record<string, unknown>) {
    super('NO_HEALTHY_SESSION', message, HttpStatus.NOT_FOUND, details);
  }
}

export class ProfileNotFoundException extends TabbyDomainException {
  constructor(message: string, details?: Record<string, unknown>) {
    super('PROFILE_NOT_FOUND', message, HttpStatus.NOT_FOUND, details);
  }
}

export class CredentialDecryptException extends TabbyDomainException {
  constructor(details?: Record<string, unknown>) {
    super(
      'CREDENTIAL_DECRYPT_FAILED',
      'Failed to decrypt credential bundle',
      HttpStatus.INTERNAL_SERVER_ERROR,
      details,
    );
  }
}
