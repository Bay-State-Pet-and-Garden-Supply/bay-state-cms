import type { Product } from '@/shared/types';
import { sanitizeXml } from './xml-sanitizer';
import { isValidXmlTagName, escapeCdata } from './multipart-upload';
import {
  builtInDefaultValue,
  isBuiltInOutputField,
} from './built-in-output-policy';
import { resolveBaseFileName } from './file-name';

export interface DenormalizedResult {
  xml: string;
  warnings: string[];
}

/**
 * Denormalize a Product back into ShopSite product XML.
 * Preserves advanced blocks and unknown elements from original import.
 * Overlays changed core fields and custom fields.
 */
export function denormalizeProduct(product: Product, opts?: { fileName?: string }): DenormalizedResult {
  const warnings: string[] = [];
  const lines: string[] = [];

  lines.push('<Product>');

  // ── Element order and names mirror the LIVE ShopSite 15 products db_xml
  // export (version=15.0, DTD 2.9, 22,067-record reference download). The
  // legacy-format export (no version param) has a DIFFERENT, smaller element
  // set — never use it as the schema reference.

  lines.push(`  <Name>${escapeXml(product.core.name)}</Name>`);

  // Price / SaleAmount — omit entirely when null or empty (DTD marks both as optional)
  if (product.core.price != null && product.core.price !== '') {
    lines.push(`  <Price>${escapeXml(product.core.price)}</Price>`);
  }
  if (product.core.salePrice != null && product.core.salePrice !== '') {
    lines.push(`  <SaleAmount>${escapeXml(product.core.salePrice)}</SaleAmount>`);
  }

  // Status — ProductDisabled is a real v15 schema field (present on 21,240 of
  // 22,067 store records).
  lines.push(`  <ProductDisabled>${product.status === 'active' ? 'uncheck' : 'checked'}</ProductDisabled>`);

  // MinimumQuantity — v15 schema field (present on all store records); DTD
  // default '0' per the built-in output policy when omitted.
  const minQty = product.customFields['MinimumQuantity']
    || (product.shopsite.preserved.unknownElements['MinimumQuantity'] != null
        ? String(product.shopsite.preserved.unknownElements['MinimumQuantity'])
        : builtInDefaultValue('MinimumQuantity') ?? '0');
  lines.push(`  <MinimumQuantity>${escapeXml(minQty)}</MinimumQuantity>`);

  // Taxable
  lines.push(`  <Taxable>${product.core.taxable ? 'checked' : 'uncheck'}</Taxable>`);

  // Core identity — SKU is the dbupload uniqueName match key
  lines.push(`  <SKU>${escapeXml(product.sku)}</SKU>`);

  // Image — Graphic is always emitted (policy omission: 'always'); the DTD
  // default 'none' applies when no primary image exists.
  if (product.core.media.primary) {
    lines.push(`  <Graphic>${escapeXml(product.core.media.primary)}</Graphic>`);
  } else {
    lines.push(`  <Graphic>${builtInDefaultValue('Graphic') ?? 'none'}</Graphic>`);
  }

  // SEO - escape CDATA terminators
  if (product.core.seo.searchKeywords) {
    const kwText = escapeCdata(product.core.seo.searchKeywords);
    if (kwText.trim().length > 0) {
      lines.push(`  <SearchKeywords><![CDATA[${kwText}]]></SearchKeywords>`);
    }
  }

  // ProductDescription — per catalog upload convention, this short store-page
  // slot always carries the product NAME; descriptive copy belongs in
  // <MoreInformationText> below (renders on the product More Info page).
  if (product.core.name) {
    lines.push(`  <ProductDescription><![CDATA[${escapeCdata(product.core.name)}]]></ProductDescription>`);
  }

  // Weight — v15 schema position (after the quantity-pricing block, before
  // the shipping carrier fields).
  if (product.core.weight != null && product.core.weight !== '') {
    lines.push(`  <Weight>${escapeXml(product.core.weight)}</Weight>`);
  }

  // ShopSite <ProductType> — default to Tangible (policy DTD default) for
  // physical goods if not specified. Every record in the live store export
  // carries Tangible.
  // Note: Internal Primary Product Type (e.g. dog_food_dry) must never be mapped to ShopSite <ProductType>.
  const shopSiteProductType = product.customFields['ProductType']
    || (product.shopsite.preserved.unknownElements['ProductType'] != null
        ? String(product.shopsite.preserved.unknownElements['ProductType'])
        : builtInDefaultValue('ProductType') ?? 'Tangible');
  lines.push(`  <ProductType>${escapeXml(shopSiteProductType)}</ProductType>`);

  // QuantityOnHand
  if (product.core.inventory.quantityOnHand != null) {
    lines.push(`  <QuantityOnHand>${product.core.inventory.quantityOnHand}</QuantityOnHand>`);
  }

  // GTIN / GoogleGTIN — real v15 schema fields (GTIN present on 15,252 store
  // records), emitted in the Google-base field group per the DTD sequence.
  // GTIN falls back to the numeric SKU; GoogleGTIN only when explicit.
  const gtinValue = product.customFields['GTIN']
    || product.customFields['GoogleGTIN']
    || (product.sku && /^\d{8,14}$/.test(product.sku) ? product.sku : null);
  if (gtinValue) {
    lines.push(`  <GTIN>${escapeXml(gtinValue)}</GTIN>`);
  }
  if (product.customFields['GoogleGTIN']) {
    lines.push(`  <GoogleGTIN>${escapeXml(product.customFields['GoogleGTIN'])}</GoogleGTIN>`);
  }

  // Availability — v15 schema field (present on all store records).
  if (product.core.availability) {
    lines.push(`  <Availability>${escapeXml(product.core.availability)}</Availability>`);
  }

  // ProductOnPages — v15 structure: PageLink children with Name elements.
  const pageNames = extractPageNames(product);
  if (pageNames.length > 0) {
    lines.push(`  <ProductOnPages>`);
    for (const pageName of pageNames) {
      lines.push(`    <PageLink>`);
      lines.push(`      <Name>${escapeXml(pageName)}</Name>`);
      lines.push(`    </PageLink>`);
    }
    lines.push(`  </ProductOnPages>`);
  }

  // DisplayMoreInformationPage — v15 element name (no trailing underscore);
  // precedes MoreInformationText. Auto-enabled whenever descriptive copy
  // ships, unless an explicit custom/preserved value opts out.
  const moreInfoText = product.customFields['MoreInformationText']
    || (product.shopsite.preserved.unknownElements['MoreInformationText'] != null
        ? String(product.shopsite.preserved.unknownElements['MoreInformationText'])
        : product.core.description);
  if (moreInfoText) {
    const displayFlagRaw = product.customFields['DisplayMoreInformationPage']
      ?? product.customFields['DisplayMoreInformationPage_']
      ?? (product.shopsite.preserved.unknownElements['DisplayMoreInformationPage'] != null
          ? String(product.shopsite.preserved.unknownElements['DisplayMoreInformationPage'])
          : (product.shopsite.preserved.unknownElements['DisplayMoreInformationPage_'] != null
              ? String(product.shopsite.preserved.unknownElements['DisplayMoreInformationPage_'])
              : null));
    const displayDisabled = ['uncheck', 'unchecked', 'no', '0', 'false']
      .includes((displayFlagRaw ?? '').trim().toLowerCase());
    lines.push(`  <DisplayMoreInformationPage>${displayDisabled ? 'uncheck' : 'checked'}</DisplayMoreInformationPage>`);
    lines.push(`  <MoreInformationText><![CDATA[${escapeCdata(moreInfoText)}]]></MoreInformationText>`);
  }

  // MoreInformationGraphic — always emitted (DTD default 'none'); a preserved
  // store value wins over the primary image fallback.
  const preservedMoreInfoGraphic = product.shopsite.preserved.unknownElements['MoreInformationGraphic'];
  if (preservedMoreInfoGraphic != null && String(preservedMoreInfoGraphic).length > 0) {
    lines.push(`  <MoreInformationGraphic>${escapeXml(String(preservedMoreInfoGraphic))}</MoreInformationGraphic>`);
  } else if (product.core.media.primary) {
    lines.push(`  <MoreInformationGraphic>${escapeXml(product.core.media.primary)}</MoreInformationGraphic>`);
  } else {
    lines.push(`  <MoreInformationGraphic>${builtInDefaultValue('MoreInformationGraphic') ?? 'none'}</MoreInformationGraphic>`);
  }

  // Additional images — v15 schema exposes 20 More Info image slots.
  for (let i = 0; i < 20; i++) {
    const img = product.core.media.additional?.[i];
    if (img) {
      lines.push(`  <MoreInfoImage${i + 1}>${escapeXml(img)}</MoreInfoImage${i + 1}>`);
    }
  }

  // FileName — product detail HTML page name. Precedence: explicit
  // override (batch uniquification) → explicit customField / preserved
  // import value → persisted per-source-URL slug → slugged draft name
  // (see shopsite/file-name.ts; issue #107). Resolution is normalized:
  // blank or extensionless stored values fall through instead of exporting
  // raw, so export, validation, and uniquification always agree.
  const fileName = opts?.fileName?.trim() ? opts.fileName : resolveBaseFileName(product);
  lines.push(`  <FileName>${escapeXml(fileName)}</FileName>`);

  // ProductField mappings from customFields - validate tag names. Custom
  // ProductField* values are NOT ShopSite built-ins (issue #17 J): they stay
  // on classification mapping/serialization, and the immutable built-in
  // output policy governs only the DTD fields above. The live store defines
  // ProductField1-32; emitted in numeric order at the store's canonical
  // position (after QBImport).
  const customFieldEntries = Object.entries(product.customFields)
    .filter(([field, value]) => {
      if (!value) return false;
      if (isBuiltInOutputField(field)) return false; // governed by the policy, not custom serialization
      if (!field.startsWith('ProductField')) return false; // only store custom fields serialize here (GTIN etc. are governed above)
      if (!isValidXmlTagName(field)) {
        warnings.push(`Skipping custom field "${field}" because it is not a valid XML tag name.`);
        return false;
      }
      return true;
    })
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  for (const [field, value] of customFieldEntries) {
    lines.push(`  <${field}>${escapeXml(value)}</${field}>`);
  }

  // Preserved advanced blocks — skip ProductOnPages (handled above with proper PageLink/Name tags)
  const preserved = product.shopsite.preserved;
  for (const [blockName, blockXml] of Object.entries(preserved.advancedBlocks)) {
    if (blockName === 'ProductOnPages') continue;
    if (blockName === 'productOnPages') continue;
    lines.push(`  ${blockXml}`);
  }

  // Preserved unknown elements - validate tag names. Skips: ProductOnPages
  // (handled above), GTIN/GoogleGTIN variants + MinimumQuantity +
  // ProductDisabled + Availability (governed fields already emitted),
  // MoreInformationText / DisplayMoreInformationPage (both variants) /
  // MoreInformationGraphic / FileName (handled above).
  for (const [tag, rawValue] of Object.entries(preserved.unknownElements)) {
    if (tag === 'ProductOnPages') continue;
    if (tag === 'GTIN' || tag === 'GoogleGTIN' || tag === 'Google_GTIN') continue;
    if (tag === 'MinimumQuantity' || tag === 'ProductDisabled' || tag === 'Availability') continue;
    if (tag === 'MoreInformationText') continue;
    if (tag === 'DisplayMoreInformationPage' || tag === 'DisplayMoreInformationPage_') continue;
    if (tag === 'MoreInformationGraphic') continue;
    if (tag === 'FileName') continue;
    if (!isValidXmlTagName(tag)) {
      warnings.push(`Skipping unknown element "${tag}" because it is not a valid XML tag name.`);
      continue;
    }
    const stringVal = rawValue != null ? String(rawValue) : '';
    if (stringVal) {
      lines.push(`  <${tag}>${escapeXml(stringVal)}</${tag}>`);
    }
  }

  lines.push('</Product>');

  const rawXml = lines.join('\n');

  return {
    xml: sanitizeXml(rawXml),
    warnings,
  };
}

/**
 * Extract page names from any preserved ProductOnPages source and normalize them.
 * Handles multiple tag variants (Name, PageName, PageLink) to produce DTD-compliant output.
 */
function extractPageNames(product: Product): string[] {
  const names = new Set<string>();
  const preserved = product.shopsite.preserved;

  // 1. Check unknownElements (set by draft-promoter)
  const fromUnknown = preserved.unknownElements['ProductOnPages'];
  if (fromUnknown) {
    const raw = String(fromUnknown);
    // Extract from <Name>, <PageName>, or <PageLink> tags
    const tagRegex = /<(?:Name|PageName|PageLink)>([^<]*)<\/(?:Name|PageName|PageLink)>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(raw)) !== null) {
      const name = m[1].trim();
      if (name) names.add(name);
    }
    // Fallback: if no tags matched but there's text, try splitting by newlines
    if (names.size === 0) {
      const cleaned = raw.replace(/<[^>]+>/g, '').trim();
      if (cleaned) {
        for (const line of cleaned.split(/\n+/)) {
          const trimmed = line.trim();
          if (trimmed) names.add(trimmed);
        }
      }
    }
  }

  // 2. Check advancedBlocks (from original ShopSite import)
  const fromAdvanced = preserved.advancedBlocks['ProductOnPages'] || preserved.advancedBlocks['productOnPages'];
  if (fromAdvanced) {
    const tagRegex = /<(?:Name|PageName|PageLink)>([^<]*)<\/(?:Name|PageName|PageLink)>/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRegex.exec(fromAdvanced)) !== null) {
      const name = m[1].trim();
      if (name) names.add(name);
    }
    // Fallback: extract product page references from raw elements
    if (names.size === 0) {
      const elemRegex = /<\w+[^>]*>([^<]+)<\/\w+>/g;
      let em: RegExpExecArray | null;
      while ((em = elemRegex.exec(fromAdvanced)) !== null) {
        const val = em[1].trim();
        if (val && !val.startsWith('<?') && !val.startsWith('<')) names.add(val);
      }
    }
  }

  return Array.from(names);
}

function escapeXml(str: unknown): string {
  if (str == null) return '';
  return String(str)
    .replace(/&(?!#(?:[0-9]+|x[0-9a-fA-F]+);|[a-zA-Z0-9]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
