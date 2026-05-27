import { connect, NatsConnection } from 'nats';

interface NatsLogger {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export async function connectNats(
  url: string,
  logger: NatsLogger,
  options?: { skipStatusMonitor?: boolean },
): Promise<NatsConnection> {
  const nc = await connect({
    servers: url,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    reconnectJitter: 1000,
    pingInterval: 10_000,
    maxPingOut: 3,
  });

  if (!options?.skipStatusMonitor) {
    (async () => {
      for await (const s of nc.status()) {
        if (s.type === 'disconnect') logger.warn('NATS disconnected, reconnecting...');
        if (s.type === 'reconnect') logger.log('NATS reconnected');
      }
      logger.error('NATS connection permanently closed, exiting');
      process.exit(1);
    })();
  }

  return nc;
}
