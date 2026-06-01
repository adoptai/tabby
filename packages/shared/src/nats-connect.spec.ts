import { connectNats } from './nats-connect';

// Mock the nats module
jest.mock('nats', () => ({
  connect: jest.fn(),
}));

import { connect } from 'nats';

const mockConnect = connect as jest.Mock;

const logger = {
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// A status iterator that never yields (stays open forever — simulates a live connection)
function makeNeverEndingStatusIterator() {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          // Never resolves — keeps the background loop alive without exiting
          return new Promise<{ value: any; done: boolean }>(() => {});
        },
      };
    },
  };
}

function makeMockNc(statusIterator?: any) {
  return {
    status: jest.fn().mockReturnValue(statusIterator ?? makeNeverEndingStatusIterator()),
    drain: jest.fn().mockResolvedValue(undefined),
  };
}

describe('connectNats', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls nats connect with resilience options', async () => {
    const nc = makeMockNc();
    mockConnect.mockResolvedValue(nc);

    await connectNats('nats://localhost:4222', logger, { skipStatusMonitor: true });

    expect(mockConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        servers: 'nats://localhost:4222',
        maxReconnectAttempts: -1,
        reconnectTimeWait: 2000,
        reconnectJitter: 1000,
        pingInterval: 10_000,
        maxPingOut: 3,
      }),
    );
  });

  it('returns the NatsConnection', async () => {
    const nc = makeMockNc();
    mockConnect.mockResolvedValue(nc);

    const result = await connectNats('nats://localhost:4222', logger, { skipStatusMonitor: true });

    expect(result).toBe(nc);
  });

  it('does not start status monitor when skipStatusMonitor=true', async () => {
    const nc = makeMockNc();
    mockConnect.mockResolvedValue(nc);

    await connectNats('nats://localhost:4222', logger, { skipStatusMonitor: true });

    // status() should not have been called
    expect(nc.status).not.toHaveBeenCalled();
  });

  it('starts status monitor when skipStatusMonitor is not set', async () => {
    const nc = makeMockNc(); // uses never-ending iterator to avoid process.exit
    mockConnect.mockResolvedValue(nc);

    await connectNats('nats://localhost:4222', logger);

    // status() is called to start monitoring (async loop runs in background)
    expect(nc.status).toHaveBeenCalled();
  });

  it('logs disconnect warning and reconnect info from status events', async () => {
    // Use a custom async iterator that yields disconnect + reconnect then stays open
    let callCount = 0;
    const events = [{ type: 'disconnect' }, { type: 'reconnect' }];
    const customIterator = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (callCount < events.length) {
              return { value: events[callCount++], done: false };
            }
            // After events are exhausted, never resolve (avoid process.exit)
            return new Promise<{ value: any; done: boolean }>(() => {});
          },
        };
      },
    };

    const nc = makeMockNc(customIterator);
    mockConnect.mockResolvedValue(nc);

    await connectNats('nats://localhost:4222', logger);

    // Give the async loop a tick to process the first two events
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledWith('NATS disconnected, reconnecting...');
    expect(logger.log).toHaveBeenCalledWith('NATS reconnected');
  });
});
