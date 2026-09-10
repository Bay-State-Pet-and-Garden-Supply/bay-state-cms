import { randomUUID } from 'node:crypto';
import type { ParsedProduct } from './product-parser';
import type { Product, FieldRegistryEntry } from '@/shared/types';

/**
 * Normalize parsed ShopSite product data into the generic Product schema.
 * Unknown fields go into `customFields` or `shopsite.preserved`.
 */
export function normalizeProduct(
  parsed: ParsedProduct,
  workspaceId: string,
  _existingRegistry?: FieldRegistryEntry[],
): { product: Product; registryObserved: Omit<FieldRegistryEntry, 'id'>[] } {
  const fields = parsed.fields;
  const now = new Date().toISOString();
  const id = randomUUID();

  const sku = fields['SKU'] ?? fields['sku'] ?? '';
  const name = fields['Name'] ?? fields['name'] ?? '';
  const price = fields['Price'] ?? fields['price'] ?? null;
  const saleAmount = fields['SaleAmount'] ?? fields['saleAmount'] ?? null;
  // Description resolution: descriptive copy lives in MoreInformationText
  // (the upload convention stores the product NAME in ProductDescription).
  // Fall back to ProductDescription for legacy exports, but never treat it as
  // a description when it merely echoes the product name.
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

  // Collect ProductField* and unknown fields
  const customFields: Record<string, string> = {};
  const observedFields: Record<string, string> = {};

  for (const [tag, value] of Object.entries(fields)) {
    if (value == null) continue;
    if (tag.startsWith('ProductField')) {
      customFields[tag] = value;
      observedFields[tag] = value;
    }
  }

  // Persist GTIN in customFields, preserving the original tag distinction
  if (rawLegacyGtin) {
    customFields['GTIN'] = rawLegacyGtin;
  }
  if (rawGtin || rawUnderscoreGtin) {
    customFields['GoogleGTIN'] = gtin ?? '';
  }

  // Build registry observations
  const registryObserved: Omit<FieldRegistryEntry, 'id'>[] = [];
  const knownFieldLabels: Record<string, { label: string; kind: string }> = {
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

  const seen = new Set<string>();
  for (const tag of Object.keys(fields)) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    const known = knownFieldLabels[tag];
    if (known) {
      registryObserved.push({
        workspaceId,
        xmlField: tag,
        label: known.label,
        kind: known.kind,
        dataType: inferDataType(tag, fields[tag]),
        editable: known.kind !== 'system',
        required: tag === 'SKU' || tag === 'Name',
        uiGroup: known.kind === 'core' ? 'Core' : known.kind === 'system' ? 'ShopSite' : 'Custom Fields',
        sampleValuesJson: fields[tag] ? JSON.stringify([fields[tag]]) : null,
        createdAt: now,
        updatedAt: now,
      });
    } else if (tag.startsWith('ProductField')) {
      registryObserved.push({
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
    }
  }

  // Collect additional images (MoreInfoImage1 to MoreInfoImage20)
  const additionalImages: string[] = [];
  for (let i = 1; i <= 20; i++) {
    const key = `MoreInfoImage${i}`;
    const val = fields[key];
    if (val && val !== 'none') {
      additionalImages.push(val);
    }
  }

  // Collect unknown preserved elements not already in customFields or MoreInfoImages
  const unknownElements: Record<string, unknown> = {};
  for (const [tag, value] of Object.entries(parsed.unknownElements)) {
    if (
      !knownFieldLabels[tag] &&
      !tag.startsWith('ProductField') &&
      !/^MoreInfoImage\d+$/.test(tag)
    ) {
      unknownElements[tag] = value;
    }
  }

  if (moreInfoGraphic && moreInfoGraphic !== 'none' && moreInfoGraphic !== graphic) {
    unknownElements['MoreInformationGraphic'] = moreInfoGraphic;
  }

  const product: Product = {
    schemaVersion: 1,
    id,
    sku,
    status: disabled ? 'draft' : 'active',
    core: {
      name,
      price,
      salePrice: saleAmount,
      description: description,
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
      productOnPages: [],
    },
    customFields,
    shopsite: {
      productId,
      productGuid,
      xmlVersion: '15.0',
      lastPulledAt: now,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: {
        dbname: 'products',
        uniqueName: 'SKU',
      },
      preserved: {
        unknownElements,
        advancedBlocks: parsed.advancedBlocks,
        rawAttributes: {},
      },
    },
    metadata: {
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    },
  };

  return { product, registryObserved };
}

function inferDataType(tag: string, _value: string | null): 'string' | 'number' | 'boolean' | 'image' {
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
