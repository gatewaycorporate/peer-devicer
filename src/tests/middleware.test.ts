// ────────────────────────────────────────────────────────────
//  Tests — middleware (peer-devicer)
// ────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import type { ServerResponse } from 'node:http';
import { createPeerMiddleware, extractPeerContext, resolveIp } from '../libs/middleware.js';
import type { PeerRequest } from '../libs/middleware.js';

function makeRequest(
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, 'remoteAddress', { value: remoteAddress, writable: true });
  const req = new IncomingMessage(socket);
  Object.assign(req.headers, headers);
  return req;
}

// ── resolveIp ──────────────────────────────────────────────

describe('resolveIp', () => {
  it('prefers req.resolvedIp (set by ip-devicer) over all headers', () => {
    const req = makeRequest({ 'cf-connecting-ip': '1.2.3.4' }) as IncomingMessage & { resolvedIp?: string };
    req.resolvedIp = '9.9.9.9';
    expect(resolveIp(req)).toBe('9.9.9.9');
  });

  it('prefers CF-Connecting-IP when resolvedIp is absent', () => {
    const req = makeRequest({ 'cf-connecting-ip': '198.51.100.10', 'x-real-ip': '1.1.1.1' });
    expect(resolveIp(req)).toBe('198.51.100.10');
  });

  it('prefers True-Client-IP over X-Real-IP', () => {
    const req = makeRequest({ 'true-client-ip': '2.2.2.2', 'x-real-ip': '3.3.3.3' });
    expect(resolveIp(req)).toBe('2.2.2.2');
  });

  it('prefers X-Real-IP over X-Forwarded-For', () => {
    const req = makeRequest({ 'x-real-ip': '4.4.4.4', 'x-forwarded-for': '5.5.5.5' });
    expect(resolveIp(req)).toBe('4.4.4.4');
  });

  it('uses the first entry of X-Forwarded-For', () => {
    const req = makeRequest({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' });
    expect(resolveIp(req)).toBe('203.0.113.5');
  });

  it('handles array header values (CF-Connecting-IP)', () => {
    const req = makeRequest({});
    req.headers['cf-connecting-ip'] = ['6.6.6.6', '7.7.7.7'];
    expect(resolveIp(req)).toBe('6.6.6.6');
  });

  it('falls back to socket remoteAddress', () => {
    const req = makeRequest({}, '192.168.1.50');
    expect(resolveIp(req)).toBe('192.168.1.50');
  });

  it('returns unknown when nothing is available', () => {
    const req = makeRequest();
    Object.defineProperty(req.socket, 'remoteAddress', { value: undefined, writable: true });
    expect(resolveIp(req)).toBe('unknown');
  });
});

// ── extractPeerContext ───────────────────────────────────────

describe('extractPeerContext', () => {
  it('populates the ip field from header chain', () => {
    const req = makeRequest({ 'x-real-ip': '10.0.0.1' });
    const ctx = extractPeerContext(req);
    expect(ctx.ip).toBe('10.0.0.1');
  });

  it('reads userId from x-user-id header', () => {
    const req = makeRequest({ 'x-user-id': 'user-123', 'x-real-ip': '1.1.1.1' });
    const ctx = extractPeerContext(req);
    expect(ctx.userId).toBe('user-123');
  });

  it('does not set userId when x-user-id header is absent', () => {
    const req = makeRequest({ 'x-real-ip': '1.1.1.1' });
    const ctx = extractPeerContext(req);
    expect(ctx.userId).toBeUndefined();
  });

  it('reads ja4 from req.tlsProfile set by tls-devicer', () => {
    const req = makeRequest() as PeerRequest;
    req.tlsProfile = { ja4: 't13d1516h2_abc', ja3: 'md5abc' };
    const ctx = extractPeerContext(req);
    expect(ctx.tlsProfile?.ja4).toBe('t13d1516h2_abc');
    expect(ctx.tlsProfile?.ja3).toBe('md5abc');
  });

  it('falls back to x-ja4 proxy header when req.tlsProfile is absent', () => {
    const req = makeRequest({ 'x-ja4': 't13d1516h2_fallback', 'x-real-ip': '1.1.1.1' });
    const ctx = extractPeerContext(req);
    expect(ctx.tlsProfile?.ja4).toBe('t13d1516h2_fallback');
  });

  it('falls back to cf-ja4 when x-ja4 is also absent', () => {
    const req = makeRequest({ 'cf-ja4': 't13d1516h2_cf', 'x-real-ip': '1.1.1.1' });
    const ctx = extractPeerContext(req);
    expect(ctx.tlsProfile?.ja4).toBe('t13d1516h2_cf');
  });

  it('omits tlsProfile entirely when no JA4/JA3 signals are present', () => {
    const req = makeRequest({ 'x-real-ip': '1.1.1.1' });
    const ctx = extractPeerContext(req);
    expect(ctx.tlsProfile).toBeUndefined();
  });
});

// ── createPeerMiddleware ─────────────────────────────────────

describe('createPeerMiddleware', () => {
  it('attaches peerContext and calls next()', () => {
    const req = makeRequest({ 'x-real-ip': '10.0.1.1', 'x-user-id': 'u42' }) as PeerRequest;
    const next = vi.fn();
    const middleware = createPeerMiddleware();

    middleware(req, {} as ServerResponse, next);

    expect(req.peerContext).toBeDefined();
    expect(req.peerContext?.ip).toBe('10.0.1.1');
    expect(req.peerContext?.userId).toBe('u42');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('calls next() even when no signals are present', () => {
    const req = makeRequest() as PeerRequest;
    Object.defineProperty(req.socket, 'remoteAddress', { value: undefined, writable: true });
    const next = vi.fn();
    createPeerMiddleware()(req, {} as ServerResponse, next);
    expect(next).toHaveBeenCalled();
  });
});
