// Issue #201 — representative product-page verification tests.
//
// Asserts externally visible behavior at the pre-agreed seams (parent spec
// #197: "platform detection against recorded product-page fixtures"):
// the verdict table covers every gap domain with product-page evidence,
// the Nutrisource canonical-host finding holds at product-page level, and
// the ladder's platform/structured functions behave on marker excerpts
// transcribed from the observed pages (no network — all fixtures inline).
import { describe, it, expect } from 'vitest';
import {
  detectPlatform,
  parseStructuredSignals,
  shopifyProductUrl,
} from '../../onboarding/extraction-ladder/platforms';
import {
  PRODUCT_PAGE_VERDICTS_201,
  VERDICT_201_DOMAINS,
  VERDICT_201_TOTAL_ITEMS,
  verdict201ByDomain,
  type ProductPageVerdictKind,
} from '../../onboarding/brand-hub/product-page-verdicts-201';

const VERDICT_KINDS: readonly ProductPageVerdictKind[] = [
  'platform_evidence',
  'static_profile',
  'ai_draft',
  'distributor_manual',
];

describe('issue #201 verdict-table coverage', () => {
  it('covers exactly the 18 gap domains (5 original + 5 walled + 8 newly mapped)', () => {
    expect(PRODUCT_PAGE_VERDICTS_201).toHaveLength(18);
    expect(new Set(VERDICT_201_DOMAINS).size).toBe(18);
    for (const d of [
      'discovernutrisource.com', 'openfarmpet.com', 'bluebuffalo.com', 'nylabone.com', 'bonide.com',
      'bil-jac.com', 'chickensouppets.com', 'multipet.com', 'northstatesind.com', 'yeowww.com',
      'snifsnax.com', 'jollypets.com', 'hummzinger.com', 'yowup.com',
      'wondercide.com', 'gardentech.com', 'ocraw.com', 'horsemenspride.com',
    ]) {
      expect(verdict201ByDomain(d), `missing verdict for ${d}`).toBeDefined();
    }
  });

  it('reconciles to 81 official-domain items (52 original + 29 newly mapped)', () => {
    expect(VERDICT_201_TOTAL_ITEMS).toBe(81);
  });

  it('every verdict states a taxonomy kind with rationale and a downstream owner', () => {
    for (const v of PRODUCT_PAGE_VERDICTS_201) {
      expect(VERDICT_KINDS).toContain(v.verdict);
      expect(v.rationale.length).toBeGreaterThan(80);
      expect(v.downstream.length).toBeGreaterThan(0);
      expect(v.structuredData.length).toBeGreaterThan(0);
    }
  });

  it('no domain proceeds on homepage evidence alone', () => {
    for (const v of PRODUCT_PAGE_VERDICTS_201) {
      expect(v.probes.length).toBeGreaterThanOrEqual(1);
      // Leaf-level proof: at least one probe below the site root (a bare
      // homepage probe alone never suffices — not even for walled domains).
      const hasLeafProbe = v.probes.some((p) => {
        try {
          return new URL(p.url).pathname !== '/';
        } catch {
          return false;
        }
      });
      expect(hasLeafProbe, `${v.domain}: homepage-only evidence`).toBe(true);
      if (v.verdict === 'distributor_manual') {
        // Still-walled: the blocking status on leaf pages is the evidence.
        expect(v.probes.every((p) => p.status === 403)).toBe(true);
        expect(v.endpoint.kind).toBe('none');
      } else {
        expect(v.probes.some((p) => p.status === 200), `${v.domain}: no fetched product page`).toBe(true);
      }
    }
  });

  it('confirms the Nutrisource canonical-host finding at product-page level', () => {
    const v = verdict201ByDomain('discovernutrisource.com')!;
    const legacy = v.probes[0]!;
    // The legacy mapped host redirects to the canonical host on a real product URL.
    expect(legacy.url).toContain('nutrisourcepetfoods.com');
    expect(legacy.finalHost).toBe('discovernutrisource.com');
    expect(legacy.finalUrl).toContain('discovernutrisource.com/products/');
    expect(v.endpoint.kind).toBe('shopify_js');
    expect(v.endpoint.url).toContain('discovernutrisource.com');
  });

  it('each verdict agrees on one fetch host, and the endpoint names it (the #202 alignment rule)', () => {
    for (const v of PRODUCT_PAGE_VERDICTS_201) {
      const hosts = new Set(v.probes.filter((p) => p.status === 200).map((p) => p.finalHost));
      if (v.verdict !== 'distributor_manual') {
        // No redirect split within a verdict: every fetched probe lands on
        // fetchHost (www-subdomain serving is fine — the split is what
        // breaks profile matching). Endpoint shapes must name that host.
        expect(hosts.size, `${v.domain}: split hosts ${[...hosts]}`).toBe(1);
        expect([...hosts][0], `${v.domain}: fetchHost mismatch`).toBe(v.fetchHost);
        if (v.endpoint.url) expect(v.endpoint.url, `${v.domain}: endpoint off-host`).toContain(v.fetchHost);
      } else {
        // Walled rows still record the attempted host so #203 knows what was probed.
        expect(v.fetchHost.length).toBeGreaterThan(0);
      }
    }
  });
});

// Marker excerpts transcribed from pages observed 2026-09-16 (verbatim
// detector-relevant substrings, trimmed to the seam under test).
const SHOPIFY_EXCERPT =
  '<html><head><link rel="preconnect" href="https://cdn.shopify.com">' +
  '<script src="/cdn/shop/t/42/main.js"></script>' +
  '<script>Shopify.theme = {"name":"Dawn"};</script></head><body></body></html>';

// Jolly Pets: Shopify markers coexist with legacy Yoast/wp-content markup.
const JOLLY_HYBRID_EXCERPT =
  '<html><head><script src="/cdn/shop/t/7/app.js"></script>' +
  '<!-- Yoast SEO --><link rel="stylesheet" href="/wp-content/themes/old/style.css">' +
  '<script src="https://shopify.com/s/files/x.js"></script></head><body></body></html>';

const WOO_EXCERPT =
  '<html><head><link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woo.css">' +
  '<!-- Yoast SEO v28.5 --></head><body class="woocommerce"></body></html>';

const OPTIMIZELY_EXCERPT =
  '<html><head><!--EPiServerMonitoring DxP--><meta charset="utf-8">' +
  '<script src="/static/bundles/app.js"></script></head><body></body></html>';

const SITECORE_EXCERPT =
  '<html><head><link href="/-/media/feature/experience-accelerator/sxa.css">' +
  '<link href="/-/media/themes/oneweb/nylabone/styles.css">' +
  '<div class="sxa-base-theme"></div></head><body></body></html>';

const BIGCOMMERCE_EXCERPT =
  '<html><head><link rel="dns-prefetch preconnect" href="https://cdn11.bigcommerce.com/s-jwr7lmet6p">' +
  '<script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js"></script></head><body></body></html>';

const PLAIN_WP_EXCERPT =
  '<html><head><!-- Yoast SEO --><link rel="stylesheet" href="/wp-content/themes/yowup/style.css">' +
  '<link rel="https://api.w.org/" href="/wp-json/"></head><body></body></html>';

describe('issue #201 platform detection on recorded fixtures', () => {
  it('detects Shopify including the Jolly Pets hybrid markup', () => {
    expect(detectPlatform(SHOPIFY_EXCERPT, 'https://x.com/products/y')).toBe('shopify');
    expect(detectPlatform(JOLLY_HYBRID_EXCERPT, 'https://jollypets.com/products/z')).toBe('shopify');
  });

  it('detects WooCommerce from the plugin marker (Bonide/Hummzinger/OC Raw shape)', () => {
    expect(detectPlatform(WOO_EXCERPT, 'https://bonide.com/product/x/')).toBe('woocommerce');
  });

  it('returns generic for Optimizely, Sitecore SXA, and plain WordPress (AI-draft shapes)', () => {
    expect(detectPlatform(OPTIMIZELY_EXCERPT, 'https://www.bluebuffalo.com/x/')).toBe('generic');
    expect(detectPlatform(SITECORE_EXCERPT, 'https://www.nylabone.com/products/x')).toBe('generic');
    expect(detectPlatform(PLAIN_WP_EXCERPT, 'https://yowup.com/en/productos/x/')).toBe('generic');
  });

  it('returns generic for BigCommerce (no ladder adapter — recorded, not a failure)', () => {
    expect(detectPlatform(BIGCOMMERCE_EXCERPT, 'https://northstatesind.com/x/')).toBe('generic');
    expect(verdict201ByDomain('northstatesind.com')!.endpoint.evidence).toMatch(/no .* adapter/i);
  });

  it('a Cloudflare challenge-platform script alone does not change detection (status is the arbiter)', () => {
    // Bil-Jac leaves carry this inline script and still return real content.
    expect(detectPlatform(BIGCOMMERCE_EXCERPT, 'https://www.bil-jac.com/products/x/')).toBe('generic');
    expect(verdict201ByDomain('bil-jac.com')!.probes.every((p) => p.status === 200)).toBe(true);
  });
});

describe('issue #201 structured signals on recorded fixtures', () => {
  it('parses a North-States-shaped JSON-LD Product with sku, gtin, offer, and image', () => {
    const html =
      '<html><head><script type="application/ld+json">' +
      '{"@context":"https://schema.org","@type":"Product","name":"North States MyPet Petgate Essential",' +
      '"sku":"8739","gtin":"00026107087393","image":["https://img.example.com/gate.jpg"],' +
      '"offers":{"price":"36.99","availability":"https://schema.org/InStock"}}</script>' +
      '</head><body></body></html>';
    const signals = parseStructuredSignals(html);
    expect(signals.jsonLdProducts).toHaveLength(1);
    expect(signals.jsonLdProducts[0]).toMatchObject({ name: 'North States MyPet Petgate Essential', sku: '8739', gtin: '00026107087393' });
    expect(signals.jsonLdProducts[0]!.offers).toHaveLength(1);
    expect(signals.jsonLdProducts[0]!.images).toHaveLength(1);
  });

  it('parses Nylabone-shaped empty Product shells as fieldless products (structured layer carries nothing)', () => {
    const html =
      '<html><head><script type="application/ld+json">' +
      '{"@context":"https://schema.org","@type":"Product","name":"","offers":[]}</script>' +
      '</head><body></body></html>';
    const signals = parseStructuredSignals(html);
    expect(signals.jsonLdProducts).toHaveLength(1);
    expect(signals.jsonLdProducts[0]).toMatchObject({ name: null, sku: null, gtin: null });
    expect(signals.jsonLdProducts[0]!.offers).toHaveLength(0);
    expect(verdict201ByDomain('nylabone.com')!.structuredData).toMatch(/empty shells/i);
  });

  it('parses a Blue-Buffalo-shaped page (no ld+json) as zero products', () => {
    const signals = parseStructuredSignals(OPTIMIZELY_EXCERPT);
    expect(signals.jsonLdProducts).toHaveLength(0);
    expect(verdict201ByDomain('bluebuffalo.com')!.structuredData).toMatch(/zero/i);
  });

  it('maps Shopify product URLs to the .js endpoint and rejects Sitecore-shaped paths', () => {
    expect(shopifyProductUrl('https://discovernutrisource.com/products/adult-chicken-and-rice-dog-food')).toBe(
      'https://discovernutrisource.com/products/adult-chicken-and-rice-dog-food.js',
    );
    expect(
      shopifyProductUrl('https://www.nylabone.com/products/product-type/chew-toys/power-chew/durachew-cheese-bone'),
    ).toBeNull();
  });

  it('every verdict names a downstream ticket or follow-up (the no-re-probing input artifact)', () => {
    // Handoff-completeness guard: the mechanism tickets partition the table.
    // Counts are pinned deliberately — silently re-routing a domain to a
    // different ticket must fail loudly here, not drift downstream.
    const downstreams = PRODUCT_PAGE_VERDICTS_201.map((v) => v.downstream);
    expect(downstreams.filter((d) => d.includes('#207')).length).toBe(6);
    expect(downstreams.filter((d) => d.includes('#203')).length).toBe(5);
    expect(downstreams.filter((d) => d.includes('new ticket')).length).toBe(4);
    expect(downstreams.filter((d) => d.includes('#204')).length).toBe(1);
  });
});
