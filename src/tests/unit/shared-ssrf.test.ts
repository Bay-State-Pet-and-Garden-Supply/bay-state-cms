import { describe, expect, it } from 'vitest';
import { classifyIp, isPrivateOrLinkLocal } from '../../shared/ssrf';

describe('shared ssrf classifier', () => {
  it('classifies loopback as private (verbatim legacy behavior)', () => {
    expect(classifyIp('127.0.0.1')).toBe('private');
    expect(classifyIp('::1')).toBe('link_local');
    expect(classifyIp('::')).toBe('link_local');
  });

  it('classifies RFC1918 ranges as private', () => {
    expect(classifyIp('10.1.2.3')).toBe('private');
    expect(classifyIp('172.16.0.1')).toBe('private');
    expect(classifyIp('172.31.255.255')).toBe('private');
    expect(classifyIp('192.168.1.1')).toBe('private');
  });

  it('classifies link-local ranges', () => {
    expect(classifyIp('169.254.169.254')).toBe('link_local');
    expect(classifyIp('fe80::1')).toBe('private');
  });

  it('handles octal, hex, and integer IPv4 representations', () => {
    // 127.0.0.1 variants
    expect(classifyIp('0177.0.0.1')).toBe('private');
    expect(classifyIp('0x7f000001')).toBe('private');
    expect(classifyIp('2130706433')).toBe('private');
    expect(classifyIp('127.1')).toBe('private');
    // 10.0.0.1 variant
    expect(classifyIp('012.0.0.1')).toBe('private');
    // 169.254.169.254 integer variant (2852038142)
    expect(classifyIp('2852038142')).toBe('link_local');
  });

  it('handles ::ffff:-mapped IPv4', () => {
    expect(classifyIp('::ffff:127.0.0.1')).toBe('private');
    expect(classifyIp('::ffff:7f00:1')).toBe('private');
    expect(classifyIp('::ffff:0177.0.0.1')).toBe('private');
    expect(classifyIp('::ffff:192.168.0.5')).toBe('private');
    expect(classifyIp('::ffff:8.8.8.8')).toBe('public');
  });

  it('handles alternate IPv6 encodings (zero-padded, unique-local, site-local)', () => {
    // Zero-padded loopback & unspecified
    expect(classifyIp('0000:0000:0000:0000:0000:0000:0000:0001')).toBe('link_local');
    expect(classifyIp('0:0:0:0:0:0:0:1')).toBe('link_local');
    expect(classifyIp('0000:0000:0000:0000:0000:0000:0000:0000')).toBe('link_local');

    // Full-length IPv4-mapped IPv6
    expect(classifyIp('0:0:0:0:0:ffff:127.0.0.1')).toBe('private');
    expect(classifyIp('0000:0000:0000:0000:0000:ffff:192.168.1.1')).toBe('private');
    expect(classifyIp('0:0:0:0:0:ffff:8.8.8.8')).toBe('public');

    // Unique-local fc00::/7 & link/site-local
    expect(classifyIp('fc00::1')).toBe('private');
    expect(classifyIp('fd00::1')).toBe('private');
    expect(classifyIp('fe80:0:0:0:0:0:0:1')).toBe('private');
    expect(classifyIp('fec0::1')).toBe('private');
  });

  it('classifies public addresses', () => {
    expect(classifyIp('8.8.8.8')).toBe('public');
    expect(classifyIp('2606:4700::1111')).toBe('public');
  });

  it('returns unknown for garbage input', () => {
    expect(classifyIp('not-an-ip')).toBe('unknown');
    expect(classifyIp('999.1.1.1')).toBe('unknown');
    expect(classifyIp('')).toBe('unknown');
  });
});

describe('isPrivateOrLinkLocal', () => {
  it('blocks private and link-local, allows public', () => {
    expect(isPrivateOrLinkLocal('127.0.0.1')).toBe(true);
    expect(isPrivateOrLinkLocal('0177.0.0.1')).toBe(true);
    expect(isPrivateOrLinkLocal('2130706433')).toBe(true);
    expect(isPrivateOrLinkLocal('10.0.0.7')).toBe(true);
    expect(isPrivateOrLinkLocal('169.254.1.1')).toBe(true);
    expect(isPrivateOrLinkLocal('8.8.8.8')).toBe(false);
  });
});

describe('isPrivateOrLinkLocalHost', () => {
  it('blocks literal private/loopback IPs and localhost', async () => {
    const { isPrivateOrLinkLocalHost } = await import('../../shared/ssrf');
    expect(await isPrivateOrLinkLocalHost('localhost')).toBe(true);
    expect(await isPrivateOrLinkLocalHost('127.0.0.1')).toBe(true);
    expect(await isPrivateOrLinkLocalHost('10.0.0.1')).toBe(true);
    expect(await isPrivateOrLinkLocalHost('169.254.169.254')).toBe(true);
  });

  it('allows literal public IPs without DNS lookup', async () => {
    const { isPrivateOrLinkLocalHost } = await import('../../shared/ssrf');
    const mockLookup = async () => { throw new Error('DNS should not be called'); };
    expect(await isPrivateOrLinkLocalHost('8.8.8.8', { lookup: mockLookup as any })).toBe(false);
  });

  it('resolves DNS for hostnames and blocks private targets', async () => {
    const { isPrivateOrLinkLocalHost } = await import('../../shared/ssrf');
    const mockLookupPrivate = async () => [{ address: '127.0.0.1' }];
    expect(await isPrivateOrLinkLocalHost('spoof.example.com', { lookup: mockLookupPrivate as any })).toBe(true);
  });

  it('resolves DNS for hostnames and allows public targets', async () => {
    const { isPrivateOrLinkLocalHost } = await import('../../shared/ssrf');
    const mockLookupPublic = async () => [{ address: '93.184.215.14' }];
    expect(await isPrivateOrLinkLocalHost('example.com', { lookup: mockLookupPublic as any })).toBe(false);
  });

  it('fails closed when DNS lookup fails or returns no records', async () => {
    const { isPrivateOrLinkLocalHost } = await import('../../shared/ssrf');
    const mockLookupError = async () => { throw new Error('ENOTFOUND'); };
    const mockLookupEmpty = async () => [];
    expect(await isPrivateOrLinkLocalHost('unknown-domain.invalid', { lookup: mockLookupError as any })).toBe(true);
    expect(await isPrivateOrLinkLocalHost('nodata-domain.invalid', { lookup: mockLookupEmpty as any })).toBe(true);
  });
});
