// ────────────────────────────────────────────────────────────
//  Tests — SQLite storage adapter (peer-devicer)
// ────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteAdapter } from '../../libs/adapters/sqlite.js';
import type { PeerStorage } from '../../libs/adapters/inmemory.js';

// ── Helpers ────────────────────────────────────────────────

function edgePartial(
  deviceIdA: string,
  deviceIdB: string,
  edgeType: 'shared_user' | 'shared_ip_subnet' | 'shared_tls_ja4' | 'shared_canvas' | 'shared_webgl' = 'shared_ip_subnet',
  signalValue = '10.0.0.0/24',
  weight = 0.4,
) {
  return {
    deviceIdA,
    deviceIdB,
    edgeType,
    signalValue,
    weight,
    occurrences: 1,
    firstSeen: new Date(),
    lastSeen: new Date(),
  } as const;
}

let storage: PeerStorage;

beforeEach(() => {
  // Use an in-memory SQLite database for each test
  storage = createSqliteAdapter(':memory:', 50);
});

// ── Table auto-creation ─────────────────────────────────────

describe('createSqliteAdapter — table creation', () => {
  it('creates tables without throwing on first use', () => {
    expect(() => createSqliteAdapter(':memory:')).not.toThrow();
  });

  it('is idempotent — second adapter on same :memory: does not fail', () => {
    expect(() => {
      createSqliteAdapter(':memory:');
      createSqliteAdapter(':memory:');
    }).not.toThrow();
  });
});

// ── upsertEdge ─────────────────────────────────────────────

describe('createSqliteAdapter — upsertEdge', () => {
  it('inserts a new edge and returns it with an id', () => {
    const edge = storage.upsertEdge(edgePartial('a', 'b'));
    expect(edge.id).toBeTruthy();
  });

  it('increments occurrences on duplicate upsert (ON CONFLICT logic)', () => {
    const e1 = storage.upsertEdge(edgePartial('a', 'b'));
    const e2 = storage.upsertEdge(edgePartial('a', 'b'));
    expect(e1.id).toBe(e2.id);
    expect(e2.occurrences).toBe(2);
  });

  it('stores distinct edges for different edge types on same pair', () => {
    const e1 = storage.upsertEdge(edgePartial('a', 'b', 'shared_user', 'u1', 1.0));
    const e2 = storage.upsertEdge(edgePartial('a', 'b', 'shared_ip_subnet', '1.2.3.0/24', 0.4));
    expect(e1.id).not.toBe(e2.id);
  });
});

// ── getEdges ───────────────────────────────────────────────

describe('createSqliteAdapter — getEdges', () => {
  it('retrieves edges from both sides of a device', () => {
    storage.upsertEdge(edgePartial('x', 'y'));
    expect(storage.getEdges('x')).toHaveLength(1);
    expect(storage.getEdges('y')).toHaveLength(1);
  });

  it('returns an empty array for an unknown device', () => {
    expect(storage.getEdges('nobody')).toHaveLength(0);
  });

  it('respects limit', () => {
    storage.upsertEdge(edgePartial('a', 'b'));
    storage.upsertEdge(edgePartial('a', 'c'));
    storage.upsertEdge(edgePartial('a', 'd'));
    expect(storage.getEdges('a', 2)).toHaveLength(2);
  });

  it('returns edges ordered newest-last-seen first', async () => {
    const e1 = storage.upsertEdge(edgePartial('a', 'b', 'shared_user', 'u1', 1.0));
    await new Promise((r) => setTimeout(r, 10));
    const e2 = storage.upsertEdge(edgePartial('a', 'c', 'shared_ip_subnet', '1.2.3.0/24', 0.4));
    const edges = storage.getEdges('a');
    expect(edges[0].id).toBe(e2.id);
    void e1;
  });
});

// ── findPeersBySignal ──────────────────────────────────────

describe('createSqliteAdapter — findPeersBySignal', () => {
  it('returns both device IDs from matching edges', () => {
    storage.upsertEdge(edgePartial('dev-a', 'dev-b', 'shared_user', 'user-42', 1.0));
    const peers = storage.findPeersBySignal('shared_user', 'user-42');
    expect(peers).toContain('dev-a');
    expect(peers).toContain('dev-b');
  });

  it('returns empty for no matches', () => {
    expect(storage.findPeersBySignal('shared_user', 'nonexistent')).toHaveLength(0);
  });
});

// ── device cache — JSON round-trip ─────────────────────────

describe('createSqliteAdapter — device cache', () => {
  it('round-trips a cache entry including flagReasons JSON array', () => {
    storage.saveDeviceCache({
      deviceId: 'sq-dev-1',
      updatedAt: new Date(),
      ipRisk: 77,
      tlsConsistency: 55,
      driftScore: 20,
      flagReasons: ['vpn', 'known_bot_cluster'],
    });
    const cache = storage.getDeviceCache('sq-dev-1');
    expect(cache?.ipRisk).toBe(77);
    expect(cache?.tlsConsistency).toBe(55);
    expect(cache?.flagReasons).toEqual(['vpn', 'known_bot_cluster']);
  });

  it('round-trips a cache entry with undefined optional fields', () => {
    storage.saveDeviceCache({
      deviceId: 'sq-dev-2',
      updatedAt: new Date(),
      flagReasons: [],
    });
    const cache = storage.getDeviceCache('sq-dev-2');
    expect(cache?.ipRisk).toBeUndefined();
    expect(cache?.tlsConsistency).toBeUndefined();
    expect(cache?.driftScore).toBeUndefined();
  });

  it('returns null for an unknown device', () => {
    expect(storage.getDeviceCache('never')).toBeNull();
  });

  it('updates on second save', () => {
    const base = { deviceId: 'sq-upd', updatedAt: new Date(), ipRisk: 5, flagReasons: [] as string[] };
    storage.saveDeviceCache(base);
    storage.saveDeviceCache({ ...base, ipRisk: 99 });
    expect(storage.getDeviceCache('sq-upd')?.ipRisk).toBe(99);
  });
});

// ── size ───────────────────────────────────────────────────

describe('createSqliteAdapter — size', () => {
  it('returns 0 for empty storage', () => {
    expect(storage.size()).toBe(0);
  });

  it('counts unique device IDs across both columns', () => {
    storage.upsertEdge(edgePartial('s1', 's2'));
    storage.upsertEdge(edgePartial('s1', 's3'));
    expect(storage.size()).toBe(3);
  });
});

// ── pruneStaleEdges ────────────────────────────────────────

describe('createSqliteAdapter — pruneStaleEdges', () => {
  it('retains recent edges', () => {
    storage.upsertEdge(edgePartial('pa', 'pb'));
    expect(storage.pruneStaleEdges(1000 * 60 * 60)).toBe(0);
  });

  it('removes edges older than the threshold', async () => {
    storage.upsertEdge(edgePartial('oa', 'ob'));
    await new Promise((r) => setTimeout(r, 20));
    const removed = storage.pruneStaleEdges(10);
    expect(removed).toBe(1);
    expect(storage.getEdges('oa')).toHaveLength(0);
  });
});

// ── clearEdges ─────────────────────────────────────────────

describe('createSqliteAdapter — clearEdges', () => {
  it('clears all edges when no deviceId given', () => {
    storage.upsertEdge(edgePartial('a', 'b'));
    storage.upsertEdge(edgePartial('c', 'd'));
    storage.clearEdges();
    expect(storage.size()).toBe(0);
  });

  it('clears only the specified device', () => {
    storage.upsertEdge(edgePartial('rm-me', 'other'));
    storage.upsertEdge(edgePartial('keep-a', 'keep-b'));
    storage.clearEdges('rm-me');
    expect(storage.getEdges('rm-me')).toHaveLength(0);
    expect(storage.getEdges('keep-a')).toHaveLength(1);
  });
});

// ── per-device cap ─────────────────────────────────────────

describe('createSqliteAdapter — per-device cap', () => {
  it('retains at most maxEdgesPerDevice edges per device', () => {
    const capped = createSqliteAdapter(':memory:', 3);
    for (let i = 0; i < 6; i++) {
      capped.upsertEdge(edgePartial('device-x', `peer-${i}`, 'shared_ip_subnet', `10.0.${i}.0/24`));
    }
    expect(capped.getEdges('device-x').length).toBeLessThanOrEqual(3);
  });
});
