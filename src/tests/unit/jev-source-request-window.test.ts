/**
 * Behavioral source-request-window tests (public seam only, no network).
 *
 * Covers the owned-window invariants at the module boundary: immutable
 * allocation + exact binding, atomic pre-HTTP numbered reservations across
 * reopened handles (second worker/process/resume shares spend), exhaustion
 * refusal before transport with no refund, per-hop/per-kind shared counting,
 * corrupt/malformed fail-closed, symlink + public-docs rejection, SHA-only
 * public receipts, and per-invocation remaining-window caps. No source or
 * wiring assertions; raw fixture URLs never appear in public receipts.
 */
import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPublicSourceReceipt,
  buildPublicWindowLedger,
  computeOwnerDecisionSha256,
  createSourceWindow,
  getSourceWindowUsage,
  hashSourceUrlForReceipt,
  openSourceWindow,
  parseInvocationCap,
  recordSourceOutcome,
  reserveSourceRequest,
  SOURCE_WINDOW_MAX,
  SourceWindowExhaustedError,
  type SourceWindowHandle,
} from '../../../scripts/lib/source-request-window';

const AUTHORITY = 'ff17dc313076c4657e87fa557ae7fa182796ddfcb53ce385f7525ebc03a33026';
const OTHER_HEX = '00'.repeat(32);

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'source-window-test-'));
}

function ownerFile(root: string, body = '{"approved":true}'): { path: string; sha: string } {
  const p = path.join(root, 'owner-approved-decisions.json');
  fs.writeFileSync(p, body);
  return { path: p, sha: computeOwnerDecisionSha256(p) };
}

function openWindow(dir: string, ownerSha: string, max = SOURCE_WINDOW_MAX): SourceWindowHandle {
  return openSourceWindow({
    windowDir: dir,
    expectedOwnerDecisionSha256: ownerSha,
    expectedAuthorityHash: AUTHORITY,
    expectedMaxHttpAttempts: max,
  });
}

describe('source-request-window allocation (no network)', () => {
  it('creates one immutable allocation bound to owner SHA + authority, sealed against resell', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    const handle = createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY });
    expect(handle.maxHttpAttempts).toBe(1200);
    expect(getSourceWindowUsage(handle)).toMatchObject({ spent: 0, remaining: 1200, max: 1200 });
    expect(() => createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY }))
      .toThrow(/source_window_immutable/);
    expect(() => openWindow(dir, OTHER_HEX)).toThrow(/source_window_allocation_mismatch/);
    expect(() => openSourceWindow({
      windowDir: dir,
      expectedOwnerDecisionSha256: owner.sha,
      expectedAuthorityHash: OTHER_HEX,
      expectedMaxHttpAttempts: SOURCE_WINDOW_MAX,
    })).toThrow(/source_window_allocation_mismatch/);
    expect(() => openWindow(dir, owner.sha, 1199)).toThrow(/source_window_allocation_mismatch/);
  });

  it('rejects oversized allocations, public-docs windows, and symlink windows', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    expect(() => createSourceWindow({
      windowDir: path.join(root, 'too-big'),
      ownerDecisionSha256: owner.sha,
      authorityHash: AUTHORITY,
      maxHttpAttempts: 1201,
    })).toThrow(/source_window_invalid_allocation/);
    expect(() => createSourceWindow({
      windowDir: path.join('docs', 'audits', 'window-test-should-fail'),
      ownerDecisionSha256: owner.sha,
      authorityHash: AUTHORITY,
    })).toThrow(/source_window_private_path_required/);
    const target = path.join(root, 'real-window');
    createSourceWindow({ windowDir: target, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY });
    const link = path.join(root, 'window-link');
    fs.symlinkSync(target, link);
    expect(() => openWindow(link, owner.sha)).toThrow(/source_window_symlink_rejected/);
  });

  it('binds the exact owner-decision bytes, not a retyped copy', () => {
    const root = tempRoot();
    const owner = ownerFile(root, '{"approved":true}');
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY });
    fs.writeFileSync(owner.path, '{"approved": true}');
    const drifted = computeOwnerDecisionSha256(owner.path);
    expect(drifted).not.toBe(owner.sha);
    expect(() => openWindow(dir, drifted)).toThrow(/source_window_allocation_mismatch/);
    expect(openWindow(dir, owner.sha).ownerDecisionSha256).toBe(owner.sha);
  });
});

describe('source-request-window reservations (no network)', () => {
  it('numbers reservations 1..N across reopened handles: a resume never resets spend', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY });
    const first = openWindow(dir, owner.sha);
    expect(reserveSourceRequest(first, { url: 'https://fixtures.test/sitemap.xml', kind: 'sitemap' }).seq).toBe(1);
    expect(reserveSourceRequest(first, { url: 'https://fixtures.test/products.json?page=1', kind: 'feed' }).seq).toBe(2);
    // Second worker / process / resume opens the same window and continues the ledger.
    const second = openWindow(dir, owner.sha);
    expect(getSourceWindowUsage(second).spent).toBe(2);
    expect(reserveSourceRequest(second, { url: 'https://fixtures.test/products/a', kind: 'page' }).seq).toBe(3);
    expect(getSourceWindowUsage(openWindow(dir, owner.sha))).toMatchObject({ spent: 3, remaining: 1197 });
  });

  it('shares one window across sitemap/feed/page/enrich kinds: every hop spends', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY, maxHttpAttempts: 4 });
    const handle = openWindow(dir, owner.sha, 4);
    const kinds = ['sitemap', 'feed', 'page', 'enrich'] as const;
    kinds.forEach((kind, i) => {
      expect(reserveSourceRequest(handle, { url: `https://fixtures.test/hop-${i}`, kind }).seq).toBe(i + 1);
    });
    expect(getSourceWindowUsage(handle)).toMatchObject({ spent: 4, remaining: 0 });
  });

  it('refuses before transport at exhaustion with no refund: outcomes never unspend', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY, maxHttpAttempts: 2 });
    const handle = openWindow(dir, owner.sha, 2);
    const first = reserveSourceRequest(handle, { url: 'https://fixtures.test/a', kind: 'page' });
    reserveSourceRequest(handle, { url: 'https://fixtures.test/b', kind: 'page' });
    expect(() => reserveSourceRequest(handle, { url: 'https://fixtures.test/c', kind: 'page' }))
      .toThrow(SourceWindowExhaustedError);
    recordSourceOutcome(handle, first.seq, { status: 200, finalUrl: 'https://fixtures.test/a', bytes: 10 });
    expect(getSourceWindowUsage(handle).spent).toBe(2);
    expect(() => reserveSourceRequest(handle, { url: 'https://fixtures.test/c', kind: 'page' }))
      .toThrow(/source_window_exhausted/);
  });

  it('treats a crash between reserve and outcome as conservatively spent', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY });
    const handle = openWindow(dir, owner.sha);
    reserveSourceRequest(handle, { url: 'https://fixtures.test/crash', kind: 'page' });
    // No outcome recorded (simulated crash): the seq stays spent and publishes as outcome-missing.
    expect(getSourceWindowUsage(openWindow(dir, owner.sha)).spent).toBe(1);
    const [receipt] = buildPublicSourceReceipt(openWindow(dir, owner.sha), [1]);
    expect(receipt).toMatchObject({ seq: 1, status: null, outcomeMissing: true });
  });

  it('requires https URLs and known kinds at reservation time', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY });
    const handle = openWindow(dir, owner.sha);
    expect(() => reserveSourceRequest(handle, { url: 'http://fixtures.test/x', kind: 'page' }))
      .toThrow(/source_window_invalid_request/);
    expect(() => reserveSourceRequest(handle, { url: 'https://fixtures.test/x', kind: 'probe' as never }))
      .toThrow(/source_window_invalid_request/);
    expect(getSourceWindowUsage(handle).spent).toBe(0);
  });
});

describe('source-request-window receipts (no network)', () => {
  it('records immutable outcomes once; rejects unreserved seqs and overwrites', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY });
    const handle = openWindow(dir, owner.sha);
    const receipt = reserveSourceRequest(handle, { url: 'https://fixtures.test/products/a', kind: 'page' });
    expect(() => recordSourceOutcome(handle, 2, { status: 200 })).toThrow(/source_window_unreserved_seq/);
    recordSourceOutcome(handle, receipt.seq, { status: 200, finalUrl: 'https://fixtures.test/products/a', bytes: 42 });
    expect(() => recordSourceOutcome(handle, receipt.seq, { status: 200 })).toThrow(/source_window_immutable/);
  });

  it('publishes SHA-only public receipts: raw held URLs never appear', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY });
    const handle = openWindow(dir, owner.sha);
    const url = 'https://fixtures.test/products/secret-slug-123';
    const finalUrl = 'https://fixtures.test/products/secret-slug-123?variant=4';
    const { seq } = reserveSourceRequest(handle, { url, kind: 'page', worker: 'batch3-p1' });
    recordSourceOutcome(handle, seq, { status: 200, finalUrl, bytes: 100 });
    const [receipt] = buildPublicSourceReceipt(openWindow(dir, owner.sha), [seq]);
    expect(receipt).toMatchObject({
      seq,
      urlSha256: hashSourceUrlForReceipt(url),
      finalUrlSha256: hashSourceUrlForReceipt(finalUrl),
      kind: 'page',
      worker: 'batch3-p1',
      status: 200,
      bytes: 100,
      outcomeMissing: false,
    });
    expect(JSON.stringify(receipt)).not.toContain('secret-slug');
    expect(JSON.stringify(receipt)).not.toContain('fixtures.test');
    expect(JSON.stringify(buildPublicWindowLedger(openWindow(dir, owner.sha)))).not.toContain('fixtures.test');
  });

  it('fails closed on corrupt/malformed receipts: tamper, gaps, and strangers all throw', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY });
    const handle = openWindow(dir, owner.sha);
    reserveSourceRequest(handle, { url: 'https://fixtures.test/a', kind: 'page' });
    reserveSourceRequest(handle, { url: 'https://fixtures.test/b', kind: 'page' });
    const reservations = path.join(dir, 'reservations');
    // Tampered sha binding.
    const tampered = path.join(reservations, '000001.json');
    const parsed = JSON.parse(fs.readFileSync(tampered, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(tampered, JSON.stringify({ ...parsed, urlSha256: OTHER_HEX }));
    expect(() => getSourceWindowUsage(openWindow(dir, owner.sha))).toThrow(/source_window_corrupt/);
    fs.writeFileSync(tampered, JSON.stringify(parsed));
    // Deleted seq creates a gap (no silent shrink).
    fs.rmSync(path.join(reservations, '000001.json'));
    expect(() => getSourceWindowUsage(openWindow(dir, owner.sha))).toThrow(/source_window_corrupt/);
  });

  it('rejects stranger files and symlink receipts inside the ledger', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY });
    const handle = openWindow(dir, owner.sha);
    reserveSourceRequest(handle, { url: 'https://fixtures.test/a', kind: 'page' });
    fs.writeFileSync(path.join(dir, 'reservations', 'notes.txt'), 'stranger');
    expect(() => getSourceWindowUsage(openWindow(dir, owner.sha))).toThrow(/source_window_corrupt/);
    fs.rmSync(path.join(dir, 'reservations', 'notes.txt'));
    const link = path.join(dir, 'reservations', '000002.json');
    fs.symlinkSync(path.join(dir, 'reservations', '000001.json'), link);
    expect(() => getSourceWindowUsage(openWindow(dir, owner.sha))).toThrow(/source_window_symlink_rejected/);
  });
});

describe('source-request-window invocation caps (no network)', () => {
  it('parses per-invocation caps as remaining-window: default remaining, reject-if-greater', () => {
    expect(parseInvocationCap(null, 1200)).toBe(1200);
    expect(parseInvocationCap('1200', 1200)).toBe(1200);
    expect(parseInvocationCap(null, 5)).toBe(5);
    expect(parseInvocationCap('5', 5)).toBe(5);
    expect(() => parseInvocationCap('6', 5)).toThrow(/exceeds remaining window/);
    expect(() => parseInvocationCap('1201', 1200)).toThrow(/invalid_attempt_cap/);
    expect(() => parseInvocationCap('0', 1200)).toThrow(/invalid_attempt_cap/);
    expect(() => parseInvocationCap(null, 0)).toThrow(SourceWindowExhaustedError);
    expect(() => parseInvocationCap(null, -1)).toThrow(/source_window_corrupt/);
  });

  it('never lets a second worker exceed the shared remaining window', () => {
    const root = tempRoot();
    const owner = ownerFile(root);
    const dir = path.join(root, 'window');
    createSourceWindow({ windowDir: dir, ownerDecisionSha256: owner.sha, authorityHash: AUTHORITY, maxHttpAttempts: 3 });
    const first = openWindow(dir, owner.sha, 3);
    reserveSourceRequest(first, { url: 'https://fixtures.test/1', kind: 'page' });
    reserveSourceRequest(first, { url: 'https://fixtures.test/2', kind: 'page' });
    const second = openWindow(dir, owner.sha, 3);
    const remaining = getSourceWindowUsage(second).remaining;
    expect(remaining).toBe(1);
    expect(parseInvocationCap(null, remaining)).toBe(1);
    expect(() => parseInvocationCap('2', remaining)).toThrow(/exceeds remaining window/);
    reserveSourceRequest(second, { url: 'https://fixtures.test/3', kind: 'page' });
    expect(() => reserveSourceRequest(openWindow(dir, owner.sha, 3), { url: 'https://fixtures.test/4', kind: 'page' }))
      .toThrow(/source_window_exhausted/);
  });
});
