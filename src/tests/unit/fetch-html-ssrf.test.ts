import { describe, it, expect } from 'vitest';
import app from '../../server/app';

describe('fetch-html SSRF & Local File Disclosure protection', () => {
  it('rejects file:// scheme URLs', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'file:///etc/passwd' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('Only http and https protocols are allowed');
  });

  it('rejects gopher:// scheme URLs', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'gopher://127.0.0.1:70/' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('Only http and https protocols are allowed');
  });

  it('rejects private IP addresses (localhost)', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:8080/admin' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('URL points to a private network address');
  });

  it('rejects private IP addresses (127.0.0.1)', async () => {
    const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/secret' }),
    });

    expect(res.status).toBe(400);
    const json = await res.json() as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('URL points to a private network address');
  });

  it('rejects alternate IPv4 encodings and cloud metadata addresses', async () => {
    const targets = [
      'http://0177.0.0.1/octal',
      'http://0x7f000001/hex',
      'http://2130706433/integer',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/ipv6-loopback',
      'http://[::ffff:127.0.0.1]/ipv6-mapped',
    ];

    for (const url of targets) {
      const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toBe('URL points to a private network address');
    }
  });

  it('rejects domain names that resolve to private or loopback IP addresses (SSRF DNS bypass)', async () => {
    const targets = [
      'http://127.0.0.1.nip.io/secret',
      'http://spoof.127.0.0.1.nip.io/admin',
    ];

    for (const url of targets) {
      const res = await app.request('/api/onboarding/settings/profile-tooling/fetch-html', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      expect(res.status).toBe(400);
      const json = await res.json() as { ok: boolean; error: string };
      expect(json.ok).toBe(false);
      expect(json.error).toBe('URL points to a private network address');
    }
  });
});
