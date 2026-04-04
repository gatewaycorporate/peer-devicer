// ────────────────────────────────────────────────────────────
//  Tests — peer reputation scoring (peer-devicer)
// ────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { computePeerReputation, computeConfidenceBoost } from '../libs/scoring.js';
import type { PeerDeviceCache, PeerEdge, PeerSignals } from '../types.js';

// ── Helpers ────────────────────────────────────────────────

function makeEdge(
  deviceA: string,
  deviceB: string,
  edgeType: PeerEdge['edgeType'] = 'shared_ip_subnet',
  weight = 0.4,
): PeerEdge {
  return {
    id: `edge-${deviceA}-${deviceB}`,
    deviceIdA: deviceA,
    deviceIdB: deviceB,
    edgeType,
    signalValue: '1.2.3.0/24',
    weight,
    occurrences: 3,
    firstSeen: new Date('2026-01-01'),
    lastSeen: new Date('2026-04-01'),
  };
}

function makeCache(deviceId: string, overrides: Partial<PeerDeviceCache> = {}): PeerDeviceCache {
  return {
    deviceId,
    updatedAt: new Date(),
    ipRisk: 0,
    tlsConsistency: 100,
    driftScore: 0,
    flagReasons: [],
    ...overrides,
  };
}

const SIGNALS: PeerSignals = { ipSubnet: '1.2.3.0/24' };

// ── computePeerReputation — no peers ──────────────────────

describe('computePeerReputation — no peers', () => {
  it('returns taintScore=0 and trustScore=100 when no peers', () => {
    const result = computePeerReputation([], SIGNALS, 'device-a');
    expect(result.taintScore).toBe(0);
    expect(result.trustScore).toBe(100);
  });

  it('marks isNewDevice=true when no peers', () => {
    const result = computePeerReputation([], SIGNALS, 'device-a');
    expect(result.isNewDevice).toBe(true);
  });

  it('returns empty factors and peerEdges when no peers', () => {
    const result = computePeerReputation([], SIGNALS, 'device-a');
    expect(result.factors).toHaveLength(0);
    expect(result.peerEdges).toHaveLength(0);
  });

  it('returns confidenceBoost=0 when no peers', () => {
    const result = computePeerReputation([], SIGNALS, 'device-a');
    expect(result.confidenceBoost).toBe(0);
  });
});

// ── computePeerReputation — clean peers ────────────────────

describe('computePeerReputation — clean peers', () => {
  it('produces low taintScore when all peers have clean signals', () => {
    const peers = [
      { edge: makeEdge('device-a', 'peer-1'), cache: makeCache('peer-1') },
      { edge: makeEdge('device-a', 'peer-2'), cache: makeCache('peer-2') },
    ];
    const result = computePeerReputation(peers, SIGNALS, 'device-a');
    expect(result.taintScore).toBe(0);
    expect(result.trustScore).toBe(100);
  });

  it('emits all_peers_clean factor when trust is high and taint is low', () => {
    const peers = [
      { edge: makeEdge('device-a', 'peer-1'), cache: makeCache('peer-1') },
    ];
    const result = computePeerReputation(peers, SIGNALS, 'device-a');
    expect(result.factors).toContain('all_peers_clean');
  });
});

// ── computePeerReputation — tainted peers ─────────────────

describe('computePeerReputation — tainted peers', () => {
  it('elevates taintScore when a peer has high ipRisk', () => {
    const peers = [
      { edge: makeEdge('device-a', 'peer-bad'), cache: makeCache('peer-bad', { ipRisk: 100 }) },
    ];
    const result = computePeerReputation(peers, SIGNALS, 'device-a');
    expect(result.taintScore).toBeGreaterThan(30);
  });

  it('elevates taintScore when a peer has low tlsConsistency', () => {
    const peers = [
      {
        edge: makeEdge('device-a', 'peer-bad'),
        cache: makeCache('peer-bad', { tlsConsistency: 0, ipRisk: 0, driftScore: 0 }),
      },
    ];
    const result = computePeerReputation(peers, SIGNALS, 'device-a');
    expect(result.taintScore).toBeGreaterThan(20);
  });

  it('elevates taintScore when a peer has high driftScore', () => {
    const peers = [
      {
        edge: makeEdge('device-a', 'peer-bad'),
        cache: makeCache('peer-bad', { driftScore: 100, ipRisk: 0, tlsConsistency: 100 }),
      },
    ];
    const result = computePeerReputation(peers, SIGNALS, 'device-a');
    expect(result.taintScore).toBeGreaterThan(20);
  });

  it('emits high_taint_peers factor when taintScore >= 70', () => {
    const peers = [
      {
        edge: makeEdge('device-a', 'peer-bad', 'shared_user', 1.0),
        cache: makeCache('peer-bad', { ipRisk: 100, tlsConsistency: 0, driftScore: 100 }),
      },
    ];
    const result = computePeerReputation(peers, SIGNALS, 'device-a');
    expect(result.factors).toContain('high_taint_peers');
  });

  it('emits known_bot_cluster when 2+ peers are highly suspicious', () => {
    const peers = [
      { edge: makeEdge('device-a', 'peer-1', 'shared_ip_subnet', 0.4), cache: makeCache('peer-1', { ipRisk: 90, tlsConsistency: 0, driftScore: 80 }) },
      { edge: makeEdge('device-a', 'peer-2', 'shared_ip_subnet', 0.4), cache: makeCache('peer-2', { ipRisk: 90, tlsConsistency: 0, driftScore: 80 }) },
    ];
    const result = computePeerReputation(peers, SIGNALS, 'device-a');
    expect(result.factors).toContain('known_bot_cluster');
  });

  it('stronger edge weight amplifies taint when combined with a neutral peer', () => {
    // Device A: high suspicion → contributes taint proportional to its edge weight
    // Device B: clean (taint = 0) → acts as dilution weight
    // With a strong weight for A, the net taint should exceed the weak-weight case
    const highSuspicionCache = makeCache('peer-tainted', { ipRisk: 100 });
    const cleanCache         = makeCache('peer-clean',   { ipRisk: 0, tlsConsistency: 100, driftScore: 0 });

    const weakScenario = [
      { edge: makeEdge('device-a', 'peer-tainted', 'shared_ip_subnet', 0.1), cache: highSuspicionCache },
      { edge: makeEdge('device-a', 'peer-clean',   'shared_ip_subnet', 0.9), cache: cleanCache },
    ];
    const strongScenario = [
      { edge: makeEdge('device-a', 'peer-tainted', 'shared_user', 1.0), cache: highSuspicionCache },
      { edge: makeEdge('device-a', 'peer-clean',   'shared_ip_subnet', 0.1), cache: cleanCache },
    ];

    const weakResult   = computePeerReputation(weakScenario,   SIGNALS, 'device-a');
    const strongResult = computePeerReputation(strongScenario, SIGNALS, 'device-a');
    expect(strongResult.taintScore).toBeGreaterThan(weakResult.taintScore);
  });
});

// ── computePeerReputation — null cache ─────────────────────

describe('computePeerReputation — null cache (unknown peer)', () => {
  it('treats unknown peers as neutral (no taint)', () => {
    const peers = [
      { edge: makeEdge('device-a', 'peer-unknown'), cache: null },
    ];
    const result = computePeerReputation(peers, SIGNALS, 'device-a');
    expect(result.taintScore).toBe(0);
    expect(result.isNewDevice).toBe(false);
  });
});

// ── computePeerReputation — score cap ─────────────────────

describe('computePeerReputation — score capping', () => {
  it('taintScore is capped at 100', () => {
    const peers = Array.from({ length: 10 }, (_, i) => ({
      edge: makeEdge('device-a', `peer-${i}`, 'shared_user', 1.0),
      cache: makeCache(`peer-${i}`, { ipRisk: 100, tlsConsistency: 0, driftScore: 100 }),
    }));
    const result = computePeerReputation(peers, SIGNALS, 'device-a');
    expect(result.taintScore).toBeLessThanOrEqual(100);
    expect(result.trustScore).toBeGreaterThanOrEqual(0);
  });
});

// ── computeConfidenceBoost ─────────────────────────────────

describe('computeConfidenceBoost', () => {
  it('returns 0 for isNewDevice=true regardless of scores', () => {
    expect(computeConfidenceBoost({ taintScore: 90, trustScore: 10, isNewDevice: true })).toBe(0);
  });

  it('returns a negative number when taintScore >= 70', () => {
    const boost = computeConfidenceBoost({ taintScore: 80, trustScore: 20, isNewDevice: false });
    expect(boost).toBeLessThan(0);
  });

  it('returns a negative number when taintScore >= 40', () => {
    const boost = computeConfidenceBoost({ taintScore: 55, trustScore: 40, isNewDevice: false });
    expect(boost).toBeLessThan(0);
  });

  it('returns a positive number when trustScore >= 80 and taint is low', () => {
    const boost = computeConfidenceBoost({ taintScore: 5, trustScore: 95, isNewDevice: false });
    expect(boost).toBeGreaterThan(0);
  });

  it('returns 0 when taint and trust are both in neutral range', () => {
    const boost = computeConfidenceBoost({ taintScore: 20, trustScore: 70, isNewDevice: false });
    expect(boost).toBe(0);
  });

  it('scales with weight parameter', () => {
    const boostDefault = computeConfidenceBoost({ taintScore: 80, trustScore: 10, isNewDevice: false });
    const boostHalf    = computeConfidenceBoost({ taintScore: 80, trustScore: 10, isNewDevice: false }, 0.1);
    expect(Math.abs(boostDefault)).toBeGreaterThan(Math.abs(boostHalf));
  });
});
