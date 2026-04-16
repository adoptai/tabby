/**
 * Credential Response Envelope & Volatility Model (ADR-013).
 *
 * Defines the contract for credential delivery from the platform
 * to consuming agents. Each credential field carries a volatility
 * classification that informs caching and refresh strategies.
 */

import { CredentialFreshness, CredentialVolatility } from './enums';

// ============================================================
// Individual Credential Types
// ============================================================

export interface CookieCredential {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: string;
  volatility: CredentialVolatility;
}

export interface HeaderCredential {
  name: string;
  value: string;
  volatility: CredentialVolatility;
}

export interface CsrfCredential {
  token: string;
  header_name: string;
  volatility: CredentialVolatility;
}

export interface CustomCredential {
  key: string;
  value: string;
  volatility: CredentialVolatility;
}

// ============================================================
// Credential Set — grouped credentials for a session
// ============================================================

export interface CredentialSet {
  cookies: CookieCredential[];
  headers: HeaderCredential[];
  csrf?: CsrfCredential;
  custom?: CustomCredential[];
  local_storage?: Record<string, string>;
  session_storage?: Record<string, string>;
}

// ============================================================
// Usage & Metadata
// ============================================================

export interface CredentialUsage {
  ttl_seconds: number;
  refresh_before_seconds: number;
  volatile_fields: string[];
}

export interface CredentialMetadata {
  extracted_at: string;
  extraction_duration_ms: number;
  profile_version: string;
  worker_id?: string;
}

// ============================================================
// Response Envelope
// ============================================================

export interface CredentialResponseEnvelope {
  freshness: CredentialFreshness;
  request_id: string;
  profile_id: string;
  session_id: string;
  credentials: CredentialSet;
  usage: CredentialUsage;
  metadata: CredentialMetadata;
}
