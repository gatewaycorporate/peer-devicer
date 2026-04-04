// ────────────────────────────────────────────────────────────
//  Tests — PostgreSQL storage adapter (mock; peer-devicer)
// ────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPostgresAdapter } from '../../libs/adapters/postgres.js';
import type { PgPoolLike } from '../../libs/adapters/postgres.js';
import type { AsyncPeerStorage } from '../../libs/adapters/inmemory.js';

// ── Mock pool builder ──────────────────────────────────────
//
// We store inserted/upserted rows in-memory so we can verify round-trip
// behaviour without a real Postgres connection.

type EdgeRow = {
  id: string;
  deviceida: string;
  deviceidb: string;
  edgetype: string;
  signalvalue: string;
  weight: number;
  occurrences: number;
  firstseen: string;
  lastseen: string;
};
type CacheRow = {
  deviceid: string;
  updatedat: string;
  iprisk: number | null;
  tlsconsistency: number | null;
  driftscore: number | null;
  flagreasons: string[];
};

function createMockPool(): { pool: PgPoolLike; edgeStore: Map<string, EdgeRow>; cacheStore: Map<string, CacheRow> } {
  const edgeStore = new Map<string, EdgeRow>();
  const cacheStore = new Map<string, CacheRow>();
  /** `${edgeType}||${signalValue}` → Set<deviceId> */
  const signalStore = new Map<string, Set<string>>();

  const pool: PgPoolLike = {
    async query(sql: string, values?: unknown[]) {
      const s = sql.trim().toUpperCase();

      // ── init() DDL statements ───────────────────────────────
      if (s.startsWith('CREATE TABLE') || s.startsWith('CREATE INDEX')) {
        return { rows: [] };
      }

      // ── upsertEdge INSERT ON CONFLICT ───────────────────────
      if (s.startsWith('INSERT INTO PEER_EDGES')) {
        const v = values as [string, string, string, string, string, number, unknown, unknown];
        const [id, deviceIdA, deviceIdB, edgeType, signalValue, weight] = v;
        const key = `${deviceIdA}||${deviceIdB}||${edgeType}||${signalValue}`;
        const existing = edgeStore.get(key);
        if (existing) {
          existing.occurrences += 1;
          existing.lastseen = new Date().toISOString();
        } else {
          edgeStore.set(key, {
            id,
            deviceida: deviceIdA,
            deviceidb: deviceIdB,
            edgetype: edgeType,
            signalvalue: signalValue,
            weight,
            occurrences: 1,
            firstseen: new Date().toISOString(),
            lastseen: new Date().toISOString(),
          });
        }
        return { rows: [] };
      }

      // ── upsertEdge cap DELETE (contains AND ID NOT IN) ──────
      if (s.startsWith('DELETE FROM PEER_EDGES') && s.includes('ID NOT IN')) {
        return { rows: [] };
      }

      // ── upsertEdge SELECT to return the row (uses AND) ──────
      if (
        s.startsWith('SELECT * FROM PEER_EDGES') &&
        s.includes('DEVICEIDA = $1') &&
        s.includes('AND DEVICEIDB = $2')
      ) {
        const v = values as [string, string, string, string];
        const [deviceIdA, deviceIdB, edgeType, signalValue] = v;
        const key = `${deviceIdA}||${deviceIdB}||${edgeType}||${signalValue}`;
        const row = edgeStore.get(key);
        return { rows: row ? [row] : [] };
      }

      // ── getEdges SELECT (uses OR, has LIMIT $2) ──────────────
      if (
        s.startsWith('SELECT * FROM PEER_EDGES') &&
        s.includes('OR DEVICEIDB = $1')
      ) {
        const deviceId = values?.[0] as string;
        const limit    = (values?.[1] as number | undefined) ?? 999;
        const rows = [...edgeStore.values()]
          .filter((r) => r.deviceida === deviceId || r.deviceidb === deviceId)
          .slice(0, limit);
        return { rows };
      }

      // ── findPeersBySignal (returns deviceIdA, deviceIdB) ─────
      if (s.includes('FROM PEER_EDGES') && s.includes('EDGETYPE = $1')) {
        const [edgeType, signalValue] = values as [string, string];
        const rows = [...edgeStore.values()].filter(
          (r) => r.edgetype === edgeType && r.signalvalue === signalValue,
        );
        return { rows };
      }

      // ── registerDeviceSignal INSERT ──────────────────────────
      if (s.startsWith('INSERT INTO PEER_DEVICE_SIGNALS')) {
        const [deviceId, edgeType, signalValue] = values as [string, string, string];
        const key = `${edgeType}||${signalValue}`;
        if (!signalStore.has(key)) signalStore.set(key, new Set());
        signalStore.get(key)!.add(deviceId);
        return { rows: [] };
      }

      // ── registerDeviceSignal SELECT ──────────────────────────
      if (s.startsWith('SELECT DEVICEID FROM PEER_DEVICE_SIGNALS')) {
        const [edgeType, signalValue, excludeId] = values as [string, string, string];
        const key = `${edgeType}||${signalValue}`;
        const devices = [...(signalStore.get(key) ?? [])].filter((id) => id !== excludeId);
        return { rows: devices.map((deviceid) => ({ deviceid })) };
      }

      // ── upsertCache ─────────────────────────────────────────
      if (s.startsWith('INSERT INTO PEER_DEVICE_CACHE')) {
        const v = values as [string, string, number | null, number | null, number | null, string[]];
        const [deviceId, updatedAt, ipRisk, tlsConsistency, driftScore, flagReasons] = v;
        cacheStore.set(deviceId, {
          deviceid: deviceId,
          updatedat: updatedAt,
          iprisk: ipRisk,
          tlsconsistency: tlsConsistency,
          driftscore: driftScore,
          flagreasons: Array.isArray(flagReasons) ? flagReasons : JSON.parse(String(flagReasons)),
        });
        return { rows: [] };
      }

      // ── getDeviceCache ──────────────────────────────────────
      if (s.startsWith('SELECT * FROM PEER_DEVICE_CACHE')) {
        const deviceId = values?.[0] as string;
        const row = cacheStore.get(deviceId);
        return { rows: row ? [row] : [] };
      }

      // ── size ────────────────────────────────────────────────
      if (s.includes('COUNT(*)') && s.includes('PEER_EDGES')) {
        const allIds = new Set<string>();
        for (const r of edgeStore.values()) {
          allIds.add(r.deviceida);
          allIds.add(r.deviceidb);
        }
        return { rows: [{ n: allIds.size }] };
      }

      // ── pruneStaleEdges ─────────────────────────────────────
      if (s.startsWith('DELETE FROM PEER_EDGES WHERE LASTSEEN')) {
        const cutoff = new Date(values?.[0] as string).getTime();
        let removed = 0;
        for (const [k, r] of edgeStore.entries()) {
          if (new Date(r.lastseen).getTime() < cutoff) {
            edgeStore.delete(k);
            removed++;
          }
        }
        return { rows: [{ count: removed }] };
      }

      // ── clearEdges by device (has OR DEVICEIDB) ─────────────
      if (s.startsWith('DELETE FROM PEER_EDGES') && s.includes('OR DEVICEIDB = $1')) {
        const deviceId = values?.[0] as string;
        for (const [k, r] of edgeStore.entries()) {
          if (r.deviceida === deviceId || r.deviceidb === deviceId) {
            edgeStore.delete(k);
          }
        }
        return { rows: [] };
      }

      // ── clearEdges all ──────────────────────────────────────
      if (s.startsWith('DELETE FROM PEER_EDGES')) {
        edgeStore.clear();
        return { rows: [] };
      }

      return { rows: [] };
    },
    async end() {
      // no-op
    },
  };

  return { pool, edgeStore, cacheStore };
}

// ── Test setup ─────────────────────────────────────────────

let storage: AsyncPeerStorage;
let cacheStore: Map<string, CacheRow>;

beforeEach(async () => {
  const { pool, cacheStore: cs } = createMockPool();
  cacheStore = cs;
  storage = createPostgresAdapter(pool, 50);
  await storage.init();
});

function edgePartial(
  deviceIdA: string,
  deviceIdB: string,
  edgeType: 'shared_user' | 'shared_ip_subnet' | 'shared_tls_ja4' = 'shared_ip_subnet',
  signalValue = '10.0.0.0/24',
  weight = 0.4,
) {
  return { deviceIdA, deviceIdB, edgeType, signalValue, weight, occurrences: 1, firstSeen: new Date(), lastSeen: new Date() } as const;
}

// ── Tests ──────────────────────────────────────────────────

describe('createPostgresAdapter — upsertEdge', () => {
  it('inserts and returns an edge with an id', async () => {
    const edge = await storage.upsertEdge(edgePartial('a', 'b'));
    expect(edge.id).toBeTruthy();
  });

  it('increments occurrences on duplicate', async () => {
    const e1 = await storage.upsertEdge(edgePartial('a', 'b'));
    const e2 = await storage.upsertEdge(edgePartial('a', 'b'));
    expect(e1.id).toBe(e2.id);
    expect(e2.occurrences).toBe(2);
  });

  it('stores distinct edges for different types', async () => {
    const e1 = await storage.upsertEdge(edgePartial('a', 'b', 'shared_user', 'u1'));
    const e2 = await storage.upsertEdge(edgePartial('a', 'b', 'shared_ip_subnet', '1.2.3.0/24'));
    expect(e1.id).not.toBe(e2.id);
  });
});

describe('createPostgresAdapter — getEdges', () => {
  it('returns edges for a device', async () => {
    await storage.upsertEdge(edgePartial('x', 'y'));
    const edges = await storage.getEdges('x');
    expect(edges.length).toBeGreaterThan(0);
  });

  it('returns empty for unknown device', async () => {
    expect(await storage.getEdges('nobody')).toHaveLength(0);
  });
});

describe('createPostgresAdapter — findPeersBySignal', () => {
  it('returns device IDs matching the signal', async () => {
    await storage.upsertEdge(edgePartial('pa', 'pb', 'shared_user', 'u-test'));
    const peers = await storage.findPeersBySignal('shared_user', 'u-test');
    expect(peers).toContain('pa');
    expect(peers).toContain('pb');
  });

  it('returns empty for no matches', async () => {
    expect(await storage.findPeersBySignal('shared_user', 'nobody')).toHaveLength(0);
  });
});

describe('createPostgresAdapter — device cache', () => {
  it('round-trips a cache entry with JSONB flagReasons', async () => {
    await storage.saveDeviceCache({
      deviceId: 'pg-dev-1',
      updatedAt: new Date(),
      ipRisk: 60,
      tlsConsistency: 40,
      driftScore: 15,
      flagReasons: ['vpn', 'known_bot_cluster'],
    });
    const cache = await storage.getDeviceCache('pg-dev-1');
    expect(cache?.ipRisk).toBe(60);
    expect(cache?.flagReasons).toEqual(['vpn', 'known_bot_cluster']);
  });

  it('returns null for an unknown device', async () => {
    expect(await storage.getDeviceCache('nobody')).toBeNull();
  });
});

describe('createPostgresAdapter — size', () => {
  it('returns 0 for empty storage', async () => {
    expect(await storage.size()).toBe(0);
  });

  it('counts unique device IDs', async () => {
    await storage.upsertEdge(edgePartial('s1', 's2'));
    await storage.upsertEdge(edgePartial('s1', 's3'));
    expect(await storage.size()).toBe(3);
  });
});

describe('createPostgresAdapter — pruneStaleEdges', () => {
  it('returns 0 when no edges are stale', async () => {
    await storage.upsertEdge(edgePartial('a', 'b'));
    expect(await storage.pruneStaleEdges(1000 * 60 * 60)).toBe(0);
  });
});

describe('createPostgresAdapter — clearEdges', () => {
  it('clears all edges', async () => {
    await storage.upsertEdge(edgePartial('a', 'b'));
    await storage.clearEdges();
    expect(await storage.getEdges('a')).toHaveLength(0);
  });

  it('clears only a specific device', async () => {
    await storage.upsertEdge(edgePartial('rm', 'other'));
    await storage.upsertEdge(edgePartial('keep-a', 'keep-b'));
    await storage.clearEdges('rm');
    expect(await storage.getEdges('rm')).toHaveLength(0);
    expect(await storage.getEdges('keep-a')).toHaveLength(1);
  });
});

describe('createPostgresAdapter — close', () => {
  it('resolves without throwing', async () => {
    await expect(storage.close()).resolves.toBeUndefined();
  });
});
