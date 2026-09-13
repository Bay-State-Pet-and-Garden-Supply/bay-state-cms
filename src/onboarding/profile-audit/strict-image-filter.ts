/**
 * Strict Post-Merge Image Filter (Audit Gate Seam)
 *
 * Implements the strict image filter rule under evaluation (Spec #173):
 * 1. Discards unusable/decorative/role-based non-product images (icons, social, payment, badges).
 * 2. Variant qualification: admits only selected-variant or proven shared-product images,
 *    excluding images that belong specifically to other non-selected variants.
 * 3. Applies ordering signals (preserves primary image at index 0).
 * 4. Safe deduplication across resolution/size variations.
 * 5. Enforces safety gallery caps.
 */

import type { VariantMatrix } from '../../shared/schemas/variant-resolution';
import {
  isUsableImageSource,
  canonicalizeUrl,
  cleanAndDeduplicateImages,
} from '../image-utils';

export interface StrictImageFilterInput {
  images: string[];
  baseUrl: string;
  variantMatrix?: VariantMatrix | null;
  selectedVariantKey?: string | null;
  maxImages?: number;
}

export interface StrictImageFilterResult {
  primaryImage: string | null;
  admittedImages: string[];
  rejectedImages: string[];
  rejectionReasons: Record<string, string>;
}

const DEFAULT_MAX_IMAGES = 12;

// Patterns indicating non-product role/decorative graphics
const REJECT_ROLE_PATTERNS = [
  /[-_/]icon[-_.]/i,
  /\/icons\//i,
  /favicon/i,
  /[-_/]badge[-_.]/i,
  /\/badges\//i,
  /[-_/]seal[-_.]/i,
  /[-_/]logo[-_.]/i,
  /\/logos?\//i,
  /[-_/]social[-_.]/i,
  /facebook/i,
  /instagram/i,
  /twitter/i,
  /tiktok/i,
  /pinterest/i,
  /youtube/i,
  /visa/i,
  /mastercard/i,
  /amex/i,
  /paypal/i,
  /applepay/i,
  /payment/i,
  /star[-_]rating/i,
  /promobar/i,
  /free[-_]shipping/i,
];

export function isRoleRejectedImage(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const pathAndQuery = parsed.pathname + parsed.search;
    for (const pattern of REJECT_ROLE_PATTERNS) {
      if (pattern.test(pathAndQuery)) return true;
    }
  } catch {
    for (const pattern of REJECT_ROLE_PATTERNS) {
      if (pattern.test(urlStr)) return true;
    }
  }
  return false;
}

export function applyStrictImageFilter(input: StrictImageFilterInput): StrictImageFilterResult {
  const { images, baseUrl, variantMatrix, selectedVariantKey, maxImages = DEFAULT_MAX_IMAGES } = input;

  const rejectedImages: string[] = [];
  const rejectionReasons: Record<string, string> = {};

  // Build variant image lookup if matrix is present
  const selectedVariantCanonicals = new Set<string>();
  const otherVariantCanonicals = new Set<string>();

  if (variantMatrix && variantMatrix.candidates && variantMatrix.candidates.length > 0) {
    for (const candidate of variantMatrix.candidates) {
      const isSelected = selectedVariantKey ? candidate.variantKey === selectedVariantKey : false;
      const candidateImages = (candidate.images || []).map(img => typeof img === 'string' ? img : img.url);

      for (const imgUrl of candidateImages) {
        if (!imgUrl) continue;
        const canon = canonicalizeUrl(imgUrl, baseUrl);
        if (isSelected) {
          selectedVariantCanonicals.add(canon);
        } else {
          otherVariantCanonicals.add(canon);
        }
      }
    }
    // Remove canonicals from otherVariants if they are shared with selected variant
    for (const canon of selectedVariantCanonicals) {
      otherVariantCanonicals.delete(canon);
    }
  }

  // Step 1: Pre-filter usable and role
  const candidateUrls: string[] = [];

  for (const img of images) {
    if (!img || typeof img !== 'string') continue;
    const trimmed = img.trim();
    if (!isUsableImageSource(trimmed)) {
      rejectedImages.push(trimmed);
      rejectionReasons[trimmed] = 'not_usable';
      continue;
    }

    if (isRoleRejectedImage(trimmed)) {
      rejectedImages.push(trimmed);
      rejectionReasons[trimmed] = 'role_rejected';
      continue;
    }

    // Step 2: Variant membership
    const canon = canonicalizeUrl(trimmed, baseUrl);
    if (otherVariantCanonicals.has(canon) && !selectedVariantCanonicals.has(canon)) {
      rejectedImages.push(trimmed);
      rejectionReasons[trimmed] = 'other_variant';
      continue;
    }

    candidateUrls.push(trimmed);
  }

  // Step 3 & 4: Safe deduplication across resolution variations
  const deduped = cleanAndDeduplicateImages(candidateUrls, baseUrl);

  // Step 5: Caps
  const admittedImages: string[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const url = deduped[i];
    if (admittedImages.length < maxImages) {
      admittedImages.push(url);
    } else {
      rejectedImages.push(url);
      rejectionReasons[url] = 'cap_exceeded';
    }
  }

  const primaryImage = admittedImages.length > 0 ? admittedImages[0] : null;

  return {
    primaryImage,
    admittedImages,
    rejectedImages,
    rejectionReasons,
  };
}
