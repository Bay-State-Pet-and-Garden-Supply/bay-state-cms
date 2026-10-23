import Icecat from 'icecat';
import { isThirdPartyPriceSpecification, type ScrapedProductEvidence, ScrapedProductEvidenceSchema } from '../corpus-schema.js';
import { computeEntityId } from '../url-policy.js';

export interface OpenIcecatProductResponse {
  data?: {
    GeneralInfo?: {
      Title?: string;
      Brand?: string;
      BrandLogo?: string;
      GTIN?: string[];
      Category?: {
        Name?: { Value?: string };
      };
      Description?: {
        LongDesc?: string;
      };
    };
    FeaturesGroups?: Array<{
      Features?: Array<{
        Feature?: { Name?: { Value?: string } };
        Value?: string;
      }>;
    }>;
    Image?: {
      HighPic?: string;
    };
  };
}

/**
 * Fetches structured product content sheets using GreenCore/icecat library with fallback to open API endpoints.
 */

/** Minimal structural fetch signature — lets callers inject the PI
 *  policy-gateway bound fetch (P0-1). */
type NetworkFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export async function fetchOpenIcecatByGtin(
  gtin: string,
  username?: string,
  fetchFn: NetworkFetch = fetch
): Promise<ScrapedProductEvidence | null> {
  const cleanGtin = gtin.trim().replace(/[^0-9]/g, '');
  if (!cleanGtin) return null;

  const icecatUser = username || 'OpenIcecatUser';

  // Try GreenCore/icecat SDK first — ONLY when no transport was injected.
  // The SDK owns its HTTP internally (client.openCatalog.getProduct) and
  // cannot be policy-gated, so Product Intelligence callers (which always
  // pass a gateway-bound fetchFn) bypass it entirely and use the REST
  // endpoint through the injected transport. The onboarding/crawler path
  // keeps the SDK behaviour unchanged.
  if (fetchFn === fetch) {
    try {
      const client = new Icecat(icecatUser, 'dummy_password');
      const product = await client.openCatalog.getProduct('EN', cleanGtin);

    if (product && typeof product.getTitle === 'function' && product.getTitle()) {
      const title = product.getTitle();
      const brand = typeof product.getBrand === 'function' ? product.getBrand() : undefined;
      const category = typeof product.getCategory === 'function' ? product.getCategory() : undefined;
      const description = typeof product.getLongDescription === 'function' ? product.getLongDescription() : undefined;
      const images: string[] = [];

      if (typeof product.getImages === 'function') {
        const rawImgs = product.getImages();
        if (Array.isArray(rawImgs)) {
          rawImgs.forEach((img: { HighPic?: string; Pic?: string }) => {
            if (img.HighPic || img.Pic) images.push(img.HighPic || img.Pic || '');
          });
        }
      }

      const evidence: ScrapedProductEvidence = {
        id: `openicecat-${cleanGtin}`,
        entityId: computeEntityId(`https://icecat.biz/en/p/${cleanGtin}`),
        retailer: 'icecat.biz',
        sourceUrl: `https://icecat.biz/en/p/${cleanGtin}`,
        scrapedAt: new Date().toISOString(),
        title: String(title).trim(),
        brand: brand ? String(brand).trim() : undefined,
        upc: cleanGtin,
        gtin: cleanGtin,
        rawBreadcrumb: category ? [String(category).trim()] : [],
        specifications: {},
        description: description ? String(description).trim() : undefined,
        images: images.filter(Boolean),
        acquisitionMode: 'open_api',
        parserVersion: '2.0',
        licenseStatus: 'proprietary',
      };

      return ScrapedProductEvidenceSchema.parse(evidence);
    }
  } catch {
    // Fall back to direct JSON REST endpoint if SDK call throws
  }
  }

  // Fallback to direct REST endpoint
  const url = `https://live.icecat.biz/api/?shop_name=${encodeURIComponent(icecatUser)}&lang=en&gtin=${cleanGtin}`;

  try {
    const res = await fetchFn(url, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!res.ok) return null;

    const body = (await res.json()) as OpenIcecatProductResponse;
    const info = body.data?.GeneralInfo;
    if (!info || !info.Title) return null;

    const title = info.Title.trim();
    const brand = info.Brand?.trim() || undefined;
    const categoryName = info.Category?.Name?.Value?.trim();
    const rawBreadcrumb = categoryName ? [categoryName] : [];

    const specifications: Record<string, string> = {};
    if (body.data?.FeaturesGroups) {
      for (const group of body.data.FeaturesGroups) {
        if (group.Features) {
          for (const feat of group.Features) {
            const name = feat.Feature?.Name?.Value?.trim();
            const val = feat.Value?.trim();
            if (name && val && !isThirdPartyPriceSpecification(name)) {
              specifications[name] = val;
            }
          }
        }
      }
    }

    const description = info.Description?.LongDesc?.trim() || undefined;
    const images: string[] = [];
    if (body.data?.Image?.HighPic) {
      images.push(body.data.Image.HighPic);
    }

    const evidence: ScrapedProductEvidence = {
      id: `openicecat-${cleanGtin}`,
      entityId: computeEntityId(`https://icecat.biz/en/p/${cleanGtin}`),
      retailer: 'icecat.biz',
      sourceUrl: `https://icecat.biz/en/p/${cleanGtin}`,
      scrapedAt: new Date().toISOString(),
      title,
      brand,
      upc: cleanGtin,
      gtin: cleanGtin,
      rawBreadcrumb,
      specifications,
      description,
      images,
      acquisitionMode: 'open_api',
      parserVersion: '2.0',
      licenseStatus: 'proprietary',
      validationState: 'unvalidated',
      qualityFlags: [],
      pageKind: 'unknown',
    };

    return ScrapedProductEvidenceSchema.parse(evidence);
  } catch (error) {
    console.error(`Failed to fetch Open Icecat for GTIN ${cleanGtin}:`, error);
    return null;
  }
}
