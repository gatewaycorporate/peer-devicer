import { type LicenseTier } from '../libs/license.js';
import type { PeerDeviceCache, PeerEdge, PeerIdentifyContext, PeerManagerOptions, PeerReputationResult } from '../types.js';
import type { DeviceManagerPlugin, DeviceManagerLike } from 'devicer.js';
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
export declare class PeerManager implements DeviceManagerPlugin {
    private storage;
    private readonly options;
    private licenseInfo;
    private initPromise;
    private readonly _licenseKey;
    private readonly _customStorage;
    constructor(opts?: PeerManagerOptions);
    /** The active license tier. Resolves to `'free'` until {@link init} completes. */
    get tier(): LicenseTier;
    /**
     * Validate the Polar license key if one was supplied.
     *
     * Call once at application startup before processing requests. Safe to
     * await multiple times — subsequent calls return the cached promise.
     */
    init(): Promise<void>;
    private _doInit;
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
    assess(incoming: Record<string, unknown>, context: PeerIdentifyContext, deviceId: string, enrichmentDetails: Record<string, Record<string, unknown>>): Promise<PeerReputationResult>;
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
    registerWith(deviceManager: DeviceManagerLike): (() => void) | void;
    /**
     * Return the stored peer edges for a device.
     *
     * @param deviceId - Device identifier.
     * @param limit    - Maximum edges to return.
     */
    getEdges(deviceId: string, limit?: number): Promise<PeerEdge[]>;
    /**
     * Return the cached reputation signals for a device, or `null` if not found.
     */
    getDeviceCache(deviceId: string): Promise<PeerDeviceCache | null>;
    /**
     * Remove edges older than `olderThanMs` milliseconds. Returns the count
     * of pruned edges.
     */
    pruneStaleEdges(olderThanMs: number): Promise<number>;
    /**
     * Clear stored edges — all devices when `deviceId` is omitted.
     */
    clear(deviceId?: string): Promise<void>;
}
//# sourceMappingURL=PeerManager.d.ts.map