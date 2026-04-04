// ────────────────────────────────────────────────────────────
//  adapters/sqlite — SQLite peer graph storage (better-sqlite3)
// ────────────────────────────────────────────────────────────
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
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
export function createSqliteAdapter(dbPath = ':memory:', maxEdgesPerDevice = 50) {
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
    db.exec('CREATE INDEX IF NOT EXISTS idx_peer_signals ON peer_device_signals(edgeType, signalValue)');
    const stmtInsertEdge = db.prepare(`
    INSERT INTO peer_edges (id, deviceIdA, deviceIdB, edgeType, signalValue, weight, occurrences, firstSeen, lastSeen)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(deviceIdA, deviceIdB, edgeType, signalValue)
    DO UPDATE SET occurrences = occurrences + 1, lastSeen = excluded.lastSeen
  `);
    const stmtGetEdge = db.prepare('SELECT * FROM peer_edges WHERE (deviceIdA = ? OR deviceIdB = ?) ORDER BY lastSeen DESC');
    const stmtGetEdgeLimit = db.prepare('SELECT * FROM peer_edges WHERE (deviceIdA = ? OR deviceIdB = ?) ORDER BY lastSeen DESC LIMIT ?');
    const stmtFindPeers = db.prepare('SELECT deviceIdA, deviceIdB FROM peer_edges WHERE edgeType = ? AND signalValue = ?');
    const stmtFindPeersLimit = db.prepare('SELECT deviceIdA, deviceIdB FROM peer_edges WHERE edgeType = ? AND signalValue = ? LIMIT ?');
    const stmtRegisterSignal = db.prepare(`
    INSERT INTO peer_device_signals (deviceId, edgeType, signalValue, seenAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(deviceId, edgeType, signalValue) DO UPDATE SET seenAt = excluded.seenAt
  `);
    const stmtFindDevicesBySignal = db.prepare('SELECT deviceId FROM peer_device_signals WHERE edgeType = ? AND signalValue = ? AND deviceId != ?');
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
    function rowToEdge(row) {
        return {
            id: row['id'],
            deviceIdA: row['deviceIdA'],
            deviceIdB: row['deviceIdB'],
            edgeType: row['edgeType'],
            signalValue: row['signalValue'],
            weight: row['weight'],
            occurrences: row['occurrences'],
            firstSeen: new Date(row['firstSeen']),
            lastSeen: new Date(row['lastSeen']),
        };
    }
    function rowToCache(row) {
        return {
            deviceId: row['deviceId'],
            updatedAt: new Date(row['updatedAt']),
            ipRisk: row['ipRisk'] != null ? row['ipRisk'] : undefined,
            tlsConsistency: row['tlsConsistency'] != null ? row['tlsConsistency'] : undefined,
            driftScore: row['driftScore'] != null ? row['driftScore'] : undefined,
            flagReasons: JSON.parse(row['flagReasons']),
        };
    }
    return {
        upsertEdge(partial) {
            const id = randomUUID();
            const now = new Date().toISOString();
            const ts = partial.firstSeen instanceof Date ? partial.firstSeen.toISOString() : now;
            stmtInsertEdge.run(id, partial.deviceIdA, partial.deviceIdB, partial.edgeType, partial.signalValue, partial.weight, ts, now);
            // Retrieve the current row (may be the upserted one if conflict occurred)
            const rows = stmtGetEdge.all(partial.deviceIdA, partial.deviceIdA)
                .filter((r) => r['deviceIdA'] === partial.deviceIdA &&
                r['deviceIdB'] === partial.deviceIdB &&
                r['edgeType'] === partial.edgeType &&
                r['signalValue'] === partial.signalValue);
            const row = rows[0] ?? stmtGetEdgeById.get(id);
            // Prune beyond cap
            const allA = stmtGetEdgeLimit.all(partial.deviceIdA, partial.deviceIdA, maxEdgesPerDevice + 1);
            if (allA.length > maxEdgesPerDevice) {
                const excess = allA.slice(maxEdgesPerDevice);
                for (const e of excess) {
                    db.prepare('DELETE FROM peer_edges WHERE id = ?').run(e['id']);
                }
            }
            return rowToEdge(row);
        },
        getEdges(deviceId, limit) {
            const rows = limit !== undefined
                ? stmtGetEdgeLimit.all(deviceId, deviceId, limit)
                : stmtGetEdge.all(deviceId, deviceId);
            return rows.map(rowToEdge);
        },
        findPeersBySignal(edgeType, signalValue, limit) {
            const rows = limit !== undefined
                ? stmtFindPeersLimit.all(edgeType, signalValue, limit * 2)
                : stmtFindPeers.all(edgeType, signalValue);
            const ids = [];
            for (const r of rows) {
                ids.push(r['deviceIdA'], r['deviceIdB']);
            }
            const unique = [...new Set(ids)];
            return limit !== undefined ? unique.slice(0, limit) : unique;
        },
        registerDeviceSignal(deviceId, edgeType, signalValue) {
            stmtRegisterSignal.run(deviceId, edgeType, signalValue, new Date().toISOString());
            const rows = stmtFindDevicesBySignal.all(edgeType, signalValue, deviceId);
            return rows.map((r) => r['deviceId']);
        },
        saveDeviceCache(cache) {
            stmtUpsertCache.run(cache.deviceId, cache.updatedAt.toISOString(), cache.ipRisk ?? null, cache.tlsConsistency ?? null, cache.driftScore ?? null, JSON.stringify(cache.flagReasons));
        },
        getDeviceCache(deviceId) {
            const row = stmtGetCache.get(deviceId);
            return row ? rowToCache(row) : null;
        },
        size() {
            const row = stmtSize.get();
            return row.n;
        },
        pruneStaleEdges(olderThanMs) {
            const cutoff = new Date(Date.now() - olderThanMs).toISOString();
            const result = stmtPrune.run(cutoff);
            return result.changes;
        },
        clearEdges(deviceId) {
            if (deviceId !== undefined) {
                stmtClearDevice.run(deviceId, deviceId);
            }
            else {
                stmtClearAll.run();
            }
        },
    };
}
//# sourceMappingURL=sqlite.js.map