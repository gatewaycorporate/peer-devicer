// ────────────────────────────────────────────────────────────
//  scoring — peer reputation propagation and confidence boosting
// ────────────────────────────────────────────────────────────
// ── Per-signal weights inside peer suspicion formula ──────────
/**
 * Coefficients applied when computing a single peer device's suspicion level
 * from its cached reputation signals.
 *
 * Must sum to 1.0.
 */
const PEER_SUSPICION_WEIGHTS = {
    ipRisk: 0.4,
    tlsInconsistency: 0.3, // derived as (100 − tlsConsistency)
    driftScore: 0.3,
};
// ── Thresholds for factor string generation ───────────────────
/** Taint level that marks the peer neighborhood as strongly suspicious. */
const HIGH_TAINT_THRESHOLD = 70;
/** Taint level where negative confidence adjustment begins. */
const MED_TAINT_THRESHOLD = 40;
/** Trust level that qualifies a peer neighborhood as strongly trustworthy. */
const HIGH_TRUST_THRESHOLD = 80;
/** Per-peer suspicion level counted toward known-bot-cluster detection. */
const HIGH_SUSPICION_THRESHOLD = 60;
/** Matches peer flag reasons associated with VPN, proxy, hosting, or cloud networks. */
const VPN_SUBNET_PATTERN = /vpn|proxy|datacenter|hosting|cloud/i;
/**
 * Compute an overall peer reputation for the device being identified, based
 * on the reputation signals cached for each of its graph neighbours.
 *
 * @param peers    - Edge + cache pairs for all known peer devices.
 * @param signals  - Signals extracted from the current request.
 * @param deviceId - The device being evaluated (used to filter self-edges).
 */
export function computePeerReputation(peers, signals, deviceId) {
    const peerEdges = peers.map((p) => p.edge);
    const isNewDevice = peers.length === 0;
    if (isNewDevice) {
        return {
            peerCount: 0,
            taintScore: 0,
            trustScore: 100,
            peerEdges: [],
            signals,
            isNewDevice: true,
            factors: [],
            confidenceBoost: 0,
        };
    }
    const factors = [];
    let weightedTaintSum = 0;
    let weightedTrustSum = 0;
    let totalWeight = 0;
    let highSuspicionCount = 0;
    for (const { edge, cache } of peers) {
        const edgeWeight = edge.weight;
        totalWeight += edgeWeight;
        if (!cache) {
            // Unknown peer — neutral contribution
            weightedTaintSum += edgeWeight * 0;
            weightedTrustSum += edgeWeight * 100;
            continue;
        }
        // ── Peer suspicion ──────────────────────────────────────
        const ipRisk = cache.ipRisk ?? 0;
        const tlsRisk = 100 - (cache.tlsConsistency ?? 100);
        const drift = cache.driftScore ?? 0;
        const peerSuspicion = ipRisk * PEER_SUSPICION_WEIGHTS.ipRisk +
            tlsRisk * PEER_SUSPICION_WEIGHTS.tlsInconsistency +
            drift * PEER_SUSPICION_WEIGHTS.driftScore;
        const effectiveTaint = peerSuspicion * edgeWeight;
        weightedTaintSum += effectiveTaint;
        // ── Peer trust ──────────────────────────────────────────
        const peerTrust = 100 - peerSuspicion;
        weightedTrustSum += peerTrust * edgeWeight;
        if (peerSuspicion >= HIGH_SUSPICION_THRESHOLD) {
            highSuspicionCount++;
        }
        // ── Per-peer factor collection ──────────────────────────
        for (const reason of cache.flagReasons) {
            if (VPN_SUBNET_PATTERN.test(reason) && !factors.includes('shared_vpn_subnet')) {
                factors.push('shared_vpn_subnet');
            }
        }
    }
    const rawTaint = totalWeight > 0 ? weightedTaintSum / totalWeight : 0;
    const rawTrust = totalWeight > 0 ? weightedTrustSum / totalWeight : 100;
    const taintScore = Math.round(Math.max(0, Math.min(100, rawTaint)));
    const trustScore = Math.round(Math.max(0, Math.min(100, rawTrust)));
    // ── Factor labels ───────────────────────────────────────────
    if (taintScore >= HIGH_TAINT_THRESHOLD) {
        factors.push('high_taint_peers');
    }
    if (highSuspicionCount >= 2) {
        factors.push('known_bot_cluster');
    }
    if (trustScore >= HIGH_TRUST_THRESHOLD && taintScore < MED_TAINT_THRESHOLD) {
        factors.push('all_peers_clean');
    }
    // ── Check for user-account flag ─────────────────────────────
    if (signals.userId) {
        const userEdge = peers.find((p) => p.edge.edgeType === 'shared_user');
        if (userEdge?.cache && userEdge.cache.flagReasons.includes('user_account_flagged')) {
            if (!factors.includes('user_account_flagged')) {
                factors.push('user_account_flagged');
            }
        }
    }
    const confidenceBoost = computeConfidenceBoost({ taintScore, trustScore, isNewDevice: false });
    return {
        peerCount: peers.length,
        taintScore,
        trustScore,
        peerEdges,
        signals,
        isNewDevice: false,
        factors,
        confidenceBoost,
    };
}
// ── Confidence boost calculation ──────────────────────────────
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
export function computeConfidenceBoost(summary, weight = 0.2) {
    if (summary.isNewDevice)
        return 0;
    const FULL_SCALE = 1 / 0.2; // normalise so weight=0.2 gives the stated range
    let delta = 0;
    if (summary.taintScore >= HIGH_TAINT_THRESHOLD) {
        // Map 70–100 → −10 to −20
        delta = -10 - ((summary.taintScore - HIGH_TAINT_THRESHOLD) / 30) * 10;
    }
    else if (summary.taintScore >= MED_TAINT_THRESHOLD) {
        // Map 40–70 → 0 to −10
        delta = -((summary.taintScore - MED_TAINT_THRESHOLD) / 30) * 10;
    }
    else if (summary.trustScore >= HIGH_TRUST_THRESHOLD) {
        // Map 80–100 → 0 to +10
        delta = ((summary.trustScore - HIGH_TRUST_THRESHOLD) / 20) * 10;
    }
    return Math.round(delta * weight * FULL_SCALE);
}
//# sourceMappingURL=scoring.js.map