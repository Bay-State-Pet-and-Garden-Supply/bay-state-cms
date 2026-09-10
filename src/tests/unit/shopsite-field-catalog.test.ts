import { describe, it, expect } from 'vitest';
import {
  SHOP_SITE_FIELD_CATALOG,
  SHOP_SITE_FIELD_CATALOG_VERSION,
  SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION,
  SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1,
  getFieldByTag,
  getFieldByDisplayName,
  getAllFields,
  getFieldsByCategory,
  isGovernedBuiltIn,
  getDtdDefault,
  builtInDefaultValue,
  getBuiltInOutputRule,
  isBuiltInOutputField,
  type ShopSiteFieldDefinition,
  type ShopSiteFieldType,
} from '../../shopsite/field-catalog';

describe('Authoritative ShopSite Field Catalog Module (Ticket #138)', () => {
  describe('Immutability and Provenance', () => {
    it('is versioned and runtime deep-frozen', () => {
      expect(SHOP_SITE_FIELD_CATALOG_VERSION).toBe('shopsite-field-catalog-v1');
      expect(Object.isFrozen(SHOP_SITE_FIELD_CATALOG)).toBe(true);
      for (const field of SHOP_SITE_FIELD_CATALOG) {
        expect(Object.isFrozen(field)).toBe(true);
      }
    });

    it('preserves shopsite-built-in-output-policy-v1 version and byte rules for ADR-0011 provenance', () => {
      expect(SHOP_SITE_BUILT_IN_OUTPUT_POLICY_VERSION).toBe('shopsite-built-in-output-policy-v1');
      expect(Object.isFrozen(SHOP_SITE_BUILT_IN_OUTPUT_POLICY_V1)).toBe(true);

      // Verify that all ADR-0011 built-in elements and defaults match exactly
      expect(builtInDefaultValue('MinimumQuantity')).toBe('0');
      expect(builtInDefaultValue('ProductType')).toBe('Tangible');
      expect(builtInDefaultValue('Graphic')).toBe('none');
      expect(builtInDefaultValue('MoreInformationGraphic')).toBe('none');
      expect(builtInDefaultValue('Name')).toBeNull();

      expect(isBuiltInOutputField('SearchKeywords')).toBe(true);
      expect(isBuiltInOutputField('MoreInfoImage1')).toBe(true);
      expect(isBuiltInOutputField('MoreInfoImage20')).toBe(true);
      expect(isBuiltInOutputField('ProductField1')).toBe(false);

      const priceRule = getBuiltInOutputRule('Price');
      expect(priceRule?.omission).toBe('omit-empty');
      expect(priceRule?.cardinality).toBe('zero-or-one');

      const descRule = getBuiltInOutputRule('ProductDescription');
      expect(descRule?.encoding).toBe('cdata');
    });
  });

  describe('Catalog Coverage & 11-Type System', () => {
    it('contains over 100 documented product fields across core, system, and custom categories', () => {
      const all = getAllFields();
      expect(all.length).toBeGreaterThanOrEqual(100);

      const coreFields = getFieldsByCategory('core');
      const customFields = getFieldsByCategory('custom');
      const systemFields = getFieldsByCategory('system');

      expect(coreFields.length).toBeGreaterThan(30);
      expect(customFields.length).toBeGreaterThanOrEqual(34); // ProductField1..32 + GTIN + GoogleGTIN
      expect(systemFields.length).toBeGreaterThan(0);
    });

    it('accurately represents the 11 ShopSite field types without naive string guessing', () => {
      const types = new Set<ShopSiteFieldType>();
      for (const field of getAllFields()) {
        types.add(field.dataType);
      }

      // Verify presence of documented data types
      expect(types.has('text')).toBe(true);
      expect(types.has('textarea')).toBe(true);
      expect(types.has('checkbox')).toBe(true);
      expect(types.has('number')).toBe(true);
      expect(types.has('image')).toBe(true);
      expect(types.has('popup')).toBe(true);
      expect(types.has('radio')).toBe(true);
      expect(types.has('date')).toBe(true);
      expect(types.has('url')).toBe(true);
      expect(types.has('composite')).toBe(true);
      expect(types.has('system')).toBe(true);

      // Verify specific field typing
      expect(getFieldByTag('Taxable')?.dataType).toBe('checkbox');
      expect(getFieldByTag('ProductDisabled')?.dataType).toBe('checkbox');
      expect(getFieldByTag('Price')?.dataType).toBe('number');
      expect(getFieldByTag('QuantityOnHand')?.dataType).toBe('number');
      expect(getFieldByTag('Weight')?.dataType).toBe('number');
      expect(getFieldByTag('Graphic')?.dataType).toBe('image');
      expect(getFieldByTag('MoreInformationGraphic')?.dataType).toBe('image');
      expect(getFieldByTag('ProductDescription')?.dataType).toBe('textarea');
      expect(getFieldByTag('MoreInformationText')?.dataType).toBe('textarea');
      expect(getFieldByTag('ProductType')?.dataType).toBe('popup');
      expect(getFieldByTag('DisplayAddToCart')?.dataType).toBe('popup');
      expect(getFieldByTag('ImageAlignment')?.dataType).toBe('popup');
      expect(getFieldByTag('Video')?.dataType).toBe('url');
      expect(getFieldByTag('Subproducts')?.dataType).toBe('composite');
      expect(getFieldByTag('ProductOptions')?.dataType).toBe('composite');
      expect(getFieldByTag('ProductID')?.dataType).toBe('system');
    });

    it('contains all 32 custom fields (ProductField1 through ProductField32)', () => {
      for (let i = 1; i <= 32; i++) {
        const tag = `ProductField${i}`;
        const field = getFieldByTag(tag);
        expect(field).toBeDefined();
        expect(field?.category).toBe('custom');
        expect(field?.dataType).toBe('text');
      }
    });

    it('contains all 20 MoreInfoImage slots (MoreInfoImage1 through MoreInfoImage20)', () => {
      for (let i = 1; i <= 20; i++) {
        const tag = `MoreInfoImage${i}`;
        const field = getFieldByTag(tag);
        expect(field).toBeDefined();
        expect(field?.category).toBe('core');
        expect(field?.dataType).toBe('image');
        expect(field?.omission).toBe('omit-empty');
      }
    });
  });

  describe('Query Operations & Lookup Efficiency', () => {
    it('provides fast O(1) query by XML tag name (exact and case-insensitive)', () => {
      const skuField = getFieldByTag('SKU');
      expect(skuField).toBeDefined();
      expect(skuField?.displayName).toBe('SKU');
      expect(skuField?.category).toBe('core');

      // Case-insensitive query
      const skuLower = getFieldByTag('sku');
      expect(skuLower).toBe(skuField);

      expect(getFieldByTag('NonExistentTag')).toBeNull();
    });

    it('provides query by human-readable display name', () => {
      const nameField = getFieldByDisplayName('Product Name');
      expect(nameField).toBeDefined();
      expect(nameField?.xmlTag).toBe('Name');

      const brandField = getFieldByDisplayName('Brand');
      expect(brandField).toBeDefined();

      expect(getFieldByDisplayName('Non Existent Label')).toBeNull();
    });

    it('returns DTD defaults and CDATA requirements', () => {
      expect(getDtdDefault('MinimumQuantity')).toBe('0');
      expect(getDtdDefault('ProductType')).toBe('Tangible');
      expect(getDtdDefault('Graphic')).toBe('none');
      expect(getDtdDefault('SKU')).toBeNull();

      expect(getFieldByTag('ProductDescription')?.encoding).toBe('cdata');
      expect(getFieldByTag('MoreInformationText')?.encoding).toBe('cdata');
      expect(getFieldByTag('SearchKeywords')?.encoding).toBe('cdata');
      expect(getFieldByTag('Name')?.encoding).toBe('text');
    });

    it('identifies governed built-in fields correctly', () => {
      expect(isGovernedBuiltIn('Name')).toBe(true);
      expect(isGovernedBuiltIn('Price')).toBe(true);
      expect(isGovernedBuiltIn('MinimumQuantity')).toBe(true);
      expect(isGovernedBuiltIn('MoreInfoImage5')).toBe(true);
      expect(isGovernedBuiltIn('ProductField1')).toBe(false);
      expect(isGovernedBuiltIn('ProductField16')).toBe(false);
      expect(isGovernedBuiltIn('UnknownField')).toBe(false);
    });
  });
});
