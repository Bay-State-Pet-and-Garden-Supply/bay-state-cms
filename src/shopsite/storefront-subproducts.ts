import type { Product } from '../shared/types';

/**
 * Managed Subproducts emission for adopted storefront families (issue #368).
 *
 * The codec owns ALL Subproducts XML authoring: unmanaged products keep
 * their raw-preserved block byte-for-byte, while adopted family members
 * receive exactly one managed `<Subproducts>` block built by
 * `buildManagedSubproductsXml`. The encoder calls `managedSubproductsXml`
 * only when the product opts in via `shopsite.preserved.rawAttributes`
 * `managedFamilyId`; otherwise the preserved raw block (or absence) is
 * emitted untouched.
 *
 * Single-concept vocabulary (glossary): one opt-in "managed Subproducts
 * block" carries the full member set on every member; "managed mesh" /
 * "managed block" / "managed markers" in comments all denote this same one
 * block, stamped by the managedFamily markers. There is deliberately no
 * duplicate writer: every managed block flows through this single builder.
 *
 * Unsupported structures refuse adoption BEFORE this module runs:
 * nested `<Subproducts>` inside `<Subproducts>`, non-SKU member payloads
 * the builder cannot reproduce, or cross-workspace references.
 */

export const MANAGED_FAMILY_ID_ATTR = 'managedFamilyId';
export const MANAGED_FAMILY_MEMBERS_ATTR = 'managedFamilyMemberSkus';

/** Structural refusal codes for unsupported native Subproducts blocks. */
export type SubproductsSupportCode =
  | 'supported_absent'
  | 'supported_managed'
  | 'supported_unmanaged_simple'
  | 'unsupported_nested'
  | 'unsupported_unparseable';

export interface SubproductsSupport {
  code: SubproductsSupportCode;
  detail: string;
}

/**
 * Classify the current native Subproducts posture of a product.
 * Pure: reads only the codec-owned raw block. Adoption requires
 * supported_*; unsupported_* refuses family membership for that product.
 */
export function classifySubproductsSupport(product: Product): SubproductsSupport {
  const raw = rawSubproductsBlock(product);
  if (raw === null) {
    return { code: 'supported_absent', detail: 'No native Subproducts block; adoption writes the first managed block.' };
  }
  const inner = innerOfSubproducts(raw);
  if (inner === null) {
    return { code: 'unsupported_unparseable', detail: 'Native Subproducts block is not parseable; refusing adoption to avoid data loss.' };
  }
  if (/<\s*subproducts[\s>]/i.test(inner)) {
    return { code: 'unsupported_nested', detail: 'Native Subproducts block nests Subproducts; unsupported chained-parent structure refuses adoption.' };
  }
  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  if (typeof attrs[MANAGED_FAMILY_ID_ATTR] === 'string' && attrs[MANAGED_FAMILY_ID_ATTR].length > 0) {
    return { code: 'supported_managed', detail: 'Product already carries a managed family block; re-adoption is allowed only by the same family.' };
  }
  return { code: 'supported_unmanaged_simple', detail: 'Unmanaged raw Subproducts block preserved; adoption replaces it with one managed block.' };
}

/** Structural verdicts for adopting an existing native relationship (issue #369). */
export type NativeAdoptionCode =
  | 'adoptable_family'
  | 'refused_accessory'
  | 'refused_not_family'
  | 'refused_incomplete'
  | 'refused_ambiguous'
  | 'refused_unsupported';

export interface NativeAdoptionSupport {
  code: NativeAdoptionCode;
  detail: string;
}

/**
 * Classify one native host's Subproducts block as an adoptable family or a
 * refusal that preserves the native structure unmanaged. Pure: reads only
 * the codec-owned raw block. Adoption requires `adoptable_family`; every
 * other code refuses with a preservation reason instead of dropping data.
 *
 * Structural discriminators (no model calls, no cohort consultation):
 * - no/empty/self-only block: not a family (nothing to adopt);
 * - host absent from its own member list: accessory-style parenting, never
 *   reinterpreted as a family (the family main always lists itself);
 * - native member set != supplied group: incomplete/ambiguous, adopt the
 *   complete group or leave it unmanaged;
 * - raw SKU occurrences beyond the distinct set (before dedupe): ambiguous
 *   membership, refused — dedupe would otherwise hide the double-listing;
 * - stanzas without SKUs: malformed/unsupported, preserved untouched;
 * - nested/unparseable blocks: unsupported, preserved untouched.
 */
export function classifyNativeAdoption(host: Product, candidateSkus: string[]): NativeAdoptionSupport {
  const raw = rawSubproductsBlock(host);
  if (raw === null) {
    return { code: 'refused_not_family', detail: 'No native Subproducts block; nothing to adopt (leave unmanaged).' };
  }
  const inner = innerOfSubproducts(raw);
  if (inner === null) {
    return { code: 'refused_unsupported', detail: 'Native Subproducts block is not parseable; refusing adoption to avoid data loss.' };
  }
  if (/<\s*subproducts[\s>]/i.test(inner)) {
    return { code: 'refused_unsupported', detail: 'Native Subproducts block nests Subproducts; unsupported chained-parent structure refuses adoption.' };
  }
  const rawOccurrences = countNativeSkuOccurrences(raw);
  const refs = extractNativeSkus(raw);
  // Ambiguity from raw occurrences, counted BEFORE dedupe, fires first: a
  // SKU occurring more than once double-lists membership — the deduped set
  // would hide it, and narrower verdicts (self-only) must not shadow it.
  const dupes = rawOccurrences.filter((o) => o.count > 1);
  if (dupes.length > 0) {
    return { code: 'refused_ambiguous', detail: `Native block lists ${dupes.map((d) => `"${d.sku}" (${d.count}x)`).join(', ')} more than once; ambiguous membership refuses adoption.` };
  }
  if (refs.length === 0) {
    return { code: 'refused_not_family', detail: 'Native Subproducts block names no SKUs; nothing to adopt (leave unmanaged).' };
  }
  // SKU-less stanzas are structural malformation: more specific than the
  // self-only shape, so this fires before it (a nameless stanza plus a
  // self-listing host is malformed, not a lone-member family).
  const stanzaCount = (raw.match(/<\s*subproduct[\s>]/gi) ?? []).length;
  if (stanzaCount > refs.length) {
    return { code: 'refused_unsupported', detail: 'Native block carries member stanzas without SKU identity; malformed metadata refuses adoption.' };
  }
  if (refs.length === 1 && refs[0] === host.sku) {
    return { code: 'refused_not_family', detail: 'Native block lists only its host; a family needs at least 2 distinct real size SKUs.' };
  }
  if (!refs.includes(host.sku)) {
    return { code: 'refused_accessory', detail: `Host "${host.sku}" does not list itself; accessory-style parenting is never reinterpreted as a family.` };
  }
  // Preserve-or-refuse for per-stanza child metadata: SKU identity plus the
  // supported display/price children (Name, Price) survive adoption
  // verbatim. Any other native child (quantity, flags, unknown tags) would
  // be silently dropped by the managed writer — refuse instead.
  const unsupportedChild = firstUnsupportedStanzaChild(raw);
  if (unsupportedChild) {
    return { code: 'refused_unsupported', detail: `Native block carries unsupported <${unsupportedChild.tag}> inside "${unsupportedChild.sku}" stanza; adoption preserves only SKU/Name/Price — refusing to avoid data loss.` };
  }
  const refSet: Record<string, true> = {};
  for (const r of refs) refSet[r] = true;
  const candidates: Record<string, true> = {};
  for (const sku of candidateSkus) candidates[sku] = true;
  const outside = refs.filter((r) => !candidates[r]);
  const uncovered = candidateSkus.filter((s) => !refSet[s]);
  if (outside.length > 0 || uncovered.length > 0) {
    return {
      code: 'refused_incomplete',
      detail: `Native block references (${refs.join(', ')}) but the supplied group is (${[...candidateSkus].sort().join(', ')}); adopt the complete group or leave it unmanaged.`,
    };
  }
  return { code: 'adoptable_family', detail: `Native family of ${refs.length} members hosted by "${host.sku}" with complete membership and self-listed main.` };
}

/**
 * First native stanza child outside the adoption contract (SKU/Name/Price),
 * if any. Scans each member stanza's direct children — the managed writer
 * emits only those three verbatim, so anything else refuses adoption.
 */
function firstUnsupportedStanzaChild(raw: string): { sku: string; tag: string } | null {
  const stanzaRe = /<\s*subproduct\b[^>]*>([\s\S]*?)(?:<\/\s*subproduct\s*>|(?=<\s*subproduct\b[^>]*>)|(?=<\s*\/\s*subproducts\s*>)|$)/gi;
  let stanza: RegExpExecArray | null;
  stanzaRe.lastIndex = 0;
  while ((stanza = stanzaRe.exec(raw)) !== null) {
    const inner = stanza[1] ?? '';
    const skuMatch = inner.match(/<\s*sku\s*>([^<]*)<\/\s*sku\s*>/i);
    const sku = skuMatch ? skuMatch[1]!.trim() || '(no SKU)' : '(no SKU)';
    const childRe = /<(\/?)\s*([A-Za-z][A-Za-z0-9._-]*)\b[^>]*>/g;
    let child: RegExpExecArray | null;
    childRe.lastIndex = 0;
    while ((child = childRe.exec(inner)) !== null) {
      // Skip closing tags (`</SKU>`) — only opening tags declare children.
      if (child[1] === '/') continue;
      const tag = child[2]!;
      if (tag.toLowerCase() !== 'sku' && tag.toLowerCase() !== 'name' && tag.toLowerCase() !== 'price') {
        return { sku, tag };
      }
    }
  }
  return null;
}

/**
 * Codec-owned writer for the explicit reviewed clear (issue #369): emits
 * exactly one canonical empty `<Subproducts></Subproducts>` block. An
 * omitted block is never assumed to clear — the clear is ON THE WIRE and
 * round-trips as an empty preserved block (never resurrected, never
 * dropped). PF7 and every unrelated block/field stay untouched; every
 * managed-family local marker is released so a cleared draft never looks
 * like a half-removed member.
 */
export function clearSubproductsBlock(product: Product): Product {
  const nextBlocks: Record<string, string> = {};
  for (const key of Object.keys(product.shopsite.preserved.advancedBlocks ?? {})) {
    if (key.toLowerCase() === 'subproducts') continue;
    nextBlocks[key] = product.shopsite.preserved.advancedBlocks[key];
  }
  nextBlocks['Subproducts'] = '<Subproducts></Subproducts>';
  const nextAttrs: Record<string, string> = { ...(product.shopsite.preserved.rawAttributes ?? {}) };
  delete nextAttrs[MANAGED_FAMILY_ID_ATTR];
  delete nextAttrs[MANAGED_FAMILY_MEMBERS_ATTR];
  delete nextAttrs[MANAGED_FAMILY_NAMES_ATTR];
  delete nextAttrs[MANAGED_FAMILY_PRICES_ATTR];
  delete nextAttrs[MANAGED_FAMILY_CHILD_NAMES_ATTR];
  // withAdoptedFamilyDraft stamps family-local markers (main, reviewed
  // type, retail/pack evidence) that belong to the managed relationship,
  // not the SKU. A cleared draft leaves the family explicitly — release
  // all of them so no stale managedFamilyMain/reviewedTypeHash survives
  // locally while the wire carries an empty block.
  delete nextAttrs['managedFamilyMain'];
  delete nextAttrs['reviewedTypeHash'];
  delete nextAttrs['stagedFamilyRuleVersion'];
  delete nextAttrs['retailUnit'];
  delete nextAttrs['packCountDeclared'];
  delete nextAttrs['packCount'];
  delete nextAttrs['nonFoodModel'];
  delete nextAttrs['nonFoodMaterial'];
  delete nextAttrs['nonFoodFunction'];
  delete nextAttrs['nonFoodSafetyDose'];
  delete nextAttrs['nonFoodStrength'];
  delete nextAttrs['nonFoodFit'];
  delete nextAttrs['nonFoodSizeRaw'];
  delete nextAttrs['nonFoodColorRaw'];
  delete nextAttrs['nonFoodCountRaw'];
  delete nextAttrs['nonFoodCountQuantity'];
  delete nextAttrs['nonFoodProductTypeId'];
  return {
    ...product,
    shopsite: {
      ...product.shopsite,
      preserved: {
        ...product.shopsite.preserved,
        advancedBlocks: nextBlocks,
        rawAttributes: nextAttrs,
      },
    },
  };
}

/**
 * True when the product carries an explicit reviewed clear: a present but
 * SKU-less `<Subproducts>` block. Present-and-empty is a deliberate clear;
 * absent is unmanaged preservation — never confused.
 */
export function hasExplicitSubproductsClear(product: Product): boolean {
  const raw = rawSubproductsBlock(product);
  if (raw === null) return false;
  const inner = innerOfSubproducts(raw);
  if (inner === null) return false;
  return extractNativeSkus(raw).length === 0;
}

/**
 * Count raw `<SKU>` occurrences in document order (no dedupe): drives the
 * ambiguous-duplicate verdict. `extractNativeSkus` dedupes for membership
 * comparison; this reader preserves multiplicity so double-listed members
 * refuse instead of silently collapsing.
 */
function countNativeSkuOccurrences(raw: string): Array<{ sku: string; count: number }> {
  const counts: Record<string, number> = {};
  const order: string[] = [];
  const skuRe = /<SKU\s*>([^<]*)<\/SKU\s*>/gi;
  let match: RegExpExecArray | null;
  skuRe.lastIndex = 0;
  while ((match = skuRe.exec(raw)) !== null) {
    const sku = match[1].trim();
    if (!sku) continue;
    if (!(sku in counts)) {
      counts[sku] = 0;
      order.push(sku);
    }
    counts[sku]! += 1;
  }
  return order.map((sku) => ({ sku, count: counts[sku]! }));
}

/**
 * Native member SKUs in true document order: first-occurrence order of
 * `<SKU>` in the raw block. Complements the sorted `extractNativeSkus`
 * membership reader — previews/materialization use this for display and
 * emission order so adoption preserves the store's native ordering instead
 * of silently re-sorting to SKU order.
 */
export function nativeSkusInDocumentOrder(raw: string): string[] {
  const seen: Record<string, true> = {};
  const out: string[] = [];
  const skuRe = /<SKU\s*>([^<]*)<\/SKU\s*>/gi;
  let match: RegExpExecArray | null;
  skuRe.lastIndex = 0;
  while ((match = skuRe.exec(raw)) !== null) {
    const sku = match[1].trim();
    if (sku && !seen[sku]) {
      seen[sku] = true;
      out.push(sku);
    }
  }
  return out;
}

/**
 * Supported per-stanza child metadata for one native member stanza: the
 * `<Price>` and `<Name>` values carried by the member's own `<Subproduct>`
 * stanza in the adopted block. Emitted verbatim on the managed block after
 * explicit review — never synthesized, never dropped without a refusal.
 * Returns null when the member has no stanza in the block.
 */
export interface NativeStanzaMetadata {
  sku: string;
  price: string | null;
  childName: string | null;
}
export function nativeStanzaMetadata(raw: string, sku: string): NativeStanzaMetadata | null {
  // Match each stanza separately, then filter by SKU: a single regex from
  // the first `<Subproduct>` to the target SKU would swallow earlier
  // stanzas and attribute their Price/Name to the wrong member. The final
  // stanza may lack its own closer in live native blocks (the fixture's
  // trailing stanza runs straight into `</Subproducts>`) — terminate at
  // the next stanza, the block close, or end of input instead.
  const stanzaRe = /<\s*subproduct\b[^>]*>([\s\S]*?)(?:<\/\s*subproduct\s*>|(?=<\s*subproduct\b[^>]*>)|(?=<\s*\/\s*subproducts\s*>)|$)/gi;
  let stanza: RegExpExecArray | null;
  stanzaRe.lastIndex = 0;
  while ((stanza = stanzaRe.exec(raw)) !== null) {
    const inner = stanza[1] ?? '';
    const skuMatch = inner.match(/<\s*sku\s*>([^<]*)<\/\s*sku\s*>/i);
    if (!skuMatch || skuMatch[1]!.trim() !== sku) continue;
    const priceMatch = inner.match(/<\s*price\s*>([^<]*)<\/\s*price\s*>/i);
    const nameMatch = inner.match(/<\s*name\s*>([^<]*)<\/\s*name\s*>/i);
    return {
      sku,
      price: priceMatch ? priceMatch[1]!.trim() || null : null,
      childName: nameMatch ? nameMatch[1]!.trim() || null : null,
    };
  }
  return null;
}

function extractNativeSkus(raw: string): string[] {
  const seen: Record<string, true> = {};
  const refs: string[] = [];
  const skuRe = /<SKU\s*>([^<]*)<\/SKU\s*>/gi;
  let match: RegExpExecArray | null;
  skuRe.lastIndex = 0;
  while ((match = skuRe.exec(raw)) !== null) {
    const sku = match[1].trim();
    if (sku && !seen[sku]) {
      seen[sku] = true;
      refs.push(sku);
    }
  }
  return refs.sort();
}

/**
 * Build the single managed `<Subproducts>` block for one family: every
 * member SKU (main included exactly once) as a `<Subproduct>` carrying the
 * reviewed display name plus the supported native child metadata (Price +
 * Name) verbatim. Members emit in the caller's order — adoption passes the
 * native document order so the managed block preserves it; callers that
 * need determinism pass a pre-sorted list. One block only — the encoder
 * emits this instead of any preserved raw block when opted in.
 */
export function buildManagedSubproductsXml(members: ReadonlyArray<{ sku: string; name: string; price?: string | null; childName?: string | null }>): string {
  // No silent normalization: a repeated SKU is an invalid duplicate — the
  // encoder surfaces it instead of collapsing it. Every member must appear
  // exactly once; callers pass the already-validated member set.
  const seen: Record<string, true> = {};
  const lines = ['<Subproducts>'];
  for (const m of members) {
    if (seen[m.sku]) {
      throw new Error(`family_managed_duplicate: managed Subproducts member "${m.sku}" appears more than once; each member appears exactly once.`);
    }
    seen[m.sku] = true;
    const price = typeof m.price === 'string' && m.price.trim().length > 0 ? `<Price>${escapeXml(m.price.trim())}</Price>` : '';
    const childName = typeof m.childName === 'string' && m.childName.trim().length > 0 ? `<Name>${escapeXml(m.childName.trim())}</Name>` : `<Name>${escapeXml(m.name)}</Name>`;
    lines.push(`<Subproduct><SKU>${escapeXml(m.sku)}</SKU>${childName}${price}</Subproduct>`);
  }
  lines.push('</Subproducts>');
  return lines.join('');
}

/** Marker attribute carrying aligned member prices as JSON (null = no native Price). */
export const MANAGED_FAMILY_PRICES_ATTR = 'managedFamilyMemberPrices';

/** Marker attribute carrying aligned member stanza child Names as JSON (null = fall back to member name). */
export const MANAGED_FAMILY_CHILD_NAMES_ATTR = 'managedFamilyMemberChildNames';

/**
 * Marker attribute carrying aligned member display names as JSON.
 * Kept in `preserved.rawAttributes` (never emitted on the wire).
 */
export const MANAGED_FAMILY_NAMES_ATTR = 'managedFamilyMemberNames';

/**
 * Codec-owned writer for the managed Subproducts slot (issue #368): the
 * single choke point that authors a managed block. Writes exactly one
 * canonical `Subproducts` key (drops any lowercase alias so the encoder can
 * never emit a duplicate block), stamps the managed markers, and returns
 * the updated product. Unmanaged products never pass through here — their
 * raw block is preserved byte-for-byte.
 *
 * Member order is the caller's contract: the writer emits (and records)
 * members in the given order without re-sorting, so adoption preserves the
 * native document order end-to-end (approval gates compare exact order).
 */
export function setManagedSubproducts(
  product: Product,
  familyId: string,
  members: ReadonlyArray<{ sku: string; name: string; price?: string | null; childName?: string | null }>,
): Product {
  const xml = buildManagedSubproductsXml(members);
  const nextBlocks: Record<string, string> = {};
  for (const key of Object.keys(product.shopsite.preserved.advancedBlocks ?? {})) {
    if (key.toLowerCase() === 'subproducts') continue;
    nextBlocks[key] = product.shopsite.preserved.advancedBlocks[key];
  }
  nextBlocks['Subproducts'] = xml;
  return {
    ...product,
    shopsite: {
      ...product.shopsite,
      preserved: {
        ...product.shopsite.preserved,
        advancedBlocks: nextBlocks,
        rawAttributes: {
          ...(product.shopsite.preserved.rawAttributes ?? {}),
          [MANAGED_FAMILY_ID_ATTR]: familyId,
          [MANAGED_FAMILY_MEMBERS_ATTR]: members.map((m) => m.sku).join(','),
          [MANAGED_FAMILY_NAMES_ATTR]: JSON.stringify(members.map((m) => m.name)),
          [MANAGED_FAMILY_PRICES_ATTR]: JSON.stringify(members.map((m) => m.price ?? null)),
          [MANAGED_FAMILY_CHILD_NAMES_ATTR]: JSON.stringify(members.map((m) => m.childName ?? null)),
        },
      },
    },
  };
}

/**
 * Resolve the effective Subproducts XML for encode: the managed block when
 * the product opts in, otherwise the preserved raw block (or null when
 * absent). Returns the marker family id when managed, else null.
 */
export function managedSubproductsXml(product: Product): { xml: string; familyId: string } | null {
  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  const familyId = attrs[MANAGED_FAMILY_ID_ATTR];
  const membersCsv = attrs[MANAGED_FAMILY_MEMBERS_ATTR];
  if (typeof familyId !== 'string' || familyId.length === 0) return null;
  if (typeof membersCsv !== 'string' || membersCsv.length === 0) return null;
  const parsedSkus: string[] = membersCsv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parsedSkus.length === 0) return null;
  const names = readManagedMemberNames(product);
  const prices = readManagedMemberJson(product, MANAGED_FAMILY_PRICES_ATTR);
  const childNames = readManagedMemberJson(product, MANAGED_FAMILY_CHILD_NAMES_ATTR);
  return {
    xml: buildManagedSubproductsXml(parsedSkus.map((sku, i) => ({ sku, name: names[i] ?? sku, price: prices[i] ?? null, childName: childNames[i] ?? null }))),
    familyId,
  };
}

/**
 * True when a product opts into managed family emission (marker present).
 * Used by validation to require whole-group consistency.
 */
export function isManagedFamilyProduct(product: Product): boolean {
  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  return typeof attrs[MANAGED_FAMILY_ID_ATTR] === 'string' && attrs[MANAGED_FAMILY_ID_ATTR].length > 0;
}

/**
 * Read the managed-family emission markers stamped by the managed writer:
 * the marker family id plus the member-SKU membership the encoder actually
 * emits (multiplicity-preserving — duplicates survive here so approval can
 * refuse them before the builder throws). Null when the product does not
 * opt into managed emission or the membership marker is unparseable.
 */
export function readManagedMembership(product: Product): { familyId: string; memberSkus: string[] } | null {
  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  const familyId = attrs[MANAGED_FAMILY_ID_ATTR];
  const membersCsv = attrs[MANAGED_FAMILY_MEMBERS_ATTR];
  if (typeof familyId !== 'string' || familyId.length === 0) return null;
  if (typeof membersCsv !== 'string' || membersCsv.length === 0) return null;
  const memberSkus = membersCsv.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (memberSkus.length === 0) return null;
  return { familyId, memberSkus };
}

function rawSubproductsBlock(product: Product): string | null {
  const blocks = product.shopsite?.preserved?.advancedBlocks ?? {};
  for (const tag of Object.keys(blocks)) {
    if (tag.toLowerCase() === 'subproducts') return blocks[tag];
  }
  return null;
}

function innerOfSubproducts(raw: string): string | null {
  const match = raw.match(/<\s*subproducts[^>]*>([\s\S]*)<\/\s*subproducts\s*>/i);
  return match ? match[1] ?? '' : null;
}

function readManagedMemberNames(product: Product): string[] {
  return readManagedMemberJson(product, MANAGED_FAMILY_NAMES_ATTR).filter((v): v is string => typeof v === 'string');
}

function readManagedMemberJson(product: Product, attr: string): Array<string | null> {
  const attrs = product.shopsite.preserved.rawAttributes ?? {};
  const raw = attrs[attr];
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((v) => (typeof v === 'string' ? v : null));
  } catch {
    return [];
  }
}

function escapeXml(value: string): string {
  return String(value)
    .replace(/&(?![a-zA-Z0-9#]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Extract distinct nested Subproduct SKUs referenced by a product's preserved
 * native blocks: document order, deduped. Local structural reader (pure regex
 * over preserved blocks) so this module stays cycle-free — the codec owns the
 * canonical copy; this mirrors it for managed-mesh checks without importing
 * the codec (which imports managedSubproductsXml from here).
 */
export function extractSubproductSkus(product: Product): string[] {
  const advancedBlocks: Record<string, string> = product.shopsite?.preserved?.advancedBlocks ?? {};
  const seen: Record<string, true> = {};
  const out: string[] = [];
  const skuRe = /<SKU\s*>([^<]*)<\/SKU\s*>/gi;
  for (const tag of Object.keys(advancedBlocks)) {
    if (tag.toLowerCase() !== 'subproducts') continue;
    const block = advancedBlocks[tag];
    let match: RegExpExecArray | null;
    skuRe.lastIndex = 0;
    while ((match = skuRe.exec(block)) !== null) {
      const sku = match[1].trim();
      if (sku && !seen[sku]) {
        seen[sku] = true;
        out.push(sku);
      }
    }
  }
  return out;
}
