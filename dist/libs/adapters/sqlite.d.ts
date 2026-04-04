import type { PeerStorage } from './inmemory.js';
/**
 * Create a {@link PeerStorage} backed by SQLite via `better-sqlite3`.
 *
 * Two tables are created automatically on first use:
 * - `peer_edges`        — edge graph with upsert logic
 * - `peer_device_cache` — latest reputation signals per device
 *
 * @param dbPath         - Path to the SQLite file, or `':memory:'` (default).
 * @param maxEdgesPerDevice - Maximum edges retained per device side. Default: 50.
 */
export declare function createSqliteAdapter(dbPath?: string, maxEdgesPerDevice?: number): PeerStorage;
//# sourceMappingURL=sqlite.d.ts.map