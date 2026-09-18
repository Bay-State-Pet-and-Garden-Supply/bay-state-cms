// T2 (#226) — deterministic policy compiler (Vitest, pure).
//
// Pins the compiler contract over the versioned typed investigation result:
// only supported versioned primitives compile; arbitrary generated programs
// are never persisted for later execution. Covers adapter-first, adapter
// with selector exception, supported selector-only, unsupported primitives,
// requires_code_adapter, and multiple incompatible structures (detected and
// blocked, never squeezed into one domain-wide policy).
//
// No DB, no network, no provider imports.

import { describe, it, expect } from 'vitest';
import {
  INVESTIGATION_RESULT_VERSION,
  type InvestigationResult,
} from '../../shared/schemas/browser-investigation';
import {
  EXTRACTION_POLICY_VERSION,
  POLICY_FIELDS,
} from '../../shared/schemas/browser-investigation-policy';
import { compileInvestigationResult, isAppliableOutcome } from '../../onboarding/browser-investigation/compiler';

const CTX = {
  domain: 'shop.example.com',
  investigationId: 'binv_test_1',
  runId: 'binvrun_test_1',
  inputHash: 'input-hash-test-1',
  resultHash: 'result-hash-test-1',
};

function baseResult(overrides: Partial<InvestigationResult> = {}): InvestigationResult {
  return {
    version: INVESTIGATION_RESULT_VERSION,
    summary: 'Deterministic compiler fixture. Untrusted proposal evidence only.',
    observations: [
      {
        kind: 'fake_dom_observation',
        sourceUrl: 'https://shop.example.com/products/alpha',
        artifactHash: 'abcdef1234567890abcdef1234567890',
        incomplete: false,
      },
    ],
    evidenceRefs: [],
    gaps: [],
    renderedBrowserRequired: false,
    ...overrides,
  } as InvestigationResult;
}

const SHOPIFY_IDENTITY = {
  productIdentity: ['gtin_exact', 'sku_exact', 'platform_product_id'],
  variantIdentity: ['gtin_exact', 'sku_exact', 'platform_variant_id_exact', 'options_exact_tuple', 'operator_selection'],
  optionAxes: [],
};

function shopifyField(field: (typeof POLICY_FIELDS)[number], extra: Record<string, unknown> = {}) {
  return {
    field,
    sources: ['shopify_product_json', 'json_ld', 'meta'],
    structureId: 'shopify-default',
    ...extra,
  };
}

/** Full recommendation set with one field's entry replaced (shared by the exception/gap tests). */
function withFieldOverride(
  field: (typeof POLICY_FIELDS)[number],
  rec: { sources: string[]; selector?: string; structureId?: string; evidenceRef?: string },
) {
  return POLICY_FIELDS.map((f) => (f === field ? { field: f, ...rec } : shopifyField(f)));
}

/** Two-structure fixture; the template-b side uses divergent selector sources. */
function divergentStructuresResult(selectorPrefix: string, extra: Record<string, unknown> = {}) {
  return baseResult({
    structures: [
      { id: 'template-a', sampleUrls: ['https://shop.example.com/products/alpha'] },
      { id: 'template-b', sampleUrls: ['https://shop.example.com/products/beta'] },
    ],
    fieldRecommendations: [
      ...POLICY_FIELDS.map((field) => shopifyField(field, { structureId: 'template-a' })),
      ...POLICY_FIELDS.map((field) => ({
        field,
        sources: ['selector'],
        selector: `${selectorPrefix}${field}`,
        structureId: 'template-b',
      })),
    ],
    identityRequirements: { ...SHOPIFY_IDENTITY },
    ...extra,
  });
}

/** Assert a compilable outcome and narrow to its proposal (shared guard). */
function expectProposal(outcome: ReturnType<typeof compileInvestigationResult>) {
  expect(outcome.status).toBe('proposal');
  expect(isAppliableOutcome(outcome)).toBe(true);
  if (outcome.status !== 'proposal') throw new Error('expected a compilable proposal outcome');
  return outcome.proposal;
}

/** Assert a blocked outcome carrying the expected gap kind (shared guard). */
function expectUnresolved(outcome: ReturnType<typeof compileInvestigationResult>, kind: string) {
  expect(outcome.status).toBe('unresolved');
  expect(isAppliableOutcome(outcome)).toBe(false);
  if (outcome.status !== 'unresolved') throw new Error('expected an unresolved outcome');
  expect(outcome.gaps.some((g) => g.kind === kind)).toBe(true);
  return outcome.gaps;
}

function shopifyResult(overrides: Partial<InvestigationResult> = {}): InvestigationResult {
  return baseResult({
    platform: 'shopify',
    structures: [
      {
        id: 'shopify-default',
        sampleUrls: ['https://shop.example.com/products/alpha'],
        description: 'Single Shopify product template.',
        platformSource: 'shopify_product_json',
      },
    ],
    fieldRecommendations: POLICY_FIELDS.map((field) => shopifyField(field)),
    identityRequirements: { ...SHOPIFY_IDENTITY },
    ...overrides,
  });
}

describe('browser investigation policy compiler (T2)', () => {
  it('compiles an adapter-first result with zero selector exceptions', () => {
    const proposal = expectProposal(compileInvestigationResult(shopifyResult(), CTX));
    expect(proposal.version).toBe(EXTRACTION_POLICY_VERSION);
    expect(proposal.domain).toBe(CTX.domain);
    expect(proposal.investigationId).toBe(CTX.investigationId);
    expect(proposal.resultHash).toBe(CTX.resultHash);
    expect(proposal.fields).toHaveLength(POLICY_FIELDS.length);
    for (const field of proposal.fields) {
      expect(field.sources[0]).toBe('shopify_product_json');
      expect(field.selector).toBeUndefined();
    }
    expect(proposal.identity.productIdentity[0]).toBe('gtin_exact');
  });

  it('compiles adapter-first with one validated selector exception', () => {
    const result = shopifyResult({
      fieldRecommendations: withFieldOverride('price', {
        sources: ['shopify_product_json', 'selector'],
        selector: '.price__regular',
        structureId: 'shopify-default',
      }),
    });
    const proposal = expectProposal(compileInvestigationResult(result, CTX));
    const price = proposal.fields.find((f) => f.field === 'price');
    expect(price?.sources).toContain('selector');
    expect(price?.selector).toBe('.price__regular');
    // Untouched fields carry no selector data.
    const title = proposal.fields.find((f) => f.field === 'title');
    expect(title?.selector).toBeUndefined();
  });

  it('compiles a supported selector-only result', () => {
    const result = shopifyResult({
      platform: 'generic',
      structures: [
        {
          id: 'generic-default',
          sampleUrls: ['https://shop.example.com/products/alpha'],
          platformSource: 'selector',
        },
      ],
      fieldRecommendations: POLICY_FIELDS.map((field) => ({
        field,
        sources: ['selector'],
        selector: `.product-${field}`,
        structureId: 'generic-default',
      })),
    });
    const outcome = compileInvestigationResult(result, CTX);
    expect(outcome.status).toBe('proposal');
    expect(isAppliableOutcome(outcome)).toBe(true);
    if (outcome.status !== 'proposal') return;
    expect(outcome.proposal.fields.every((f) => f.sources[0] === 'selector')).toBe(true);
  });

  it('rejects executable-looking selectors instead of persisting them', () => {
    // Attribute selectors such as div[onclick] are read-only element queries
    // and stay allowed: selectors never execute. Rejected here are script,
    // URL, style-directive, and template-expression injections.
    for (const evil of [
      'javascript:alert(1)',
      '<script>alert(1)</script>',
      '${evil}',
      '{{evil}}',
      'a[href^="javascript:"]',
      'div{behavior:url(evil)}',
    ]) {
      const result = shopifyResult({
        fieldRecommendations: withFieldOverride('title', {
          sources: ['selector'],
          selector: evil,
          structureId: 'shopify-default',
        }),
      });
      const outcome = compileInvestigationResult(result, CTX);
      expect(outcome.status).toBe('proposal');
      if (outcome.status !== 'proposal') continue;
      const title = outcome.proposal.fields.find((f) => f.field === 'title');
      // The rejected selector must not survive. These fixtures offer the
      // selector as the only source, so the field drops out entirely and
      // the rejection is preserved as a blocker.
      expect(title?.selector).toBeUndefined();
      expect(title?.sources ?? []).not.toContain('selector');
      expect(outcome.gaps.some((g) => g.kind === 'selector_rejected' && g.field === 'title')).toBe(true);
    }
  });

  it('reports unsupported primitives as typed gaps and never persists them', () => {
    const result = shopifyResult({
      fieldRecommendations: withFieldOverride('variants', {
        sources: ['execute_js_click_flow'],
        structureId: 'shopify-default',
      }),
    });
    const outcome = compileInvestigationResult(result, CTX);
    expect(outcome.status).toBe('proposal');
    if (outcome.status !== 'proposal') return;
    // The unsupported primitive is a preserved blocker, not policy content.
    expect(outcome.gaps.some((g) => g.kind === 'unsupported_primitive' && g.field === 'variants')).toBe(true);
    const variants = outcome.proposal.fields.find((f) => f.field === 'variants');
    expect(variants).toBeUndefined();
    const serialized = JSON.stringify(outcome.proposal);
    expect(serialized).not.toContain('execute_js_click_flow');
  });

  it('returns requires_code_adapter when the typed result declares a missing capability', () => {
    const result = shopifyResult({
      codeAdapterNeeded: {
        capability: 'woo_store_api_adapter',
        reason: 'WooCommerce Store API representation observed; no supported runtime adapter exists.',
      },
    });
    const outcome = compileInvestigationResult(result, CTX);
    expect(outcome.status).toBe('requires_code_adapter');
    expect(isAppliableOutcome(outcome)).toBe(false);
    if (outcome.status !== 'requires_code_adapter') return;
    expect(outcome.codeAdapterRequest.capability).toBe('woo_store_api_adapter');
  });

  it('blocks multiple incompatible structures instead of merging them', () => {
    const result = divergentStructuresResult('.template-b-', {
      platform: 'shopify',
      incompatibleStructureIds: ['template-a', 'template-b'],
    });
    expectUnresolved(compileInvestigationResult(result, CTX), 'incompatible_structures');
  });

  it('detects conflicting first-choice sources across structures even without an explicit flag', () => {
    const result = divergentStructuresResult('.b-', { platform: 'generic' });
    expectUnresolved(compileInvestigationResult(result, CTX), 'incompatible_structures');
  });

  it('compiles distinct visual templates that share one proven platform representation', () => {
    const result = baseResult({
      platform: 'shopify',
      structures: [
        {
          id: 'template-a',
          sampleUrls: ['https://shop.example.com/products/alpha'],
          platformSource: 'shopify_product_json',
        },
        {
          id: 'template-b',
          sampleUrls: ['https://shop.example.com/products/beta'],
          platformSource: 'shopify_product_json',
        },
      ],
      fieldRecommendations: POLICY_FIELDS.map((field) => shopifyField(field)),
      identityRequirements: { ...SHOPIFY_IDENTITY },
    });
    const outcome = compileInvestigationResult(result, CTX);
    expect(outcome.status).toBe('proposal');
    if (outcome.status !== 'proposal') return;
    expect(outcome.proposal.structures).toHaveLength(2);
    expect(outcome.proposal.fields).toHaveLength(POLICY_FIELDS.length);
  });

  it('stays unresolved when product/variant identity requirements are missing', () => {
    const result = shopifyResult({ identityRequirements: undefined });
    expectUnresolved(compileInvestigationResult(result, CTX), 'missing_identity');
  });

  it('records uncovered fields as honest gaps while staying compilable', () => {
    const result = shopifyResult({
      fieldRecommendations: POLICY_FIELDS.filter((f) => f !== 'availability').map((field) =>
        shopifyField(field),
      ),
    });
    const outcome = compileInvestigationResult(result, CTX);
    expect(outcome.status).toBe('proposal');
    if (outcome.status !== 'proposal') return;
    expect(outcome.proposal.fields.find((f) => f.field === 'availability')).toBeUndefined();
    expect(
      outcome.gaps.some((g) => g.kind === 'missing_field_evidence' && g.field === 'availability'),
    ).toBe(true);
  });

  it('never copies raw observation text or free-form strategy strings into the proposal', () => {
    const canary = 'CANARY-PROMPT-ZZ9 model says execute anything';
    const result = shopifyResult({
      summary: canary,
      recommendedStrategy: 'CANARY-STRATEGY run arbitrary python adapter',
      observations: [
        {
          kind: 'suspicious_kind',
          sourceUrl: 'https://shop.example.com/products/alpha',
          artifactHash: 'abcdef1234567890abcdef1234567890',
          detail: canary,
          incomplete: false,
        },
      ],
    });
    const outcome = compileInvestigationResult(result, CTX);
    expect(outcome.status).toBe('proposal');
    if (outcome.status !== 'proposal') return;
    const serialized = JSON.stringify(outcome.proposal);
    expect(serialized).not.toContain('CANARY-PROMPT-ZZ9');
    expect(serialized).not.toContain('CANARY-STRATEGY');
  });

  it('ignores the free-form recommendedStrategy display string when classifying sources', () => {
    const result = shopifyResult({ recommendedStrategy: 'execute_arbitrary_js' });
    const outcome = compileInvestigationResult(result, CTX);
    expect(outcome.status).toBe('proposal');
    if (outcome.status !== 'proposal') return;
    expect(JSON.stringify(outcome.proposal)).not.toContain('execute_arbitrary_js');
  });
});
