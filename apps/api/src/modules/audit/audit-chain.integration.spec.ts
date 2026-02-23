import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// Audit chain integration tests.
//
// These tests simulate the audit service's hash chain creation and the
// verifier's integrity checks WITHOUT requiring a real database.
// The hash chain logic is:
//   hash = SHA256(prev_hash + canonical_payload)
// where canonical_payload = JSON.stringify(payload, sorted_keys).
// ---------------------------------------------------------------------------

interface MockAuditEvent {
  id: string;
  sequence_num: number;
  tenant_id: string | null;
  timestamp: Date;
  actor_type: 'system' | 'human';
  actor_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  prev_hash: string | null;
  hash: string;
}

interface MockAuditAnchor {
  id: string;
  anchor_date: string;
  root_hash: string;
  event_count: number;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Helpers that mirror the production logic
// ---------------------------------------------------------------------------

function computeCanonicalPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(payload, Object.keys(payload).sort());
}

function computeHash(prevHash: string | null, payload: Record<string, unknown>): string {
  const canonical = computeCanonicalPayload(payload);
  const hashInput = (prevHash || '') + canonical;
  return createHash('sha256').update(hashInput).digest('hex');
}

/** Build a chain of audit events, the same way AuditService.log() does. */
function buildChain(
  inputs: Array<{
    actor_id: string;
    event_type: string;
    payload: Record<string, unknown>;
  }>,
): MockAuditEvent[] {
  const events: MockAuditEvent[] = [];
  let prevHash: string | null = null;

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const hash = computeHash(prevHash, input.payload);

    events.push({
      id: `evt-${i + 1}`,
      sequence_num: i + 1,
      tenant_id: 'tenant-1',
      timestamp: new Date(),
      actor_type: 'system',
      actor_id: input.actor_id,
      event_type: input.event_type,
      payload: input.payload,
      prev_hash: prevHash,
      hash,
    });

    prevHash = hash;
  }

  return events;
}

/** Verify the hash chain integrity (mirrors AuditVerifierService logic). */
function verifyChain(events: MockAuditEvent[]): {
  status: 'pass' | 'fail';
  brokenLinks: Array<{ sequence_num: number; event_id: string; expected: string; actual: string }>;
} {
  const brokenLinks: Array<{ sequence_num: number; event_id: string; expected: string; actual: string }> = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    // Verify prev_hash linkage (skip first event)
    if (i > 0 && event.prev_hash !== events[i - 1].hash) {
      brokenLinks.push({
        sequence_num: event.sequence_num,
        event_id: event.id,
        expected: events[i - 1].hash,
        actual: event.prev_hash || '(null)',
      });
      continue;
    }

    // Recompute hash
    const computedHash = computeHash(event.prev_hash, event.payload);
    if (computedHash !== event.hash) {
      brokenLinks.push({
        sequence_num: event.sequence_num,
        event_id: event.id,
        expected: computedHash,
        actual: event.hash,
      });
    }
  }

  return {
    status: brokenLinks.length === 0 ? 'pass' : 'fail',
    brokenLinks,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Audit Chain Integration', () => {
  // -----------------------------------------------------------------------
  // Create series of audit events, verify hash chain
  // -----------------------------------------------------------------------
  describe('hash chain creation and verification', () => {
    it('creates a valid hash chain from a series of audit events', () => {
      const events = buildChain([
        { actor_id: 'system', event_type: 'session.created', payload: { session_id: 's1' } },
        { actor_id: 'system', event_type: 'session.state.changed', payload: { old_state: 'STARTING', new_state: 'HEALTHY' } },
        { actor_id: 'user-1', event_type: 'artifact.accessed', payload: { artifact_id: 'a1' } },
      ]);

      expect(events).toHaveLength(3);

      // First event's prev_hash is null
      expect(events[0].prev_hash).toBeNull();

      // Subsequent events chain to the previous hash
      expect(events[1].prev_hash).toBe(events[0].hash);
      expect(events[2].prev_hash).toBe(events[1].hash);

      // All hashes are 64-char hex strings (SHA-256)
      for (const event of events) {
        expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('each event hash depends on all previous events (transitive chaining)', () => {
      const events = buildChain([
        { actor_id: 'system', event_type: 'e1', payload: { a: 1 } },
        { actor_id: 'system', event_type: 'e2', payload: { b: 2 } },
        { actor_id: 'system', event_type: 'e3', payload: { c: 3 } },
      ]);

      // If we recompute event 3's hash manually, it should match
      const expected = computeHash(events[1].hash, { c: 3 });
      expect(events[2].hash).toBe(expected);
    });
  });

  // -----------------------------------------------------------------------
  // Run verifier, expect pass
  // -----------------------------------------------------------------------
  describe('verifier passes for valid chain', () => {
    it('returns pass for an untampered chain', () => {
      const events = buildChain([
        { actor_id: 'system', event_type: 'session.created', payload: { id: '1' } },
        { actor_id: 'system', event_type: 'session.started', payload: { id: '1', state: 'HEALTHY' } },
        { actor_id: 'user-1', event_type: 'intervention.created', payload: { id: '2' } },
        { actor_id: 'system', event_type: 'artifact.exported', payload: { ref: 's3://bucket/obj' } },
      ]);

      const result = verifyChain(events);

      expect(result.status).toBe('pass');
      expect(result.brokenLinks).toHaveLength(0);
    });

    it('returns pass for a single-event chain', () => {
      const events = buildChain([
        { actor_id: 'system', event_type: 'startup', payload: { message: 'init' } },
      ]);

      const result = verifyChain(events);

      expect(result.status).toBe('pass');
      expect(result.brokenLinks).toHaveLength(0);
    });

    it('returns pass for empty event list', () => {
      const result = verifyChain([]);

      expect(result.status).toBe('pass');
      expect(result.brokenLinks).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Tamper with an event hash, verify chain, expect broken link reported
  // -----------------------------------------------------------------------
  describe('tamper detection', () => {
    it('detects tampered event hash', () => {
      const events = buildChain([
        { actor_id: 'system', event_type: 'e1', payload: { key: 'val1' } },
        { actor_id: 'system', event_type: 'e2', payload: { key: 'val2' } },
        { actor_id: 'system', event_type: 'e3', payload: { key: 'val3' } },
      ]);

      // Tamper with event 2's hash
      events[1].hash = 'deadbeef'.repeat(8);

      const result = verifyChain(events);

      expect(result.status).toBe('fail');
      expect(result.brokenLinks.length).toBeGreaterThanOrEqual(1);

      // Event 2 should be detected as broken (its stored hash doesn't match recomputed)
      const brokenEvent2 = result.brokenLinks.find((l) => l.event_id === 'evt-2');
      expect(brokenEvent2).toBeDefined();
    });

    it('detects tampered event payload', () => {
      const events = buildChain([
        { actor_id: 'system', event_type: 'e1', payload: { amount: 100 } },
        { actor_id: 'system', event_type: 'e2', payload: { amount: 200 } },
      ]);

      // Tamper with event 1's payload (but not its hash)
      events[0].payload = { amount: 999 };

      const result = verifyChain(events);

      expect(result.status).toBe('fail');
      expect(result.brokenLinks.length).toBeGreaterThanOrEqual(1);
    });

    it('detects broken prev_hash linkage', () => {
      const events = buildChain([
        { actor_id: 'system', event_type: 'e1', payload: { a: 1 } },
        { actor_id: 'system', event_type: 'e2', payload: { b: 2 } },
        { actor_id: 'system', event_type: 'e3', payload: { c: 3 } },
      ]);

      // Break the prev_hash link of event 3
      events[2].prev_hash = 'aaaa'.repeat(16);

      const result = verifyChain(events);

      expect(result.status).toBe('fail');
      const brokenEvent3 = result.brokenLinks.find((l) => l.event_id === 'evt-3');
      expect(brokenEvent3).toBeDefined();
      expect(brokenEvent3!.expected).toBe(events[1].hash);
      expect(brokenEvent3!.actual).toBe('aaaa'.repeat(16));
    });

    it('reports the correct broken link when middle event is tampered', () => {
      const events = buildChain([
        { actor_id: 's', event_type: 'e1', payload: { x: 1 } },
        { actor_id: 's', event_type: 'e2', payload: { x: 2 } },
        { actor_id: 's', event_type: 'e3', payload: { x: 3 } },
        { actor_id: 's', event_type: 'e4', payload: { x: 4 } },
        { actor_id: 's', event_type: 'e5', payload: { x: 5 } },
      ]);

      // Tamper with event 3's hash -- should break events 3 and 4
      events[2].hash = '0'.repeat(64);

      const result = verifyChain(events);

      expect(result.status).toBe('fail');
      // Event 3 has bad hash, event 4 has broken prev_hash link
      expect(result.brokenLinks.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -----------------------------------------------------------------------
  // Daily anchor computation stores correct root hash
  // -----------------------------------------------------------------------
  describe('daily anchor computation', () => {
    it('anchor root_hash equals the last event hash of the day', () => {
      const events = buildChain([
        { actor_id: 's', event_type: 'e1', payload: { a: 1 } },
        { actor_id: 's', event_type: 'e2', payload: { b: 2 } },
        { actor_id: 's', event_type: 'e3', payload: { c: 3 } },
      ]);

      // Simulate daily anchor: last event's hash is the root
      const anchor: MockAuditAnchor = {
        id: 'anchor-1',
        anchor_date: '2026-01-15',
        root_hash: events[events.length - 1].hash,
        event_count: events.length,
        created_at: new Date(),
      };

      expect(anchor.root_hash).toBe(events[2].hash);
      expect(anchor.event_count).toBe(3);
    });

    it('empty day gets null hash anchor', () => {
      const anchor: MockAuditAnchor = {
        id: 'anchor-2',
        anchor_date: '2026-01-16',
        root_hash: '0'.repeat(64),
        event_count: 0,
        created_at: new Date(),
      };

      expect(anchor.root_hash).toBe('0'.repeat(64));
      expect(anchor.event_count).toBe(0);
    });

    it('anchor matches verifier check when chain is valid', () => {
      const events = buildChain([
        { actor_id: 's', event_type: 'login', payload: { user: 'admin' } },
        { actor_id: 's', event_type: 'export', payload: { ref: 'obj1' } },
      ]);

      const anchor: MockAuditAnchor = {
        id: 'anchor-3',
        anchor_date: '2026-02-01',
        root_hash: events[events.length - 1].hash,
        event_count: events.length,
        created_at: new Date(),
      };

      // Verify chain passes
      const verifyResult = verifyChain(events);
      expect(verifyResult.status).toBe('pass');

      // Anchor matches last event's hash
      const lastEvent = events[events.length - 1];
      const anchorMatch = lastEvent.hash === anchor.root_hash;
      expect(anchorMatch).toBe(true);
    });

    it('anchor mismatch detected when chain is tampered after anchoring', () => {
      const events = buildChain([
        { actor_id: 's', event_type: 'e1', payload: { data: 'original' } },
      ]);

      // Anchor was created from original chain
      const anchor: MockAuditAnchor = {
        id: 'anchor-4',
        anchor_date: '2026-02-02',
        root_hash: events[0].hash,
        event_count: 1,
        created_at: new Date(),
      };

      // Now tamper with the event
      events[0].payload = { data: 'tampered' };
      events[0].hash = computeHash(null, events[0].payload);

      // Anchor no longer matches
      expect(events[0].hash).not.toBe(anchor.root_hash);
    });
  });

  // -----------------------------------------------------------------------
  // Canonical JSON serialization
  // -----------------------------------------------------------------------
  describe('canonical JSON payload', () => {
    it('sorts keys deterministically', () => {
      const payload1 = { z: 1, a: 2, m: 3 };
      const payload2 = { a: 2, m: 3, z: 1 };

      const canonical1 = computeCanonicalPayload(payload1);
      const canonical2 = computeCanonicalPayload(payload2);

      expect(canonical1).toBe(canonical2);
    });

    it('produces same hash for payloads with same data but different key order', () => {
      const hash1 = computeHash(null, { z: 1, a: 2 });
      const hash2 = computeHash(null, { a: 2, z: 1 });

      expect(hash1).toBe(hash2);
    });
  });
});
