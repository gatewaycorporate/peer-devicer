// ────────────────────────────────────────────────────────────
//  adapters/postgres — async PostgreSQL peer graph storage
// ────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
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
export function createPostgresAdapter(pool, maxEdgesPerDevice = 50) {
    function rowToEdge(row) {
        return {
            id: row['id'],
            deviceIdA: (row['deviceida'] ?? row['deviceIdA']),
            deviceIdB: (row['deviceidb'] ?? row['deviceIdB']),
            edgeType: (row['edgetype'] ?? row['edgeType']),
            signalValue: (row['signalvalue'] ?? row['signalValue']),
            weight: row['weight'],
            occurrences: row['occurrences'],
            firstSeen: new Date(row['firstseen'] ?? row['firstSeen']),
            lastSeen: new Date(row['lastseen'] ?? row['lastSeen']),
        };
    }
    function rowToCache(row) {
        const flagReasons = Array.isArray(row['flagreasons'] ?? row['flagReasons'])
            ? (row['flagreasons'] ?? row['flagReasons'])
            : JSON.parse((row['flagreasons'] ?? row['flagReasons']));
        return {
            deviceId: (row['deviceid'] ?? row['deviceId']),
            updatedAt: new Date(row['updatedat'] ?? row['updatedAt']),
            ipRisk: row['iprisk'] != null ? row['iprisk'] : undefined,
            tlsConsistency: row['tlsconsistency'] != null ? row['tlsconsistency'] : undefined,
            driftScore: row['driftscore'] != null ? row['driftscore'] : undefined,
            flagReasons,
        };
    }
    return {
        async init() {
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
            await pool.query('CREATE INDEX IF NOT EXISTS idx_peer_edges_a ON peer_edges(deviceIdA, lastSeen DESC)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_peer_edges_b ON peer_edges(deviceIdB, lastSeen DESC)');
            await pool.query('CREATE INDEX IF NOT EXISTS idx_peer_edges_signal ON peer_edges(edgeType, signalValue)');
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
            await pool.query('CREATE INDEX IF NOT EXISTS idx_peer_signals ON peer_device_signals(edgeType, signalValue)');
        },
        async upsertEdge(partial) {
            const id = randomUUID();
            const now = new Date();
            const ts = partial.firstSeen instanceof Date ? partial.firstSeen : now;
            await pool.query(`INSERT INTO peer_edges
           (id, deviceIdA, deviceIdB, edgeType, signalValue, weight, occurrences, firstSeen, lastSeen)
         VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)
         ON CONFLICT(deviceIdA, deviceIdB, edgeType, signalValue)
         DO UPDATE SET occurrences = peer_edges.occurrences + 1, lastSeen = excluded.lastSeen`, [id, partial.deviceIdA, partial.deviceIdB, partial.edgeType, partial.signalValue,
                partial.weight, ts, now]);
            // Trim edges beyond cap for deviceIdA
            await pool.query(`DELETE FROM peer_edges
         WHERE deviceIdA = $1
         AND id NOT IN (
           SELECT id FROM peer_edges WHERE deviceIdA = $1 ORDER BY lastSeen DESC LIMIT $2
         )`, [partial.deviceIdA, maxEdgesPerDevice]);
            const res = await pool.query(`SELECT * FROM peer_edges
         WHERE deviceIdA = $1 AND deviceIdB = $2 AND edgeType = $3 AND signalValue = $4`, [partial.deviceIdA, partial.deviceIdB, partial.edgeType, partial.signalValue]);
            return rowToEdge(res.rows[0]);
        },
        async getEdges(deviceId, limit = 50) {
            const res = await pool.query(`SELECT * FROM peer_edges
         WHERE deviceIdA = $1 OR deviceIdB = $1
         ORDER BY lastSeen DESC LIMIT $2`, [deviceId, limit]);
            return res.rows.map(rowToEdge);
        },
        async findPeersBySignal(edgeType, signalValue, limit = 100) {
            const res = await pool.query(`SELECT deviceIdA, deviceIdB FROM peer_edges
         WHERE edgeType = $1 AND signalValue = $2 LIMIT $3`, [edgeType, signalValue, limit * 2]);
            const ids = res.rows.flatMap((r) => [
                (r['deviceida'] ?? r['deviceIdA']),
                (r['deviceidb'] ?? r['deviceIdB']),
            ]);
            return [...new Set(ids)].slice(0, limit);
        },
        async registerDeviceSignal(deviceId, edgeType, signalValue) {
            await pool.query(`INSERT INTO peer_device_signals (deviceId, edgeType, signalValue, seenAt)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT(deviceId, edgeType, signalValue) DO UPDATE SET seenAt = excluded.seenAt`, [deviceId, edgeType, signalValue]);
            const res = await pool.query('SELECT deviceId FROM peer_device_signals WHERE edgeType = $1 AND signalValue = $2 AND deviceId != $3', [edgeType, signalValue, deviceId]);
            return res.rows.map((r) => (r['deviceid'] ?? r['deviceId']));
        },
        async saveDeviceCache(cache) {
            await pool.query(`INSERT INTO peer_device_cache (deviceId, updatedAt, ipRisk, tlsConsistency, driftScore, flagReasons)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(deviceId)
         DO UPDATE SET updatedAt = excluded.updatedAt, ipRisk = excluded.ipRisk,
                       tlsConsistency = excluded.tlsConsistency, driftScore = excluded.driftScore,
                       flagReasons = excluded.flagReasons`, [
                cache.deviceId, cache.updatedAt,
                cache.ipRisk ?? null, cache.tlsConsistency ?? null, cache.driftScore ?? null,
                JSON.stringify(cache.flagReasons),
            ]);
        },
        async getDeviceCache(deviceId) {
            const res = await pool.query('SELECT * FROM peer_device_cache WHERE deviceId = $1', [deviceId]);
            return res.rows[0] ? rowToCache(res.rows[0]) : null;
        },
        async size() {
            const res = await pool.query(`SELECT COUNT(*) AS n FROM (
           SELECT deviceIdA AS d FROM peer_edges
           UNION SELECT deviceIdB FROM peer_edges
         ) sub`);
            return Number(res.rows[0].n);
        },
        async pruneStaleEdges(olderThanMs) {
            const cutoff = new Date(Date.now() - olderThanMs);
            const res = await pool.query('DELETE FROM peer_edges WHERE lastSeen < $1', [cutoff]);
            return res.rowCount ?? 0;
        },
        async clearEdges(deviceId) {
            if (deviceId !== undefined) {
                await pool.query('DELETE FROM peer_edges WHERE deviceIdA = $1 OR deviceIdB = $1', [deviceId]);
            }
            else {
                await pool.query('DELETE FROM peer_edges');
            }
        },
        async close() {
            await pool.end();
        },
    };
}
//# sourceMappingURL=postgres.js.map