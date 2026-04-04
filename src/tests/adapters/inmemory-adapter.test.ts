// ────────────────────────────────────────────────────────────
//  Tests — in-memory storage adapter (peer-devicer)
// ────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { createPeerStorage } from '../../libs/adapters/inmemory.js';
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
  storage = createPeerStorage(50);
});

// ── upsertEdge ─────────────────────────────────────────────

describe('createPeerStorage — upsertEdge', () => {
  it('inserts a new edge and assigns a UUID id', () => {
    const edge = storage.upsertEdge(edgePartial('a', 'b'));
    expect(edge.id).toBeTruthy();
    expect(edge.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('increments occurrences on duplicate upsert', () => {
    const e1 = storage.upsertEdge(edgePartial('a', 'b'));
    const e2 = storage.upsertEdge(edgePartial('a', 'b'));
    expect(e1.id).toBe(e2.id);
    expect(e2.occurrences).toBe(2);
  });

  it('updates lastSeen on duplicate upsert', async () => {
    const e1 = storage.upsertEdge(edgePartial('a', 'b'));
    await new Promise((r) => setTimeout(r, 5));
    const e2 = storage.upsertEdge(edgePartial('a', 'b'));
    expect(e2.lastSeen.getTime()).toBeGreaterThanOrEqual(e1.lastSeen.getTime());
  });

  it('stores distinct edges for different edge types', () => {
    const e1 = storage.upsertEdge(edgePartial('a', 'b', 'shared_user', 'user-1', 1.0));
    const e2 = storage.upsertEdge(edgePartial('a', 'b', 'shared_ip_subnet', '10.0.0.0/24', 0.4));
    expect(e1.id).not.toBe(e2.id);
  });
});

// ── getEdges ───────────────────────────────────────────────

describe('createPeerStorage — getEdges', () => {
  it('returns edges for a device from either side', () => {
    storage.upsertEdge(edgePartial('x', 'y'));
    const edgesX = storage.getEdges('x');
    const edgesY = storage.getEdges('y');
    expect(edgesX).toHaveLength(1);
    expect(edgesY).toHaveLength(1);
  });

  it('returns edges newest-last-seen first', async () => {
    storage.upsertEdge(edgePartial('a', 'b', 'shared_user', 'u1', 1.0));
    await new Promise((r) => setTimeout(r, 5));
    const edge2 = storage.upsertEdge(edgePartial('a', 'c', 'shared_ip_subnet', '1.2.3.0/24', 0.4));
    const edges = storage.getEdges('a');
    expect(edges[0].id).toBe(edge2.id);
  });

  it('respects the limit parameter', () => {
    storage.upsertEdge(edgePartial('a', 'b'));
    storage.upsertEdge(edgePartial('a', 'c'));
    storage.upsertEdge(edgePartial('a', 'd'));
    expect(storage.getEdges('a', 2)).toHaveLength(2);
  });

  it('returns empty array for unknown device', () => {
    expect(storage.getEdges('nobody')).toHaveLength(0);
  });
});

// ── findPeersBySignal ──────────────────────────────────────

describe('createPeerStorage — findPeersBySignal', () => {
  it('returns both device IDs from a matching edge', () => {
    storage.upsertEdge(edgePartial('dev-a', 'dev-b', 'shared_user', 'user-42', 1.0));
    const peers = storage.findPeersBySignal('shared_user', 'user-42');
    expect(peers).toContain('dev-a');
    expect(peers).toContain('dev-b');
  });

  it('does not return IDs for a different signal value', () => {
    storage.upsertEdge(edgePartial('dev-a', 'dev-b', 'shared_user', 'user-42', 1.0));
    const peers = storage.findPeersBySignal('shared_user', 'user-other');
    expect(peers).toHaveLength(0);
  });

  it('respects the limit parameter', () => {
    storage.upsertEdge(edgePartial('a', 'b', 'shared_ip_subnet', '1.2.3.0/24'));
    storage.upsertEdge(edgePartial('a', 'c', 'shared_ip_subnet', '1.2.3.0/24'));
    storage.upsertEdge(edgePartial('a', 'd', 'shared_ip_subnet', '1.2.3.0/24'));
    const peers = storage.findPeersBySignal('shared_ip_subnet', '1.2.3.0/24', 1);
    expect(peers.length).toBeLessThanOrEqual(1);
  });
});

// ── saveDeviceCache / getDeviceCache ───────────────────────

describe('createPeerStorage — device cache', () => {
  it('round-trips a device cache entry', () => {
    storage.saveDeviceCache({
      deviceId: 'dev-cache-a',
      updatedAt: new Date(),
      ipRisk: 45,
      tlsConsistency: 80,
      driftScore: 10,
      flagReasons: ['vpn'],
    });
    const cache = storage.getDeviceCache('dev-cache-a');
    expect(cache?.ipRisk).toBe(45);
    expect(cache?.tlsConsistency).toBe(80);
    expect(cache?.driftScore).toBe(10);
    expect(cache?.flagReasons).toContain('vpn');
  });

  it('returns null for an unknown device', () => {
    expect(storage.getDeviceCache('nobody')).toBeNull();
  });

  it('updates the cache on second save', () => {
    const base = { deviceId: 'd', updatedAt: new Date(), ipRisk: 10, tlsConsistency: 100, driftScore: 0, flagReasons: [] };
    storage.saveDeviceCache(base);
    storage.saveDeviceCache({ ...base, ipRisk: 80 });
    expect(storage.getDeviceCache('d')?.ipRisk).toBe(80);
  });
});

// ── size ───────────────────────────────────────────────────

describe('createPeerStorage — size', () => {
  it('returns 0 for empty storage', () => {
    expect(storage.size()).toBe(0);
  });

  it('counts unique device IDs on both sides of edges', () => {
    storage.upsertEdge(edgePartial('s1', 's2'));
    storage.upsertEdge(edgePartial('s1', 's3'));
    // Distinct IDs: s1, s2, s3
    expect(storage.size()).toBe(3);
  });

  it('does not double-count re-upserted edges', () => {
    storage.upsertEdge(edgePartial('q1', 'q2'));
    storage.upsertEdge(edgePartial('q1', 'q2')); // duplicate
    expect(storage.size()).toBe(2);
  });
});

// ── pruneStaleEdges ────────────────────────────────────────

describe('createPeerStorage — pruneStaleEdges', () => {
  it('returns 0 when no edges are older than the threshold', () => {
    storage.upsertEdge(edgePartial('a', 'b'));
    const removed = storage.pruneStaleEdges(1000 * 60 * 60); // 1 hour
    expect(removed).toBe(0);
  });

  it('removes edges older than the threshold', async () => {
    storage.upsertEdge(edgePartial('old-a', 'old-b'));
    await new Promise((r) => setTimeout(r, 20));
    const removed = storage.pruneStaleEdges(10); // 10ms — the edge is now older
    expect(removed).toBe(1);
    expect(storage.getEdges('old-a')).toHaveLength(0);
  });
});

// ── clearEdges ─────────────────────────────────────────────

describe('createPeerStorage — clearEdges', () => {
  it('clears all edges when called without argument', () => {
    storage.upsertEdge(edgePartial('a', 'b'));
    storage.upsertEdge(edgePartial('c', 'd'));
    storage.clearEdges();
    expect(storage.size()).toBe(0);
  });

  it('clears only the specified device\'s edges', () => {
    storage.upsertEdge(edgePartial('rm', 'other'));
    storage.upsertEdge(edgePartial('keep-a', 'keep-b'));
    storage.clearEdges('rm');
    expect(storage.getEdges('rm')).toHaveLength(0);
    expect(storage.getEdges('keep-a')).toHaveLength(1);
  });
});

// ── per-device cap enforcement ─────────────────────────────

describe('createPeerStorage — per-device cap', () => {
  it('retains at most maxEdgesPerDevice edges per device', () => {
    const capped = createPeerStorage(3);
    for (let i = 0; i < 5; i++) {
      capped.upsertEdge(edgePartial('device-x', `peer-${i}`, 'shared_ip_subnet', `10.0.${i}.0/24`));
    }
    expect(capped.getEdges('device-x').length).toBeLessThanOrEqual(3);
  });
});
