import { Pool, PoolClient } from 'pg';
import { requireEnv } from '@browser-hitl/shared';

/**
 * Session Database Access for Worker.
 * Worker connects with the dedicated 'worker' database role.
 * Worker writes: health_result_type, last_health_check, last_login_at,
 *                artifacts_last_exported_at
 * Worker MUST NOT write sessions.state (controller only).
 * Per spec section 9.6.
 */
export class SessionDb {
  private pool: Pool | null = null;
  private readonly sessionId: string;

  constructor() {
    this.sessionId = process.env.SESSION_ID || '';
  }

  async connect(): Promise<void> {
    this.pool = new Pool({
      connectionString: requireEnv('DATABASE_URL', {
        testDefault: 'postgresql://postgres:postgres@localhost:5432/browser_hitl',
      }),
    });
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  async updateHealthResult(sessionId: string, result: string): Promise<void> {
    if (!this.pool) return;
    await this.withSession(async (client) => {
      await client.query(
        `UPDATE sessions SET health_result_type = $1, last_health_check = now() WHERE id = $2`,
        [result, sessionId],
      );
    });
  }

  async updateLastLoginAt(sessionId: string): Promise<void> {
    if (!this.pool) return;
    await this.withSession(async (client) => {
      await client.query(
        `UPDATE sessions SET last_login_at = now() WHERE id = $1`,
        [sessionId],
      );
    });
  }

  async updateLastExportedAt(sessionId: string): Promise<void> {
    if (!this.pool) return;
    await this.withSession(async (client) => {
      await client.query(
        `UPDATE sessions SET artifacts_last_exported_at = now() WHERE id = $1`,
        [sessionId],
      );
    });
  }

  async getLastExportedAt(sessionId: string): Promise<string | null> {
    if (!this.pool) return null;
    return this.withSession(async (client) => {
      const result = await client.query(
        `SELECT artifacts_last_exported_at FROM sessions WHERE id = $1`,
        [sessionId],
      );
      return result.rows[0]?.artifacts_last_exported_at || null;
    });
  }

  async loadAppConfig(appId: string): Promise<any> {
    if (!this.pool) return null;
    return this.withSession(async (client) => {
      // Worker needs to read application config but via a direct query
      // (RLS doesn't restrict SELECT on applications for the worker if using a different approach)
      const result = await client.query(
        `SELECT * FROM applications WHERE id = $1`,
        [appId],
      );
      return result.rows[0] || null;
    });
  }

  async writePendingInputRequest(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    if (!this.pool) {
      console.warn('[SessionDb] writePendingInputRequest: pool not connected');
      return;
    }
    const json = JSON.stringify(metadata);
    console.log(`[SessionDb] writePendingInputRequest: sessionId=${sessionId}, payload=${json}`);
    await this.withSession(async (client) => {
      const result = await client.query(
        `UPDATE sessions SET pending_input_request = $1 WHERE id = $2`,
        [json, sessionId],
      );
      console.log(`[SessionDb] writePendingInputRequest: rowCount=${result.rowCount}`);
    });
  }

  async loadLatestBrowserState(
    appId: string,
    tenantId: string,
    ownerUserId: string | null,
  ): Promise<{
    encrypted_payload_ref: string;
    nonce: Buffer;
    key_version: string;
    expires_at: string;
  } | null> {
    if (!this.pool) return null;
    return this.withSession(async (client) => {
      const result = await client.query(
        `SELECT encrypted_payload_ref, nonce, key_version, expires_at
         FROM browser_state_snapshots
         WHERE app_id = $1 AND tenant_id = $2
           AND (($3::varchar IS NULL AND owner_user_id IS NULL) OR owner_user_id = $3)
           AND expires_at > now()
         ORDER BY saved_at DESC LIMIT 1`,
        [appId, tenantId, ownerUserId],
      );
      return result.rows[0] || null;
    });
  }

  async upsertBrowserState(
    appId: string,
    tenantId: string,
    ownerUserId: string | null,
    encryptedPayloadRef: string,
    nonce: Buffer,
    keyVersion: string,
    expiresAt: string,
    sourceSessionId: string,
    healthResult: string,
  ): Promise<void> {
    if (!this.pool) return;
    await this.withSession(async (client) => {
      await client.query(
        `INSERT INTO browser_state_snapshots
           (app_id, tenant_id, owner_user_id, encrypted_payload_ref, nonce, key_version,
            expires_at, source_session_id, health_result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (app_id, tenant_id, COALESCE(owner_user_id, '__shared__'))
         DO UPDATE SET
           encrypted_payload_ref = EXCLUDED.encrypted_payload_ref,
           nonce = EXCLUDED.nonce,
           key_version = EXCLUDED.key_version,
           saved_at = now(),
           expires_at = EXCLUDED.expires_at,
           source_session_id = EXCLUDED.source_session_id,
           health_result = EXCLUDED.health_result`,
        [
          appId, tenantId, ownerUserId, encryptedPayloadRef,
          nonce, keyVersion, expiresAt, sourceSessionId, healthResult,
        ],
      );
    });
  }

  async insertArtifactBundle(input: {
    sessionId: string;
    appId: string;
    tenantId: string;
    encryptedPayloadRef: string;
    nonce: Buffer;
    keyVersion: string;
    expiresAt: string;
  }): Promise<string | null> {
    if (!this.pool) return null;
    return this.withSession(async (client) => {
      const result = await client.query(
        `INSERT INTO artifact_bundles (
          session_id,
          app_id,
          tenant_id,
          encrypted_payload_ref,
          storage_backend,
          nonce,
          key_version,
          exported_at,
          expires_at
        ) VALUES ($1, $2, $3, $4, 'minio', $5, $6, now(), $7)
        RETURNING id`,
        [
          input.sessionId,
          input.appId,
          input.tenantId,
          input.encryptedPayloadRef,
          input.nonce,
          input.keyVersion,
          input.expiresAt,
        ],
      );
      return result.rows[0]?.id || null;
    });
  }

  private async withSession<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool) {
      throw new Error('SessionDb is not connected');
    }

    const client = await this.pool.connect();
    try {
      await client.query(
        `SELECT set_config('app.session_id', $1, false)`,
        [this.sessionId],
      );
      return await fn(client);
    } finally {
      client.release();
    }
  }
}
