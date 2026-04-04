import type { AsyncPeerStorage } from './inmemory.js';
/** Minimal pg-pool compatible interface to avoid a hard runtime dependency. */
export interface PgPoolLike {
    query(sql: string, values?: unknown[]): Promise<{
        rows: Record<string, unknown>[];
    }>;
    end(): Promise<void>;
}
/**
 * Create an {@link AsyncPeerStorage} backed by PostgreSQL.
 *
 * Two tables are created automatically on `init()`:
 * - `peer_edges`        — edge graph with ON CONFLICT upsert
 * - `peer_device_cache` — latest reputation signals per device (JSONB)
 *
 * @param pool           - A `pg.Pool` instance (or compatible).
 * @param maxEdgesPerDevice - Maximum edges retained per device side. Default: `50`.
 */
export declare function createPostgresAdapter(pool: PgPoolLike, maxEdgesPerDevice?: number): AsyncPeerStorage;
//# sourceMappingURL=postgres.d.ts.map