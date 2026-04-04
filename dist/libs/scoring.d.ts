import type { PeerDeviceCache, PeerEdge, PeerReputationResult, PeerSignals } from '../types.js';
export interface PeerWithEdge {
    edge: PeerEdge;
    cache: PeerDeviceCache | null;
}
/**
 * Compute an overall peer reputation for the device being identified, based
 * on the reputation signals cached for each of its graph neighbours.
 *
 * @param peers    - Edge + cache pairs for all known peer devices.
 * @param signals  - Signals extracted from the current request.
 * @param deviceId - The device being evaluated (used to filter self-edges).
 */
export declare function computePeerReputation(peers: PeerWithEdge[], signals: PeerSignals, deviceId: string): PeerReputationResult;
/**
 * Convert a reputation summary into a DeviceManager confidence delta.
 *
 * Range: approximately −20 to +10 points (scaled by `weight`).
 *
 * | taintScore | trustScore | effect        |
 * |------------|------------|---------------|
 * | ≥ 70       | any        | up to −20 pts |
 * | ≥ 40       | any        | up to −10 pts |
 * | any        | ≥ 80       | up to +10 pts |
 * | no peers   |            | 0             |
 *
 * @param summary - `{ taintScore, trustScore, isNewDevice }` from reputation result.
 * @param weight  - Scale factor (0–1). Default `0.2` matches manager default.
 */
export declare function computeConfidenceBoost(summary: {
    taintScore: number;
    trustScore: number;
    isNewDevice: boolean;
}, weight?: number): number;
//# sourceMappingURL=scoring.d.ts.map