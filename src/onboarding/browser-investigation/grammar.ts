// Browser Investigation declarative inspection grammar (T3).
//
// Versioned read-only grammar for the constrained local harness. The model
// gets ONLY these bounded operations — no clicks, typing, form submissions,
// logins, carts, downloads, service workers, WebSockets, authentication /
// CAPTCHA workflows, or executable code. Unknown operations or parameters
// fail closed; a discovered URL gains no fetch permission; clipped
// observations are marked incomplete and cannot certify absence, coverage,
// or identity.
//
// Pure (Zod only): Vitest-safe. Enforcement of byte/node/match caps happens
// here at parse time for declarative bounds and in the harness at execution
// time for measured bounds.

import { z } from 'zod';
import { validatePolicySelector } from '../../shared/schemas/browser-investigation-policy';

/** Grammar version. The harness executes only this version; anything else fails closed. */
export const INSPECTION_GRAMMAR_VERSION = 1 as const;

export class GrammarError extends Error {
  readonly code: 'unknown_operation' | 'invalid_params' | 'grammar_version_mismatch' | 'scope_violation';
  constructor(
    code: GrammarError['code'],
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'GrammarError';
    this.code = code;
  }
}

function fail(code: GrammarError['code'], message: string): never {
  throw new GrammarError(code, message);
}

// ─── Opaque scoped references ─────────────────────────────────────────────
// References are opaque strings bound to (workspace, investigation, capture).
// The grammar never mints fetch grants: `read_attribute` may RETURN a URL as
// text, but that text is untrusted data — only the broker's immutable scope
// (approved hosts/paths) can authorize a fetch, and the broker never consults
// grammar output for permission.

const ARTIFACT_REF_RE = /^artifact:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})$/;
const RESPONSE_REF_RE = /^response:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})$/;
const ELEMENT_REF_RE = /^el:([A-Za-z0-9_-]{1,128}):([0-9]{1,6}):([0-9]{1,6})$/;

export interface ScopedRef {
  kind: 'artifact' | 'response' | 'element';
  investigationId: string;
  captureId: string;
}

/** Parse an opaque reference without authorizing anything. */
export function parseScopedRef(raw: unknown): ScopedRef {
  if (typeof raw !== 'string') fail('invalid_params', 'reference must be a string');
  const text = raw as string;
  let m = ARTIFACT_REF_RE.exec(text);
  if (m) return { kind: 'artifact', investigationId: m[1]!, captureId: m[2]! };
  m = RESPONSE_REF_RE.exec(text);
  if (m) return { kind: 'response', investigationId: m[1]!, captureId: m[2]! };
  m = ELEMENT_REF_RE.exec(text);
  if (m) return { kind: 'element', investigationId: m[1]!, captureId: `${m[2]}:${m[3]}` };
  fail('invalid_params', 'malformed opaque reference');
}

/** Assert a reference belongs to the running (workspace is implicit in the store binding) investigation. */
export function assertRefScope(ref: ScopedRef, investigationId: string): void {
  if (ref.investigationId !== investigationId) {
    fail('scope_violation', 'foreign or stale artifact reference');
  }
}

/** Mint an opaque artifact reference. Capture ids are harness-generated, never model-chosen. */
// fallow-ignore-next-line unused-export — harness + tests
export function mintArtifactRef(investigationId: string, captureId: string): string {
  assertRefId(investigationId);
  assertRefId(captureId);
  return `artifact:${investigationId}:${captureId}`;
}

// fallow-ignore-next-line unused-export — harness + tests
export function mintResponseRef(investigationId: string, captureId: string): string {
  assertRefId(investigationId);
  assertRefId(captureId);
  return `response:${investigationId}:${captureId}`;
}

// fallow-ignore-next-line unused-export — harness + tests
export function mintElementRef(investigationId: string, pageIndex: number, elementIndex: number): string {
  assertRefId(investigationId);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex > 999_999) {
    fail('invalid_params', 'page index out of range');
  }
  if (!Number.isInteger(elementIndex) || elementIndex < 0 || elementIndex > 999_999) {
    fail('invalid_params', 'element index out of range');
  }
  return `el:${investigationId}:${pageIndex}:${elementIndex}`;
}

function assertRefId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail('invalid_params', 'invalid reference scope id');
}

// ─── Operation schemas (strict: unknown keys rejected) ────────────────────

const BaseOpSchema = z.object({
  version: z.literal(INSPECTION_GRAMMAR_VERSION),
});

const SelectorField = z.string().min(1).max(512);

export const QuerySelectorAllSchema = BaseOpSchema.extend({
  op: z.literal('query_selector_all'),
  /** Captured page to query (opaque artifact ref, same investigation). */
  pageRef: z.string().min(1).max(256),
  /** Bounded CSS selector. No clicking or mutation. */
  selector: SelectorField,
  /** Max matches to return (harness also enforces the budget cap). */
  maxMatches: z.number().int().min(1).max(100).default(100),
}).strict();
export type QuerySelectorAllOp = z.infer<typeof QuerySelectorAllSchema>;

export const ReadAttributeSchema = BaseOpSchema.extend({
  op: z.literal('read_attribute'),
  /** Existing element reference from a prior query_selector_all. */
  elementRef: z.string().min(1).max(256),
  /** Named DOM attribute. Returned as text only. */
  attribute: z.string().min(1).max(128),
}).strict();
export type ReadAttributeOp = z.infer<typeof ReadAttributeSchema>;

export const ReadScriptJsonSchema = BaseOpSchema.extend({
  op: z.literal('read_script_json'),
  elementRef: z.string().min(1).max(256),
  /** Max JSON nodes the harness may visit while bounding the value. */
  maxNodes: z.number().int().min(1).max(10_000).default(10_000),
  /** Max pointer depth the harness may traverse. */
  maxDepth: z.number().int().min(1).max(32).default(32),
}).strict();
export type ReadScriptJsonOp = z.infer<typeof ReadScriptJsonSchema>;

export const ReadMetaSchema = BaseOpSchema.extend({
  op: z.literal('read_meta'),
  pageRef: z.string().min(1).max(256),
  /** Max meta/link entries to return. */
  maxEntries: z.number().int().min(1).max(100).default(100),
}).strict();
export type ReadMetaOp = z.infer<typeof ReadMetaSchema>;

export const InspectNetworkResponseSchema = BaseOpSchema.extend({
  op: z.literal('inspect_network_response'),
  /** Opaque id of an ALREADY-CAPTURED broker-approved response. No replay. */
  responseRef: z.string().min(1).max(256),
  /** Max body bytes to project (harness also enforces the observation cap). */
  maxBytes: z.number().int().min(1).max(32 * 1024).default(32 * 1024),
}).strict();
export type InspectNetworkResponseOp = z.infer<typeof InspectNetworkResponseSchema>;

const JSON_POINTER_TOKEN_RE = /^[A-Za-z0-9_\-+:.@,*#%()[\] ]{0,128}$/;

export const ReadJsonPointerSchema = BaseOpSchema.extend({
  op: z.literal('read_json_pointer'),
  /** Opaque ref to a captured JSON value (from read_script_json or network inspection). */
  valueRef: z.string().min(1).max(256),
  /** Bounded RFC 6901 pointer tokens. No recursive descent, filters, expressions, or functions. */
  pointer: z.array(z.string().max(128)).min(1).max(32),
}).strict();
export type ReadJsonPointerOp = z.infer<typeof ReadJsonPointerSchema>;

export const InspectionOpSchema = z.discriminatedUnion('op', [
  QuerySelectorAllSchema,
  ReadAttributeSchema,
  ReadScriptJsonSchema,
  ReadMetaSchema,
  InspectNetworkResponseSchema,
  ReadJsonPointerSchema,
]);
export type InspectionOp = z.infer<typeof InspectionOpSchema>;

export const INSPECTION_OP_NAMES = [
  'query_selector_all',
  'read_attribute',
  'read_script_json',
  'read_meta',
  'inspect_network_response',
  'read_json_pointer',
] as const;

/** Executable-expression fragments that are never valid in pointer tokens. */
const FORBIDDEN_POINTER_FRAGMENTS = [
  '__proto__',
  'constructor',
  'prototype',
  '..',
  '$',
  '(',
  ')',
  '`',
  '${',
  'function',
  '=>',
  ';',
];

function assertPointerToken(token: string): void {
  if (!JSON_POINTER_TOKEN_RE.test(token)) fail('invalid_params', 'pointer token has invalid characters');
  const lowered = token.toLowerCase();
  for (const frag of FORBIDDEN_POINTER_FRAGMENTS) {
    if (lowered.includes(frag)) fail('invalid_params', 'pointer token traverses prototype or expressions');
  }
}

/**
 * Parse one raw model-requested operation. Unknown `op` names, wrong grammar
 * versions, unknown parameters, executable-looking selectors, and
 * prototype-traversing pointers fail closed with a GrammarError.
 */
export function parseInspectionOp(raw: unknown): InspectionOp {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('unknown_operation', 'operation must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== INSPECTION_GRAMMAR_VERSION) {
    fail('grammar_version_mismatch', 'unsupported inspection grammar version');
  }
  if (typeof obj.op !== 'string' || !(INSPECTION_OP_NAMES as readonly string[]).includes(obj.op)) {
    fail('unknown_operation', 'unknown inspection operation');
  }
  // Strict schemas reject unknown parameters; .strict() on extend chains is
  // expressed here by refusing known-dangerous extras explicitly.
  const parsed = InspectionOpSchema.safeParse(raw);
  if (!parsed.success) {
    fail('invalid_params', parsed.error.issues.map((i) => i.message).join('; ') || 'invalid operation parameters');
  }
  const op = (parsed as { success: true; data: InspectionOp }).data;
  assertOpSemantics(op);
  return op;
}

/** Per-operation semantic checks after structural parse: refs, selectors, pointers. */
function assertOpSemantics(op: InspectionOp): void {
  assertDomOpSemantics(op);
  assertDataOpSemantics(op);
}

/** Selector/attribute/meta ops: executable patterns and handler attributes refused. */
function assertDomOpSemantics(op: InspectionOp): void {
  if (op.op === 'query_selector_all') {
    const validated = validatePolicySelector(op.selector);
    if (!validated.ok) fail('invalid_params', `selector rejected (${validated.reason})`);
    parseScopedRef(op.pageRef);
  } else if (op.op === 'read_attribute') {
    parseScopedRef(op.elementRef);
    // Inline event-handler attributes (`onclick`, …) are executable code,
    // not data. Ordinary attributes — including URL-valued ones — read as
    // text only; a returned URL gains no fetch permission (see module doc).
    if (/^on/i.test(op.attribute)) {
      fail('invalid_params', 'event-handler attributes are not readable');
    }
  } else if (op.op === 'read_meta') {
    parseScopedRef(op.pageRef);
  }
}

/** Script-JSON/network/pointer ops: scope-bound refs, prototype-safe pointers. */
function assertDataOpSemantics(op: InspectionOp): void {
  if (op.op === 'read_script_json') {
    parseScopedRef(op.elementRef);
  } else if (op.op === 'inspect_network_response') {
    parseScopedRef(op.responseRef);
  } else if (op.op === 'read_json_pointer') {
    parseScopedRef(op.valueRef);
    for (const token of op.pointer) assertPointerToken(token);
  }
}

// ─── Strict script-JSON parsing ───────────────────────────────────────────
// Never evaluates JavaScript assignments or hydration code: the trimmed text
// must be strict JSON (object/array), parsed with JSON.parse, then bounded by
// size, depth, and visited-node count.

export interface ScriptJsonLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

export interface ParsedScriptJson {
  value: unknown;
  nodeCount: number;
}

/** Parse strict JSON from a script element with size/depth/node limits. */
export function parseStrictScriptJson(text: string, limits: ScriptJsonLimits): ParsedScriptJson {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > limits.maxBytes) {
    fail('invalid_params', 'script JSON exceeds size limit');
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    // Assignments (`window.__STATE__ = {...}`), function calls, and bare
    // identifiers are hydration code, not strict JSON — never evaluated.
    fail('invalid_params', 'script content is not strict JSON');
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    fail('invalid_params', 'script content is not strict JSON');
  }
  const nodeCount = countJsonNodes(value, limits);
  return { value, nodeCount };
}

function countJsonNodes(value: unknown, limits: ScriptJsonLimits): number {
  let count = 0;
  const visit = (node: unknown, depth: number): void => {
    if (depth > limits.maxDepth) fail('invalid_params', 'JSON depth exceeds limit');
    count += 1;
    if (count > limits.maxNodes) fail('invalid_params', 'JSON node count exceeds limit');
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
    } else if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) visit((node as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(value, 0);
  return count;
}

/**
 * Own-property RFC 6901 read over an already-captured JSON value. Prototype
 * traversal, recursive descent, filters, and expressions are rejected at
 * parse time; this executor additionally guards with hasOwnProperty.
 */
export function readOwnJsonPointer(value: unknown, pointer: string[]): { value: unknown; visited: number } {
  let current = value;
  let visited = 1;
  for (const token of pointer) {
    assertPointerToken(token);
    if (current === null || typeof current !== 'object') {
      fail('invalid_params', 'pointer traverses a non-container value');
    }
    if (!Object.prototype.hasOwnProperty.call(current, token)) {
      fail('invalid_params', 'pointer references a missing own property');
    }
    current = (current as Record<string, unknown>)[token];
    visited += 1;
  }
  return { value: current, visited };
}

// ─── Clipped observations ─────────────────────────────────────────────────

export interface CappedText {
  text: string;
  clipped: boolean;
}

/** Cap model-visible text at a UTF-8 byte budget; clipped output is marked incomplete. */
export function capObservationText(text: string, maxBytes: number): CappedText {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, clipped: false };
  // Cut on a UTF-8 boundary by decoding a truncated buffer with replacement
  // safety: slice then drop a trailing partial sequence.
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  // If the boundary byte starts a multi-byte sequence, step before it.
  if (end > 0 && end < buf.length && (buf[end - 1]! & 0x80) !== 0) {
    const lead = buf[end - 1]!;
    const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    if (buf.length - (end - 1) < expected || end - 1 + expected > maxBytes) end -= 1;
  }
  return { text: buf.subarray(0, end).toString('utf8'), clipped: true };
}

/** A clipped observation must be marked incomplete with its source/artifact reference. */
export interface ClippedObservation {
  incomplete: true;
  artifactRef: string;
  clippedBytes: number;
}

export function markClipped(artifactRef: string, clippedBytes: number): ClippedObservation {
  parseScopedRef(artifactRef);
  return { incomplete: true as const, artifactRef, clippedBytes };
}

export class CertificationError extends Error {
  constructor(message: string) {
    super(`uncertifiable: ${message}`);
    this.name = 'CertificationError';
  }
}

/**
 * Clipped observations cannot establish field absence, exhaustive image
 * membership, unique variant identity, or full coverage. These guards fail
 * closed whenever any contributing observation is incomplete.
 */
export function certifyFieldAbsence(observations: ReadonlyArray<{ incomplete?: boolean }>): void {
  if (observations.some((o) => o.incomplete)) {
    throw new CertificationError('clipped observations cannot certify field absence');
  }
}

// fallow-ignore-next-line unused-export — harness coverage gate + tests
export function certifyImageMembership(observations: ReadonlyArray<{ incomplete?: boolean }>): void {
  if (observations.some((o) => o.incomplete)) {
    throw new CertificationError('clipped observations cannot certify exhaustive image membership');
  }
}

// fallow-ignore-next-line unused-export — harness identity gate + tests
export function certifyVariantIdentity(observations: ReadonlyArray<{ incomplete?: boolean }>): void {
  if (observations.some((o) => o.incomplete)) {
    throw new CertificationError('clipped observations cannot certify unique variant identity');
  }
}

// fallow-ignore-next-line unused-export — harness coverage gate + tests
export function certifyCoverage(observations: ReadonlyArray<{ incomplete?: boolean }>): void {
  if (observations.some((o) => o.incomplete)) {
    throw new CertificationError('clipped observations cannot certify coverage');
  }
}
