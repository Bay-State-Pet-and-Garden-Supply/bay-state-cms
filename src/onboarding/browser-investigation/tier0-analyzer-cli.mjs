// Tier 0 analyzer container entrypoint (#236).
//
// Reads one analysis request as JSON on stdin (host broker captures),
// runs the dependency-free analyzer, and writes exactly one envelope as
// JSON on stdout. Nothing else is ever written to stdout, so the host can
// parse it unambiguously. Unexpected failures still produce an envelope
// (fail closed); the process exit code only signals transport health.

import {
  analyzeTier0Captures,
  TIER0_ANALYSIS_PROTOCOL_VERSION,
} from './tier0-analyzer.mjs';

const MAX_STDIN_BYTES = 96 * 1024 * 1024;
const MAX_DETAIL_BYTES = 500;

function sliceDetail(text) {
  return String(text ?? '').slice(0, MAX_DETAIL_BYTES);
}

function writeEnvelope(envelope) {
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    process.stdin.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > MAX_STDIN_BYTES) {
        fail(new Error('request exceeds the stdin ceiling'));
        return;
      }
      chunks.push(buf);
    });
    process.stdin.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    process.stdin.on('error', fail);
  });
}

function shallowValid(request) {
  return (
    !!request &&
    typeof request === 'object' &&
    typeof request.investigationId === 'string' &&
    !!request.budget &&
    typeof request.budget === 'object' &&
    Array.isArray(request.captures)
  );
}

async function main() {
  let raw;
  try {
    raw = await readStdin();
  } catch (err) {
    writeEnvelope({ ok: false, version: TIER0_ANALYSIS_PROTOCOL_VERSION, code: 'invalid_input', detail: sliceDetail(err) });
    return;
  }
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    writeEnvelope({ ok: false, version: TIER0_ANALYSIS_PROTOCOL_VERSION, code: 'invalid_input', detail: 'request is not valid JSON' });
    return;
  }
  if (!shallowValid(request)) {
    writeEnvelope({ ok: false, version: TIER0_ANALYSIS_PROTOCOL_VERSION, code: 'invalid_input', detail: 'request envelope malformed' });
    return;
  }
  try {
    const result = analyzeTier0Captures(request);
    writeEnvelope({ ok: true, version: TIER0_ANALYSIS_PROTOCOL_VERSION, result });
  } catch (err) {
    const code = err && (err.code === 'budget_exhausted' || err.code === 'invalid_input') ? err.code : 'provider_error';
    writeEnvelope({
      ok: false,
      version: TIER0_ANALYSIS_PROTOCOL_VERSION,
      code,
      // Analyzer messages are static strings (never page bytes), safe to forward sliced.
      detail: sliceDetail(err instanceof Error ? err.message : err),
    });
  }
}

main().catch((err) => {
  try {
    writeEnvelope({ ok: false, version: TIER0_ANALYSIS_PROTOCOL_VERSION, code: 'provider_error', detail: sliceDetail(err) });
  } catch {
    process.exitCode = 1;
  }
});
