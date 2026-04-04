// ────────────────────────────────────────────────────────────
//  adapters/inmemory — in-memory peer graph storage
// ────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
// ── In-memory implementation ──────────────────────────────────
/**
 * Create an in-memory {@link PeerStorage}.
 *
 * Stores edges in a flat map keyed by canonical edge identity
 * (`deviceIdA||deviceIdB||edgeType||signalValue`) and device caches in a
 * separate map.  All data is lost when the process exits.
 *
 * @param maxEdgesPerDevice - Maximum edges retained per device side. Default: 50.
 */
export function createPeerStorage(maxEdgesPerDevice = 50) {
    /** edgeKey → PeerEdge */
    const edges = new Map();
    /** deviceId → PeerDeviceCache */
    const caches = new Map();
    /** `${edgeType}||${signalValue}` → Set<deviceId> */
    const signalRegistry = new Map();
    function edgeKey(e) {
        return `${e.deviceIdA}||${e.deviceIdB}||${e.edgeType}||${e.signalValue}`;
    }
    function edgesForDevice(deviceId) {
        const result = [];
        for (const edge of edges.values()) {
            if (edge.deviceIdA === deviceId || edge.deviceIdB === deviceId) {
                result.push(edge);
            }
        }
        return result.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
    }
    function enforcePerDeviceCap(deviceId) {
        const all = edgesForDevice(deviceId);
        if (all.length <= maxEdgesPerDevice)
            return;
        // Remove oldest edges beyond cap
        const toRemove = all.slice(maxEdgesPerDevice);
        for (const e of toRemove) {
            edges.delete(edgeKey(e));
        }
    }
    return {
        upsertEdge(partial) {
            const k = edgeKey(partial);
            const existing = edges.get(k);
            if (existing) {
                existing.occurrences += 1;
                existing.lastSeen = new Date();
                return existing;
            }
            const edge = { ...partial, id: randomUUID() };
            edges.set(k, edge);
            enforcePerDeviceCap(edge.deviceIdA);
            enforcePerDeviceCap(edge.deviceIdB);
            return edge;
        },
        getEdges(deviceId, limit) {
            const all = edgesForDevice(deviceId);
            return limit !== undefined ? all.slice(0, limit) : all;
        },
        findPeersBySignal(edgeType, signalValue, limit) {
            const peers = [];
            for (const edge of edges.values()) {
                if (edge.edgeType === edgeType && edge.signalValue === signalValue) {
                    peers.push(edge.deviceIdA, edge.deviceIdB);
                }
            }
            const unique = [...new Set(peers)];
            return limit !== undefined ? unique.slice(0, limit) : unique;
        },
        registerDeviceSignal(deviceId, edgeType, signalValue) {
            const key = `${edgeType}||${signalValue}`;
            if (!signalRegistry.has(key))
                signalRegistry.set(key, new Set());
            const devices = signalRegistry.get(key);
            devices.add(deviceId);
            return [...devices].filter((id) => id !== deviceId);
        },
        saveDeviceCache(cache) {
            caches.set(cache.deviceId, { ...cache });
        },
        getDeviceCache(deviceId) {
            return caches.get(deviceId) ?? null;
        },
        size() {
            const deviceIds = new Set();
            for (const edge of edges.values()) {
                deviceIds.add(edge.deviceIdA);
                deviceIds.add(edge.deviceIdB);
            }
            return deviceIds.size;
        },
        pruneStaleEdges(olderThanMs) {
            const cutoff = Date.now() - olderThanMs;
            let removed = 0;
            for (const [k, edge] of edges.entries()) {
                if (edge.lastSeen.getTime() < cutoff) {
                    edges.delete(k);
                    removed++;
                }
            }
            return removed;
        },
        clearEdges(deviceId) {
            if (deviceId !== undefined) {
                for (const [k, edge] of edges.entries()) {
                    if (edge.deviceIdA === deviceId || edge.deviceIdB === deviceId) {
                        edges.delete(k);
                    }
                }
            }
            else {
                edges.clear();
            }
        },
    };
}
//# sourceMappingURL=inmemory.js.map