// story: #191 — Output-first inspection and sibling-URL validation routes
import { Hono } from 'hono';
import { z } from 'zod';
import { inspectProfileUrl, validateSiblingUrls } from '../../onboarding/profile-workspace/output-first-service';
import { captureProfilePage } from '../../onboarding/profile-capture';
import { getVersionById, type ProfileVersion } from '../../db/repositories/profile-version-repo';
import { getRepresentativeSuite } from '../../db/repositories/representative-suite-repo';
import type { ExtractorProfile } from '../../db/repositories/extractor-profile-repo';

export const profileInspectRoutes = new Hono();

function normalizeDomain(d: string): string {
  return d.toLowerCase().replace(/^www\./, '').trim();
}

export function versionToExtractorProfile(version: ProfileVersion): ExtractorProfile {
  const sel = (version.selectors ?? {}) as Record<string, any>;
  return {
    id: version.id,
    domain: version.domain,
    titleSelector: sel.titleSelector ?? sel.title_selector ?? null,
    priceSelector: sel.priceSelector ?? sel.price_selector ?? null,
    descriptionSelector: sel.descriptionSelector ?? sel.description_selector ?? null,
    brandSelector: sel.brandSelector ?? sel.brand_selector ?? null,
    imagesSelector: sel.imagesSelector ?? sel.images_selector ?? sel.imageSelector ?? sel.image_selector ?? null,
    sitemapProductUrlPattern: sel.sitemapProductUrlPattern ?? sel.sitemap_product_url_pattern ?? null,
    customSelectors: sel.customSelectors ?? sel.custom_selectors ?? {},
    titleOptionalSelectors: sel.titleOptionalSelectors ?? sel.title_optional_selectors ?? [],
    variantSelectionStrategy: sel.variantSelectionStrategy ?? null,
    runtime: (version.runtime as 'static' | 'rendered') ?? 'rendered',
    shopifyJsonPath: sel.shopifyJsonPath ?? 0,
    customSelectorMetadata: sel.customSelectorMetadata ?? {},
    createdAt: version.createdAt,
    updatedAt: version.createdAt,
  } as unknown as ExtractorProfile;
}

const InspectBodySchema = z.object({
  url: z.string().url(),
  html: z.string().optional(),
  runtime: z.enum(['static', 'rendered']).default('rendered'),
  versionId: z.string().optional(),
  expected: z
    .object({
      name: z.string().optional(),
      brandHint: z.string().nullable().optional(),
      price: z.string().nullable().optional(),
      gtin: z.string().nullable().optional(),
      sku: z.string().nullable().optional(),
    })
    .optional(),
});

profileInspectRoutes.post('/domains/:domain/profile/inspect', async (c) => {
  const domain = normalizeDomain(c.req.param('domain') ?? '');
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = InspectBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid inspect payload', details: parsed.error.format() }, 400);
  }

  const { url, runtime, versionId, expected } = parsed.data;
  let html = parsed.data.html;

  // Capture if HTML was not supplied directly
  if (!html) {
    try {
      const cap = await captureProfilePage({ url, runtime });
      html = cap.dom;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Capture failed: ${msg}` }, 500);
    }
  }

  let profile: ExtractorProfile | null = null;
  if (versionId) {
    const v = getVersionById(versionId);
    if (v) profile = versionToExtractorProfile(v);
  }

  try {
    const result = await inspectProfileUrl({
      domain,
      url,
      html,
      profile,
      expected,
    });
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Inspection failed: ${msg}` }, 500);
  }
});

const ValidateSiblingsSchema = z.object({
  versionId: z.string().optional(),
  siblingUrls: z.array(z.string().url()).optional(),
  siblingHtmls: z.record(z.string(), z.string()).optional(),
});

profileInspectRoutes.post('/domains/:domain/profile/validate-siblings', async (c) => {
  const domain = normalizeDomain(c.req.param('domain') ?? '');
  const rawBody = await c.req.json().catch(() => ({}));
  const parsed = ValidateSiblingsSchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: 'Invalid validate-siblings payload', details: parsed.error.format() }, 400);
  }

  const { versionId, siblingHtmls = {} } = parsed.data;
  const suite = getRepresentativeSuite(domain);
  const siblingUrls = parsed.data.siblingUrls ?? suite;

  if (siblingUrls.length === 0) {
    return c.json({ error: 'No sibling URLs available for validation' }, 400);
  }

  let profile: ExtractorProfile | null = null;
  if (versionId) {
    const v = getVersionById(versionId);
    if (v) profile = versionToExtractorProfile(v);
  }

  const siblingPages: Array<{ url: string; html?: string }> = [];
  for (const u of siblingUrls) {
    let sHtml = siblingHtmls[u];
    if (!sHtml) {
      try {
        const cap = await captureProfilePage({ url: u, runtime: 'rendered' });
        sHtml = cap.dom;
      } catch (_err) {
        // Leave undefined so runner handles empty/failed
      }
    }
    siblingPages.push({ url: u, html: sHtml });
  }

  try {
    const result = await validateSiblingUrls({
      domain,
      siblingPages,
      profile,
    });
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Sibling validation failed: ${msg}` }, 500);
  }
});
