// ────────────────────────────────────────────────────────────
//  Tests — signal extraction and edge building (peer-devicer)
// ────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import {
  extractPeerSignals,
  buildEdgeShape,
  activeSignalEntries,
  EDGE_WEIGHTS,
  FREE_TIER_EDGE_TYPES,
} from '../libs/edges.js';
import type { PeerIdentifyContext } from '../types.js';

// ── extractPeerSignals ─────────────────────────────────────

describe('extractPeerSignals', () => {
  it('extracts ipSubnet /24 from an IPv4 address', () => {
    const signals = extractPeerSignals({ ip: '203.0.113.45' }, {});
    expect(signals.ipSubnet).toBe('203.0.113.0/24');
  });

  it('produces the same /24 for two IPs in the same subnet', () => {
    const a = extractPeerSignals({ ip: '1.2.3.100' }, {});
    const b = extractPeerSignals({ ip: '1.2.3.200' }, {});
    expect(a.ipSubnet).toBe(b.ipSubnet);
    expect(a.ipSubnet).toBe('1.2.3.0/24');
  });

  it('produces different subnets for IPs in different /24 blocks', () => {
    const a = extractPeerSignals({ ip: '10.0.1.1' }, {});
    const b = extractPeerSignals({ ip: '10.0.2.1' }, {});
    expect(a.ipSubnet).not.toBe(b.ipSubnet);
  });

  it('extracts IPv6 /48 prefix', () => {
    const signals = extractPeerSignals({ ip: '2001:db8:1234::1' }, {});
    expect(signals.ipSubnet).toMatch(/^2001:db8:1234::/);
  });

  it('silently ignores an invalid IP', () => {
    const signals = extractPeerSignals({ ip: 'not-an-ip' }, {});
    expect(signals.ipSubnet).toBeUndefined();
  });

  it('extracts userId from context', () => {
    const signals = extractPeerSignals({ userId: 'user-abc' }, {});
    expect(signals.userId).toBe('user-abc');
  });

  it('extracts ja4 from tlsProfile', () => {
    const signals = extractPeerSignals({ tlsProfile: { ja4: 't13d1516h2_abc' } }, {});
    expect(signals.ja4).toBe('t13d1516h2_abc');
  });

  it('extracts canvasHash from fingerprint payload', () => {
    const signals = extractPeerSignals({}, { canvas: 'data:image/png;base64,abc123==' });
    expect(signals.canvasHash).toBe('data:image/png;base64,abc123==');
  });

  it('extracts webglHash from fingerprint payload', () => {
    const signals = extractPeerSignals({}, { webgl: 'webgl-renderer-hash-xyz' });
    expect(signals.webglHash).toBe('webgl-renderer-hash-xyz');
  });

  it('ignores empty canvas string', () => {
    const signals = extractPeerSignals({}, { canvas: '   ' });
    expect(signals.canvasHash).toBeUndefined();
  });

  it('returns an empty signals object when context and payload are empty', () => {
    const signals = extractPeerSignals({}, {});
    expect(Object.keys(signals).length).toBe(0);
  });

  it('trims whitespace from canvas hash', () => {
    const signals = extractPeerSignals({}, { canvas: '  hash123  ' });
    expect(signals.canvasHash).toBe('hash123');
  });
});

// ── buildEdgeShape ─────────────────────────────────────────

describe('buildEdgeShape', () => {
  it('produces canonical ordering (A < B lexicographically)', () => {
    const shape = buildEdgeShape({
      deviceId: 'zzz-device',
      peerDeviceId: 'aaa-peer',
      edgeType: 'shared_ip_subnet',
      signalValue: '10.0.0.0/24',
    });
    expect(shape.deviceIdA).toBe('aaa-peer');
    expect(shape.deviceIdB).toBe('zzz-device');
  });

  it('produces the same canonical form regardless of argument order', () => {
    const shapeAB = buildEdgeShape({
      deviceId: 'device-alpha',
      peerDeviceId: 'device-beta',
      edgeType: 'shared_canvas',
      signalValue: 'canvas-hash-abc',
    });
    const shapeBA = buildEdgeShape({
      deviceId: 'device-beta',
      peerDeviceId: 'device-alpha',
      edgeType: 'shared_canvas',
      signalValue: 'canvas-hash-abc',
    });
    expect(shapeAB.deviceIdA).toBe(shapeBA.deviceIdA);
    expect(shapeAB.deviceIdB).toBe(shapeBA.deviceIdB);
  });

  it('sets weight from EDGE_WEIGHTS for the given type', () => {
    const shape = buildEdgeShape({
      deviceId: 'a', peerDeviceId: 'b',
      edgeType: 'shared_user', signalValue: 'user-123',
    });
    expect(shape.weight).toBe(EDGE_WEIGHTS.shared_user);
  });

  it('initialises occurrences to 1', () => {
    const shape = buildEdgeShape({
      deviceId: 'a', peerDeviceId: 'b',
      edgeType: 'shared_ip_subnet', signalValue: '1.2.3.0/24',
    });
    expect(shape.occurrences).toBe(1);
  });

  it('sets firstSeen and lastSeen to the current time', () => {
    const before = Date.now();
    const shape = buildEdgeShape({
      deviceId: 'a', peerDeviceId: 'b',
      edgeType: 'shared_tls_ja4', signalValue: 'ja4-abc',
    });
    const after = Date.now();
    expect(shape.firstSeen.getTime()).toBeGreaterThanOrEqual(before);
    expect(shape.lastSeen.getTime()).toBeLessThanOrEqual(after);
  });
});

// ── EDGE_WEIGHTS ──────────────────────────────────────────

describe('EDGE_WEIGHTS', () => {
  it('shared_user has the highest weight', () => {
    const weights = Object.values(EDGE_WEIGHTS);
    expect(EDGE_WEIGHTS.shared_user).toBe(Math.max(...weights));
  });

  it('shared_ip_subnet has the lowest weight', () => {
    const weights = Object.values(EDGE_WEIGHTS);
    expect(EDGE_WEIGHTS.shared_ip_subnet).toBe(Math.min(...weights));
  });

  it('all weights are between 0 and 1 exclusive', () => {
    for (const w of Object.values(EDGE_WEIGHTS)) {
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });
});

// ── FREE_TIER_EDGE_TYPES ───────────────────────────────────

describe('FREE_TIER_EDGE_TYPES', () => {
  it('includes shared_user and shared_ip_subnet', () => {
    expect(FREE_TIER_EDGE_TYPES).toContain('shared_user');
    expect(FREE_TIER_EDGE_TYPES).toContain('shared_ip_subnet');
  });

  it('does not include canvas, webgl, or tls_ja4', () => {
    expect(FREE_TIER_EDGE_TYPES).not.toContain('shared_canvas');
    expect(FREE_TIER_EDGE_TYPES).not.toContain('shared_webgl');
    expect(FREE_TIER_EDGE_TYPES).not.toContain('shared_tls_ja4');
  });
});

// ── activeSignalEntries ────────────────────────────────────

describe('activeSignalEntries', () => {
  const allTypes = ['shared_user', 'shared_ip_subnet', 'shared_tls_ja4', 'shared_canvas', 'shared_webgl'] as const;

  const fullSignals = {
    userId: 'u1',
    ipSubnet: '1.2.3.0/24',
    ja4: 'ja4-test',
    canvasHash: 'canvas-hash',
    webglHash: 'webgl-hash',
  };

  it('returns all 5 entries on pro tier with all signals present', () => {
    const entries = activeSignalEntries(fullSignals, [...allTypes], false);
    expect(entries).toHaveLength(5);
  });

  it('restricts to user + subnet on free tier', () => {
    const entries = activeSignalEntries(fullSignals, [...allTypes], true);
    const types = entries.map((e) => e.edgeType);
    expect(types).toContain('shared_user');
    expect(types).toContain('shared_ip_subnet');
    expect(types).not.toContain('shared_canvas');
    expect(types).not.toContain('shared_webgl');
    expect(types).not.toContain('shared_tls_ja4');
  });

  it('returns no entries when signals are missing', () => {
    const ctx: PeerIdentifyContext = {};
    const entries = activeSignalEntries({}, [...allTypes], false);
    expect(entries).toHaveLength(0);
    void ctx;
  });

  it('excludes types not in enabledEdgeTypes even on pro tier', () => {
    const entries = activeSignalEntries(fullSignals, ['shared_user'], false);
    expect(entries).toHaveLength(1);
    expect(entries[0].edgeType).toBe('shared_user');
  });
});
