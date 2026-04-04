// ────────────────────────────────────────────────────────────
//  adapters/postgres — async PostgreSQL peer graph storage
// ────────────────────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import type { PeerDeviceCache, PeerEdge, PeerEdgeType } from '../../types.js';
import type { AsyncPeerStorage } from './inmemory.js';

/** Minimal pg-pool compatible interface to avoid a hard runtime dependency. */
export interface PgPoolLike {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
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
export function createPostgresAdapter(
  pool: PgPoolLike,
  maxEdgesPerDevice = 50,
): AsyncPeerStorage {
  function rowToEdge(row: Record<string, unknown>): PeerEdge {
    return {
      id:          row['id'] as string,
      deviceIdA:   (row['deviceida'] ?? row['deviceIdA']) as string,
      deviceIdB:   (row['deviceidb'] ?? row['deviceIdB']) as string,
      edgeType:    (row['edgetype']  ?? row['edgeType'])  as PeerEdgeType,
      signalValue: (row['signalvalue'] ?? row['signalValue']) as string,
      weight:      row['weight'] as number,
      occurrences: row['occurrences'] as number,
      firstSeen:   new Date(row['firstseen'] as string ?? row['firstSeen'] as string),
      lastSeen:    new Date(row['lastseen']  as string ?? row['lastSeen']  as string),
    };
  }

  function rowToCache(row: Record<string, unknown>): PeerDeviceCache {
    const flagReasons = Array.isArray(row['flagreasons'] ?? row['flagReasons'])
      ? (row['flagreasons'] ?? row['flagReasons']) as string[]
      : JSON.parse((row['flagreasons'] ?? row['flagReasons']) as string) as string[];
    return {
      deviceId:       (row['deviceid'] ?? row['deviceId']) as string,
      updatedAt:      new Date(row['updatedat'] as string ?? row['updatedAt'] as string),
      ipRisk:         row['iprisk'] != null ? (row['iprisk'] as number) : undefined,
      tlsConsistency: row['tlsconsistency'] != null ? (row['tlsconsistency'] as number) : undefined,
      driftScore:     row['driftscore'] != null ? (row['driftscore'] as number) : undefined,
      flagReasons,
    };
  }

  return {
    async init(): Promise<void> {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS peer_edges (
          id           TEXT PRIMARY KEY,
          deviceIdA    TEXT        NOT NULL,
          deviceIdB    TEXT        NOT NULL,
          edgeType     TEXT        NOT NULL,
          signalValue  TEXT        NOT NULL,
          weight       DOUBLE PRECISION NOT NULL,
          occurrences  INTEGER     NOT NULL DEFAULT 1,
          firstSeen    TIMESTAMPTZ NOT NULL,
          lastSeen     TIMESTAMPTZ NOT NULL,
          UNIQUE(deviceIdA, deviceIdB, edgeType, signalValue)
        )
      `);
      await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_peer_edges_a ON peer_edges(deviceIdA, lastSeen DESC)',
      );
      await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_peer_edges_b ON peer_edges(deviceIdB, lastSeen DESC)',
      );
      await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_peer_edges_signal ON peer_edges(edgeType, signalValue)',
      );
      await pool.query(`
        CREATE TABLE IF NOT EXISTS peer_device_cache (
          deviceId       TEXT PRIMARY KEY,
          updatedAt      TIMESTAMPTZ NOT NULL,
          ipRisk         DOUBLE PRECISION,
          tlsConsistency DOUBLE PRECISION,
          driftScore     DOUBLE PRECISION,
          flagReasons    JSONB NOT NULL DEFAULT '[]'
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS peer_device_signals (
          deviceId    TEXT        NOT NULL,
          edgeType    TEXT        NOT NULL,
          signalValue TEXT        NOT NULL,
          seenAt      TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (deviceId, edgeType, signalValue)
        )
      `);
      await pool.query(
        'CREATE INDEX IF NOT EXISTS idx_peer_signals ON peer_device_signals(edgeType, signalValue)',
      );
    },

    async upsertEdge(partial): Promise<PeerEdge> {
      const id  = randomUUID();
      const now = new Date();
      const ts  = partial.firstSeen instanceof Date ? partial.firstSeen : now;
      await pool.query(
        `INSERT INTO peer_edges
           (id, deviceIdA, deviceIdB, edgeType, signalValue, weight, occurrences, firstSeen, lastSeen)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
         ON CONFLICT(deviceIdA, deviceIdB, edgeType, signalValue)
         DO UPDATE SET occurrences = peer_edges.occurrences + 1, lastSeen = excluded.lastSeen`,
        [id, partial.deviceIdA, partial.deviceIdB, partial.edgeType, partial.signalValue,
         partial.weight, ts, now],
      );

      // Trim edges beyond cap for deviceIdA
      await pool.query(
        `DELETE FROM peer_edges
         WHERE deviceIdA = $1
         AND id NOT IN (
           SELECT id FROM peer_edges WHERE deviceIdA = $1 ORDER BY lastSeen DESC LIMIT $2
         )`,
        [partial.deviceIdA, maxEdgesPerDevice],
      );

      const res = await pool.query(
        `SELECT * FROM peer_edges
         WHERE deviceIdA = $1 AND deviceIdB = $2 AND edgeType = $3 AND signalValue = $4`,
        [partial.deviceIdA, partial.deviceIdB, partial.edgeType, partial.signalValue],
      );
      return rowToEdge(res.rows[0]);
    },

    async getEdges(deviceId, limit = 50): Promise<PeerEdge[]> {
      const res = await pool.query(
        `SELECT * FROM peer_edges
         WHERE deviceIdA = $1 OR deviceIdB = $1
         ORDER BY lastSeen DESC LIMIT $2`,
        [deviceId, limit],
      );
      return res.rows.map(rowToEdge);
    },

    async findPeersBySignal(edgeType, signalValue, limit = 100): Promise<string[]> {
      const res = await pool.query(
        `SELECT deviceIdA, deviceIdB FROM peer_edges
         WHERE edgeType = $1 AND signalValue = $2 LIMIT $3`,
        [edgeType, signalValue, limit * 2],
      );
      const ids = res.rows.flatMap((r) => [
        (r['deviceida'] ?? r['deviceIdA']) as string,
        (r['deviceidb'] ?? r['deviceIdB']) as string,
      ]);
      return [...new Set(ids)].slice(0, limit);
    },

    async registerDeviceSignal(deviceId, edgeType, signalValue): Promise<string[]> {
      await pool.query(
        `INSERT INTO peer_device_signals (deviceId, edgeType, signalValue, seenAt)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT(deviceId, edgeType, signalValue) DO UPDATE SET seenAt = excluded.seenAt`,
        [deviceId, edgeType, signalValue],
      );
      const res = await pool.query(
        'SELECT deviceId FROM peer_device_signals WHERE edgeType = $1 AND signalValue = $2 AND deviceId != $3',
        [edgeType, signalValue, deviceId],
      );
      return res.rows.map((r) => (r['deviceid'] ?? r['deviceId']) as string);
    },

    async saveDeviceCache(cache): Promise<void> {
      await pool.query(
        `INSERT INTO peer_device_cache (deviceId, updatedAt, ipRisk, tlsConsistency, driftScore, flagReasons)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(deviceId)
         DO UPDATE SET updatedAt = excluded.updatedAt, ipRisk = excluded.ipRisk,
                       tlsConsistency = excluded.tlsConsistency, driftScore = excluded.driftScore,
                       flagReasons = excluded.flagReasons`,
        [
          cache.deviceId, cache.updatedAt,
          cache.ipRisk ?? null, cache.tlsConsistency ?? null, cache.driftScore ?? null,
          JSON.stringify(cache.flagReasons),
        ],
      );
    },

    async getDeviceCache(deviceId): Promise<PeerDeviceCache | null> {
      const res = await pool.query(
        'SELECT * FROM peer_device_cache WHERE deviceId = $1',
        [deviceId],
      );
      return res.rows[0] ? rowToCache(res.rows[0]) : null;
    },

    async size(): Promise<number> {
      const res = await pool.query(
        `SELECT COUNT(*) AS n FROM (
           SELECT deviceIdA AS d FROM peer_edges
           UNION SELECT deviceIdB FROM peer_edges
         ) sub`,
      );
      return Number(res.rows[0].n);
    },

    async pruneStaleEdges(olderThanMs): Promise<number> {
      const cutoff = new Date(Date.now() - olderThanMs);
      const res = await pool.query(
        'DELETE FROM peer_edges WHERE lastSeen < $1',
        [cutoff],
      );
      return (res as unknown as { rowCount: number }).rowCount ?? 0;
    },

    async clearEdges(deviceId?: string): Promise<void> {
      if (deviceId !== undefined) {
        await pool.query(
          'DELETE FROM peer_edges WHERE deviceIdA = $1 OR deviceIdB = $1',
          [deviceId],
        );
      } else {
        await pool.query('DELETE FROM peer_edges');
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
