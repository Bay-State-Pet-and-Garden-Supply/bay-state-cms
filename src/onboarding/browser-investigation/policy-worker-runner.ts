// Shared production worker seam for browser-investigation validation (#228/#239).
//
// One definition, used by BOTH the validation route and the #239 pilot CLI,
// so the pilot exercises the exact runner production runs: the compiled
// draft profile goes through the profile-runner client to the extraction
// worker, and only the fields the validation contract needs come back.
//
// Pure translation over an injected worker call shape: no DB, no network of
// its own (the profile-runner client owns transport).

import { runProfileExtraction } from '../profile-runner-client';
import type { PolicyWorkerResult } from './validate';

type RunnerExpected = {
  name: string;
  brandHint?: string | null;
  price?: string | null;
  upc?: string;
  sku?: string;
  platformVariantId?: string;
};

/** Trusted expected identity → profile-runner expected carrier (UPC rides the GTIN slot). */
function runnerExpectedOf(expected: RunnerExpected): {
  name: string;
  brandHint: string | null;
  price: string | null;
  upc?: string;
  sku?: string;
  platformVariantId?: string;
} {
  return {
    name: expected.name,
    brandHint: expected.brandHint ?? null,
    price: expected.price ?? null,
    ...(expected.upc ? { upc: expected.upc } : {}),
    ...(expected.sku ? { sku: expected.sku } : {}),
    ...(expected.platformVariantId ? { platformVariantId: expected.platformVariantId } : {}),
  };
}

/** Image list from an extraction payload (falls back to primary + additional). */
function imagesOf(data: Record<string, unknown>): string[] {
  const images = (data as { images?: unknown }).images;
  if (Array.isArray(images)) return images.filter((url): url is string => typeof url === 'string');
  const primary = (data as { primaryImage?: unknown }).primaryImage;
  const additional = ((data as { additionalImages?: unknown }).additionalImages as unknown[] | undefined) ?? [];
  return [primary, ...additional].filter((url): url is string => typeof url === 'string');
}

type PolicyWorkerData = NonNullable<Extract<PolicyWorkerResult, { ok: true }>['data']>;

/** Extraction data → validation data carrier (only the fields under test). */
function dataOf(
  data: Record<string, unknown>,
  images: string[],
  fieldProvenance: Record<string, string>,
): PolicyWorkerData {
  return {
    title: (data.title as string | null) ?? null,
    brand: (data.brand as string | null) ?? null,
    description: (data.description as string | null) ?? null,
    price: (data.price as string | null) ?? null,
    primaryImage: images[0] ?? null,
    additionalImages: images.slice(1),
    customFields: ((data.customFields as Record<string, string> | undefined) ?? {}) as Record<string, string>,
    fieldProvenance,
  } as never;
}

/** Successful worker response → policy worker result (parent product id rides through for identity). */
function successOf(res: Record<string, unknown> & { data: Record<string, unknown> }): PolicyWorkerResult {
  return {
    ok: true,
    data: dataOf(res.data, imagesOf(res.data), (res.fieldProvenance ?? {}) as Record<string, string>),
    matrixDecision: (res.matrixDecision ?? null) as never,
    selectedReceipt: (res.selectedReceipt ?? null) as never,
    parentProductId: (res.parentProductId as string | undefined) ?? null,
    sourceContentHash: (res.sourceContentHash as string | null | undefined) ?? null,
  };
}

/** Failed worker response → policy worker result (identity evidence preserved). */
function failureOf(res: {
  error: string;
  failureCode?: string | null;
  matrixDecision?: unknown;
  selectedReceipt?: unknown;
}): PolicyWorkerResult {
  return {
    ok: false,
    error: res.error,
    failureCode: res.failureCode ?? null,
    matrixDecision: (res.matrixDecision ?? null) as never,
    selectedReceipt: (res.selectedReceipt ?? null) as never,
  };
}

/**
 * Production worker runner: the compiled draft profile executes on the real
 * extraction worker through the trusted profile runner — never a fallback,
 * never an LLM.
 */
export const productionPolicyRunner = {
  run: async ({
    profile,
    sampleUrl,
    expected,
  }: Parameters<import('./validate').PolicyWorkerRunner['run']>[0]): Promise<PolicyWorkerResult> => {
    const res = await runProfileExtraction({
      sourceUrl: sampleUrl,
      profile,
      expected: runnerExpectedOf(expected),
    });
    return res.ok
      ? successOf({ ...(res as unknown as Record<string, unknown>), data: res.data as unknown as Record<string, unknown> })
      : failureOf(res);
  },
} satisfies import('./validate').PolicyWorkerRunner;
