import { Injectable, Logger } from '@nestjs/common';

/**
 * Per-tenant NATS authorization configuration.
 *
 * All NATS subjects in this system embed the tenant_id as a path token,
 * so tenant isolation is enforced by allowing publish/subscribe only
 * to subjects that contain the tenant's own ID.
 *
 * Subject format examples:
 *   auth.bundle.exported.{tenant_id}.{app_id}
 *   session.state.changed.{tenant_id}.{session_id}
 *   hitl.started.{tenant_id}.{session_id}
 *   hitl.completed.{tenant_id}.{session_id}
 *   hitl.otp-requested.{tenant_id}.{session_id}
 */

export interface TenantNatsAcl {
  tenant_id: string;
  publish: {
    allow: string[];
    deny: string[];
  };
  subscribe: {
    allow: string[];
    deny: string[];
  };
}

@Injectable()
export class NatsAclService {
  private readonly logger = new Logger(NatsAclService.name);

  /**
   * Generate a NATS authorization configuration for the given tenant.
   *
   * The ACL constrains the tenant to subjects that include their own
   * tenant_id in the 4th position (0-indexed: 3rd dot-separated token
   * for three-part prefixes, or after the action compound token).
   *
   * Wildcard patterns:
   *   - `*.*.*.{tenant_id}.>` allows any subject that has the tenant_id
   *     in position 4 with any further tokens.
   */
  generateTenantAcl(tenantId: string): TenantNatsAcl {
    // Subjects the tenant may subscribe to (all events scoped to their ID)
    const allowedSubscribe = [
      `auth.bundle.exported.${tenantId}.>`,
      `session.state.changed.${tenantId}.>`,
      `hitl.started.${tenantId}.>`,
      `hitl.completed.${tenantId}.>`,
      `hitl.otp-requested.${tenantId}.>`,
    ];

    // Subjects the tenant may publish to (same scoping)
    const allowedPublish = [
      `auth.bundle.exported.${tenantId}.>`,
      `session.state.changed.${tenantId}.>`,
      `hitl.started.${tenantId}.>`,
      `hitl.completed.${tenantId}.>`,
      `hitl.otp-requested.${tenantId}.>`,
    ];

    // Explicit deny: anything that does NOT include the tenant_id
    // (this is a safety-net; the NATS server should be configured in
    //  deny-by-default mode where only the allow list is permitted).
    const denyAll = ['>'];

    return {
      tenant_id: tenantId,
      publish: {
        allow: allowedPublish,
        deny: denyAll,
      },
      subscribe: {
        allow: allowedSubscribe,
        deny: denyAll,
      },
    };
  }

  /**
   * Validate whether a tenant is permitted to access a given NATS subject.
   *
   * Returns true only if the subject contains the tenant_id in the expected
   * position (token index 3, zero-based).
   */
  validateSubjectAccess(tenantId: string, subject: string): boolean {
    const tokens = subject.split('.');

    // All current subjects have at least 5 tokens:
    //   <action-part1>.<action-part2>.<action-part3>.<tenant_id>.<resource_id>
    // or for compound actions:
    //   <part1>.<compound-part>.<tenant_id>.<resource_id>
    //
    // The tenant_id always sits at one of these positions depending on the
    // subject prefix length.  We check all reasonable positions.

    // Position 3 (e.g. "auth.bundle.exported.{tenant_id}.{app_id}")
    if (tokens.length >= 5 && tokens[3] === tenantId) {
      return true;
    }

    // Position 2 (e.g. "hitl.otp-requested.{tenant_id}.{session_id}")
    if (tokens.length >= 4 && tokens[2] === tenantId) {
      return true;
    }

    this.logger.warn(
      `Subject access denied: tenant=${tenantId}, subject=${subject}`,
    );
    return false;
  }
}
