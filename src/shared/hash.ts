/**
 * Environment-agnostic SHA-256. node:crypto is required lazily inside
 * sha256() so the module import itself never evaluates a node builtin —
 * Vite externalizes node:crypto in client bundles as a throwing stub, and
 * a top-level import crashes the whole app before render.
 */
function pureSha256(data: string | Uint8Array): string {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  const H = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  // Encode string as UTF-8 bytes or use Uint8Array directly
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const len = bytes.length;
  const bitLen = len * 8;

  // Padding
  const k = (448 - ((len * 8 + 8) % 512) + 512) % 512;
  const paddingLen = (8 + k) / 8 + 8;
  const padded = new Uint8Array(len + paddingLen);
  padded.set(bytes);
  padded[len] = 0x80;

  // Append bit length as 64-bit big-endian integer
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen % 0x100000000;
  view.setUint32(padded.length - 8, highBits, false);
  view.setUint32(padded.length - 4, lowBits, false);

  const w = new Int32Array(64);

  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getInt32(i + j * 4, false);
    }
    for (let j = 16; j < 64; j++) {
      const s0 =
        ((w[j - 15] >>> 7) | (w[j - 15] << 25)) ^
        ((w[j - 15] >>> 18) | (w[j - 15] << 14)) ^
        (w[j - 15] >>> 3);
      const s1 =
        ((w[j - 2] >>> 17) | (w[j - 2] << 15)) ^
        ((w[j - 2] >>> 19) | (w[j - 2] << 13)) ^
        (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }

    let a = H[0];
    let b = H[1];
    let c = H[2];
    let d = H[3];
    let e = H[4];
    let f = H[5];
    let g = H[6];
    let h = H[7];

    for (let j = 0; j < 64; j++) {
      const S1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[j] + w[j]) | 0;
      const S0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    H[0] = (H[0] + a) | 0;
    H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0;
    H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0;
    H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0;
    H[7] = (H[7] + h) | 0;
  }

  return H.map((val) => (val >>> 0).toString(16).padStart(8, '0')).join('');
}

/**
 * Compute SHA-256 hash string (hex encoded).
 * Uses node:crypto when available, falling back to pure SHA-256 in browser environments.
 */
export function sha256(data: string | Uint8Array): string {
  try {
    // Lazy require: top-level node: imports crash Vite client bundles.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto: { createHash?: (algo: string) => { update: (d: string | Uint8Array, e?: string) => { digest: (f: string) => string } } } | undefined =
      typeof process !== 'undefined' && process.versions?.node ? require('node:crypto') : undefined;
    if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
      if (typeof data === 'string') {
        return nodeCrypto.createHash('sha256').update(data, 'utf8').digest('hex');
      }
      return nodeCrypto.createHash('sha256').update(data).digest('hex');
    }
  } catch {
    // Bundled or restricted runtime: fall through to pure JS.
  }
  return pureSha256(data);
}
