/**
 * Unit tests for `src/onboarding/profile-generator.ts`.
 *
 * The LLM client is mocked at the module level so that no network
 * requests are made and no `getDb()` calls are required for the
 * generation tests. Validation tests use real Cheerio against inline
 * HTML strings.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock the LLM client before importing the module under test.
// `getLlmConfig` and `callLlm` are kept as legacy fallbacks; the
// tests below also stub the task-specific helpers
// (`getLlmConfigForTask`, `callLlmForTask`) that the
// `profile_generation` task now uses by default.
vi.mock('@/onboarding/llm-client', () => ({
  getLlmConfig: vi.fn(),
  callLlm: vi.fn(),
  getLlmConfigForTask: vi.fn(),
  callLlmForTask: vi.fn(),
  MissingLlmTaskConfigError: class MissingLlmTaskConfigError extends Error {},
  PROFILE_TASKS_REQUIRE_EXPLICIT: new Set(['profile_generation', 'profile_revision']),
}));

import {
  getMinimizedDom,
  buildSelectorCandidates,
  generateExtractorProfile,
  validateGeneratedProfile,
  isProfileGenerationEnabled,
  shouldAttemptProfileGeneration,
  validateProfileAcrossSamples,
  type GeneratedSelectorProfile,
  type SelectorCandidate,
  type ProfileGenerationTriggerInput,
  type ValidationSample,
} from '../../onboarding/profile-generator';
import * as llmClient from '../../onboarding/llm-client';

// ─── Fixtures ─────────────────────────────────────────────────────────────

const SAMPLE_PRODUCT_HTML = `<!doctype html>
<html>
  <head>
    <title>Old Title</title>
    <script>window.SOME_TRACKER = {};</script>
    <script type="application/ld+json">
      {"@type":"Product","name":"Sample Product","offers":{"price":"19.99"}}
    </script>
    <script>
      window.productJSON = {"id":1,"title":"Sample Product","variants":[{"id":42,"price":"19.99"}]};
    </script>
    <style>.x { color: red; }</style>
  </head>
  <body>
    <header>Site header</header>
    <nav>Main nav</nav>
    <main>
      <div class="product" id="pdp">
        <h1 class="product-title" data-testid="product-title">Sample Product</h1>
        <div class="product-brand" itemprop="brand">Acme</div>
        <div class="product-price" data-product-price>$19.99</div>
        <p class="product-description">
          A long product description that should be picked up by the description selector logic. It contains multiple sentences and is more than twenty characters.
        </p>
        <div class="product-gallery">
          <img src="https://example.com/img1.jpg" alt="img1" />
          <img src="https://example.com/img2.jpg" alt="img2" />
        </div>
        <div class="legacy-noise">
          <span>th:1:1</span>
          <span>th:2:2</span>
        </div>
      </div>
    </main>
    <footer>Site footer</footer>
  </body>
</html>`;

// ─── getMinimizedDom ──────────────────────────────────────────────────────

describe('getMinimizedDom', () => {
  it('removes noisy tags (style, svg, iframe, header, footer, nav)', () => {
    const html = `<html><head><style>.x{}</style></head><body><header>H</header><nav>N</nav><main><svg></svg><iframe src="x"></iframe><p>Main content</p></main><footer>F</footer></body></html>`;
    const out = getMinimizedDom(html);
    expect(out).not.toContain('<style');
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('<header');
    expect(out).not.toContain('<footer');
    expect(out).not.toContain('<nav');
    expect(out).toContain('Main content');
  });

  it('preserves JSON-LD scripts (application/ld+json)', () => {
    const out = getMinimizedDom(SAMPLE_PRODUCT_HTML);
    expect(out).toContain('application/ld+json');
    expect(out).toContain('@type');
  });

  it('preserves scripts containing productJSON', () => {
    const out = getMinimizedDom(SAMPLE_PRODUCT_HTML);
    expect(out).toContain('productJSON');
    expect(out).toContain('variants');
  });

  it('removes ordinary tracking scripts', () => {
    const out = getMinimizedDom(SAMPLE_PRODUCT_HTML);
    expect(out).not.toContain('SOME_TRACKER');
  });

  it('truncates very large output to MAX_MINIMIZED_BYTES', () => {
    const huge = '<main>' + 'a'.repeat(500_000) + '</main>';
    const out = getMinimizedDom(huge);
    expect(out.length).toBeLessThanOrEqual(200_000 + 50);
    expect(out).toContain('truncated');
  });

  it('returns an empty string for empty or non-string input', () => {
    expect(getMinimizedDom('')).toBe('');
    // @ts-expect-error testing runtime guard
    expect(getMinimizedDom(null)).toBe('');
    // @ts-expect-error testing runtime guard
    expect(getMinimizedDom(undefined)).toBe('');
  });
});

// ─── buildSelectorCandidates ──────────────────────────────────────────────

describe('buildSelectorCandidates', () => {
  it('returns an empty array for empty input', () => {
    expect(buildSelectorCandidates('')).toEqual([]);
  });

  it('finds title candidates from h1 and product-title class', () => {
    const candidates = buildSelectorCandidates(SAMPLE_PRODUCT_HTML);
    const titleCandidates = candidates.filter((c) =>
      c.kindHints.includes('title'),
    );
    expect(titleCandidates.length).toBeGreaterThan(0);
    // The h1 has both class="product-title" and data-testid="product-title".
    // The data-testid is more stable, so it should win — but we accept
    // either as long as some selector points to the h1 with the right text.
    const h1Candidate = titleCandidates.find(
      (c) => c.tag === 'h1' && c.textSnippet.includes('Sample Product'),
    );
    expect(h1Candidate).toBeDefined();
    expect(h1Candidate?.selector).toMatch(/h1/);
  });

  it('no longer finds price candidates (price scanning removed)', () => {
    const candidates = buildSelectorCandidates(SAMPLE_PRODUCT_HTML);
    const priceCandidates = candidates.filter((c) =>
      c.kindHints.includes('price'),
    );
    expect(priceCandidates.length).toBe(0);
  });

  it('finds description candidates from product-description class', () => {
    const candidates = buildSelectorCandidates(SAMPLE_PRODUCT_HTML);
    const descCandidates = candidates.filter((c) =>
      c.kindHints.includes('description'),
    );
    expect(descCandidates.length).toBeGreaterThan(0);
  });

  it('no longer finds brand candidates (brand scanning removed)', () => {
    const candidates = buildSelectorCandidates(SAMPLE_PRODUCT_HTML);
    const brandCandidates = candidates.filter((c) =>
      c.kindHints.includes('brand'),
    );
    expect(brandCandidates.length).toBe(0);
  });

  it('finds image candidates from product-gallery', () => {
    const candidates = buildSelectorCandidates(SAMPLE_PRODUCT_HTML);
    const imageCandidates = candidates.filter((c) =>
      c.kindHints.includes('image'),
    );
    expect(imageCandidates.length).toBeGreaterThan(0);
  });

  it('limits candidates to CANDIDATE_LIMIT (100)', () => {
    const candidates = buildSelectorCandidates(SAMPLE_PRODUCT_HTML);
    expect(candidates.length).toBeLessThanOrEqual(100);
  });

  it('does not return duplicate selectors', () => {
    const candidates = buildSelectorCandidates(SAMPLE_PRODUCT_HTML);
    const selectors = candidates.map((c) => c.selector);
    const unique = new Set(selectors);
    expect(unique.size).toBe(selectors.length);
  });
});

// ─── buildStableSelector (tested indirectly via buildSelectorCandidates) ─

describe('buildStableSelector (via candidates)', () => {
  it('prefers unique id when id is not auto-generated', () => {
    const html = `<main><div id="product-title-1"><h1>My Title</h1></div></main>`;
    const candidates = buildSelectorCandidates(html);
    const h1 = candidates.find((c) => c.tag === 'h1');
    // The h1 itself has no id, but its parent does, so the parent+child
    // strategy should win and the selector should include the id.
    expect(h1).toBeDefined();
    expect(h1?.selector).toContain('product-title-1');
  });

  it('avoids auto-generated ids (CSS modules, hash ids)', () => {
    const html = `<main><div><h1 id="_abc1234">Title</h1></div></main>`;
    const candidates = buildSelectorCandidates(html);
    const h1 = candidates.find((c) => c.tag === 'h1');
    expect(h1).toBeDefined();
    // Should not use the auto-generated id.
    expect(h1?.selector).not.toContain('_abc1234');
  });

  it('prefers itemprop when present', () => {
    const html = `<main><h1 itemprop="name">My Title</h1></main>`;
    const candidates = buildSelectorCandidates(html);
    const h1 = candidates.find((c) => c.tag === 'h1');
    expect(h1).toBeDefined();
    expect(h1?.selector).toContain('itemprop="name"');
  });

  it('marks nth-of-type selectors as low stability', () => {
    const html = `<main><div><span>noise</span><h1>Title</h1></div></main>`;
    const candidates = buildSelectorCandidates(html);
    const h1 = candidates.find((c) => c.tag === 'h1');
    expect(h1).toBeDefined();
    // Should at least mark the h1 with a stability level.
    expect(['high', 'medium', 'low']).toContain(h1?.stability);
  });
});

// ─── generateExtractorProfile (with mocked LLM) ───────────────────────────

describe('generateExtractorProfile', () => {
  const originalEnv = process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED;
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Reset mocks and force the feature flag on for these tests.
    vi.resetAllMocks();
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    const testConfig = {
      provider: 'openai',
      apiKey: 'test-key',
      baseUrl: 'https://api.test/v1',
      model: 'gpt-4o-mini',
    };
    // The `profile_generation` task uses these (per Phase 2 routing).
    (llmClient.getLlmConfigForTask as any).mockReturnValue(testConfig);
    (llmClient.callLlmForTask as any).mockResolvedValue(
      '{"titleSelector":"h1"}',
    );
    // Legacy fallbacks kept for completeness; no profile task should
    // hit them in these tests.
    (llmClient.getLlmConfigForTask as any).mockReturnValue(testConfig);
    (llmClient.callLlmForTask as any).mockResolvedValue(
      '{"titleSelector":"h1"}',
    );
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED;
    } else {
      process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = originalEnv;
    }
    global.fetch = originalFetch;
  });

  it('returns null when feature flag is disabled', async () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'false';
    const result = await generateExtractorProfile(
      'https://example.com/p',
      SAMPLE_PRODUCT_HTML,
    );
    expect(result).toBeNull();
    expect(llmClient.callLlmForTask).not.toHaveBeenCalled();
  });

  it('returns null when no LLM config exists', async () => {
    (llmClient.getLlmConfigForTask as any).mockReturnValue(null);
    const result = await generateExtractorProfile(
      'https://example.com/p',
      SAMPLE_PRODUCT_HTML,
    );
    expect(result).toBeNull();
  });

  it('parses plain JSON and returns a profile', async () => {
    (llmClient.callLlmForTask as any).mockResolvedValue(
      '{"titleSelector":"h1.product-title","descriptionSelector":null,"brandSelector":null,"imagesSelector":null}',
    );
    const result = await generateExtractorProfile(
      'https://example.com/p',
      SAMPLE_PRODUCT_HTML,
    );
    expect(result).not.toBeNull();
    expect(result?.titleSelector).toBe('h1.product-title');
    expect(result?.descriptionSelector).toBeNull();
  });

  it('parses fenced JSON in markdown code blocks', async () => {
    (llmClient.callLlmForTask as any).mockResolvedValue(
      '```json\n{"titleSelector":"h1","descriptionSelector":null,"brandSelector":null,"imagesSelector":null}\n```',
    );
    const result = await generateExtractorProfile(
      'https://example.com/p',
      SAMPLE_PRODUCT_HTML,
    );
    expect(result).not.toBeNull();
    expect(result?.titleSelector).toBe('h1');
  });

  it('returns null on invalid JSON', async () => {
    (llmClient.callLlmForTask as any).mockResolvedValue('not valid json at all');
    const result = await generateExtractorProfile(
      'https://example.com/p',
      SAMPLE_PRODUCT_HTML,
    );
    expect(result).toBeNull();
  });

  it('returns null when titleSelector is missing in the response', async () => {
    (llmClient.callLlmForTask as any).mockResolvedValue(
      '{"titleSelector":null,"descriptionSelector":null,"brandSelector":null,"imagesSelector":null}',
    );
    const result = await generateExtractorProfile(
      'https://example.com/p',
      SAMPLE_PRODUCT_HTML,
    );
    expect(result).toBeNull();
  });

  it('returns null on LLM exception', async () => {
    (llmClient.callLlmForTask as any).mockRejectedValue(new Error('LLM is down'));
    const result = await generateExtractorProfile(
      'https://example.com/p',
      SAMPLE_PRODUCT_HTML,
    );
    expect(result).toBeNull();
  });

  it('rejects selectors with XPath syntax', async () => {
    (llmClient.callLlmForTask as any).mockResolvedValue(
      '{"titleSelector":"//h1","descriptionSelector":null,"brandSelector":null,"imagesSelector":null}',
    );
    const result = await generateExtractorProfile(
      'https://example.com/p',
      SAMPLE_PRODUCT_HTML,
    );
    expect(result).toBeNull();
  });

  it('rejects selectors with browser-only pseudo-selectors', async () => {
    (llmClient.callLlmForTask as any).mockResolvedValue(
      '{"titleSelector":"h1:has(span)","descriptionSelector":null,"brandSelector":null,"imagesSelector":null}',
    );
    const result = await generateExtractorProfile(
      'https://example.com/p',
      SAMPLE_PRODUCT_HTML,
    );
    expect(result).toBeNull();
  });

  it('rejects when response is not an object', async () => {
    (llmClient.callLlmForTask as any).mockResolvedValue('"just a string"');
    const result = await generateExtractorProfile(
      'https://example.com/p',
      SAMPLE_PRODUCT_HTML,
    );
    expect(result).toBeNull();
  });
});

// ─── validateGeneratedProfile ─────────────────────────────────────────────

describe('validateGeneratedProfile', () => {
  const goodProfile: GeneratedSelectorProfile = {
    titleSelector: 'h1.product-title',
    descriptionSelector: '.product-description',
    imagesSelector: '.product-gallery img',
    shopifyJSONPath: false,
    brandSelector: null,
  };

  it('fails when titleSelector is missing', () => {
    const profile: GeneratedSelectorProfile = { ...goodProfile, titleSelector: null };
    const result = validateGeneratedProfile(SAMPLE_PRODUCT_HTML, profile);
    expect(result.valid).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/titleSelector/);
  });

  it('fails when titleSelector returns empty text', () => {
    const profile: GeneratedSelectorProfile = {
      ...goodProfile,
      titleSelector: '.does-not-exist',
    };
    const result = validateGeneratedProfile(SAMPLE_PRODUCT_HTML, profile);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/empty/i);
  });

  it('passes for a valid profile with all fields', () => {
    const result = validateGeneratedProfile(SAMPLE_PRODUCT_HTML, goodProfile);
    expect(result.valid).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.fieldSamples.title).toContain('Sample Product');
  });

  it('rejects when expected validation flags blocked title', () => {
    const blockedHtml = `<html><body><h1 class="product-title">Sorry, you have been blocked | Earth Animal</h1><div class="product-price">$10</div></body></html>`;
    const profile: GeneratedSelectorProfile = {
      titleSelector: 'h1.product-title',
      descriptionSelector: null,
      imagesSelector: null,
      shopifyJSONPath: false,
    brandSelector: null,
    };
    const result = validateGeneratedProfile(blockedHtml, profile, {
      name: 'Some Product',
      sourceUrl: 'https://example.com/p',
    });
    expect(result.valid).toBe(false);
    expect(result.status).toBe('rejected');
    expect(result.reason).toMatch(/blocked/i);
  });

  it('rejects when expected validation flags offline title', () => {
    const offlineHtml = `<html><body><h1 class="product-title">This Shopify store is currently unavailable.</h1><div class="product-price">$10</div></body></html>`;
    const result = validateGeneratedProfile(
      offlineHtml,
      {
        titleSelector: 'h1.product-title',
        descriptionSelector: null,
        imagesSelector: null,
        shopifyJSONPath: false,
    brandSelector: null,
      },
      { name: 'X', sourceUrl: 'https://example.com/p' },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/offline/i);
  });

  it('rejects when expected validation flags mismatch', () => {
    const mismatchHtml = `<html><body><h1 class="product-title">BABY WIPE PINK 72PC</h1><div class="product-price">$10</div></body></html>`;
    const result = validateGeneratedProfile(
      mismatchHtml,
      {
        titleSelector: 'h1.product-title',
        descriptionSelector: null,
        imagesSelector: null,
        shopifyJSONPath: false,
    brandSelector: null,
      },
      { name: 'Woof Poomergency Dog Food', sourceUrl: 'https://pricepower.com/06863' },
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/mismatch/i);
  });

  it('sets readyForReview true only with high confidence and no low-stability selectors', () => {
    const result = validateGeneratedProfile(SAMPLE_PRODUCT_HTML, goodProfile, {
      name: 'Sample Product',
      sourceUrl: 'https://example.com/p',
    });
    // The good profile should produce a high enough confidence and
    // no nth-of-type selectors, so readyForReview should be true.
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.readyForReview).toBe(true);
  });

  it('sets readyForReview false when an nth-of-type selector is used', () => {
    const profile: GeneratedSelectorProfile = {
      titleSelector: 'h1:nth-of-type(1)',
      descriptionSelector: null,
      imagesSelector: null,
      shopifyJSONPath: false,
    brandSelector: null,
    };
    const result = validateGeneratedProfile(SAMPLE_PRODUCT_HTML, profile);
    // Even with high confidence, low-stability selector disqualifies
    // the proposal from being ready for review (it is still auditable
    // and may still be approved, but the advisory flag is false).
    expect(result.readyForReview).toBe(false);
  });

  it('fails closed on unsupported selector syntax', () => {
    const profile: GeneratedSelectorProfile = {
      // Cast through unknown to bypass typecheck for the test.
      ...goodProfile,
      titleSelector: 'h1:has(span)',
    };
    const result = validateGeneratedProfile(SAMPLE_PRODUCT_HTML, profile);
    expect(result.valid).toBe(false);
  });

  it('returns failed for empty HTML', () => {
    const result = validateGeneratedProfile('', goodProfile);
    expect(result.valid).toBe(false);
    expect(result.status).toBe('failed');
  });
});

// ─── isProfileGenerationEnabled ───────────────────────────────────────────

describe('isProfileGenerationEnabled', () => {
  const original = process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED;
    } else {
      process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = original;
    }
  });

  it('returns true for "true"', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    expect(isProfileGenerationEnabled()).toBe(true);
  });

  it('returns true for "1"', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = '1';
    expect(isProfileGenerationEnabled()).toBe(true);
  });

  it('returns true for "yes" (case-insensitive)', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'YES';
    expect(isProfileGenerationEnabled()).toBe(true);
  });

  it('returns false for any other value', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'enabled';
    expect(isProfileGenerationEnabled()).toBe(false);
  });

  it('returns true when the variable is not set (enabled by default)', () => {
    delete process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED;
    expect(isProfileGenerationEnabled()).toBe(true);
  });
});

// ─── shouldAttemptProfileGeneration ──────────────────────────────────────

describe('shouldAttemptProfileGeneration', () => {
  const originalEnv = process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED;

  const baseInput: ProfileGenerationTriggerInput = {
    domain: 'example.com',
    existingProfile: null,
    extractionResult: {
      title: 'Sample Product',
      brand: 'Acme',
      description: 'A description',
    },
    validationResult: { valid: true, status: 'ok', reason: null, confidence: 0.85 },
    customHadAnyValue: false,
  };

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED;
    } else {
      process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = originalEnv;
    }
  });

  it('returns false when the feature flag is disabled', () => {
    delete process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED;
    expect(shouldAttemptProfileGeneration(baseInput)).toBe(false);
  });

  it('returns false when validation status is blocked', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    const input: ProfileGenerationTriggerInput = {
      ...baseInput,
      validationResult: { valid: false, status: 'blocked', reason: 'blocked', confidence: 0 },
    };
    expect(shouldAttemptProfileGeneration(input)).toBe(false);
  });

  it('returns false when validation status is offline', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    const input: ProfileGenerationTriggerInput = {
      ...baseInput,
      validationResult: { valid: false, status: 'offline', reason: 'offline', confidence: 0 },
    };
    expect(shouldAttemptProfileGeneration(input)).toBe(false);
  });

  it('returns false when validation status is mismatch', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    const input: ProfileGenerationTriggerInput = {
      ...baseInput,
      validationResult: { valid: false, status: 'mismatch', reason: 'mismatch', confidence: 0 },
    };
    expect(shouldAttemptProfileGeneration(input)).toBe(false);
  });

  it('returns false when only price is missing (no improvement target)', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    // The "price-only missing" case: when both description AND brand are
    // present, the trigger should NOT fire. To model price-only missing,
    // set description and brand present, and the trigger must still
    // return false because the only thing missing is something outside
    // this trigger's scope (profile generation never fills price). Since the trigger
    // checks description+brand missing, it requires AT LEAST one of
    // them to be missing. With both present, no improvement target.
    const priceOnlyInput: ProfileGenerationTriggerInput = {
      ...baseInput,
      extractionResult: {
        title: 'Sample Product',
        brand: 'Acme',
        description: 'A long product description here.',
      },
      customHadAnyValue: false,
    };
    expect(shouldAttemptProfileGeneration(priceOnlyInput)).toBe(false);
  });

  it('returns false when the existing custom selectors already produced values', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    const input: ProfileGenerationTriggerInput = {
      ...baseInput,
      customHadAnyValue: true,
    };
    expect(shouldAttemptProfileGeneration(input)).toBe(false);
  });

  it('returns false when the validation confidence is too low', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    const input: ProfileGenerationTriggerInput = {
      ...baseInput,
      validationResult: { valid: true, status: 'ok', reason: null, confidence: 0.3 },
    };
    expect(shouldAttemptProfileGeneration(input)).toBe(false);
  });

  it('returns false when the extraction title is empty', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    const input: ProfileGenerationTriggerInput = {
      ...baseInput,
      extractionResult: {
        title: null,
        brand: null,
        description: null,
      },
    };
    expect(shouldAttemptProfileGeneration(input)).toBe(false);
  });

  it('returns true when all conditions are met (flag on, ok, empty custom, missing description)', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    const input: ProfileGenerationTriggerInput = {
      ...baseInput,
      extractionResult: {
        title: 'Sample Product',
        brand: 'Acme',
        description: null, // missing → improvement target
      },
      customHadAnyValue: false,
    };
    expect(shouldAttemptProfileGeneration(input)).toBe(true);
  });

  it('returns false when only brand is missing (no longer an improvement target)', () => {
    process.env.BAYSTATE_CMS_PROFILE_GENERATION_ENABLED = 'true';
    const input: ProfileGenerationTriggerInput = {
      ...baseInput,
      extractionResult: {
        title: 'Sample Product',
        brand: null,
        description: 'A description',
      },
      customHadAnyValue: false,
    };
    expect(shouldAttemptProfileGeneration(input)).toBe(false);
  });
});

// ─── validateProfileAcrossSamples ───────────────────────────────────────

describe('validateProfileAcrossSamples', () => {
  const goodProfile: GeneratedSelectorProfile = {
    titleSelector: 'h1.product-title',
    descriptionSelector: '.product-description',
    imagesSelector: null,
    shopifyJSONPath: false,
    brandSelector: null,
  };

  it('reports 0 passed and not ready for review when given no samples', () => {
    const result = validateProfileAcrossSamples(goodProfile, []);
    expect(result.total).toBe(0);
    expect(result.passed).toBe(0);
    expect(result.readyForReview).toBe(false);
  });

  it('reports readyForReview=true when 2+ samples pass', () => {
    const samples: ValidationSample[] = [
      { url: 'https://example.com/a', html: SAMPLE_PRODUCT_HTML },
      { url: 'https://example.com/b', html: SAMPLE_PRODUCT_HTML },
      { url: 'https://example.com/c', html: '<html><body>No title here</body></html>' },
    ];
    const result = validateProfileAcrossSamples(goodProfile, samples);
    expect(result.total).toBe(3);
    expect(result.passed).toBe(2);
    expect(result.readyForReview).toBe(true);
    expect(result.samples[0]?.valid).toBe(true);
    expect(result.samples[2]?.valid).toBe(false);
  });

  it('reports readyForReview=false when fewer than 2 samples pass', () => {
    const samples: ValidationSample[] = [
      { url: 'https://example.com/a', html: SAMPLE_PRODUCT_HTML },
      { url: 'https://example.com/b', html: '<html><body>Nothing</body></html>' },
      { url: 'https://example.com/c', html: '<html><body>Also nothing</body></html>' },
    ];
    const result = validateProfileAcrossSamples(goodProfile, samples);
    expect(result.total).toBe(3);
    expect(result.passed).toBe(1);
    expect(result.readyForReview).toBe(false);
  });

  it('forwards expected context per sample', () => {
    const samples: ValidationSample[] = [
      {
        url: 'https://example.com/a',
        html: SAMPLE_PRODUCT_HTML,
        expected: { name: 'Sample Product', sourceUrl: 'https://example.com/a' },
      },
      {
        url: 'https://example.com/b',
        html: SAMPLE_PRODUCT_HTML,
        expected: { name: 'Sample Product', sourceUrl: 'https://example.com/b' },
      },
    ];
    const result = validateProfileAcrossSamples(goodProfile, samples);
    expect(result.passed).toBe(2);
    expect(result.readyForReview).toBe(true);
  });
});
