import { StreamResponse, ReleaseResponse, AcknowledgeResponse, InputSubmitResponse } from '@browser-hitl/shared';

/**
 * HTTP client for calling the HITL API from the Slack bot.
 * Uses the service-to-service token for authentication.
 * Per spec section 12.1: bots call API endpoints to relay human actions.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly staticServiceToken: string;
  private readonly serviceClientId: string;
  private readonly serviceClientSecret: string;
  private readonly tokenCache = new Map<string, { token: string; expiresAtMs: number }>();

  constructor(baseUrl?: string, serviceToken?: string) {
    this.baseUrl = baseUrl || process.env.API_BASE_URL || 'http://localhost:8000';
    this.staticServiceToken = serviceToken || process.env.API_SERVICE_TOKEN || '';
    this.serviceClientId = process.env.SERVICE_AUTH_CLIENT_ID || '';
    this.serviceClientSecret = process.env.SERVICE_AUTH_CLIENT_SECRET || '';
  }

  /**
   * Request a stream URL for a session.
   * POST /sessions/{id}/stream
   */
  async getStreamUrl(sessionId: string, tenantId: string, token?: string): Promise<StreamResponse> {
    const authToken = token || await this.getAuthToken(tenantId);
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to get stream URL (${response.status}): ${body}`);
    }

    return response.json() as Promise<StreamResponse>;
  }

  /**
   * Submit a generic human input value for a session.
   * POST /sessions/{id}/input
   */
  async submitInput(
    sessionId: string,
    inputType: string,
    value: string,
    stepIndex: number,
    tenantId: string,
    token?: string,
  ): Promise<InputSubmitResponse> {
    const authToken = token || await this.getAuthToken(tenantId);
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/input`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ input_type: inputType, value, step_index: stepIndex }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to submit input (${response.status}): ${body}`);
    }

    return response.json() as Promise<InputSubmitResponse>;
  }

  /**
   * Release human control of a session back to automation.
   * POST /sessions/{id}/release
   */
  async releaseControl(sessionId: string, tenantId: string, token?: string): Promise<ReleaseResponse> {
    const authToken = token || await this.getAuthToken(tenantId);
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/release`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to release control (${response.status}): ${body}`);
    }

    return response.json() as Promise<ReleaseResponse>;
  }

  /**
   * Acknowledge a session intervention with an optional note.
   * POST /sessions/{id}/acknowledge
   */
  async acknowledgeSession(
    sessionId: string,
    note: string,
    tenantId: string,
    token?: string,
  ): Promise<AcknowledgeResponse> {
    const authToken = token || await this.getAuthToken(tenantId);
    const response = await fetch(`${this.baseUrl}/sessions/${sessionId}/acknowledge`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify({ note }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to acknowledge session (${response.status}): ${body}`);
    }

    return response.json() as Promise<AcknowledgeResponse>;
  }

  private async getAuthToken(tenantId: string): Promise<string> {
    if (this.staticServiceToken) {
      return this.staticServiceToken;
    }

    if (!this.serviceClientId || !this.serviceClientSecret) {
      throw new Error(
        'Bot authentication is not configured. Set SERVICE_AUTH_CLIENT_ID and SERVICE_AUTH_CLIENT_SECRET.',
      );
    }

    const cached = this.tokenCache.get(tenantId);
    if (cached && cached.expiresAtMs > Date.now() + 30000) {
      return cached.token;
    }

    const response = await fetch(`${this.baseUrl}/auth/service-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.serviceClientId,
        client_secret: this.serviceClientSecret,
        tenant_id: tenantId,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to get service token (${response.status}): ${body}`);
    }

    const body = await response.json() as { token: string; expires_at: string };
    const expiresAtMs = Number.isNaN(Date.parse(body.expires_at))
      ? Date.now() + (55 * 60 * 1000)
      : Date.parse(body.expires_at);

    this.tokenCache.set(tenantId, { token: body.token, expiresAtMs });
    return body.token;
  }
}
