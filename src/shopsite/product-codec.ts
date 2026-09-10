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
} from './file-name';
import { getFieldByTag } from './field-catalog';

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

      // Extract raw advanced blocks
      for (const bTag of BLOCK_TAGS) {
        const blockRegex = new RegExp(`<${bTag}>[\\s\\S]*?<\\/${bTag}>`, 'i');
        const bMatch = block.match(blockRegex);
        if (bMatch) {
          advancedBlocks[bTag] = bMatch[0];
        }
      }

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

          if (BLOCK_TAGS.has(tagName)) {
            // Already preserved in advancedBlocks
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
          fields[tag] = trimmed;
          if (!CORE_FIELDS.has(tag) && !BLOCK_TAGS.has(tag)) {
            rawUnknownElements[tag] = trimmed;
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

    // 20. Custom fields ProductField1..32 in natural numeric order
    const customFieldEntries = Object.entries(product.customFields)
      .filter(([field, value]) => {
        if (!value) return false;
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

    // 21. Preserved advanced blocks (excluding ProductOnPages)
    const preserved = product.shopsite.preserved;
    for (const [blockName, blockXml] of Object.entries(preserved.advancedBlocks)) {
      if (blockName.toLowerCase() === 'productonpages') continue;
      lines.push(`  ${blockXml}`);
    }

    // 22. Preserved unknown elements
    for (const [tag, rawValue] of Object.entries(preserved.unknownElements)) {
      if (tag.toLowerCase() === 'productonpages') continue;
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
    const uniqueNames = uniquify
      ? uniquifyFileNames(keyed.map(k => ({ key: k.key, fileName: resolveBaseFileName(k.product) })))
      : null;

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
