// ────────────────────────────────────────────────────────────
//  Tests — Redis storage adapter (mock; peer-devicer)
// ────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'vitest';
import { createRedisAdapter } from '../../libs/adapters/redis.js';
import type { AsyncPeerStorage } from '../../libs/adapters/inmemory.js';
import type { RedisLike } from '../../libs/adapters/redis.js';

// ── In-memory Redis mock ────────────────────────────────────
//
// Implements the minimal RedisLike interface in-process.

function createMockRedis(): RedisLike {
  /** Key → sorted set: [{ score, member }] */
  const sortedSets = new Map<string, { score: number; member: string }[]>();
  /** Key → hash: string → string  */
  const hashes = new Map<string, Map<string, string>>();

  function getSortedSet(key: string) {
    if (!sortedSets.has(key)) sortedSets.set(key, []);
    return sortedSets.get(key)!;
  }

  return {
    async connect() {/* no-op */},
    async quit() { return 'OK'; },

    async zadd(key, score, member) {
      const set = getSortedSet(key);
      const idx = set.findIndex((e) => e.member === member);
      if (idx >= 0) {
        set[idx].score = score;
      } else {
        set.push({ score, member });
      }
      set.sort((a, b) => a.score - b.score);
      return 1;
    },

    async zrevrange(key, start, stop) {
      const set = [...getSortedSet(key)].reverse();
      const end = stop === -1 ? undefined : stop + 1;
      return set.slice(start, end).map((e) => e.member);
    },

    async zrangebyscore(key, min, max) {
      const set = getSortedSet(key);
      const mn = typeof min === 'string' ? (min === '-inf' ? -Infinity : Number(min)) : min;
      const mx = typeof max === 'string' ? (max === '+inf' ? Infinity  : Number(max)) : max;
      return set.filter((e) => e.score >= mn && e.score <= mx).map((e) => e.member);
    },

    async zremrangebyscore(key, min, max) {
      const set = getSortedSet(key);
      const mn = typeof min === 'string' ? -Infinity : min;
      const mx = typeof max === 'string' ? Infinity  : max;
      const before = set.length;
      const remaining = set.filter((e) => e.score < mn || e.score > mx);
      set.length = 0;
      set.push(...remaining);
      return before - set.length;
    },

    async zremrangebyrank(key, start, stop) {
      const set = getSortedSet(key);
      const toRemove = stop === -1 ? set.slice(start) : set.slice(start, stop + 1);
      const removed = toRemove.length;
      for (const item of toRemove) {
        const idx = set.indexOf(item);
        if (idx >= 0) set.splice(idx, 1);
      }
      return removed;
    },

    async zcard(key) {
      return getSortedSet(key).length;
    },

    async hset(key, ...args) {
      if (!hashes.has(key)) hashes.set(key, new Map());
      const h = hashes.get(key)!;
      for (let i = 0; i < args.length; i += 2) {
        h.set(String(args[i]), String(args[i + 1]));
      }
      return args.length / 2;
    },

    async hget(key, field) {
      return hashes.get(key)?.get(field) ?? null;
    },

    async hgetall(key) {
      const h = hashes.get(key);
      if (!h) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of h) out[k] = v;
      return out;
    },

    async del(...keys) {
      for (const k of keys) {
        sortedSets.delete(k);
        hashes.delete(k);
      }
      return keys.length;
    },

    async expire(_key, _seconds) { return 1; },

    async scan(_cursor, _matchKey, pattern, _countKey, _count) {
      // Return sorted-set keys matching the pattern (strip wildcards for simple match)
      const prefix = pattern.replace(/\*$/, '');
      const matched: string[] = [];
      for (const key of sortedSets.keys()) {
        if (key.startsWith(prefix)) matched.push(key);
      }
      return ['0', matched];
    },
  } satisfies RedisLike;
}

// ── Test setup ─────────────────────────────────────────────

let storage: AsyncPeerStorage;
let redis: RedisLike;

beforeEach(async () => {
  redis = createMockRedis();
  storage = createRedisAdapter(redis, 50);
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

// ── upsertEdge ─────────────────────────────────────────────

describe('createRedisAdapter — upsertEdge', () => {
  it('creates an edge and returns it with an id', async () => {
    const edge = await storage.upsertEdge(edgePartial('a', 'b'));
    expect(edge.id).toBeTruthy();
    expect(edge.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('increments occurrences on duplicate upsert', async () => {
    const e1 = await storage.upsertEdge(edgePartial('a', 'b'));
    const e2 = await storage.upsertEdge(edgePartial('a', 'b'));
    expect(e1.id).toBe(e2.id);
    expect(e2.occurrences).toBe(2);
  });

  it('stores distinct edges for different edge types', async () => {
    const e1 = await storage.upsertEdge(edgePartial('a', 'b', 'shared_user', 'u1'));
    const e2 = await storage.upsertEdge(edgePartial('a', 'b', 'shared_ip_subnet', '1.2.3.0/24'));
    expect(e1.id).not.toBe(e2.id);
  });

  it('sets a TTL on the edge key', async () => {
    const expireSpy = vi.spyOn(redis, 'expire');
    await storage.upsertEdge(edgePartial('ttl-a', 'ttl-b'));
    expect(expireSpy).toHaveBeenCalled();
    const [, seconds] = expireSpy.mock.calls[0] as [string, number];
    expect(seconds).toBeGreaterThan(0);
  });
});

import { vi } from 'vitest';

// ── getEdges ───────────────────────────────────────────────

describe('createRedisAdapter — getEdges', () => {
  it('returns edges stored for a device', async () => {
    await storage.upsertEdge(edgePartial('x', 'y'));
    expect(await storage.getEdges('x')).toHaveLength(1);
  });

  it('returns an empty array for an unknown device', async () => {
    expect(await storage.getEdges('nobody')).toHaveLength(0);
  });

  it('respects the limit parameter', async () => {
    await storage.upsertEdge(edgePartial('a', 'b'));
    await storage.upsertEdge(edgePartial('a', 'c', 'shared_user', 'u1'));
    expect(await storage.getEdges('a', 1)).toHaveLength(1);
  });
});

// ── findPeersBySignal ──────────────────────────────────────

describe('createRedisAdapter — findPeersBySignal', () => {
  it('returns device IDs matching the given signal', async () => {
    await storage.upsertEdge(edgePartial('pa', 'pb', 'shared_user', 'user-sig'));
    const peers = await storage.findPeersBySignal('shared_user', 'user-sig');
    expect(peers).toContain('pa');
    expect(peers).toContain('pb');
  });

  it('returns empty for no matches', async () => {
    expect(await storage.findPeersBySignal('shared_user', 'nobody')).toHaveLength(0);
  });
});

// ── device cache ───────────────────────────────────────────

describe('createRedisAdapter — device cache', () => {
  it('round-trips a cache entry via hset / hgetall', async () => {
    await storage.saveDeviceCache({
      deviceId: 'rd-dev-1',
      updatedAt: new Date(),
      ipRisk: 70,
      tlsConsistency: 50,
      driftScore: 30,
      flagReasons: ['vpn'],
    });
    const cache = await storage.getDeviceCache('rd-dev-1');
    expect(cache?.ipRisk).toBe(70);
    expect(cache?.tlsConsistency).toBe(50);
    expect(cache?.driftScore).toBe(30);
    expect(cache?.flagReasons).toContain('vpn');
  });

  it('returns null for unknown device', async () => {
    expect(await storage.getDeviceCache('nobody')).toBeNull();
  });

  it('stores undefined numeric fields as absent (no coercion to NaN)', async () => {
    await storage.saveDeviceCache({ deviceId: 'rd-dev-2', updatedAt: new Date(), flagReasons: [] });
    const cache = await storage.getDeviceCache('rd-dev-2');
    expect(cache?.ipRisk).toBeUndefined();
    expect(cache?.tlsConsistency).toBeUndefined();
    expect(cache?.driftScore).toBeUndefined();
  });

  it('sets a TTL on the cache key', async () => {
    const expireSpy = vi.spyOn(redis, 'expire');
    await storage.saveDeviceCache({ deviceId: 'ttl-cache', updatedAt: new Date(), flagReasons: [] });
    const cacheKeyCall = expireSpy.mock.calls.find((c) => (c[0] as string).includes('peer:cache'));
    expect(cacheKeyCall).toBeDefined();
    expect(cacheKeyCall?.[1]).toBeGreaterThan(0);
  });
});

// ── pruneStaleEdges ────────────────────────────────────────

describe('createRedisAdapter — pruneStaleEdges', () => {
  it('resolves without throwing', async () => {
    await storage.upsertEdge(edgePartial('a', 'b'));
    await expect(storage.pruneStaleEdges(1000 * 60 * 60)).resolves.toBeTypeOf('number');
  });

  it('calls zremrangebyscore for edges older than cutoff', async () => {
    const zremSpy = vi.spyOn(redis, 'zremrangebyscore');
    await storage.upsertEdge(edgePartial('a', 'b'));
    await storage.pruneStaleEdges(0);
    expect(zremSpy).toHaveBeenCalled();
  });
});

// ── clearEdges ─────────────────────────────────────────────

describe('createRedisAdapter — clearEdges', () => {
  it('removes the device edge set', async () => {
    await storage.upsertEdge(edgePartial('rm', 'other'));
    await storage.clearEdges('rm');
    expect(await storage.getEdges('rm')).toHaveLength(0);
  });

  it('does not remove unrelated device edges when clearing by id', async () => {
    await storage.upsertEdge(edgePartial('rm2', 'other2'));
    await storage.upsertEdge(edgePartial('keep-x', 'keep-y'));
    await storage.clearEdges('rm2');
    expect(await storage.getEdges('keep-x')).toHaveLength(1);
  });
});

// ── close ──────────────────────────────────────────────────

describe('createRedisAdapter — close', () => {
  it('calls redis.quit() and resolves', async () => {
    const quitSpy = vi.spyOn(redis, 'quit');
    await storage.close();
    expect(quitSpy).toHaveBeenCalled();
  });
});
