// New Relic Node agent — must be required before anything else.
// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
if (process.env.NEWRELIC_ENABLED === 'true' && process.env.NEW_RELIC_LICENSE_KEY) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  require('newrelic');
}

import {
  BotFrameworkAdapter,
  ConversationReference,
  TurnContext,
  ActivityTypes,
  WebRequest,
  WebResponse,
} from 'botbuilder';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { ApiClient } from './api-client';
import { HitlActionHandler } from './handlers/hitl-actions';
import { NatsListener } from './nats-listener';

/**
 * Wraps a Node.js ServerResponse as a botbuilder WebResponse.
 * BotFrameworkAdapter.processActivity expects Express-like send()/status() methods.
 */
function asWebResponse(res: ServerResponse): WebResponse {
  return {
    socket: res.socket,
    end(...args: any[]) {
      res.end(...args);
      return this;
    },
    send(body: any) {
      if (typeof body === 'string') {
        res.end(body);
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(body));
      }
      return this;
    },
    status(code: number) {
      res.statusCode = code;
      return code;
    },
  };
}

/**
 * Teams Bot Entry Point
 * Per spec section 12.2:
 *   - Creates BotFrameworkAdapter for Teams communication
 *   - Connects to NATS to listen for HITL events
 *   - Handles incoming card action submissions
 */
async function main(): Promise<void> {
  const appId = process.env.MICROSOFT_APP_ID || '';
  const appPassword = process.env.MICROSOFT_APP_PASSWORD || '';
  const port = parseInt(process.env.PORT || '3978', 10);

  // Create adapter with error handling
  const adapter = new BotFrameworkAdapter({
    appId,
    appPassword,
  });

  adapter.onTurnError = async (context: TurnContext, error: Error) => {
    console.error(`[TeamsBot] Unhandled error: ${error.message}`);
    await context.sendActivity('An error occurred processing your request. Please try again.');
  };

  // Initialize the API client and action handler
  const apiClient = new ApiClient();
  const actionHandler = new HitlActionHandler(apiClient);

  // Store the conversation reference when the bot first receives a message.
  // This enables proactive messaging from NATS events.
  let conversationReference: Partial<ConversationReference> | null = null;

  // Create HTTP server to receive Teams webhook requests
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/api/messages' && req.method === 'POST') {
      // Wrap raw Node.js request/response as botbuilder WebRequest/WebResponse
      const webReq = req as unknown as WebRequest;
      const webRes = asWebResponse(res);

      try {
        await adapter.processActivity(webReq, webRes, async (context: TurnContext) => {
          // Store conversation reference for proactive messaging
          if (!conversationReference) {
            conversationReference = TurnContext.getConversationReference(context.activity);
            console.log('[TeamsBot] Conversation reference stored for proactive messaging');

            // Start NATS listener now that we have a conversation reference
            startNatsListener(adapter, conversationReference, actionHandler);
          }

          // Handle Adaptive Card Action.Submit
          if (context.activity.type === ActivityTypes.Message && context.activity.value) {
            await actionHandler.handleAdaptiveCardAction(context);
            return;
          }

          // Handle invoke activities (Adaptive Card actions in Teams)
          if (context.activity.type === ActivityTypes.Invoke) {
            await actionHandler.handleAdaptiveCardAction(context);
            return;
          }

          // Default: echo help text
          if (context.activity.type === ActivityTypes.Message) {
            await context.sendActivity(
              'Browser HITL Bot ready. I will notify you when human intervention is needed.',
            );
          }
        });
      } catch (error) {
        console.error(`[TeamsBot] Error processing activity: ${error}`);
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    console.log(`[TeamsBot] HTTP server listening on port ${port}`);
    console.log(`[TeamsBot] Bot endpoint: http://localhost:${port}/api/messages`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('[TeamsBot] Shutting down...');
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Start the NATS listener once we have a conversation reference.
 */
let natsStarted = false;
async function startNatsListener(
  adapter: BotFrameworkAdapter,
  conversationReference: Partial<ConversationReference>,
  actionHandler: HitlActionHandler,
): Promise<void> {
  if (natsStarted) return;
  natsStarted = true;

  try {
    const natsListener = new NatsListener(adapter, conversationReference, actionHandler);
    await natsListener.start();
    console.log('[TeamsBot] NATS listener started');
  } catch (error) {
    console.error(`[TeamsBot] Failed to start NATS listener: ${error}`);
    natsStarted = false;
  }
}

main().catch((error) => {
  console.error(`[TeamsBot] Fatal error: ${error}`);
  process.exit(1);
});
