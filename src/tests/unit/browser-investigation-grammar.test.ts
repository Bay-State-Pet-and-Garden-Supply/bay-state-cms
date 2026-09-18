// T3 (#227) — declarative inspection grammar: fail-closed contract (Vitest, pure).
//
// Unknown operations/parameters, executable-looking selectors, event-handler
// attributes, prototype-traversing pointers, non-JSON script content, and
// foreign/stale references all fail closed. Discovered URLs gain no fetch
// permission. Clipped observations are marked incomplete and cannot certify
// absence, coverage, or identity.

import { describe, it, expect } from 'vitest';
import {
  INSPECTION_GRAMMAR_VERSION,
  INSPECTION_OP_NAMES,
  CertificationError,
  GrammarError,
  InspectNetworkResponseSchema,
  InspectionOpSchema,
  QuerySelectorAllSchema,
  ReadAttributeSchema,
  ReadJsonPointerSchema,
  ReadMetaSchema,
  ReadScriptJsonSchema,
  assertRefScope,
  capObservationText,
  certifyCoverage,
  certifyFieldAbsence,
  certifyImageMembership,
  certifyVariantIdentity,
  markClipped,
  mintArtifactRef,
  mintElementRef,
  mintResponseRef,
  parseInspectionOp,
  parseScopedRef,
  parseStrictScriptJson,
  readOwnJsonPointer,
  type CappedText,
  type ClippedObservation,
  type InspectionOp,
  type InspectNetworkResponseOp,
  type ParsedScriptJson,
  type QuerySelectorAllOp,
  type ReadAttributeOp,
  type ReadJsonPointerOp,
  type ReadMetaOp,
  type ReadScriptJsonOp,
  type ScopedRef,
} from '../../onboarding/browser-investigation/grammar';

const PAGE = 'artifact:binv_1:p0';
const EL = 'el:binv_1:0:3';
const RESP = 'response:binv_1:p0';
const VAL = 'artifact:binv_1:json0';

function op(base: Record<string, unknown>): Record<string, unknown> {
  return { version: INSPECTION_GRAMMAR_VERSION, ...base };
}

describe('inspection grammar versioning', () => {
  it('exposes exactly the six bounded read primitives', () => {
    expect([...INSPECTION_OP_NAMES].sort()).toEqual(
      [
        'query_selector_all',
        'read_attribute',
        'read_script_json',
        'read_meta',
        'inspect_network_response',
        'read_json_pointer',
      ].sort(),
    );
  });

  it('parses one valid form of every primitive', () => {
    const query: QuerySelectorAllOp = parseInspectionOp(
      op({ op: 'query_selector_all', pageRef: PAGE, selector: 'h1.product-title' }),
    ) as QuerySelectorAllOp;
    expect(query.op).toBe('query_selector_all');
    const attr: ReadAttributeOp = parseInspectionOp(
      op({ op: 'read_attribute', elementRef: EL, attribute: 'src' }),
    ) as ReadAttributeOp;
    expect(attr.op).toBe('read_attribute');
    const script: ReadScriptJsonOp = parseInspectionOp(
      op({ op: 'read_script_json', elementRef: EL }),
    ) as ReadScriptJsonOp;
    expect(script.op).toBe('read_script_json');
    const meta: ReadMetaOp = parseInspectionOp(op({ op: 'read_meta', pageRef: PAGE })) as ReadMetaOp;
    expect(meta.op).toBe('read_meta');
    const network: InspectNetworkResponseOp = parseInspectionOp(
      op({ op: 'inspect_network_response', responseRef: RESP }),
    ) as InspectNetworkResponseOp;
    expect(network.op).toBe('inspect_network_response');
    const pointer: ReadJsonPointerOp = parseInspectionOp(
      op({ op: 'read_json_pointer', valueRef: VAL, pointer: ['offers', 'price'] }),
    ) as ReadJsonPointerOp;
    expect(pointer.op).toBe('read_json_pointer');
    const anyOp: InspectionOp = pointer;
    expect(anyOp.op).toBe('read_json_pointer');
  });

  it('pins each operation schema strict (unknown keys rejected at the schema seam too)', () => {
    expect(
      QuerySelectorAllSchema.safeParse({ version: 1, op: 'query_selector_all', pageRef: PAGE, selector: 'h1', extra: 1 })
        .success,
    ).toBe(false);
    expect(
      ReadAttributeSchema.safeParse({ version: 1, op: 'read_attribute', elementRef: EL, attribute: 'src', extra: 1 })
        .success,
    ).toBe(false);
    expect(
      ReadScriptJsonSchema.safeParse({ version: 1, op: 'read_script_json', elementRef: EL, extra: 1 }).success,
    ).toBe(false);
    expect(ReadMetaSchema.safeParse({ version: 1, op: 'read_meta', pageRef: PAGE, extra: 1 }).success).toBe(false);
    expect(
      InspectNetworkResponseSchema.safeParse({ version: 1, op: 'inspect_network_response', responseRef: RESP, extra: 1 })
        .success,
    ).toBe(false);
    expect(
      ReadJsonPointerSchema.safeParse({ version: 1, op: 'read_json_pointer', valueRef: VAL, pointer: ['a'], extra: 1 })
        .success,
    ).toBe(false);
    expect(
      InspectionOpSchema.safeParse({ version: 1, op: 'read_meta', pageRef: PAGE }).success,
    ).toBe(true);
  });

  it('rejects unknown operations, wrong versions, and non-objects', () => {
    expect(() => parseInspectionOp(op({ op: 'click' }))).toThrowError(GrammarError);
    expect(() => parseInspectionOp(op({ op: 'click' }))).toThrowError(/unknown_operation/);
    expect(() => parseInspectionOp(op({ op: 'evaluate', script: '1' }))).toThrowError(/unknown_operation/);
    expect(() => parseInspectionOp({ version: 999, op: 'read_meta', pageRef: PAGE })).toThrowError(
      /grammar_version_mismatch/,
    );
    expect(() => parseInspectionOp(null)).toThrowError(/unknown_operation/);
    expect(() => parseInspectionOp('read_meta')).toThrowError(/unknown_operation/);
  });

  it('rejects unknown parameters (strict schemas fail closed)', () => {
    expect(() =>
      parseInspectionOp(op({ op: 'read_meta', pageRef: PAGE, click: true })),
    ).toThrowError(/invalid_params/);
    expect(() =>
      parseInspectionOp(op({ op: 'query_selector_all', pageRef: PAGE, selector: 'h1', javascript: 'alert(1)' })),
    ).toThrowError(/invalid_params/);
    expect(() =>
      parseInspectionOp(op({ op: 'read_json_pointer', valueRef: VAL, pointer: ['a'], filter: '$..*' })),
    ).toThrowError(/invalid_params/);
  });
});

describe('selector and attribute bounds', () => {
  it('rejects executable-looking selectors', () => {
    for (const selector of [
      'javascript:alert(1)',
      '<script>',
      'div ${evil}',
      'div{{x}}',
      'a[href^=javascript:]',
      'x'.repeat(513),
    ]) {
      expect(() => parseInspectionOp(op({ op: 'query_selector_all', pageRef: PAGE, selector })), selector.slice(0, 20)).toThrowError(
        /invalid_params/,
      );
    }
  });

  it('rejects event-handler attribute reads (executable code, not data)', () => {
    expect(() => parseInspectionOp(op({ op: 'read_attribute', elementRef: EL, attribute: 'onclick' }))).toThrowError(
      /invalid_params/,
    );
  });

  it('reads URL-valued attributes as text with no fetch grant attached', () => {
    const parsed = parseInspectionOp(op({ op: 'read_attribute', elementRef: EL, attribute: 'src' }));
    expect(parsed.op).toBe('read_attribute');
    // The grammar mints no permission: the parsed op carries no fetch target,
    // grant flag, or broker instruction of any kind.
    expect(JSON.stringify(parsed)).not.toMatch(/fetch|grant|allow|permit/i);
  });
});

describe('JSON pointer discipline', () => {
  it('rejects prototype traversal, descent, filters, and expressions', () => {
    for (const pointer of [
      ['__proto__'],
      ['constructor'],
      ['a', 'prototype', 'b'],
      ['..'],
      ['$'],
      ['a(b)'],
      ['${x}'],
      ['a=>b'],
    ]) {
      expect(
        () => parseInspectionOp(op({ op: 'read_json_pointer', valueRef: VAL, pointer })),
        JSON.stringify(pointer),
      ).toThrowError(/invalid_params/);
    }
  });

  it('rejects empty and over-deep pointers', () => {
    expect(() => parseInspectionOp(op({ op: 'read_json_pointer', valueRef: VAL, pointer: [] }))).toThrowError(
      /invalid_params/,
    );
    expect(
      () => parseInspectionOp(op({ op: 'read_json_pointer', valueRef: VAL, pointer: Array(33).fill('a') })),
    ).toThrowError(/invalid_params/);
  });

  it('reads own properties only', () => {
    const value = { offers: { price: '19.99' } };
    expect(readOwnJsonPointer(value, ['offers', 'price'])).toMatchObject({ value: '19.99' });
    expect(() => readOwnJsonPointer(value, ['offers', 'missing'])).toThrowError(/invalid_params/);
    expect(() => readOwnJsonPointer(value, ['constructor'])).toThrowError(/invalid_params/);
    expect(() => readOwnJsonPointer('scalar', ['a'])).toThrowError(/invalid_params/);
  });
});

describe('strict script-JSON parsing', () => {
  const limits = { maxBytes: 64 * 1024, maxDepth: 32, maxNodes: 10_000 };

  it('accepts strict objects and arrays', () => {
    const parsed: ParsedScriptJson = parseStrictScriptJson('{"a":1}', limits);
    expect(parsed.nodeCount).toBe(2);
    expect(parseStrictScriptJson('[1,2]', limits).nodeCount).toBe(3);
  });

  it('never evaluates assignments, calls, or bare identifiers', () => {
    for (const text of [
      'window.__STATE__ = {"a":1}',
      '({"a":1})',
      'init({"a":1})',
      'undefined',
      '<script>{"a":1}</script>',
    ]) {
      expect(() => parseStrictScriptJson(text, limits), text.slice(0, 24)).toThrowError(/invalid_params/);
    }
  });

  it('enforces size, depth, and node caps', () => {
    expect(() => parseStrictScriptJson('{"a":1}', { ...limits, maxBytes: 4 })).toThrowError(/invalid_params/);
    let deep = '0';
    for (let i = 0; i < 40; i += 1) deep = `{"a":${deep}}`;
    expect(() => parseStrictScriptJson(deep, limits)).toThrowError(/depth/);
    expect(() => parseStrictScriptJson('[1,2,3]', { ...limits, maxNodes: 2 })).toThrowError(/node/);
  });
});

describe('scoped references', () => {
  it('mints and parses workspace-bound opaque refs', () => {
    const ref: ScopedRef = parseScopedRef(mintArtifactRef('binv_1', 'p0'));
    expect(ref).toMatchObject({ kind: 'artifact', investigationId: 'binv_1' });
    expect(parseScopedRef(mintResponseRef('binv_1', 'p0')).kind).toBe('response');
    expect(parseScopedRef(mintElementRef('binv_1', 0, 3)).kind).toBe('element');
  });

  it('rejects malformed and foreign/stale references', () => {
    expect(() => parseScopedRef('https://example.com/x')).toThrowError(/invalid_params/);
    expect(() => parseScopedRef('artifact:binv_1')).toThrowError(/invalid_params/);
    expect(() => parseScopedRef(42)).toThrowError(/invalid_params/);
    expect(() => assertRefScope(parseScopedRef('artifact:binv_foreign:p0'), 'binv_1')).toThrowError(
      /scope_violation/,
    );
    expect(() =>
      assertRefScope(parseScopedRef(mintArtifactRef('binv_1', 'p0')), 'binv_1'),
    ).not.toThrow();
  });
});

describe('clipped observations cannot certify', () => {
  it('caps text on UTF-8 boundaries and marks clipping', () => {
    const whole: CappedText = capObservationText('hello', 32);
    expect(whole).toEqual({ text: 'hello', clipped: false });
    const capped = capObservationText('x'.repeat(100), 32);
    expect(capped.clipped).toBe(true);
    expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(32);
  });

  it('marks clipped observations incomplete with their artifact reference', () => {
    const clipped: ClippedObservation = markClipped(PAGE, 68);
    expect(clipped).toEqual({ incomplete: true, artifactRef: PAGE, clippedBytes: 68 });
    expect(() => markClipped('not-a-ref', 1)).toThrowError(/invalid_params/);
  });

  it('fails closed on absence, image membership, variant identity, and coverage', () => {
    const complete = [{ incomplete: false }, {}];
    const clipped = [{ incomplete: false }, { incomplete: true }];
    expect(() => certifyFieldAbsence(complete)).not.toThrow();
    expect(() => certifyImageMembership(complete)).not.toThrow();
    expect(() => certifyVariantIdentity(complete)).not.toThrow();
    expect(() => certifyCoverage(complete)).not.toThrow();
    expect(() => certifyFieldAbsence(clipped)).toThrowError(CertificationError);
    expect(() => certifyImageMembership(clipped)).toThrowError(CertificationError);
    expect(() => certifyVariantIdentity(clipped)).toThrowError(CertificationError);
    expect(() => certifyCoverage(clipped)).toThrowError(CertificationError);
  });
});
