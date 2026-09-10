import { describe, expect, it } from 'bun:test';
import { isPrivateOrLinkLocal } from '../../shared/ssrf';
import { DeterministicNetworkGate, NetworkGateDeniedError } from '../../onboarding/image-verification/network-gate';

describe('image-downloader-ssrf adversarial tests', () => {
  it('DeterministicNetworkGate blocks localhost, RFC1918, link-local, and cloud metadata IPs', async () => {
    const gate = new DeterministicNetworkGate();

    await expect(gate.fetch('http://127.0.0.1/test.jpg')).rejects.toThrow(NetworkGateDeniedError);
    await expect(gate.fetch('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(NetworkGateDeniedError);
    await expect(gate.fetch('http://10.0.0.1/secret.png')).rejects.toThrow(NetworkGateDeniedError);
    await expect(gate.fetch('http://192.168.1.1/admin.jpg')).rejects.toThrow(NetworkGateDeniedError);
    await expect(gate.fetch('http://0.0.0.0/app')).rejects.toThrow(NetworkGateDeniedError);
  });

  it('shared ssrf classifier classifies alternate representations and non-standard IPs correctly', () => {
    expect(isPrivateOrLinkLocal('127.0.0.1')).toBe(true);
    expect(isPrivateOrLinkLocal('0177.0.0.1')).toBe(true);
    expect(isPrivateOrLinkLocal('0x7f000001')).toBe(true);
    expect(isPrivateOrLinkLocal('0.0.0.0')).toBe(true);
    expect(isPrivateOrLinkLocal('169.254.169.254')).toBe(true);
    expect(isPrivateOrLinkLocal('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrLinkLocal('fc00::1')).toBe(true);

    // Public IPs (including public 172.x.x.x addresses)
    expect(isPrivateOrLinkLocal('8.8.8.8')).toBe(false);
    expect(isPrivateOrLinkLocal('172.217.14.206')).toBe(false); // Google public IP
  });
});
