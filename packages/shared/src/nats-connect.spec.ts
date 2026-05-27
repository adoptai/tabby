import { connectNats } from './nats-connect';

// Mock the nats module
jest.mock('nats', () => ({
  connect: jest.fn(),
}));

import { connect } from 'nats';

const mockConnect = connect as jest.Mock;

function makeStatusIterator(events: Array<{ type: string }>) {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) {
            return { value: events[index++], done: false };
          }
          // Simulate end of iterator (permanent close)
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function makeMockNc(statusEvents: Array<{ type: string }> = []) {
  return {
    status: jest.fn().mockReturnValue(makeStatusIterator(statusEvents)),
    drain: jest.fn().mockResolvedValue(undefined),
  };
}

describe('connectNats', () => {
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

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
    const nc = makeMockNc([]);
    mockConnect.mockResolvedValue(nc);

    await connectNats('nats://localhost:4222', logger);

    // status() is called to start monitoring (async loop runs in background)
    expect(nc.status).toHaveBeenCalled();
  });

  it('logs disconnect warning when status emits disconnect', async () => {
    // We test via a manual status callback
    const statusEvents = [{ type: 'disconnect' }, { type: 'reconnect' }];
    const nc = makeMockNc(statusEvents);
    mockConnect.mockResolvedValue(nc);

    await connectNats('nats://localhost:4222', logger);

    // Give the async loop a tick to process
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.warn).toHaveBeenCalledWith('NATS disconnected, reconnecting...');
    expect(logger.log).toHaveBeenCalledWith('NATS reconnected');
  });

  it('calls logger.error when status iterator ends (permanent close)', async () => {
    const processExitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const nc = makeMockNc([]); // empty events → loop ends immediately
    mockConnect.mockResolvedValue(nc);

    await connectNats('nats://localhost:4222', logger);

    // Allow microtasks to flush
    await new Promise((resolve) => setImmediate(resolve));

    expect(logger.error).toHaveBeenCalledWith(
      'NATS connection permanently closed, exiting',
    );

    processExitSpy.mockRestore();
  });
});
