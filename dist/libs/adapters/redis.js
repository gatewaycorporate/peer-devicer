// ────────────────────────────────────────────────────────────
//  adapters/redis — async Redis peer graph storage (ioredis)
// ────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
/**
 * Create an {@link AsyncPeerStorage} backed by Redis via `ioredis`.
 *
 * **Key schema**
 * - `peer:edges:<deviceId>` — Sorted set, score = `lastSeen` ms, members = JSON `PeerEdge`.
 * - `peer:signal:<edgeType>:<signalValue>` — Sorted set, score = `lastSeen` ms, members = `deviceIdA||deviceIdB` pairs.
 * - `peer:cache:<deviceId>` — Hash with reputation fields.
 *
 * @param redis      - An ioredis `Redis` instance (or compatible).
 * @param maxEdgesPerDevice - Maximum edges per device set. Default: 50.
 * @param ttlSeconds - TTL for device edge sets. Default: 90 days.
 */
export function createRedisAdapter(redis, maxEdgesPerDevice = 50, ttlSeconds = 60 * 60 * 24 * 90) {
    function deviceEdgeKey(deviceId) {
        return `peer:edges:${deviceId}`;
    }
    function signalKey(edgeType, signalValue) {
        return `peer:signal:${edgeType}:${signalValue}`;
    }
    /** Key schema for the device-registration signal index (separate from edge pair index). */
    function signalDevKey(edgeType, signalValue) {
        return `peer:sigdev:${edgeType}:${signalValue}`;
    }
    function cacheKey(deviceId) {
        return `peer:cache:${deviceId}`;
    }
    function parseEdge(raw) {
        const e = JSON.parse(raw);
        return { ...e, firstSeen: new Date(e.firstSeen), lastSeen: new Date(e.lastSeen) };
    }
    return {
        async init() {
            await redis.connect();
        },
        async upsertEdge(partial) {
            const now = new Date();
            const score = now.getTime();
            // Check for existing in deviceIdA set
            const existingRaws = await redis.zrevrange(deviceEdgeKey(partial.deviceIdA), 0, -1);
            const matchRaw = existingRaws.find((r) => {
                try {
                    const e = parseEdge(r);
                    return e.deviceIdB === partial.deviceIdB &&
                        e.edgeType === partial.edgeType &&
                        e.signalValue === partial.signalValue;
                }
                catch {
                    return false;
                }
            });
            let edge;
            if (matchRaw) {
                const existing = parseEdge(matchRaw);
                edge = { ...existing, occurrences: existing.occurrences + 1, lastSeen: now };
                // Remove old entry then re-add with updated score
                await redis.zremrangebyscore(deviceEdgeKey(partial.deviceIdA), existing.lastSeen.getTime(), existing.lastSeen.getTime());
            }
            else {
                edge = { ...partial, id: randomUUID(), lastSeen: now };
            }
            const serialised = JSON.stringify(edge);
            await redis.zadd(deviceEdgeKey(partial.deviceIdA), score, serialised);
            await redis.expire(deviceEdgeKey(partial.deviceIdA), ttlSeconds);
            await redis.zadd(deviceEdgeKey(partial.deviceIdB), score, serialised);
            await redis.expire(deviceEdgeKey(partial.deviceIdB), ttlSeconds);
            // Signal index: store deviceIdA||deviceIdB pair
            const pairMember = `${partial.deviceIdA}||${partial.deviceIdB}`;
            await redis.zadd(signalKey(partial.edgeType, partial.signalValue), score, pairMember);
            await redis.expire(signalKey(partial.edgeType, partial.signalValue), ttlSeconds);
            // Trim cap
            for (const devId of [partial.deviceIdA, partial.deviceIdB]) {
                const count = await redis.zcard(deviceEdgeKey(devId));
                if (count > maxEdgesPerDevice) {
                    await redis.zremrangebyrank(deviceEdgeKey(devId), 0, count - maxEdgesPerDevice - 1);
                }
            }
            return edge;
        },
        async getEdges(deviceId, limit = 50) {
            const raws = await redis.zrevrange(deviceEdgeKey(deviceId), 0, limit - 1);
            return raws.map(parseEdge);
        },
        async findPeersBySignal(edgeType, signalValue, limit = 100) {
            const pairs = await redis.zrevrange(signalKey(edgeType, signalValue), 0, limit * 2 - 1);
            const ids = [];
            for (const pair of pairs) {
                const [a, b] = pair.split('||');
                if (a)
                    ids.push(a);
                if (b)
                    ids.push(b);
            }
            return [...new Set(ids)].slice(0, limit);
        },
        async registerDeviceSignal(deviceId, edgeType, signalValue) {
            const key = signalDevKey(edgeType, signalValue);
            const score = Date.now();
            await redis.zadd(key, score, deviceId);
            await redis.expire(key, ttlSeconds);
            const members = await redis.zrevrange(key, 0, -1);
            return members.filter((m) => m !== deviceId);
        },
        async saveDeviceCache(cache) {
            const key = cacheKey(cache.deviceId);
            await redis.hset(key, 'deviceId', cache.deviceId, 'updatedAt', cache.updatedAt.toISOString(), 'ipRisk', cache.ipRisk ?? '', 'tlsConsistency', cache.tlsConsistency ?? '', 'driftScore', cache.driftScore ?? '', 'flagReasons', JSON.stringify(cache.flagReasons));
            await redis.expire(key, ttlSeconds);
        },
        async getDeviceCache(deviceId) {
            const data = await redis.hgetall(cacheKey(deviceId));
            if (!data)
                return null;
            return {
                deviceId: data['deviceId'],
                updatedAt: new Date(data['updatedAt']),
                ipRisk: data['ipRisk'] ? Number(data['ipRisk']) : undefined,
                tlsConsistency: data['tlsConsistency'] ? Number(data['tlsConsistency']) : undefined,
                driftScore: data['driftScore'] ? Number(data['driftScore']) : undefined,
                flagReasons: JSON.parse(data['flagReasons'] ?? '[]'),
            };
        },
        async size() {
            let cursor = '0';
            const keys = new Set();
            do {
                const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', 'peer:edges:*', 'COUNT', '100');
                cursor = nextCursor;
                for (const k of batch)
                    keys.add(k.replace('peer:edges:', ''));
            } while (cursor !== '0');
            return keys.size;
        },
        async pruneStaleEdges(olderThanMs) {
            const cutoff = Date.now() - olderThanMs;
            let cursor = '0';
            let removed = 0;
            do {
                const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'peer:edges:*', 'COUNT', '100');
                cursor = nextCursor;
                for (const key of keys) {
                    removed += await redis.zremrangebyscore(key, 0, cutoff);
                }
            } while (cursor !== '0');
            return removed;
        },
        async clearEdges(deviceId) {
            if (deviceId !== undefined) {
                await redis.del(deviceEdgeKey(deviceId));
            }
            else {
                let cursor = '0';
                const toDelete = [];
                do {
                    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'peer:edges:*', 'COUNT', '100');
                    cursor = nextCursor;
                    toDelete.push(...keys);
                } while (cursor !== '0');
                if (toDelete.length > 0)
                    await redis.del(...toDelete);
            }
        },
        async close() {
            await redis.quit();
        },
    };
}
//# sourceMappingURL=redis.js.map