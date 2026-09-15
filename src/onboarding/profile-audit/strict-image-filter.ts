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

export type StrictImageCandidate =
  | string
  | {
      url: string;
      source?: string;
      role?: 'primary' | 'gallery';
    };

export interface StrictImageFilterInput {
  images: StrictImageCandidate[];
  baseUrl: string;
  variantMatrix?: VariantMatrix | null;
  selectedVariantKey?: string | null;
  maxImages?: number;
  customPrimaryImage?: string | null;
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
  /\/icons?\//i,
  /favicon/i,
  /[-_/]badge[-_.]/i,
  /\/badges?\//i,
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
  /banner[-_.]/i,
  /[-_/]swatch[-_.]/i,
  /\/swatches?\//i,
  /color[-_]swatch/i,
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
  const {
    images,
    baseUrl,
    variantMatrix,
    selectedVariantKey,
    maxImages = DEFAULT_MAX_IMAGES,
    customPrimaryImage,
  } = input;

  const rejectedImages: string[] = [];
  const rejectionReasons: Record<string, string> = {};

  // Normalize inputs to candidate objects
  let preferredPrimaryCanon: string | null = null;
  if (customPrimaryImage) {
    preferredPrimaryCanon = canonicalizeUrl(customPrimaryImage, baseUrl);
  }

  const normalizedCandidates: Array<{ url: string; role?: 'primary' | 'gallery' }> = [];
  for (const item of images) {
    if (!item) continue;
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) normalizedCandidates.push({ url: trimmed });
    } else if (typeof item === 'object' && item.url) {
      const trimmed = item.url.trim();
      if (trimmed) {
        normalizedCandidates.push({ url: trimmed, role: item.role });
        if (item.role === 'primary' && !preferredPrimaryCanon) {
          preferredPrimaryCanon = canonicalizeUrl(trimmed, baseUrl);
        }
      }
    }
  }

  // Build variant image lookup and detect proven shared-product images across all variants
  const selectedVariantCanonicals = new Set<string>();
  const otherVariantCanonicals = new Set<string>();
  const provenSharedCanonicals = new Set<string>();
  const candidateImageSets: Array<Set<string>> = [];
  const hasMultipleVariants = Boolean(
    variantMatrix && variantMatrix.candidates && variantMatrix.candidates.length > 1,
  );

  if (variantMatrix && variantMatrix.candidates && variantMatrix.candidates.length > 0) {
    for (const candidate of variantMatrix.candidates) {
      const isSelected = selectedVariantKey ? candidate.variantKey === selectedVariantKey : false;
      const candidateImages = (candidate.images || []).map(img =>
        typeof img === 'string' ? img : img.url,
      );
      const thisCandidateSet = new Set<string>();

      for (const imgUrl of candidateImages) {
        if (!imgUrl) continue;
        const canon = canonicalizeUrl(imgUrl, baseUrl);
        thisCandidateSet.add(canon);
        if (isSelected) {
          selectedVariantCanonicals.add(canon);
        } else {
          otherVariantCanonicals.add(canon);
        }
      }
      if (thisCandidateSet.size > 0) {
        candidateImageSets.push(thisCandidateSet);
      }
    }

    // Proven shared-product images: present in all candidates with images
    if (candidateImageSets.length > 1) {
      for (const canon of candidateImageSets[0]) {
        if (candidateImageSets.every(s => s.has(canon))) {
          provenSharedCanonicals.add(canon);
        }
      }
    }

    // Remove from otherVariantCanonicals if they are shared with selected variant or proven shared
    for (const canon of selectedVariantCanonicals) {
      otherVariantCanonicals.delete(canon);
    }
    for (const canon of provenSharedCanonicals) {
      otherVariantCanonicals.delete(canon);
    }
  }

  // Step 1: Filter usability, role, and variant qualification
  const passedCandidateUrls: string[] = [];
  const seenPassedCanonicals = new Set<string>();

  for (const candidate of normalizedCandidates) {
    const trimmed = candidate.url;
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
    if (hasMultipleVariants) {
      const isSelectedVariant = selectedVariantCanonicals.has(canon);
      const isProvenShared = provenSharedCanonicals.has(canon);
      const isCustomPrimary = Boolean(preferredPrimaryCanon && preferredPrimaryCanon === canon);

      if (isSelectedVariant || isProvenShared || isCustomPrimary) {
        // Positive membership evidence: admitted
      } else if (otherVariantCanonicals.has(canon)) {
        rejectedImages.push(trimmed);
        rejectionReasons[trimmed] = 'other_variant';
        continue;
      } else {
        rejectedImages.push(trimmed);
        rejectionReasons[trimmed] = 'unknown_membership';
        continue;
      }
    }

    passedCandidateUrls.push(trimmed);
    seenPassedCanonicals.add(canon);
  }

  // Step 3: Safe deduplication across resolution variations
  const deduped = cleanAndDeduplicateImages(passedCandidateUrls, baseUrl);

  // Step 4: Role and ordering signals (preserve/flag primary image at index 0)
  if (preferredPrimaryCanon) {
    const primIdx = deduped.findIndex(
      u => canonicalizeUrl(u, baseUrl) === preferredPrimaryCanon,
    );
    if (primIdx > 0) {
      const [favored] = deduped.splice(primIdx, 1);
      deduped.unshift(favored);
    }
  }

  // Step 5: Safety Caps
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

  // Record resolution duplicates that were dropped by deduping:
  // For each canonical image group, the first passed candidate is accepted,
  // while subsequent resolution/size variations are recorded as resolution_duplicate.
  const allDedupedCanonicals = new Set(deduped.map(u => canonicalizeUrl(u, baseUrl)));
  const seenPassedCanonicalsForDedup = new Set<string>();
  for (const url of passedCandidateUrls) {
    const canon = canonicalizeUrl(url, baseUrl);
    if (allDedupedCanonicals.has(canon)) {
      if (!seenPassedCanonicalsForDedup.has(canon)) {
        seenPassedCanonicalsForDedup.add(canon);
      } else {
        rejectedImages.push(url);
        rejectionReasons[url] = 'resolution_duplicate';
      }
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
