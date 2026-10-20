import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { Product, FieldRegistryEntry } from '@/shared/types';
import { sanitizeXml } from './xml-sanitizer';
import { isValidXmlTagName, escapeCdata } from './multipart-upload';
import {
  builtInDefaultValue,
  isBuiltInOutputField,
} from './built-in-output-policy';
import {
  resolveBaseFileName,
  normalizeFileName,
  uniquifyFileNames,
  classifyBaseFileNameSource,
} from './file-name';
import { managedSubproductsXml } from './storefront-subproducts';
import { getFieldByTag } from './field-catalog';
import { hashCanonicalJson } from '../shared/stable-id';

export interface ProductCodecDecodeOptions {
  workspaceId?: string;
  existingRegistry?: FieldRegistryEntry[];
}

export interface ProductCodecDecodeResult {
  xmlVersion: string;
  products: Product[];
  registryObserved: Omit<FieldRegistryEntry, 'id'>[];
  warnings: string[];
}

export interface ProductCodecEncodeOptions {
  fileName?: string;
}

export interface ProductCodecEncodeResult {
  xml: string;
  warnings: string[];
}

export interface ProductCodecEncodeManyOptions {
  xmlVersion?: string;
  newProductTag?: string;
  uniquifyFileNames?: boolean;
}

export interface ProductCodecEncodeManyResult {
  xml: string;
  warnings: string[];
}

// ── Known Core Field Tags & Block Tags ─────────────────────────────────────────

const CORE_FIELDS = new Set([
  'SKU', 'sku', 'Name', 'name', 'Price', 'price', 'SaleAmount', 'saleAmount',
  'ProductDescription', 'description', 'Weight', 'weight',
  'Graphic', 'MoreInformationGraphic',
  'QuantityOnHand', 'quantity_on_hand', 'Quantity',
  'ProductDisabled', 'productDisabled',
  'Taxable', 'MinimumQuantity',
  'SearchKeywords', 'Availability',
  'ProductID', 'ProductGUID',
  'GoogleGTIN',
  'FileName',
]);

const BLOCK_TAGS = new Set([
  'Subproducts', 'subproducts',
  'ProductOptions', 'Options', 'options',
  'ProductOnPages', 'productOnPages',
]);

/**
 * True when a parsed top-level product node is a container rather than a leaf
 * scalar. Nested containers (e.g. QuantityPricing, CrossSell, AddToPages,
 * OptionMenus, QBImport) are preserved as RAW XML slices: stringifying them
 * would lose the block and store literal "[object Object]".
 */
function isNestedNode(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(entry => entry != null && typeof entry === 'object');
  return value != null && typeof value === 'object';
}

/**
 * Extract one top-level element's RAW source slice from a product block.
 * Depth/CDATA/comment-aware so nested same-name elements and CDATA bodies are
 * sliced exactly; repeated sibling occurrences of the same top-level tag are
 * concatenated with a newline. Returns null when the element cannot be sliced.
 */
function extractRawElementXml(xml: string, tagName: string): string | null {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const openPattern = new RegExp(`<${escaped}(?=[\\s/>])`, 'i');
  const slices: string[] = [];
  let searchFrom = 0;

  while (true) {
    const openMatch = openPattern.exec(xml.slice(searchFrom));
    if (!openMatch) break;
    const start = searchFrom + openMatch.index;
    const slice = sliceElementFrom(xml, start, tagName);
    if (!slice) break;
    slices.push(slice.text);
    searchFrom = slice.end;
  }

  return slices.length > 0 ? slices.join('\n') : null;
}

/** Scan one element's raw slice from its opening '<' to its matching '>'. */
function sliceElementFrom(
  xml: string,
  start: number,
  tagName: string,
): { text: string; end: number } | null {
  let depth = 0;
  let index = start;
  while (index < xml.length) {
    if (xml.startsWith('<![CDATA[', index)) {
      const close = xml.indexOf(']]>', index + 9);
      if (close < 0) return null;
      index = close + 3;
      continue;
    }
    if (xml.startsWith('<!--', index)) {
      const close = xml.indexOf('-->', index + 4);
      if (close < 0) return null;
      index = close + 3;
      continue;
    }
    if (xml[index] === '<') {
      const close = xml.indexOf('>', index);
      if (close < 0) return null;
      const tagText = xml.slice(index, close + 1);
      const nameMatch = tagText.match(/^<\/?\s*([A-Za-z_][\w.:-]*)/);
      if (nameMatch && nameMatch[1].toLowerCase() === tagName.toLowerCase()) {
        const isClose = tagText.startsWith('</');
        const selfClosing = /\/>$/.test(tagText);
        if (isClose) {
          depth -= 1;
          if (depth === 0) return { text: xml.slice(start, close + 1), end: close + 1 };
        } else if (selfClosing) {
          if (depth === 0) return { text: xml.slice(start, close + 1), end: close + 1 };
        } else {
          depth += 1;
        }
      }
      index = close + 1;
      continue;
    }
    index += 1;
  }
  return null;
}

/** Matches the preserved-value corruption sentinel ("[object Object]"/"[object Array]"). */
const PRESERVED_CORRUPTION_RE = /\[object (?:Object|Array)\]/;

/**
 * List preserved buckets that carry the "[object Object]" corruption sentinel
 * (defects from pre-fix decode of nested blocks). Empty when clean.
 */
export function findPreservedCorruption(product: Product): string[] {
  const found: string[] = [];
  for (const [tag, value] of Object.entries(product.shopsite?.preserved?.unknownElements ?? {})) {
    if (value != null && PRESERVED_CORRUPTION_RE.test(String(value))) {
      found.push(`unknownElements:${tag}`);
    }
  }
  for (const [tag, value] of Object.entries(product.shopsite?.preserved?.advancedBlocks ?? {})) {
    if (typeof value === 'string' && PRESERVED_CORRUPTION_RE.test(value)) {
      found.push(`advancedBlocks:${tag}`);
    }
  }
  return found;
}

/**
 * Fail-closed preflight for every ShopSite write path: a product whose
 * preserved data carries the corruption sentinel must never be encoded or
 * uploaded (dbupload is a full-record import — emitting the sentinel destroys
 * live blocks, and silently omitting one resets it to DTD defaults).
 */
export function assertNoPreservedCorruption(products: readonly Product[]): void {
  const offenders: string[] = [];
  for (const product of products) {
    const found = findPreservedCorruption(product);
    if (found.length > 0) {
      offenders.push(`${product.sku || '(no-sku)'} [${found.join(', ')}]`);
      if (offenders.length >= 5) break;
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `preserved_data_corrupted: ${offenders.length >= 5 ? 'at least 5 products' : `${offenders.length} product(s)`} carry "[object Object]" in preserved ShopSite data (${offenders.join('; ')}). ` +
      'Refusing to encode/upload corrupted drafts — repair the preserved blocks from a fresh db_xml.cgi download first.',
    );
  }
}

const KNOWN_FIELD_LABELS: Record<string, { label: string; kind: string }> = {
  SKU: { label: 'SKU', kind: 'core' },
  Name: { label: 'Product Name', kind: 'core' },
  Price: { label: 'Price', kind: 'core' },
  SaleAmount: { label: 'Sale Price', kind: 'core' },
  ProductDescription: { label: 'Description', kind: 'core' },
  Weight: { label: 'Weight', kind: 'core' },
  Graphic: { label: 'Primary Image', kind: 'core' },
  MoreInformationGraphic: { label: 'Detail Image', kind: 'core' },
  QuantityOnHand: { label: 'Quantity On Hand', kind: 'core' },
  Taxable: { label: 'Taxable', kind: 'core' },
  Availability: { label: 'Availability', kind: 'core' },
  ProductID: { label: 'ShopSite Product ID', kind: 'system' },
  ProductGUID: { label: 'ShopSite GUID', kind: 'system' },
  GTIN: { label: 'GTIN/UPC', kind: 'custom' },
  GoogleGTIN: { label: 'Google GTIN', kind: 'custom' },
  Google_GTIN: { label: 'Google GTIN (legacy)', kind: 'custom' },
  FileName: { label: 'Product Page File Name', kind: 'core' },
  ProductDisabled: { label: 'Product Disabled', kind: 'system' },
};

/**
 * Authoritative ShopSite Product Codec.
 *
 * Provides bidirectional translation between raw ShopSite XML documents
 * and canonical domain Product models. Encapsulates XML parsing, raw block
 * preservation, field registry observation, Category Page assignments,
 * and DTD-compliant XML serialization.
 */
export class ShopSiteProductCodec {
  /**
   * Decode ShopSite XML into domain Product models and field registry observations.
   */
  static decode(
    xmlText: string,
    options?: ProductCodecDecodeOptions,
  ): ProductCodecDecodeResult {
    const warnings: string[] = [];
    const workspaceId = options?.workspaceId ?? 'default';

    if (!xmlText || !xmlText.trim()) {
      return {
        xmlVersion: '15.0',
        products: [],
        registryObserved: [],
        warnings: ['Empty XML string provided to decode'],
      };
    }

    // Pass 1: Extract XML version from root element
    const versionMatch = xmlText.match(/<ShopSiteProducts[^>]*\sversion="([^"]+)"/i);
    const xmlVersion = versionMatch ? versionMatch[1] : '15.0';

    // Pass 2: Extract individual product blocks
    let productBlocks: string[] = [];
    const productRegex = /<(?:product|Product)>([\s\S]*?)<\/(?:product|Product)>/gi;
    let match: RegExpExecArray | null;
    while ((match = productRegex.exec(xmlText)) !== null) {
      productBlocks.push(match[0]);
    }

    // Fallback: If no <Product> tags exist but product fields are present, wrap the snippet
    if (productBlocks.length === 0) {
      if (
        xmlText.includes('<SKU>') ||
        xmlText.includes('<sku>') ||
        xmlText.includes('<Name>') ||
        xmlText.includes('<name>')
      ) {
        productBlocks = [`<Product>${xmlText}</Product>`];
      } else {
        warnings.push('No valid <Product> elements found in XML');
        return {
          xmlVersion,
          products: [],
          registryObserved: [],
          warnings,
        };
      }
    }

    const products: Product[] = [];
    const registryByField = new Map<string, Omit<FieldRegistryEntry, 'id'>>();
    const now = new Date().toISOString();

    for (const block of productBlocks) {
      const advancedBlocks: Record<string, string> = {};
      const fields: Record<string, string | null> = {};
      const rawUnknownElements: Record<string, unknown> = {};

      // Parse structured tags via fast-xml-parser
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        preserveOrder: false,
        trimValues: true,
        parseTagValue: false,
        isArray: () => false,
      });

      const wrapped = `<Root>${block}</Root>`;
      let parsedRoot: Record<string, unknown> | null = null;
      try {
        const parsed = parser.parse(wrapped) as Record<string, unknown>;
        parsedRoot = (parsed?.Root as Record<string, unknown>) ?? null;
      } catch {
        parsedRoot = null;
      }

      if (parsedRoot) {
        const productData = (parsedRoot.Product ?? parsedRoot.product ?? parsedRoot) as Record<string, unknown>;
        for (const [tagName, tagValue] of Object.entries(productData)) {
          if (tagName.startsWith('@_')) continue;
          if (tagName === 'Product' || tagName === 'product') continue;

          if (BLOCK_TAGS.has(tagName) || isNestedNode(tagValue)) {
            const rawSlice = extractRawElementXml(block, tagName);
            // Self-closing empties (<Subproducts/>) carry no content and were
            // never preserved; routing them to the raw bucket would make every
            // existing draft disagree with a fresh decode (false drift).
            if (rawSlice && !rawSlice.endsWith('/>')) {
              advancedBlocks[tagName] = rawSlice;
            }
            continue;
          }

          const stringValue = tagValue != null ? String(tagValue).trim() : null;
          fields[tagName] = stringValue;
          if (!CORE_FIELDS.has(tagName)) {
            rawUnknownElements[tagName] = stringValue;
          }
        }
      } else {
        // Fallback regex field extraction
        const fieldRegex = /<(\w+)>([^<]*)<\/\1>/g;
        let fm: RegExpExecArray | null;
        while ((fm = fieldRegex.exec(block)) !== null) {
          const [, tag, val] = fm;
          const trimmed = val.trim() || null;
          if (BLOCK_TAGS.has(tag)) {
            const blockRegex = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'i');
            const bMatch = block.match(blockRegex);
            if (bMatch) {
              advancedBlocks[tag] = bMatch[0];
            }
          } else {
            fields[tag] = trimmed;
            if (!CORE_FIELDS.has(tag)) {
              rawUnknownElements[tag] = trimmed;
            }
          }
        }
      }

      // Map parsed fields to domain Product model
      const sku = fields['SKU'] ?? fields['sku'] ?? '';
      const name = fields['Name'] ?? fields['name'] ?? '';
      const price = fields['Price'] ?? fields['price'] ?? null;
      const saleAmount = fields['SaleAmount'] ?? fields['saleAmount'] ?? null;
      const rawProductDescription = fields['ProductDescription'] ?? fields['description'] ?? null;
      const description = fields['MoreInformationText']
        ?? (rawProductDescription && rawProductDescription !== name ? rawProductDescription : null);
      const graphic = fields['Graphic'] ?? null;
      const moreInfoGraphic = fields['MoreInformationGraphic'] ?? null;
      const quantityRaw = fields['QuantityOnHand'] ?? fields['quantity_on_hand'] ?? fields['Quantity'] ?? null;
      const quantity = quantityRaw ? parseInt(quantityRaw, 10) : null;
      const weight = fields['Weight'] ?? fields['weight'] ?? null;
      const taxableRaw = fields['Taxable'];
      const taxable = taxableRaw ? taxableRaw.toLowerCase() === 'checked' : true;
      const availability = fields['Availability'] ?? null;
      const disabledRaw = fields['ProductDisabled'] ?? fields['productDisabled'] ?? null;
      const disabled = disabledRaw ? disabledRaw.toLowerCase() === 'checked' || disabledRaw === '1' : false;
      const productId = fields['ProductID'] ?? null;
      const productGuid = fields['ProductGUID'] ?? null;
      const rawGtin = fields['GoogleGTIN'] ?? null;
      const rawUnderscoreGtin = fields['Google_GTIN'] ?? null;
      const rawLegacyGtin = fields['GTIN'] ?? null;
      const gtin = rawGtin ?? rawUnderscoreGtin ?? rawLegacyGtin;

      // Extract custom fields (ProductField1..32 and GTIN variants)
      const customFields: Record<string, string> = {};
      for (const [tag, value] of Object.entries(fields)) {
        if (value == null) continue;
        if (tag.startsWith('ProductField')) {
          customFields[tag] = value;
        }
      }
      if (rawLegacyGtin) {
        customFields['GTIN'] = rawLegacyGtin;
      }
      if (rawGtin || rawUnderscoreGtin) {
        customFields['GoogleGTIN'] = gtin ?? '';
      }

      // Extract additional media images (MoreInfoImage1..20)
      const additionalImages: string[] = [];
      for (let i = 1; i <= 20; i++) {
        const key = `MoreInfoImage${i}`;
        const val = fields[key];
        if (val && val !== 'none') {
          additionalImages.push(val);
        }
      }

      // Collect unknown preserved elements
      const unknownElements: Record<string, unknown> = {};
      for (const [tag, value] of Object.entries(rawUnknownElements)) {
        if (
          !KNOWN_FIELD_LABELS[tag] &&
          !tag.startsWith('ProductField') &&
          !/^MoreInfoImage\d+$/.test(tag)
        ) {
          unknownElements[tag] = value;
        }
      }
      if (moreInfoGraphic && moreInfoGraphic !== 'none' && moreInfoGraphic !== graphic) {
        unknownElements['MoreInformationGraphic'] = moreInfoGraphic;
      }

      // Extract first-class Category Page assignments from <ProductOnPages>
      const rawPagesBlock = advancedBlocks['ProductOnPages']
        || advancedBlocks['productOnPages']
        || fields['ProductOnPages']
        || '';
      const productOnPages = extractPageNamesFromBlock(rawPagesBlock);

      const product: Product = {
        schemaVersion: 1,
        id: randomUUID(),
        sku,
        status: disabled ? 'draft' : 'active',
        core: {
          name,
          price,
          salePrice: saleAmount,
          description,
          inventory: {
            quantityOnHand: quantity,
            lowStockThreshold: null,
            outOfStockLimit: null,
          },
          availability,
          weight,
          taxable,
          media: {
            primary: graphic ?? moreInfoGraphic,
            additional: additionalImages,
          },
          seo: {
            fileName: fields['FileName'] || null,
            searchKeywords: fields['SearchKeywords'] ?? null,
            googleProductCategory: gtin ? 'GTIN:' + gtin : null,
          },
          productOnPages,
        },
        customFields,
        shopsite: {
          productId,
          productGuid,
          xmlVersion,
          lastPulledAt: now,
          lastRemoteHash: null,
          lastSyncedAt: null,
          source: {
            dbname: 'products',
            uniqueName: 'SKU',
          },
          preserved: {
            unknownElements,
            advancedBlocks,
            rawAttributes: {},
          },
        },
        metadata: {
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        },
      };

      products.push(product);

      // Record field registry observations
      for (const tag of Object.keys(fields)) {
        if (registryByField.has(tag)) continue;
        const known = KNOWN_FIELD_LABELS[tag];
        if (known) {
          registryByField.set(tag, {
            workspaceId,
            xmlField: tag,
            label: known.label,
            kind: known.kind,
            dataType: inferRegistryDataType(tag),
            editable: known.kind !== 'system',
            required: tag === 'SKU' || tag === 'Name',
            uiGroup: known.kind === 'core' ? 'Core' : known.kind === 'system' ? 'ShopSite' : 'Custom Fields',
            sampleValuesJson: fields[tag] ? JSON.stringify([fields[tag]]) : null,
            createdAt: now,
            updatedAt: now,
          });
        } else if (tag.startsWith('ProductField')) {
          registryByField.set(tag, {
            workspaceId,
            xmlField: tag,
            label: tag,
            kind: 'custom',
            dataType: 'string',
            editable: true,
            required: false,
            uiGroup: 'Custom Fields',
            sampleValuesJson: fields[tag] ? JSON.stringify([fields[tag]]) : null,
            createdAt: now,
            updatedAt: now,
          });
        } else {
          const catalogField = getFieldByTag(tag);
          if (catalogField) {
            registryByField.set(tag, {
              workspaceId,
              xmlField: tag,
              label: catalogField.displayName,
              kind: catalogField.category,
              dataType: mapCatalogTypeToRegistryType(catalogField.dataType),
              editable: catalogField.category !== 'system',
              required: false,
              uiGroup: catalogField.category === 'core' ? 'Core' : catalogField.category === 'system' ? 'ShopSite' : 'Custom Fields',
              sampleValuesJson: fields[tag] ? JSON.stringify([fields[tag]]) : null,
              createdAt: now,
              updatedAt: now,
            });
          }
        }
      }
    }

    return {
      xmlVersion,
      products,
      registryObserved: Array.from(registryByField.values()),
      warnings,
    };
  }

  /**
   * Convenience helper to decode a single product from XML.
   */
  static decodeOne(
    xmlText: string,
    options?: ProductCodecDecodeOptions,
  ): { product: Product; registryObserved: Omit<FieldRegistryEntry, 'id'>[]; warnings: string[] } | null {
    const res = ShopSiteProductCodec.decode(xmlText, options);
    if (res.products.length === 0) return null;
    return {
      product: res.products[0],
      registryObserved: res.registryObserved,
      warnings: res.warnings,
    };
  }

  /**
   * Encode a single domain Product model into DTD-compliant ShopSite product XML.
   */
  static encode(
    product: Product,
    options?: ProductCodecEncodeOptions,
  ): ProductCodecEncodeResult {
    const warnings: string[] = [];
    const lines: string[] = [];

    lines.push('<Product>');

    // 1. Name
    lines.push(`  <Name>${escapeXml(product.core.name)}</Name>`);

    // 2. Price / SaleAmount
    if (product.core.price != null && product.core.price !== '') {
      lines.push(`  <Price>${escapeXml(product.core.price)}</Price>`);
    }
    if (product.core.salePrice != null && product.core.salePrice !== '') {
      lines.push(`  <SaleAmount>${escapeXml(product.core.salePrice)}</SaleAmount>`);
    }

    // 3. ProductDisabled
    lines.push(`  <ProductDisabled>${product.status === 'active' ? 'uncheck' : 'checked'}</ProductDisabled>`);

    // 4. MinimumQuantity (DTD default 0)
    const minQty = product.customFields['MinimumQuantity']
      || (product.shopsite.preserved.unknownElements['MinimumQuantity'] != null
          ? String(product.shopsite.preserved.unknownElements['MinimumQuantity'])
          : builtInDefaultValue('MinimumQuantity') ?? '0');
    lines.push(`  <MinimumQuantity>${escapeXml(minQty)}</MinimumQuantity>`);

    // 5. Taxable
    lines.push(`  <Taxable>${product.core.taxable ? 'checked' : 'uncheck'}</Taxable>`);

    // 6. SKU
    lines.push(`  <SKU>${escapeXml(product.sku)}</SKU>`);

    // 7. Graphic (DTD default none)
    if (product.core.media.primary) {
      lines.push(`  <Graphic>${escapeXml(product.core.media.primary)}</Graphic>`);
    } else {
      lines.push(`  <Graphic>${builtInDefaultValue('Graphic') ?? 'none'}</Graphic>`);
    }

    // 8. SearchKeywords
    if (product.core.seo.searchKeywords) {
      const kwText = escapeCdata(product.core.seo.searchKeywords);
      if (kwText.trim().length > 0) {
        lines.push(`  <SearchKeywords><![CDATA[${kwText}]]></SearchKeywords>`);
      }
    }

    // 9. ProductDescription (echoes product name per catalog upload convention)
    if (product.core.name) {
      lines.push(`  <ProductDescription><![CDATA[${escapeCdata(product.core.name)}]]></ProductDescription>`);
    }

    // 10. Weight
    if (product.core.weight != null && product.core.weight !== '') {
      lines.push(`  <Weight>${escapeXml(product.core.weight)}</Weight>`);
    }

    // 11. ProductType (DTD default Tangible)
    const shopSiteProductType = product.customFields['ProductType']
      || (product.shopsite.preserved.unknownElements['ProductType'] != null
          ? String(product.shopsite.preserved.unknownElements['ProductType'])
          : builtInDefaultValue('ProductType') ?? 'Tangible');
    lines.push(`  <ProductType>${escapeXml(shopSiteProductType)}</ProductType>`);

    // 12. QuantityOnHand
    if (product.core.inventory.quantityOnHand != null) {
      lines.push(`  <QuantityOnHand>${product.core.inventory.quantityOnHand}</QuantityOnHand>`);
    }

    // 13. GTIN / GoogleGTIN
    const gtinValue = product.customFields['GTIN']
      || product.customFields['GoogleGTIN']
      || (product.sku && /^\d{8,14}$/.test(product.sku) ? product.sku : null);
    if (gtinValue) {
      lines.push(`  <GTIN>${escapeXml(gtinValue)}</GTIN>`);
    }
    if (product.customFields['GoogleGTIN']) {
      lines.push(`  <GoogleGTIN>${escapeXml(product.customFields['GoogleGTIN'])}</GoogleGTIN>`);
    }

    // 14. Availability
    if (product.core.availability) {
      lines.push(`  <Availability>${escapeXml(product.core.availability)}</Availability>`);
    }

    // 15. ProductOnPages (First-class Category Page assignments in modern <PageLink><Name> layout)
    const pageNames = resolveProductPageNames(product);
    if (pageNames.length > 0) {
      lines.push('  <ProductOnPages>');
      for (const pageName of pageNames) {
        lines.push('    <PageLink>');
        lines.push(`      <Name>${escapeXml(pageName)}</Name>`);
        lines.push('    </PageLink>');
      }
      lines.push('  </ProductOnPages>');
    }

    // 16. DisplayMoreInformationPage & MoreInformationText
    // The display flag is emitted for EVERY product (live store sets it on all
    // products); MoreInformationText stays gated on content.
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

    const moreInfoText = product.customFields['MoreInformationText']
      || (product.shopsite.preserved.unknownElements['MoreInformationText'] != null
          ? String(product.shopsite.preserved.unknownElements['MoreInformationText'])
          : product.core.description);
    if (moreInfoText) {
      lines.push(`  <MoreInformationText><![CDATA[${escapeCdata(moreInfoText)}]]></MoreInformationText>`);
    }

    // 17. MoreInformationGraphic
    const preservedMoreInfoGraphic = product.shopsite.preserved.unknownElements['MoreInformationGraphic'];
    if (preservedMoreInfoGraphic != null && String(preservedMoreInfoGraphic).length > 0) {
      lines.push(`  <MoreInformationGraphic>${escapeXml(String(preservedMoreInfoGraphic))}</MoreInformationGraphic>`);
    } else if (product.core.media.primary) {
      lines.push(`  <MoreInformationGraphic>${escapeXml(product.core.media.primary)}</MoreInformationGraphic>`);
    } else {
      lines.push(`  <MoreInformationGraphic>${builtInDefaultValue('MoreInformationGraphic') ?? 'none'}</MoreInformationGraphic>`);
    }

    // 18. Additional images (MoreInfoImage1..20)
    for (let i = 0; i < 20; i++) {
      const img = product.core.media.additional?.[i];
      if (img) {
        lines.push(`  <MoreInfoImage${i + 1}>${escapeXml(img)}</MoreInfoImage${i + 1}>`);
      }
    }

    // 19. FileName
    const fileName = normalizeFileName(options?.fileName) ?? resolveBaseFileName(product);
    lines.push(`  <FileName>${escapeXml(fileName)}</FileName>`);

    // 20. Custom fields ProductField1..32 in natural numeric order.
    // Issue #355: an explicit empty string is a reviewed clear, not an
    // omission — it emits `<Field></Field>` so the clear is ON THE WIRE and
    // round-trips back to '' (never resurrected from preserved/defaults).
    // Null/undefined stay omitted (no value asserted). Built-in and
    // non-ProductField slots never route through here.
    const customFieldEntries = Object.entries(product.customFields)
      .filter(([field, value]) => {
        if (value == null) return false;
        if (isBuiltInOutputField(field)) return false;
        if (!field.startsWith('ProductField')) return false;
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

    // 21. Preserved advanced blocks (excluding ProductOnPages). A managed
    // family product emits its single codec-built Subproducts block instead
    // of any preserved raw block: exactly one writer, never a duplicate.
    const managed = managedSubproductsXml(product);
    const preserved = product.shopsite.preserved;
    if (managed) {
      lines.push(`  ${managed.xml}`);
    }
    for (const [blockName, blockXml] of Object.entries(preserved.advancedBlocks)) {
      if (blockName.toLowerCase() === 'productonpages') continue;
      if (managed && blockName.toLowerCase() === 'subproducts') continue;
      if (PRESERVED_CORRUPTION_RE.test(blockXml)) {
        warnings.push(`Refusing to emit corrupted preserved block "${blockName}" (contains "[object Object]"); repair the draft before upload.`);
        continue;
      }
      lines.push(`  ${blockXml}`);
    }

    // 22. Preserved unknown elements. Managed-family markers live in
    // preserved.rawAttributes (a local-only bucket) and are never emitted
    // on the wire here — rawAttributes has no wire emitter by design.
    for (const [tag, rawValue] of Object.entries(preserved.unknownElements)) {
      if (tag.toLowerCase() === 'productonpages') continue;
      if (tag === 'GTIN' || tag === 'GoogleGTIN' || tag === 'Google_GTIN') continue;
      if (tag === 'MinimumQuantity' || tag === 'ProductDisabled' || tag === 'Availability') continue;
      if (tag === 'MoreInformationText') continue;
      if (tag === 'DisplayMoreInformationPage' || tag === 'DisplayMoreInformationPage_') continue;
      if (tag === 'MoreInformationGraphic') continue;
      if (tag === 'FileName') continue;
      // Dedicated emitter (§11) owns ProductType; re-emitting here duplicates it.
      if (tag === 'ProductType') continue;
      if (!isValidXmlTagName(tag)) {
        warnings.push(`Skipping unknown element "${tag}" because it is not a valid XML tag name.`);
        continue;
      }
      const stringVal = rawValue != null ? String(rawValue) : '';
      if (!stringVal) continue;
      if (PRESERVED_CORRUPTION_RE.test(stringVal)) {
        warnings.push(`Refusing to emit corrupted preserved value for "${tag}" (contains "[object Object]"); repair the draft before upload.`);
        continue;
      }
      lines.push(`  <${tag}>${escapeXml(stringVal)}</${tag}>`);
    }

    // 23. ShopSite record identity (last, matching live element order)
    if (product.shopsite.productId) {
      lines.push(`  <ProductID>${escapeXml(product.shopsite.productId)}</ProductID>`);
    }
    if (product.shopsite.productGuid) {
      lines.push(`  <ProductGUID>${escapeXml(product.shopsite.productGuid)}</ProductGUID>`);
    }

    lines.push('</Product>');

    const rawXml = lines.join('\n');
    return {
      xml: sanitizeXml(rawXml),
      warnings,
    };
  }

  /**
   * Encode multiple products into a complete ShopSiteProducts XML document.
   */
  static encodeMany(
    products: Product[],
    options?: ProductCodecEncodeManyOptions,
  ): ProductCodecEncodeManyResult {
    const xmlVersion = options?.xmlVersion ?? '15.0';
    const lines: string[] = [];
    const allWarnings: string[] = [];

    lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    lines.push('<!DOCTYPE ShopSiteProducts PUBLIC "-//shopsite.com//ShopSiteProduct DTD//EN" "http://www.shopsite.com/XML/2.9/shopsiteproducts.dtd">');
    lines.push(`<ShopSiteProducts version="${escapeAttr(xmlVersion)}">`);
    lines.push('<Products>');

    const uniquify = options?.uniquifyFileNames ?? true;
    const keyed = products.map((p, i) => ({ product: p, key: `${p.sku}#${i}` }));
    const baseByKey = new Map(keyed.map(k => [k.key, resolveBaseFileName(k.product)]));
    const sourceByKey = new Map(keyed.map(k => [k.key, classifyBaseFileNameSource(k.product)]));
    const uniqueNames = uniquify
      ? uniquifyFileNames(keyed.map(k => ({ key: k.key, fileName: baseByKey.get(k.key)! })))
      : null;
    // Issue #106 SEQUENCE 2d: the export net never SILENTLY repairs a kept
    // (explicit/preserved) name — a repair is emitted loudly so the
    // upstream collision gets resolved instead of masked.
    if (uniqueNames) {
      for (const { product, key } of keyed) {
        const final = uniqueNames.get(key);
        const base = baseByKey.get(key)!;
        const source = sourceByKey.get(key)!;
        if (final && final.toLowerCase() !== base.toLowerCase() && (source === 'explicit' || source === 'preserved')) {
          allWarnings.push(
            `Export uniquified FileName "${base}" to "${final}" for SKU ${product.sku} (${source} value preserved in the draft) — resolve the filename collision upstream instead of relying on export repair.`,
          );
        }
      }
    }

    for (const { product, key } of keyed) {
      const fileName = uniqueNames?.get(key);
      const res = ShopSiteProductCodec.encode(product, fileName ? { fileName } : undefined);
      lines.push(res.xml);
      allWarnings.push(...res.warnings);
    }

    lines.push('</Products>');
    lines.push('</ShopSiteProducts>');

    return {
      xml: sanitizeXml(lines.join('\n')),
      warnings: allWarnings,
    };
  }
}

// ── Page Name Extraction & Resolution ─────────────────────────────────────────

/**
 * Extract distinct page names from any <ProductOnPages> XML fragment.
 * Supports <PageLink><Name>, <Name>, <PageName>, <PageLink>, and newline-separated fallback.
 */
export function extractPageNamesFromBlock(rawXml: string): string[] {
  if (!rawXml) return [];
  const names = new Set<string>();

  const tagRegex = /<(?:Name|PageName|PageLink)>([^<]*)<\/(?:Name|PageName|PageLink)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(rawXml)) !== null) {
    let val = m[1].trim();
    if (val) {
      if (val.startsWith('<![CDATA[') && val.endsWith(']]>')) {
        val = val.slice(9, -3).trim();
      }
      val = unescapeXml(val);
      if (val) names.add(val);
    }
  }

  if (names.size === 0) {
    const cleaned = rawXml.replace(/<[^>]+>/g, '').trim();
    if (cleaned) {
      for (const line of cleaned.split(/\n+/)) {
        const trimmed = unescapeXml(line.trim());
        if (trimmed) names.add(trimmed);
      }
    }
  }

  return Array.from(names);
}


/**
 * Extract distinct nested Subproduct SKUs referenced by a product's preserved
 * native blocks (issue #363 structural consistency contract): document order,
 * deduped. Reads only the codec-owned raw slices; a reference is a structural
 * dependency, never a storefront-family claim.
 */
export function extractSubproductSkus(product: Product): string[] {
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const sku of extractSubproductSkuOccurrences(product)) {
    if (!seen[sku]) {
      seen[sku] = true;
      out.push(sku);
    }
  }
  return out;
}

/**
 * Extract nested Subproduct SKUs in document order WITH multiplicity (no
 * dedupe): drives the ambiguous-duplicate verdict. `extractSubproductSkus`
 * dedupes for membership comparison; this reader preserves repeats so a
 * double-listed member refuses instead of silently collapsing.
 */
export function extractSubproductSkuOccurrences(product: Product): string[] {
  const advancedBlocks: Record<string, string> = product.shopsite?.preserved?.advancedBlocks ?? {};
  const blocks: string[] = [];
  for (const tag of Object.keys(advancedBlocks)) {
    if (tag.toLowerCase() === 'subproducts') blocks.push(advancedBlocks[tag]);
  }
  const refs: string[] = [];
  const skuRe = /<SKU\s*>([^<]*)<\/SKU\s*>/gi;
  for (const block of blocks) {
    let match: RegExpExecArray | null;
    skuRe.lastIndex = 0;
    while ((match = skuRe.exec(block)) !== null) {
      const sku = match[1].trim();
      if (sku) refs.push(sku);
    }
  }
  return refs;
}


/**
 * Exact native-reference hash for a product: canonical digest over the sorted
 * referenced Subproduct SKUs plus the sorted raw block bytes. Combined with
 * the catalog comparison hash it pins the full write/read dependency.
 */
export function hashNativeReferences(product: Product): string {
  const advancedBlocks: Record<string, string> = product.shopsite?.preserved?.advancedBlocks ?? {};
  const blocks: string[] = [];
  for (const tag of Object.keys(advancedBlocks)) {
    if (tag.toLowerCase() === 'subproducts') blocks.push(advancedBlocks[tag].trim());
  }
  blocks.sort();
  return hashCanonicalJson({ blocks, skus: extractSubproductSkus(product) });
}
/**
 * Resolve effective page names for a Product, preferring canonical core.productOnPages.
 */
function resolveProductPageNames(product: Product): string[] {
  const names = new Set<string>();

  // 1. First-class productOnPages array
  if (product.core.productOnPages && Array.isArray(product.core.productOnPages)) {
    for (const p of product.core.productOnPages) {
      const trimmed = p?.trim();
      if (trimmed) names.add(trimmed);
    }
  }

  // 2. Fallback to preserved unknownElements (un-migrated drafts or legacy rows)
  const fromUnknown = product.shopsite.preserved.unknownElements['ProductOnPages'];
  if (fromUnknown) {
    for (const p of extractPageNamesFromBlock(String(fromUnknown))) {
      names.add(p);
    }
  }

  // 3. Fallback to preserved advancedBlocks
  const fromAdvanced = product.shopsite.preserved.advancedBlocks['ProductOnPages']
    || product.shopsite.preserved.advancedBlocks['productOnPages'];
  if (fromAdvanced) {
    for (const p of extractPageNamesFromBlock(String(fromAdvanced))) {
      names.add(p);
    }
  }

  return Array.from(names);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function inferRegistryDataType(tag: string): 'string' | 'number' | 'boolean' | 'image' {
  if (tag === 'Price' || tag === 'SaleAmount' || tag === 'Weight' || tag === 'QuantityOnHand') {
    return 'number';
  }
  if (tag.includes('Image') || tag === 'Graphic' || tag === 'MoreInformationGraphic') {
    return 'image';
  }
  if (tag === 'Taxable' || tag === 'ProductDisabled') {
    return 'boolean';
  }
  return 'string';
}

function mapCatalogTypeToRegistryType(catalogType: string): FieldRegistryEntry['dataType'] {
  switch (catalogType) {
    case 'number':
      return 'number';
    case 'checkbox':
      return 'boolean';
    case 'image':
      return 'image';
    case 'textarea':
      return 'html';
    default:
      return 'string';
  }
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

function unescapeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeAttr(str: string): string {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
