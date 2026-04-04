import type { PeerEdge, PeerEdgeType, PeerIdentifyContext, PeerSignals } from '../types.js';
/**
 * Default strength weights for each edge type.
 *
 * Higher weight = stronger implied relationship when two devices share
 * this signal. `shared_user` is the strongest anchor (explicit identity);
 * `shared_ip_subnet` is the weakest (many clients share a /24).
 */
export declare const EDGE_WEIGHTS: Record<PeerEdgeType, number>;
/**
 * Edge types available on the free tier. Pro/Enterprise unlock all five.
 */
export declare const FREE_TIER_EDGE_TYPES: PeerEdgeType[];
/**
 * Extract peer linkage signals from a request context and the raw
 * fingerprint payload.
 *
 * @param context  - Caller-provided context (ip, userId, tlsProfile).
 * @param incoming - Raw fingerprint data from the browser. Typed loosely so
 *                   the library does not take a hard dependency on fp-devicer
 *                   internals; only `canvas` and `webgl` string fields are
 *                   consumed.
 */
export declare function extractPeerSignals(context: PeerIdentifyContext, incoming: Record<string, unknown>): PeerSignals;
export interface BuildEdgeInput {
    deviceId: string;
    peerDeviceId: string;
    edgeType: PeerEdgeType;
    signalValue: string;
}
/**
 * Produce the canonical `Omit<PeerEdge, 'id'>` shape for a single
 * (deviceId ↔ peerDeviceId) pairing.  The caller is responsible for calling
 * `storage.upsertEdge()` with the returned value.
 *
 * Canonical ordering: `deviceIdA < deviceIdB` lexicographically, so the
 * same pair always produces the same edge regardless of which device we
 * are evaluating from.
 */
export declare function buildEdgeShape(input: BuildEdgeInput): Omit<PeerEdge, 'id'>;
/**
 * Return the set of `(edgeType, signalValue)` pairs active for a given
 * `PeerSignals` object, filtered to only types that are both enabled and
 * permitted by the current tier.
 *
 * @param signals          - Extracted request signals.
 * @param enabledTypes     - Types allowed by `PeerManagerOptions.enabledEdgeTypes`.
 * @param isFreeTier       - When `true`, non-free-tier types are excluded.
 */
export declare function activeSignalEntries(signals: PeerSignals, enabledTypes: PeerEdgeType[], isFreeTier: boolean): Array<{
    edgeType: PeerEdgeType;
    signalValue: string;
}>;
//# sourceMappingURL=edges.d.ts.map