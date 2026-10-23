import { hashCanonicalJson } from '../shared/stable-id';

export interface ItemInputIdentity {
  id: string;
  batchId: string;
  upc: string;
  name: string;
  brandHint?: string | null;
  price?: string | null;
  quantity?: number | null;
  rawIdentityJson?: string | null;
  normalizedIdentityJson?: string | null;
  identityNormalizerVersion?: number | null;
  identityProvenanceHash?: string | null;
  identityLossy?: boolean;
}

/** Canonical revision binding shared by evidence admission and manual authority creation. */
export function itemInputIdentityHash(workspaceId: string, item: ItemInputIdentity): string {
  return hashCanonicalJson({
    workspaceId,
    batchId: item.batchId,
    itemId: item.id,
    sku: item.upc,
    registerName: item.name,
    brandHint: item.brandHint ?? null,
    importedPrice: item.price ?? null,
    quantity: item.quantity ?? null,
    rawIdentityJson: item.rawIdentityJson ?? null,
    normalizedIdentityJson: item.normalizedIdentityJson ?? null,
    identityNormalizerVersion: item.identityNormalizerVersion ?? null,
    identityProvenanceHash: item.identityProvenanceHash ?? null,
    identityLossy: item.identityLossy ?? false,
  });
}
