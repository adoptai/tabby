/**
 * Adversarial tests for bot admin credential fallback removal (H4 remediation).
 *
 * These verify that the admin email/password fallback authentication path
 * has been completely removed from the bot code. The bots should ONLY
 * authenticate via service tokens (SERVICE_AUTH_CLIENT_ID + SECRET).
 */

import * as fs from 'fs';
import * as path from 'path';

const SLACK_BOT_DIR = path.join(__dirname, '..', '..', '..', '..', 'slack-bot', 'src');
const TEAMS_BOT_DIR = path.join(__dirname, '..', '..', '..', '..', 'teams-bot', 'src');

describe('Bot admin credential fallback removal (H4)', () => {
  describe('slack-bot soft-hitl-bridge.ts', () => {
    const bridgePath = path.join(SLACK_BOT_DIR, 'soft-hitl-bridge.ts');
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(bridgePath, 'utf-8');
    });

    it('does NOT reference ADMIN_EMAIL', () => {
      expect(source).not.toContain('ADMIN_EMAIL');
    });

    it('does NOT reference ADMIN_PASSWORD', () => {
      expect(source).not.toContain('ADMIN_PASSWORD');
    });

    it('does NOT reference adminEmail variable', () => {
      expect(source).not.toContain('adminEmail');
    });

    it('does NOT reference adminPassword variable', () => {
      expect(source).not.toContain('adminPassword');
    });

    it('does NOT have a login fallback path', () => {
      expect(source).not.toContain('/login');
      expect(source).not.toContain('login fallback');
    });

    it('requires SERVICE_AUTH_CLIENT_ID in ensureEnv', () => {
      expect(source).toContain('SERVICE_AUTH_CLIENT_ID');
    });

    it('requires SERVICE_AUTH_CLIENT_SECRET in ensureEnv', () => {
      expect(source).toContain('SERVICE_AUTH_CLIENT_SECRET');
    });

    it('uses /auth/service-token for authentication', () => {
      expect(source).toContain('/auth/service-token');
    });
  });

  describe('slack-bot api-client.ts', () => {
    const clientPath = path.join(SLACK_BOT_DIR, 'api-client.ts');
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(clientPath, 'utf-8');
    });

    it('does NOT reference admin email or password', () => {
      expect(source).not.toContain('ADMIN_EMAIL');
      expect(source).not.toContain('ADMIN_PASSWORD');
      expect(source).not.toContain('adminEmail');
      expect(source).not.toContain('adminPassword');
    });

    it('throws error when service creds are missing', () => {
      expect(source).toContain('Bot authentication is not configured');
    });
  });

  describe('teams-bot api-client.ts', () => {
    const clientPath = path.join(TEAMS_BOT_DIR, 'api-client.ts');
    let source: string;

    beforeAll(() => {
      source = fs.readFileSync(clientPath, 'utf-8');
    });

    it('does NOT reference admin email or password', () => {
      expect(source).not.toContain('ADMIN_EMAIL');
      expect(source).not.toContain('ADMIN_PASSWORD');
      expect(source).not.toContain('adminEmail');
      expect(source).not.toContain('adminPassword');
    });

    it('throws error when service creds are missing', () => {
      expect(source).toContain('Bot authentication is not configured');
    });
  });
});
