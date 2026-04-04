// ────────────────────────────────────────────────────────────
//  PeerManager — core orchestrator for peer reputation networking
// ────────────────────────────────────────────────────────────
import { createPeerStorage } from '../libs/adapters/inmemory.js';
import { activeSignalEntries, buildEdgeShape, extractPeerSignals, } from '../libs/edges.js';
import { computeConfidenceBoost, computePeerReputation, } from '../libs/scoring.js';
import { validateLicense, FREE_TIER_MAX_DEVICES, FREE_TIER_MAX_HISTORY, } from '../libs/license.js';
// ── Plugin name registered with DeviceManager ─────────────────
const PLUGIN_NAME = 'peer';
// ── Warning messages ──────────────────────────────────────────
const LICENSE_WARN = '[peer-devicer] No license key — running on the free tier ' +
    `(${FREE_TIER_MAX_HISTORY} edges/device, ${FREE_TIER_MAX_DEVICES.toLocaleString()} device limit, ` +
    'shared_user + shared_ip_subnet only). ' +
    'Visit https://polar.sh to upgrade to Pro or Enterprise.';
const LICENSE_INVALID_WARN = '[peer-devicer] License key could not be validated — falling back to the free tier. ' +
    'Check your key or network connectivity.';
const DEVICE_LIMIT_WARN = `[peer-devicer] Free-tier device limit reached (${FREE_TIER_MAX_DEVICES.toLocaleString()} devices). ` +
    'New device will not be tracked. Upgrade to Pro or Enterprise to remove this limit.';
/**
 * PeerManager — passive peer reputation networking for the FP-Devicer Suite.
 *
 * Builds and maintains a peer graph linking device identifiers that share
 * common signals (IP subnet, user account, JA4 fingerprint, canvas/WebGL
 * hash). After each `identify()` call the reputation signals produced by
 * `ip-devicer` and `tls-devicer` are cached against the device node so that
 * taint can propagate through the graph to connected peers.
 *
 * ### Integration with DeviceManager
 * ```ts
 * // Register ip-devicer and tls-devicer FIRST so their enrichmentInfo is
 * // available when peer-devicer runs.
 * ipManager.registerWith(deviceManager);
 * tlsManager.registerWith(deviceManager);
 * peerManager.registerWith(deviceManager);
 *
 * const result = await deviceManager.identify(req.body, req.peerContext);
 * // result.peerReputation and result.peerConfidenceBoost are now available
 * ```
 */
export class PeerManager {
    storage;
    options;
    licenseInfo = {
        valid: false,
        tier: 'free',
        maxDevices: FREE_TIER_MAX_DEVICES,
    };
    initPromise = null;
    _licenseKey;
    _customStorage;
    constructor(opts = {}) {
        const hasKey = Boolean(opts.licenseKey?.trim());
        if (!hasKey) {
            console.warn(LICENSE_WARN);
        }
        const maxPeers = hasKey
            ? (opts.maxPeersPerDevice ?? 50)
            : (opts.maxPeersPerDevice ?? FREE_TIER_MAX_HISTORY);
        this.options = {
            maxPeersPerDevice: maxPeers,
            enabledEdgeTypes: opts.enabledEdgeTypes ?? [
                'shared_user',
                'shared_ip_subnet',
                'shared_tls_ja4',
                'shared_canvas',
                'shared_webgl',
            ],
            confidenceBoostWeight: opts.confidenceBoostWeight ?? 0.2,
        };
        this._licenseKey = opts.licenseKey?.trim();
        this._customStorage = Boolean(opts.storage);
        this.storage = opts.storage ?? createPeerStorage(maxPeers);
    }
    // ── Accessors ────────────────────────────────────────────────
    /** The active license tier. Resolves to `'free'` until {@link init} completes. */
    get tier() {
        return this.licenseInfo.tier;
    }
    // ── Lifecycle ─────────────────────────────────────────────────
    /**
     * Validate the Polar license key if one was supplied.
     *
     * Call once at application startup before processing requests. Safe to
     * await multiple times — subsequent calls return the cached promise.
     */
    async init() {
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = this._doInit();
        return this.initPromise;
    }
    async _doInit() {
        if (!this._licenseKey)
            return;
        const info = await validateLicense(this._licenseKey);
        this.licenseInfo = info;
        if (!info.valid) {
            console.warn(LICENSE_INVALID_WARN);
            // If we over-provisioned, recreate the default storage with the free cap.
            if (this.options.maxPeersPerDevice > FREE_TIER_MAX_HISTORY) {
                if (!this._customStorage) {
                    this.storage = createPeerStorage(FREE_TIER_MAX_HISTORY);
                }
                this.options.maxPeersPerDevice =
                    FREE_TIER_MAX_HISTORY;
            }
        }
    }
    // ── Core assessment ───────────────────────────────────────────
    /**
     * Assess the peer reputation of a device based on signals from the current
     * request and cached reputation data from previously seen peers.
     *
     * @param incoming   - Raw fingerprint payload (FPDataSet or compatible object).
     * @param context    - Peer identity context (ip, userId, tlsProfile).
     * @param deviceId   - Resolved device identifier from DeviceManager.
     * @param enrichmentDetails - `result.enrichmentInfo.details` from DeviceManager,
     *                            used to cache ip/tls signals for this device.
     */
    async assess(incoming, context, deviceId, enrichmentDetails) {
        const signals = extractPeerSignals(context, incoming);
        const isFreeTier = this.licenseInfo.tier === 'free';
        // ── Free-tier device cap ───────────────────────────────────
        const storageSize = await Promise.resolve(this.storage.size());
        const isKnownDevice = (await Promise.resolve(this.storage.getEdges(deviceId, 1))).length > 0;
        if (!isKnownDevice && isFreeTier && storageSize >= FREE_TIER_MAX_DEVICES) {
            console.warn(DEVICE_LIMIT_WARN);
            return {
                peerCount: 0,
                taintScore: 0,
                trustScore: 100,
                peerEdges: [],
                signals,
                isNewDevice: true,
                factors: ['device-limit-exceeded'],
                confidenceBoost: 0,
            };
        }
        // ── Find peers via signal lookups ──────────────────────────
        const signalEntries = activeSignalEntries(signals, this.options.enabledEdgeTypes, isFreeTier);
        const peerDeviceIds = new Set();
        const newEdgeParts = [];
        for (const { edgeType, signalValue } of signalEntries) {
            // Register this device's signal and discover existing peers in one operation
            const found = await Promise.resolve(this.storage.registerDeviceSignal(deviceId, edgeType, signalValue));
            for (const peerId of found) {
                if (peerId !== deviceId) {
                    peerDeviceIds.add(peerId);
                    newEdgeParts.push({ peerDeviceId: peerId, edgeType, signalValue });
                }
            }
        }
        // ── Upsert edges ───────────────────────────────────────────
        for (const { peerDeviceId, edgeType, signalValue } of newEdgeParts) {
            const shape = buildEdgeShape({ deviceId, peerDeviceId, edgeType, signalValue });
            await Promise.resolve(this.storage.upsertEdge(shape));
        }
        // ── Load peer caches ───────────────────────────────────────
        const existingEdges = await Promise.resolve(this.storage.getEdges(deviceId, this.options.maxPeersPerDevice));
        const uniquePeerIds = new Set();
        for (const edge of existingEdges) {
            const other = edge.deviceIdA === deviceId ? edge.deviceIdB : edge.deviceIdA;
            uniquePeerIds.add(other);
        }
        const peersWithEdge = [];
        for (const peerId of uniquePeerIds) {
            const peerEdges = existingEdges.filter((e) => e.deviceIdA === peerId || e.deviceIdB === peerId);
            const strongestEdge = peerEdges.sort((a, b) => b.weight - a.weight)[0];
            if (!strongestEdge)
                continue;
            const cache = await Promise.resolve(this.storage.getDeviceCache(peerId));
            peersWithEdge.push({ edge: strongestEdge, cache });
        }
        // ── Compute reputation ─────────────────────────────────────
        const reputation = computePeerReputation(peersWithEdge, signals, deviceId);
        // ── Cache this device's current enrichment ─────────────────
        const ipDetails = enrichmentDetails['ip'] ?? {};
        const tlsDetails = enrichmentDetails['tls'] ?? {};
        const driftDetails = enrichmentDetails['fp'] ?? {};
        const deviceCache = {
            deviceId,
            updatedAt: new Date(),
            ipRisk: typeof ipDetails['riskScore'] === 'number' ? ipDetails['riskScore'] : undefined,
            tlsConsistency: typeof tlsDetails['consistencyScore'] === 'number' ? tlsDetails['consistencyScore'] : undefined,
            driftScore: typeof driftDetails['driftScore'] === 'number' ? driftDetails['driftScore'] : undefined,
            flagReasons: reputation.factors,
        };
        await Promise.resolve(this.storage.saveDeviceCache(deviceCache));
        return reputation;
    }
    // ── DeviceManager integration ──────────────────────────────
    /**
     * Patch `deviceManager.identify()` to automatically assess peer reputation
     * on every call and attach `peerReputation` and `peerConfidenceBoost` to
     * the result.
     *
     * Register this **after** `IpManager` and `TlsManager` so that their
     * `enrichmentInfo.details` entries are available when peer-devicer runs.
     *
     * Failures inside the peer analysis are non-fatal — the original result
     * is returned unchanged when an error occurs.
     */
    registerWith(deviceManager) {
        return deviceManager.registerIdentifyPostProcessor?.(PLUGIN_NAME, async ({ result, context, incoming }) => {
            const ctx = (context ?? {});
            // No useful signals in context — skip gracefully
            if (!ctx.ip && !ctx.userId && !ctx.tlsProfile?.ja4) {
                return;
            }
            const enrichmentDetails = result.enrichmentInfo?.details ?? {};
            const reputation = await this.assess(incoming, ctx, result.deviceId, enrichmentDetails);
            const boost = computeConfidenceBoost(reputation, this.options.confidenceBoostWeight);
            const boostedConfidence = Math.max(0, Math.min(100, result.confidence + boost));
            return {
                result: {
                    confidence: boostedConfidence,
                    matchConfidence: boostedConfidence,
                    peerReputation: reputation,
                    peerConfidenceBoost: boost,
                },
                enrichmentInfo: {
                    peerCount: reputation.peerCount,
                    taintScore: reputation.taintScore,
                    trustScore: reputation.trustScore,
                    factors: reputation.factors,
                },
                logMeta: {
                    peerCount: reputation.peerCount,
                    taintScore: reputation.taintScore,
                    factors: reputation.factors,
                },
            };
        });
    }
    // ── Query helpers ────────────────────────────────────────────
    /**
     * Return the stored peer edges for a device.
     *
     * @param deviceId - Device identifier.
     * @param limit    - Maximum edges to return.
     */
    async getEdges(deviceId, limit) {
        return Promise.resolve(this.storage.getEdges(deviceId, limit));
    }
    /**
     * Return the cached reputation signals for a device, or `null` if not found.
     */
    async getDeviceCache(deviceId) {
        return Promise.resolve(this.storage.getDeviceCache(deviceId));
    }
    /**
     * Remove edges older than `olderThanMs` milliseconds. Returns the count
     * of pruned edges.
     */
    async pruneStaleEdges(olderThanMs) {
        return Promise.resolve(this.storage.pruneStaleEdges(olderThanMs));
    }
    /**
     * Clear stored edges — all devices when `deviceId` is omitted.
     */
    async clear(deviceId) {
        return Promise.resolve(this.storage.clearEdges(deviceId));
    }
}
//# sourceMappingURL=PeerManager.js.map