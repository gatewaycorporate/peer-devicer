// ────────────────────────────────────────────────────────────
//  edges — signal extraction and peer edge construction
// ────────────────────────────────────────────────────────────

import ipaddr from 'ipaddr.js';
import type { PeerEdge, PeerEdgeType, PeerIdentifyContext, PeerSignals } from '../types.js';

// ── Edge weights ──────────────────────────────────────────────

/**
 * Default strength weights for each edge type.
 *
 * Higher weight = stronger implied relationship when two devices share
 * this signal. `shared_user` is the strongest anchor (explicit identity);
 * `shared_ip_subnet` is the weakest (many clients share a /24).
 */
export const EDGE_WEIGHTS: Record<PeerEdgeType, number> = {
  shared_user:       1.0,
  shared_canvas:     0.8,
  shared_webgl:      0.7,
  shared_tls_ja4:    0.6,
  shared_ip_subnet:  0.4,
};

/**
 * Edge types available on the free tier. Pro/Enterprise unlock all five.
 */
export const FREE_TIER_EDGE_TYPES: PeerEdgeType[] = [
  'shared_user',
  'shared_ip_subnet',
];

// ── Signal extraction ─────────────────────────────────────────

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
export function extractPeerSignals(
  context: PeerIdentifyContext,
  incoming: Record<string, unknown>,
): PeerSignals {
  const signals: PeerSignals = {};

  // ── userId ─────────────────────────────────────────────────
  if (context.userId) {
    signals.userId = context.userId;
  }

  // ── IP /24 subnet ──────────────────────────────────────────
  if (context.ip) {
    try {
      const parsed = ipaddr.parse(context.ip.trim());
      if (parsed.kind() === 'ipv4') {
        const bytes = (parsed as ipaddr.IPv4).octets;
        signals.ipSubnet = `${bytes[0]}.${bytes[1]}.${bytes[2]}.0/24`;
      } else {
        // IPv6: use /48 prefix as the subnet anchor
        const v6 = parsed as ipaddr.IPv6;
        const parts = v6.toNormalizedString().split(':');
        signals.ipSubnet = `${parts.slice(0, 3).join(':')}::/48`;
      }
    } catch {
      // Invalid IP — skip subnet signal
    }
  }

  // ── JA4 TLS fingerprint ────────────────────────────────────
  if (context.tlsProfile?.ja4) {
    signals.ja4 = context.tlsProfile.ja4;
  }

  // ── Canvas / WebGL hashes (from raw fingerprint) ───────────
  const canvas = incoming['canvas'];
  if (typeof canvas === 'string' && canvas.trim().length > 0) {
    signals.canvasHash = canvas.trim();
  }

  const webgl = incoming['webgl'];
  if (typeof webgl === 'string' && webgl.trim().length > 0) {
    signals.webglHash = webgl.trim();
  }

  return signals;
}

// ── Edge builder ──────────────────────────────────────────────

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
export function buildEdgeShape(
  input: BuildEdgeInput,
): Omit<PeerEdge, 'id'> {
  const { deviceId, peerDeviceId, edgeType, signalValue } = input;
  const [a, b] = deviceId < peerDeviceId
    ? [deviceId, peerDeviceId]
    : [peerDeviceId, deviceId];

  const now = new Date();
  return {
    deviceIdA: a,
    deviceIdB: b,
    edgeType,
    signalValue,
    weight: EDGE_WEIGHTS[edgeType],
    occurrences: 1,
    firstSeen: now,
    lastSeen: now,
  };
}

// ── Signal → edge-type mapping ────────────────────────────────

/**
 * Return the set of `(edgeType, signalValue)` pairs active for a given
 * `PeerSignals` object, filtered to only types that are both enabled and
 * permitted by the current tier.
 *
 * @param signals          - Extracted request signals.
 * @param enabledTypes     - Types allowed by `PeerManagerOptions.enabledEdgeTypes`.
 * @param isFreeTier       - When `true`, non-free-tier types are excluded.
 */
export function activeSignalEntries(
  signals: PeerSignals,
  enabledTypes: PeerEdgeType[],
  isFreeTier: boolean,
): Array<{ edgeType: PeerEdgeType; signalValue: string }> {
  const allowed = isFreeTier
    ? enabledTypes.filter((t) => FREE_TIER_EDGE_TYPES.includes(t))
    : enabledTypes;

  const entries: Array<{ edgeType: PeerEdgeType; signalValue: string }> = [];

  if (allowed.includes('shared_user') && signals.userId) {
    entries.push({ edgeType: 'shared_user', signalValue: signals.userId });
  }
  if (allowed.includes('shared_ip_subnet') && signals.ipSubnet) {
    entries.push({ edgeType: 'shared_ip_subnet', signalValue: signals.ipSubnet });
  }
  if (allowed.includes('shared_tls_ja4') && signals.ja4) {
    entries.push({ edgeType: 'shared_tls_ja4', signalValue: signals.ja4 });
  }
  if (allowed.includes('shared_canvas') && signals.canvasHash) {
    entries.push({ edgeType: 'shared_canvas', signalValue: signals.canvasHash });
  }
  if (allowed.includes('shared_webgl') && signals.webglHash) {
    entries.push({ edgeType: 'shared_webgl', signalValue: signals.webglHash });
  }

  return entries;
}
