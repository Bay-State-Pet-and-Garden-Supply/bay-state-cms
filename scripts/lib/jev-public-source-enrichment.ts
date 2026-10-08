import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { z } from 'zod';
import { JevSourceExcerptSchema } from '../../src/shared/schemas/jev-benchmark';

const ProductSchema = z.object({
  '@type': z.union([z.string(), z.array(z.string())]),
  name: z.string().optional(), Name: z.string().optional(),
  url: z.string().optional(), Url: z.string().optional(),
  description: z.string().optional(), Description: z.string().optional(),
  brand: z.union([z.string(), z.object({ name: z.string() }).passthrough()]).optional(),
  category: z.union([z.string(), z.array(z.string())]).optional(),
  audience: z.union([z.string(), z.object({ audienceType: z.string().optional(), name: z.string().optional() }).passthrough()]).optional(),
}).passthrough();

type Product = z.infer<typeof ProductSchema>;
export interface PublicProductEvidence {
  title: string;
  brand: string | null;
  sourceHash: string;
  excerpts: Array<z.infer<typeof JevSourceExcerptSchema>>;
}

const PRIMARY_DESCRIPTION = '[itemprop="description"],.product-description,.full-description,[data-product-description],.woocommerce-product-details__short-description,#tab-description,#tab-additional_information,.ProductMeta__Description,.product__description,.product-details__description,.product-info__description';
const CONTAMINANTS = 'script,style,nav,header,footer,form,[id*="review"],[class*="review"],[id*="related"],[class*="related"],[id*="recommend"],[class*="recommend"],[class*="upsell"],[class*="cross-sell"],[id*="cross-sell"],[class*="recently"],.cookie-banner,.cookie-consent,#onetrust-banner-sdk,.newsletter';
const PRICE = /[$£€]\s*\d|\b(?:price|sale price|msrp)\s*[:=]?\s*\d/i;

function text(html: string): string {
  const $ = load(html);
  $(CONTAMINANTS).remove();
  return $.text().replace(/\s+/g, ' ').trim();
}
function identityName(value: string, brand: string): string {
  const normalize = (s: string) => text(s).replace(/[®™]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const name = normalize(value);
  const prefix = normalize(brand);
  return name.startsWith(`${prefix} `) ? name.slice(prefix.length + 1) : name;
}
function productUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  // Identity comparison only — no policy judgment (https/public gates live at the fetch boundary).
  return url.hostname.toLowerCase().replace(/^www\./, '') + url.pathname.replace(/\/$/, '');
}

/** Enrich an already-public SKU only from its exact primary Product, never site-wide prose. */
export function extractPublicProductEvidence(
  html: string,
  finalUrl: string,
  expected: { canonicalUrl: string; title: string; brand: string },
): PublicProductEvidence | null {
  const final = productUrl(finalUrl);
  if (final === null || final !== productUrl(expected.canonicalUrl)) return null;
  const $ = load(html);
  const products: Product[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const parsed = ProductSchema.safeParse(value);
    if (parsed.success && [parsed.data['@type']].flat().includes('Product')) products.push(parsed.data);
    if ('@graph' in value) visit(value['@graph']);
    if ('mainEntity' in value) visit(value.mainEntity);
    // ItemList and offers/recommendations deliberately are not traversed.
  };
  $('script[type="application/ld+json"]').each((_, element) => {
    try { visit(JSON.parse($(element).text())); } catch { /* malformed metadata is not proof */ }
  });
  const matching = products.filter(product => {
    const canonical = product.url ?? product.Url;
    if (!canonical) return products.length === 1;
    let href: string;
    try { href = new URL(canonical, finalUrl).href; } catch { return false; }
    return productUrl(href) === final;
  });
  if (matching.length !== 1) return null;
  const product = matching[0];
  const title = product.name ?? product.Name;
  if (!title || identityName(title, expected.brand) !== identityName(expected.title, expected.brand)) return null;
  const excerpts: PublicProductEvidence['excerpts'] = [];
  const seen = new Set<string>();
  const append = (value: string, locator: string): void => {
    // Short facts such as “Species: Dogs” are evidence too. Never discard them for length.
    for (const sentence of text(value).split(/(?<=[.!?;])\s+/).filter(Boolean)) {
      if (sentence.length > 2000 || PRICE.test(sentence) || seen.has(sentence) || excerpts.length >= 20) continue;
      seen.add(sentence);
      excerpts.push(JevSourceExcerptSchema.parse({ text: sentence, locator: `${finalUrl}#${locator}` }));
    }
  };
  const audience = product.audience;
  if (typeof audience === 'string') append(audience, 'jsonld-primary-product-audience');
  else if (audience) {
    if (audience.audienceType) append(audience.audienceType, 'jsonld-primary-product-audienceType');
    if (audience.name) append(audience.name, 'jsonld-primary-product-audience-name');
  }
  for (const category of [product.category ?? []].flat()) append(category, 'jsonld-primary-product-category');
  const description = product.description ?? product.Description;
  if (description) append(description, 'jsonld-primary-product-description');
  $(CONTAMINANTS).remove();
  $(PRIMARY_DESCRIPTION).each((index, element) => append($(element).html() ?? '', `primary-description-${index}`));
  if (excerpts.length === 0) return null;
  const brand = typeof product.brand === 'string' ? product.brand : product.brand?.name ?? null;
  return { title: text(title), brand, sourceHash: createHash('sha256').update(html).digest('hex'), excerpts };
}
