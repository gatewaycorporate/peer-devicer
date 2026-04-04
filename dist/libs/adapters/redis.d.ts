import type { AsyncPeerStorage } from './inmemory.js';
/** Minimal ioredis-compatible interface. */
export interface RedisLike {
    connect(): Promise<void>;
    zadd(key: string, score: number, member: string): Promise<number>;
    zrevrange(key: string, start: number, stop: number): Promise<string[]>;
    zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]>;
    zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number>;
    zremrangebyrank(key: string, start: number, stop: number): Promise<number>;
    zcard(key: string): Promise<number>;
    hset(key: string, ...args: (string | number)[]): Promise<number>;
    hget(key: string, field: string): Promise<string | null>;
    hgetall(key: string): Promise<Record<string, string> | null>;
    del(...keys: string[]): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    scan(cursor: string, matchKey: string, pattern: string, countKey: string, count: string): Promise<[string, string[]]>;
    quit(): Promise<string>;
}
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
export declare function createRedisAdapter(redis: RedisLike, maxEdgesPerDevice?: number, ttlSeconds?: number): AsyncPeerStorage;
//# sourceMappingURL=redis.d.ts.map