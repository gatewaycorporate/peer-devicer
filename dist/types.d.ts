/**
 * Signal categories that can link two devices in the peer graph.
 *
 * | Type              | Free | Pro/Enterprise |
 * |-------------------|------|----------------|
 * | shared_user       | ✓    | ✓              |
 * | shared_ip_subnet  | ✓    | ✓              |
 * | shared_tls_ja4    |      | ✓              |
 * | shared_canvas     |      | ✓              |
 * | shared_webgl      |      | ✓              |
 */
export type PeerEdgeType = 'shared_user' | 'shared_ip_subnet' | 'shared_tls_ja4' | 'shared_canvas' | 'shared_webgl';
/**
 * A directed (stored canonical, A < B lexicographically) relationship edge
 * between two devices detected because they share a signal value.
 */
export interface PeerEdge {
    /** Unique edge identifier (UUID). */
    id: string;
    /** First device in the canonical ordering (lexicographically smaller). */
    deviceIdA: string;
    /** Second device in the canonical ordering. */
    deviceIdB: string;
    /** Category of shared signal that produced this edge. */
    edgeType: PeerEdgeType;
    /**
     * The shared signal value.
     * e.g. `"1.2.3.0/24"` for subnet, JA4 string for TLS, raw canvas hash.
     */
    signalValue: string;
    /** Edge strength in `[0, 1]`. Higher values indicate stronger linkage. */
    weight: number;
    /** Total number of times this edge has been reinforced. */
    occurrences: number;
    /** Timestamp of first detection. */
    firstSeen: Date;
    /** Timestamp of most recent detection. */
    lastSeen: Date;
}
/**
 * Cached reputation signals for a device, populated from other
 * plugins' `enrichmentInfo.details` entries after each `identify()` call.
 *
 * Storing these allows `PeerManager` to propagate taint through the graph
 * without requiring live calls to ip-devicer or tls-devicer.
 */
export interface PeerDeviceCache {
    deviceId: string;
    /** UTC timestamp of the most recent update. */
    updatedAt: Date;
    /** IP risk score (0–100) from ip-devicer, if available. */
    ipRisk?: number;
    /** TLS consistency score (0–100) from tls-devicer, if available. */
    tlsConsistency?: number;
    /** Fingerprint drift score (0–100) from fp-devicer, if available. */
    driftScore?: number;
    /** Human-readable reasons this device node is considered suspicious. */
    flagReasons: string[];
}
/**
 * Signals extracted from the incoming request context and fingerprint payload.
 * Used to locate existing peer edges and build new ones.
 */
export interface PeerSignals {
    /** Authenticated user identifier, if available. */
    userId?: string;
    /** IPv4 /24 CIDR string derived from the client IP (e.g. `"1.2.3.0/24"`). */
    ipSubnet?: string;
    /** JA4 fingerprint string from the TLS profile context. */
    ja4?: string;
    /** Raw canvas fingerprint hash from the browser fingerprint payload. */
    canvasHash?: string;
    /** Raw WebGL fingerprint hash from the browser fingerprint payload. */
    webglHash?: string;
}
/**
 * Synchronous peer graph storage contract.
 * Implemented by the in-memory and SQLite adapters.
 */
export interface PeerStorage {
    upsertEdge(edge: Omit<PeerEdge, 'id'>): PeerEdge;
    getEdges(deviceId: string, limit?: number): PeerEdge[];
    findPeersBySignal(edgeType: PeerEdgeType, signalValue: string, limit?: number): string[];
    registerDeviceSignal(deviceId: string, edgeType: PeerEdgeType, signalValue: string): string[];
    saveDeviceCache(cache: PeerDeviceCache): void;
    getDeviceCache(deviceId: string): PeerDeviceCache | null;
    size(): number;
    pruneStaleEdges(olderThanMs: number): number;
    clearEdges(deviceId?: string): void;
}
/**
 * Async peer graph storage contract.
 * Implemented by the PostgreSQL and Redis adapters.
 */
export interface AsyncPeerStorage {
    init(): Promise<void>;
    upsertEdge(edge: Omit<PeerEdge, 'id'>): Promise<PeerEdge>;
    getEdges(deviceId: string, limit?: number): Promise<PeerEdge[]>;
    findPeersBySignal(edgeType: PeerEdgeType, signalValue: string, limit?: number): Promise<string[]>;
    registerDeviceSignal(deviceId: string, edgeType: PeerEdgeType, signalValue: string): Promise<string[]>;
    saveDeviceCache(cache: PeerDeviceCache): Promise<void>;
    getDeviceCache(deviceId: string): Promise<PeerDeviceCache | null>;
    size(): Promise<number>;
    pruneStaleEdges(olderThanMs: number): Promise<number>;
    clearEdges(deviceId?: string): Promise<void>;
    close(): Promise<void>;
}
export interface PeerManagerOptions {
    /**
     * Polar license key that unlocks Pro or Enterprise tier features.
     *
     * | Tier         | Price    | Device limit | Servers   | Edge types       |
     * |--------------|----------|--------------|-----------|------------------|
     * | Free         | $0/mo    | 10,000       | —         | user + subnet    |
     * | Pro          | $49/mo   | Unlimited    | 1 server  | all 5 types      |
     * | Enterprise   | $299/mo  | Unlimited    | Unlimited | all + custom     |
     *
     * Obtain a key at https://polar.sh.
     */
    licenseKey?: string;
    /**
     * Maximum peer edges stored per device. Default: 50 (10 on the free tier).
     * Optimistic provisioning when a key is provided — downgraded to
     * `FREE_TIER_MAX_HISTORY` if Polar rejects the key.
     */
    maxPeersPerDevice?: number;
    /**
     * Edge types to include. Defaults to all five types when not specified.
     * Free-tier callers always have `shared_tls_ja4`, `shared_canvas`, and
     * `shared_webgl` silently filtered out regardless of this setting.
     */
    enabledEdgeTypes?: PeerEdgeType[];
    /**
     * Weight applied when adjusting DeviceManager confidence. Range 0–1.
     * Default: `0.2`.
     */
    confidenceBoostWeight?: number;
    /**
     * Custom storage backend. Defaults to the built-in in-memory store.
     * Use `createSqliteAdapter`, `createPostgresAdapter`, or
     * `createRedisAdapter` to supply a persistent backend.
     *
     * Async adapters (`AsyncPeerStorage`) must be initialised separately
     * via their own `init()` before being passed here.
     */
    storage?: PeerStorage | AsyncPeerStorage;
}
/**
 * Peer reputation analysis output for a single `identify()` call.
 */
export interface PeerReputationResult {
    /** Number of distinct peer devices found via shared signals. */
    peerCount: number;
    /**
     * Aggregated taint score propagated from suspicious peers. 0–100.
     * High values indicate that many graph neighbours are themselves
     * flagged by ip, tls, or drift signals.
     */
    taintScore: number;
    /**
     * Aggregated trust score propagated from clean peers. 0–100.
     * High values indicate consistent, low-risk graph neighbours.
     */
    trustScore: number;
    /** Edges discovered or reinforced in this request. */
    peerEdges: PeerEdge[];
    /** Signals extracted from this request that were used for graph lookup. */
    signals: PeerSignals;
    /** True when this device had no edges in storage before this request. */
    isNewDevice: boolean;
    /** Human-readable anomaly signals contributing to the taint/trust assessment. */
    factors: string[];
    /**
     * Net confidence adjustment applied to the DeviceManager result.
     * Negative when taint is high; positive when trust is high.
     */
    confidenceBoost: number;
}
/**
 * Context object attached as the second argument to `deviceManager.identify()`.
 * peer-devicer reads its signals from here alongside the raw fingerprint payload.
 */
export interface PeerIdentifyContext {
    /** Client IP address. Used to derive the `/24` subnet edge signal. */
    ip?: string;
    /** Authenticated user identifier. Used for `shared_user` edges. */
    userId?: string;
    /** TLS profile (set by tls-devicer middleware). Used for `shared_tls_ja4`. */
    tlsProfile?: {
        ja4?: string;
        ja3?: string;
    };
}
export interface IdentifyResult {
    deviceId: string;
    confidence: number;
    isNewDevice: boolean;
    matchConfidence: number;
    linkedUserId?: string;
    enrichmentInfo: {
        plugins: string[];
        details: Record<string, Record<string, unknown>>;
        failures: Array<{
            plugin: string;
            message: string;
        }>;
    };
}
export interface EnrichedIdentifyResult extends IdentifyResult {
    /** Full peer reputation analysis result. */
    peerReputation?: PeerReputationResult;
    /** Net confidence points applied (+/−) based on peer signal. */
    peerConfidenceBoost?: number;
}
//# sourceMappingURL=types.d.ts.map