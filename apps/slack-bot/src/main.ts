import { App, LogLevel } from '@slack/bolt';
import { NatsListener } from './nats-listener';
import { ApiClient } from './api-client';
import { registerHitlActions } from './handlers/hitl-actions';

/**
 * Slack Bot Entry Point
 * Per spec section 12.1-12.3:
 *   - Creates Slack App using @slack/bolt (Socket Mode)
 *   - Connects to NATS to listen for HITL events
 *   - Registers interactive action handlers for the HITL flow
 */
async function main(): Promise<void> {
  // Validate required environment variables
  const botToken = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!botToken || !signingSecret || !appToken) {
    console.error(
      'Missing required environment variables: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, SLACK_APP_TOKEN',
    );
    process.exit(1);
  }

  const defaultChannelId = process.env.SLACK_DEFAULT_CHANNEL || 'general';

  // Initialize the Slack Bolt app in Socket Mode
  const app = new App({
    token: botToken,
    signingSecret,
    appToken,
    socketMode: true,
    logLevel: (process.env.LOG_LEVEL as LogLevel) || LogLevel.INFO,
  });

  // Initialize the API client for HITL endpoint calls
  const apiClient = new ApiClient();

  // Register Slack interactive action handlers
  registerHitlActions(app, apiClient);

  // Start the Slack bolt app
  await app.start();
  console.log('[SlackBot] Bolt app started in Socket Mode');

  // Connect to NATS and subscribe to HITL events
  const natsListener = new NatsListener(app, defaultChannelId);
  await natsListener.start();
  console.log('[SlackBot] NATS listener started');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[SlackBot] Shutting down...');
    await natsListener.stop();
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(`[SlackBot] Fatal error: ${error}`);
  process.exit(1);
});
