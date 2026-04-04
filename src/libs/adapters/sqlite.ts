// ────────────────────────────────────────────────────────────
//  adapters/sqlite — SQLite peer graph storage (better-sqlite3)
// ────────────────────────────────────────────────────────────

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { PeerDeviceCache, PeerEdge, PeerEdgeType } from '../../types.js';
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
export function createSqliteAdapter(
  dbPath: string = ':memory:',
  maxEdgesPerDevice = 50,
): PeerStorage {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS peer_edges (
      id           TEXT PRIMARY KEY,
      deviceIdA    TEXT NOT NULL,
      deviceIdB    TEXT NOT NULL,
      edgeType     TEXT NOT NULL,
      signalValue  TEXT NOT NULL,
      weight       REAL NOT NULL,
      occurrences  INTEGER NOT NULL DEFAULT 1,
      firstSeen    TEXT NOT NULL,
      lastSeen     TEXT NOT NULL,
      UNIQUE(deviceIdA, deviceIdB, edgeType, signalValue)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_peer_edges_a ON peer_edges(deviceIdA, lastSeen DESC);
    CREATE INDEX IF NOT EXISTS idx_peer_edges_b ON peer_edges(deviceIdB, lastSeen DESC);
    CREATE INDEX IF NOT EXISTS idx_peer_edges_signal ON peer_edges(edgeType, signalValue);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS peer_device_cache (
      deviceId      TEXT PRIMARY KEY,
      updatedAt     TEXT NOT NULL,
      ipRisk        REAL,
      tlsConsistency REAL,
      driftScore    REAL,
      flagReasons   TEXT NOT NULL DEFAULT '[]'
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS peer_device_signals (
      deviceId    TEXT NOT NULL,
      edgeType    TEXT NOT NULL,
      signalValue TEXT NOT NULL,
      seenAt      TEXT NOT NULL,
      PRIMARY KEY (deviceId, edgeType, signalValue)
    )
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_peer_signals ON peer_device_signals(edgeType, signalValue)',
  );

  const stmtInsertEdge = db.prepare(`
    INSERT INTO peer_edges (id, deviceIdA, deviceIdB, edgeType, signalValue, weight, occurrences, firstSeen, lastSeen)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(deviceIdA, deviceIdB, edgeType, signalValue)
    DO UPDATE SET occurrences = occurrences + 1, lastSeen = excluded.lastSeen
  `);
  const stmtGetEdge = db.prepare(
    'SELECT * FROM peer_edges WHERE (deviceIdA = ? OR deviceIdB = ?) ORDER BY lastSeen DESC',
  );
  const stmtGetEdgeLimit = db.prepare(
    'SELECT * FROM peer_edges WHERE (deviceIdA = ? OR deviceIdB = ?) ORDER BY lastSeen DESC LIMIT ?',
  );
  const stmtFindPeers = db.prepare(
    'SELECT deviceIdA, deviceIdB FROM peer_edges WHERE edgeType = ? AND signalValue = ?',
  );
  const stmtFindPeersLimit = db.prepare(
    'SELECT deviceIdA, deviceIdB FROM peer_edges WHERE edgeType = ? AND signalValue = ? LIMIT ?',
  );
  const stmtRegisterSignal = db.prepare(`
    INSERT INTO peer_device_signals (deviceId, edgeType, signalValue, seenAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(deviceId, edgeType, signalValue) DO UPDATE SET seenAt = excluded.seenAt
  `);
  const stmtFindDevicesBySignal = db.prepare(
    'SELECT deviceId FROM peer_device_signals WHERE edgeType = ? AND signalValue = ? AND deviceId != ?',
  );
  const stmtUpsertCache = db.prepare(`
    INSERT INTO peer_device_cache (deviceId, updatedAt, ipRisk, tlsConsistency, driftScore, flagReasons)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(deviceId)
    DO UPDATE SET updatedAt = excluded.updatedAt, ipRisk = excluded.ipRisk,
                  tlsConsistency = excluded.tlsConsistency, driftScore = excluded.driftScore,
                  flagReasons = excluded.flagReasons
  `);
  const stmtGetCache = db.prepare('SELECT * FROM peer_device_cache WHERE deviceId = ?');
  const stmtSize = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT deviceIdA AS d FROM peer_edges
      UNION SELECT deviceIdB FROM peer_edges
    )
  `);
  const stmtPrune = db.prepare('DELETE FROM peer_edges WHERE lastSeen < ?');
  const stmtClearAll = db.prepare('DELETE FROM peer_edges');
  const stmtClearDevice = db.prepare('DELETE FROM peer_edges WHERE deviceIdA = ? OR deviceIdB = ?');
  const stmtGetEdgeById = db.prepare('SELECT * FROM peer_edges WHERE id = ?');

  function rowToEdge(row: Record<string, unknown>): PeerEdge {
    return {
      id:          row['id'] as string,
      deviceIdA:   row['deviceIdA'] as string,
      deviceIdB:   row['deviceIdB'] as string,
      edgeType:    row['edgeType'] as PeerEdgeType,
      signalValue: row['signalValue'] as string,
      weight:      row['weight'] as number,
      occurrences: row['occurrences'] as number,
      firstSeen:   new Date(row['firstSeen'] as string),
      lastSeen:    new Date(row['lastSeen'] as string),
    };
  }

  function rowToCache(row: Record<string, unknown>): PeerDeviceCache {
    return {
      deviceId:      row['deviceId'] as string,
      updatedAt:     new Date(row['updatedAt'] as string),
      ipRisk:        row['ipRisk'] != null ? (row['ipRisk'] as number) : undefined,
      tlsConsistency: row['tlsConsistency'] != null ? (row['tlsConsistency'] as number) : undefined,
      driftScore:    row['driftScore'] != null ? (row['driftScore'] as number) : undefined,
      flagReasons:   JSON.parse(row['flagReasons'] as string) as string[],
    };
  }

  return {
    upsertEdge(partial): PeerEdge {
      const id = randomUUID();
      const now = new Date().toISOString();
      const ts = partial.firstSeen instanceof Date ? partial.firstSeen.toISOString() : now;
      stmtInsertEdge.run(
        id,
        partial.deviceIdA, partial.deviceIdB,
        partial.edgeType, partial.signalValue,
        partial.weight, ts, now,
      );
      // Retrieve the current row (may be the upserted one if conflict occurred)
      const rows = (stmtGetEdge.all(partial.deviceIdA, partial.deviceIdA) as Record<string, unknown>[])
        .filter((r) =>
          r['deviceIdA'] === partial.deviceIdA &&
          r['deviceIdB'] === partial.deviceIdB &&
          r['edgeType'] === partial.edgeType &&
          r['signalValue'] === partial.signalValue,
        );
      const row = rows[0] ?? stmtGetEdgeById.get(id) as Record<string, unknown>;

      // Prune beyond cap
      const allA = stmtGetEdgeLimit.all(partial.deviceIdA, partial.deviceIdA, maxEdgesPerDevice + 1) as Record<string, unknown>[];
      if (allA.length > maxEdgesPerDevice) {
        const excess = allA.slice(maxEdgesPerDevice);
        for (const e of excess) {
          db.prepare('DELETE FROM peer_edges WHERE id = ?').run(e['id']);
        }
      }

      return rowToEdge(row);
    },

    getEdges(deviceId, limit): PeerEdge[] {
      const rows = limit !== undefined
        ? (stmtGetEdgeLimit.all(deviceId, deviceId, limit) as Record<string, unknown>[])
        : (stmtGetEdge.all(deviceId, deviceId) as Record<string, unknown>[]);
      return rows.map(rowToEdge);
    },

    findPeersBySignal(edgeType, signalValue, limit): string[] {
      const rows = limit !== undefined
        ? (stmtFindPeersLimit.all(edgeType, signalValue, limit * 2) as Record<string, unknown>[])
        : (stmtFindPeers.all(edgeType, signalValue) as Record<string, unknown>[]);
      const ids: string[] = [];
      for (const r of rows) {
        ids.push(r['deviceIdA'] as string, r['deviceIdB'] as string);
      }
      const unique = [...new Set(ids)];
      return limit !== undefined ? unique.slice(0, limit) : unique;
    },

    registerDeviceSignal(deviceId, edgeType, signalValue): string[] {
      stmtRegisterSignal.run(deviceId, edgeType, signalValue, new Date().toISOString());
      const rows = stmtFindDevicesBySignal.all(edgeType, signalValue, deviceId) as Record<string, unknown>[];
      return rows.map((r) => r['deviceId'] as string);
    },

    saveDeviceCache(cache): void {
      stmtUpsertCache.run(
        cache.deviceId,
        cache.updatedAt.toISOString(),
        cache.ipRisk ?? null,
        cache.tlsConsistency ?? null,
        cache.driftScore ?? null,
        JSON.stringify(cache.flagReasons),
      );
    },

    getDeviceCache(deviceId): PeerDeviceCache | null {
      const row = stmtGetCache.get(deviceId) as Record<string, unknown> | undefined;
      return row ? rowToCache(row) : null;
    },

    size(): number {
      const row = stmtSize.get() as { n: number };
      return row.n;
    },

    pruneStaleEdges(olderThanMs): number {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const result = stmtPrune.run(cutoff);
      return result.changes;
    },

    clearEdges(deviceId?: string): void {
      if (deviceId !== undefined) {
        stmtClearDevice.run(deviceId, deviceId);
      } else {
        stmtClearAll.run();
      }
    },
  };
}
