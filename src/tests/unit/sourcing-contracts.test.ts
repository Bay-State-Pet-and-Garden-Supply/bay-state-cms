import { describe, test, expect } from 'vitest';
import {
  normalizeGtin,
  normalizeLookupIdentifier,
  isSourcingConnectorType,
  SOURCING_CONNECTOR_TYPES,
  isIdentityCriticalField,
  parseSourcingLookupResult,
  normalizeVariantAxis,
  normalizeDeclaredVariantAxis,
  isUnknownVariantAxis,
  declareConnectorVariantAxes,
  declaredVariantAxisNames,
  MAX_CONNECTOR_VARIANT_AXES,
} from '../../onboarding/sourcing/contracts';
import {
  DistributorConnectorTypeEnum,
  DistributorConnectionConfigurationSchema,
  InsertDistributorConnectionSchema,
  ResolveConflictRequestSchema,
} from '../../shared/schemas/distributor';
import * as DistributorSchemas from '../../shared/schemas/distributor';
import {
  EvidenceAttemptSchema,
  InsertEvidenceAttempt,
  ProductEvidenceLookupResultSchema,
} from '../../shared/schemas/distributor-evidence';
import {
  SourcingDecisionV2Schema,
  SourcingDecisionReadSchema,
  LegacySourcingDecisionSchema,
  CreatableSourcingDecisionSchema,
} from '../../shared/schemas/onboarding';

describe('Sourcing contracts — identifier normalization (ADR 0014 UPC/GTIN-first)', () => {
  test('normalizeGtin accepts 8-14 digit barcodes with formatting stripped', () => {
    expect(normalizeGtin('012345678905')).toBe('012345678905'); // UPC-A
    expect(normalizeGtin('0 12345 67890 5')).toBe('012345678905');
    expect(normalizeGtin('0123456789012')).toBe('0123456789012'); // EAN-13
    expect(normalizeGtin('96385074')).toBe('96385074'); // EAN-8
    expect(normalizeGtin(123456789012)).toBe('123456789012'); // numeric input
  });

  test('SourcingLookupRequest cannot express a brand-only lookup (type + guard)', () => {
    // normalizeLookupIdentifier is the runtime guard: without a UPC/GTIN
    // that normalizes to 8-14 digits there is NO identifier to look up.
    expect(normalizeLookupIdentifier('012345678905')).toBe('012345678905');
    expect(normalizeLookupIdentifier(null, '0123456789012')).toBe('0123456789012');
    expect(normalizeLookupIdentifier('')).toBeNull();
    expect(normalizeLookupIdentifier(null)).toBeNull();
    expect(normalizeLookupIdentifier('brand-only')).toBeNull();
    // The engine request requires a non-null `upc: string` — a brand-only
    // call is not expressible at the type level either (upc is required).
  });
});

describe('Sourcing contracts — connector result validation fails closed (ADR 0014)', () => {
  const validFound = {
    outcome: 'found',
    record: {
      matchedIdentifier: '012345678905',
      distributorUpc: '012345678905',
      gtin: null,
      distributorSku: null,
      name: 'Dog Food 12 lb',
      description: null,
      brand: 'Nutro',
      manufacturerPartNumber: 'MPN-1',
      weight: '12 lb',
      features: [],
      category: null,
      dimensions: null,
      casePack: null,
      unitOfMeasure: null,
      ingredients: null,
      attributes: { size: '12 lb' },
      imageUrls: [],
      sourceUrl: null,
      catalogVersion: null,
      observedAt: '2026-08-13T00:00:00.000Z',
      expiresAt: null,
    },
    matchedFields: ['upc'],
    warnings: [],
  };

  test('valid found/not_stocked/source_error results pass validation', () => {
    expect(parseSourcingLookupResult(validFound)?.outcome).toBe('found');
    expect(parseSourcingLookupResult({ outcome: 'not_stocked', reason: 'no match' })?.outcome).toBe('not_stocked');
    expect(
      parseSourcingLookupResult({ outcome: 'source_error', code: 'timeout', message: 'timed out' })?.outcome,
    ).toBe('source_error');
  });

  test('malformed found results fail closed (never become evidence)', () => {
    // Un-normalized identifier (spaces/check-formatting not stripped)
    expect(
      parseSourcingLookupResult({
        ...validFound,
        record: { ...validFound.record, matchedIdentifier: '0123 4567 8905' },
      }),
    ).toBeNull();
    // Out-of-range identifier
    expect(
      parseSourcingLookupResult({
        ...validFound,
        record: { ...validFound.record, matchedIdentifier: '1234567' },
      }),
    ).toBeNull();
    // Missing record entirely
    expect(parseSourcingLookupResult({ outcome: 'found', matchedFields: [], warnings: [] })).toBeNull();
    // Unknown outcome
    expect(parseSourcingLookupResult({ outcome: 'maybe', record: validFound.record })).toBeNull();
    // Missing required record fields
    expect(
      parseSourcingLookupResult({
        outcome: 'found',
        record: { ...validFound.record, observedAt: undefined },
      }),
    ).toBeNull();
  });

  test('malformed not_stocked/source_error fail closed', () => {
    expect(parseSourcingLookupResult({ outcome: 'not_stocked' })).not.toBeNull();
    expect(parseSourcingLookupResult({ outcome: 'not_stocked', reason: 42 })).toBeNull();
    expect(parseSourcingLookupResult({ outcome: 'source_error', code: 'timeout' })).toBeNull(); // missing message
  });
});

describe('Sourcing contracts — closed connector set', () => {
  test('SOURCING_CONNECTOR_TYPES is exactly the ADR 0014 + Amendment B closed set', () => {
    expect([...SOURCING_CONNECTOR_TYPES].sort()).toEqual(
      ['api', 'csv', 'ftp_catalog', 'html_scraper', 'legacy_adapter'].sort(),
    );
  });

  test('isSourcingConnectorType rejects unknown/legacy-open values', () => {
    expect(isSourcingConnectorType('api')).toBe(true);
    expect(isSourcingConnectorType('ftp_catalog')).toBe(true);
    expect(isSourcingConnectorType('csv')).toBe(true);
    expect(isSourcingConnectorType('html_scraper')).toBe(true);
    expect(isSourcingConnectorType('legacy_adapter')).toBe(true);
    expect(isSourcingConnectorType('edi_832')).toBe(false);
    expect(isSourcingConnectorType('browser_scraper')).toBe(false);
    expect(isSourcingConnectorType('anything')).toBe(false);
  });

  test('DistributorConnectorTypeEnum is closed in the shared schema too', () => {
    expect(DistributorConnectorTypeEnum.safeParse('api').success).toBe(true);
    expect(DistributorConnectorTypeEnum.safeParse('html_scraper').success).toBe(true);
    expect(DistributorConnectorTypeEnum.safeParse('legacy_adapter').success).toBe(true);
    expect(DistributorConnectorTypeEnum.safeParse('central_edi').success).toBe(false);
    expect(DistributorConnectorTypeEnum.safeParse('browser_scraper').success).toBe(false);
  });
});

describe('Sourcing contracts — secret-shaped configuration fails closed (ADR 0014)', () => {
  test('top-level credential keys are rejected', () => {
    for (const bad of [
      { password: 'hunter2' },
      { api_key: 'k' },
      { token: 't' },
      { client_secret: 's' },
      { private_key: 'pk' },
      { authorization: 'Bearer x' },
    ]) {
      const res = DistributorConnectionConfigurationSchema.safeParse(bad);
      expect(res.success).toBe(false);
    }
  });

  test('nested credential keys are rejected recursively', () => {
    const res = DistributorConnectionConfigurationSchema.safeParse({
      baseUrl: 'https://api.example.com',
      auth: { clientId: 'ok', clientSecret: 'super-secret' },
      headers: { 'X-API-Key': 'abc' },
    });
    expect(res.success).toBe(false);
    // Non-secret sibling values are fine; only the credential-shaped nodes fail.
  });

  test('credential-bearing values and userinfo URLs are rejected', () => {
    expect(
      DistributorConnectionConfigurationSchema.safeParse({
        baseUrl: 'https://user:pass@api.example.com',
      }).success,
    ).toBe(false);
    expect(
      DistributorConnectionConfigurationSchema.safeParse({
        baseUrl: 'https://api.example.com',
        pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
      }).success,
    ).toBe(false);
    expect(
      DistributorConnectionConfigurationSchema.safeParse({
        env: 'PASSWORD=abc123',
      }).success,
    ).toBe(false);
  });

  test('single-component userinfo, Bearer, and Basic values are rejected', () => {
    expect(
      DistributorConnectionConfigurationSchema.safeParse({
        baseUrl: 'https://token@api.example.com',
      }).success,
    ).toBe(false);
    expect(
      DistributorConnectionConfigurationSchema.safeParse({
        authHeader: 'Bearer eyJhbGciOiJIUzI1NiJ9.token',
      }).success,
    ).toBe(false);
    expect(
      DistributorConnectionConfigurationSchema.safeParse({
        authHeader: 'Basic dXNlcjpwYXNz',
      }).success,
    ).toBe(false);
  });

  test('benign non-secret configuration passes', () => {
    expect(
      DistributorConnectionConfigurationSchema.safeParse({
        baseUrl: 'https://api.example.com',
        catalogPath: '/exports/products',
        fieldMap: { upc: 'xp.UPC', brand: 'xp.Brand' },
        pageSize: 100,
      }).success,
    ).toBe(true);
  });

  test('InsertDistributorConnectionSchema rejects credential-shaped configuration', () => {
    const res = InsertDistributorConnectionSchema.safeParse({
      workspaceId: 'w1',
      distributorId: 'd1',
      connectorType: 'api',
      configuration: { apiKey: 'secret-value' },
    });
    expect(res.success).toBe(false);
  });
});

describe('Sourcing contracts — identity conflict authority', () => {
  test('IDENTITY_CRITICAL_FIELDS covers exact identifier/pack/variant fields', () => {
    for (const field of ['upc', 'gtin', 'manufacturerPartNumber', 'weight', 'size', 'count', 'packCount', 'brand']) {
      expect(isIdentityCriticalField(field)).toBe(true);
    }
    expect(isIdentityCriticalField('description')).toBe(false);
    expect(isIdentityCriticalField('name')).toBe(false);
  });

  test('flavor and formula are hard identity fields (Amendment A)', () => {
    expect(isIdentityCriticalField('flavor')).toBe(true);
    expect(isIdentityCriticalField('formula')).toBe(true);
  });
});

describe('Sourcing contracts — variant axis registry (Amendment A)', () => {
  test('normalizeVariantAxis maps built-in axes and common spellings', () => {
    expect(normalizeVariantAxis('size')).toBe('size');
    expect(normalizeVariantAxis('count')).toBe('count');
    expect(normalizeVariantAxis('packCount')).toBe('packCount');
    expect(normalizeVariantAxis('Pack Count')).toBe('packCount');
    expect(normalizeVariantAxis('pack_count')).toBe('packCount');
    expect(normalizeVariantAxis('pack-count')).toBe('packCount');
    expect(normalizeVariantAxis('flavor')).toBe('flavor');
    expect(normalizeVariantAxis('flavour')).toBe('flavor');
    expect(normalizeVariantAxis('formula')).toBe('formula');
    expect(normalizeVariantAxis('')).toBeNull();
    expect(normalizeVariantAxis('scent')).toBeNull();
  });

  test('normalizeDeclaredVariantAxis bounds and normalizes connector declarations', () => {
    expect(normalizeDeclaredVariantAxis('serving size')).toBe('serving size');
    expect(normalizeDeclaredVariantAxis('  Serving_Size  ')).toBe('serving size');
    expect(normalizeDeclaredVariantAxis('pack count')).toBe('packCount'); // built-in alias wins
    expect(normalizeDeclaredVariantAxis('')).toBeNull();
    expect(normalizeDeclaredVariantAxis('x'.repeat(65))).toBeNull();
  });

  test('isUnknownVariantAxis flags undeclared axes and accepts built-in/declared ones', () => {
    expect(isUnknownVariantAxis('scent')).toBe(true);
    expect(isUnknownVariantAxis('scent', ['scent'])).toBe(false);
    expect(isUnknownVariantAxis('size')).toBe(false);
    expect(isUnknownVariantAxis('size', ['flavor'])).toBe(false);
    expect(isUnknownVariantAxis('scent', ['servingSize'])).toBe(true);
  });

  test('declareConnectorVariantAxes builds a deterministic rawField → normalizedAxis registry', () => {
    const declarations = declareConnectorVariantAxes(['Scent', 'serving_size', 'pack count', 'Flavor']);
    const byAxis = Object.fromEntries(declarations.map((d) => [d.normalizedAxis, d.rawField]));
    // Built-in alias 'pack count' normalizes to packCount; 'Flavor' normalizes to flavor.
    expect(byAxis['packCount']).toBe('pack count');
    expect(byAxis['flavor']).toBe('Flavor');
    expect(byAxis['scent']).toBe('Scent');
    expect(byAxis['serving size']).toBe('serving_size');
    // Sorted by normalizedAxis, deterministic across input orderings.
    const reversed = declareConnectorVariantAxes(['Flavor', 'pack count', 'serving_size', 'Scent']);
    expect(declarations).toEqual(reversed);
  });

  test('declareConnectorVariantAxes dedupes by normalized axis and bounds the registry', () => {
    const dupes = declareConnectorVariantAxes(['scent', 'SCENT', 'Scent', 'pack count', 'packCount', 'pack_count']);
    expect(new Set(dupes.map((d) => d.normalizedAxis)).size).toBe(dupes.length);
    const axes = dupes.map((d) => d.normalizedAxis);
    expect(axes.filter((a) => a === 'scent').length).toBe(1);
    expect(axes.filter((a) => a === 'packCount').length).toBe(1);
    // Invalid declarations are dropped; the registry stays bounded.
    expect(declareConnectorVariantAxes([''])).toEqual([]);
    expect(declareConnectorVariantAxes(['x'.repeat(65)])).toEqual([]);
    const many = declareConnectorVariantAxes(Array.from({ length: 40 }, (_, i) => `axis_${i}`));
    expect(many.length).toBeLessThanOrEqual(MAX_CONNECTOR_VARIANT_AXES);
  });

  test('declaredVariantAxisNames returns sorted normalized axes', () => {
    const declarations = declareConnectorVariantAxes(['scent', 'serving_size', 'Flavor']);
    expect(declaredVariantAxisNames(declarations)).toEqual(['flavor', 'scent', 'serving size']);
    expect(declaredVariantAxisNames([])).toEqual([]);
  });

  test('EvidenceAttemptSchema validates variantAxisDeclarations (unique normalized axes, bounded)', () => {
    const base = {
      id: 'a1',
      itemId: 'item-1',
      providerId: 'phillips',
      lookupUpc: '012345678901',
      outcome: 'found' as const,
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: [],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    const ok = EvidenceAttemptSchema.safeParse({
      ...base,
      variantAxisDeclarations: [
        { rawField: 'Scent', normalizedAxis: 'scent' },
        { rawField: 'serving_size', normalizedAxis: 'serving size' },
      ],
    });
    expect(ok.success).toBe(true);
    // Duplicate normalized axis fails.
    const dup = EvidenceAttemptSchema.safeParse({
      ...base,
      variantAxisDeclarations: [
        { rawField: 'Scent', normalizedAxis: 'scent' },
        { rawField: 'SCENT2', normalizedAxis: 'scent' },
      ],
    });
    expect(dup.success).toBe(false);
    // Bounded at 16.
    const many = EvidenceAttemptSchema.safeParse({
      ...base,
      variantAxisDeclarations: Array.from({ length: 17 }, (_, i) => ({ rawField: `f${i}`, normalizedAxis: `axis${i}` })),
    });
    expect(many.success).toBe(false);
    // Empty rawField fails.
    const emptyRaw = EvidenceAttemptSchema.safeParse({
      ...base,
      variantAxisDeclarations: [{ rawField: '', normalizedAxis: 'scent' }],
    });
    expect(emptyRaw.success).toBe(false);
    // rawField bounded at 256: 257 chars fails, 256 parses.
    const tooLongRaw = EvidenceAttemptSchema.safeParse({
      ...base,
      variantAxisDeclarations: [{ rawField: 'x'.repeat(257), normalizedAxis: 'scent' }],
    });
    expect(tooLongRaw.success).toBe(false);
    const maxRaw = EvidenceAttemptSchema.safeParse({
      ...base,
      variantAxisDeclarations: [{ rawField: 'x'.repeat(256), normalizedAxis: 'scent' }],
    });
    expect(maxRaw.success).toBe(true);
    // normalizedAxis must be canonical: 'Scent' (non-canonical) fails;
    // 'scent' passes. This keeps uniqueness meaningful across spellings.
    const nonCanonical = EvidenceAttemptSchema.safeParse({
      ...base,
      variantAxisDeclarations: [{ rawField: 'Scent', normalizedAxis: 'Scent' }],
    });
    expect(nonCanonical.success).toBe(false);
    const canonical = EvidenceAttemptSchema.safeParse({
      ...base,
      variantAxisDeclarations: [{ rawField: 'Scent', normalizedAxis: 'scent' }],
    });
    expect(canonical.success).toBe(true);
  });

  test('canonical built-in axes parse; noncanonical aliases are rejected', () => {
    const base = {
      id: 'a1',
      itemId: 'item-1',
      providerId: 'phillips',
      lookupUpc: '012345678901',
      outcome: 'found' as const,
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: [],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-08-13T00:00:00.000Z',
    };
    // Canonical built-in normalized axes all parse.
    for (const axis of ['size', 'count', 'packCount', 'flavor', 'formula']) {
      const result = EvidenceAttemptSchema.safeParse({
        ...base,
        variantAxisDeclarations: [{ rawField: 'whatever', normalizedAxis: axis }],
      });
      expect(result.success).toBe(true);
    }
    // Noncanonical alias spellings fail (canonical form is required so the
    // uniqueness refine is meaningful across spellings).
    for (const alias of ['pack count', 'pack_count', 'pack-count', 'flavour']) {
      const result = EvidenceAttemptSchema.safeParse({
        ...base,
        variantAxisDeclarations: [{ rawField: 'whatever', normalizedAxis: alias }],
      });
      expect(result.success).toBe(false);
    }
  });

  test('declareConnectorVariantAxes output round-trips through EvidenceAttemptSchema', () => {
    // The registry emits canonical normalizedAxis values (built-in aliases
    // collapse to their canonical axes). The evidence schema must accept
    // exactly what the registry emits (the mirror-drift bug 49ce3e65).
    const declarations = declareConnectorVariantAxes(['pack count', 'flavour', 'scent']);
    expect(declaredVariantAxisNames(declarations)).toEqual(['flavor', 'packCount', 'scent']);
    const result = EvidenceAttemptSchema.safeParse({
      id: 'a1',
      itemId: 'item-1',
      providerId: 'phillips',
      lookupUpc: '012345678901',
      outcome: 'found' as const,
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: [],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-08-13T00:00:00.000Z',
      variantAxisDeclarations: declarations,
    });
    expect(result.success).toBe(true);
  });
});

describe('Sourcing decision V2 route matrix (Amendment A)', () => {
  const v2Base = {
    schemaVersion: 2,
    origin: 'automatic_policy',
    acceptedEvidenceAttemptIds: ['a1'],
    providerIds: ['phillips'],
    sourcingGenerationId: 'g1',
    decidedAt: '2026-08-13T00:00:00.000Z',
  };

  test('distributor_record_to_extraction requires hash, source type, attempts, and extraction target', () => {
    const ok = SourcingDecisionV2Schema.safeParse({
      ...v2Base,
      route: 'distributor_record_to_extraction',
      evidenceHash: 'a'.repeat(64),
      sourceType: 'distributor_record',
      target: 'extraction',
    });
    expect(ok.success).toBe(true);
    // Missing evidence hash.
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'distributor_record_to_extraction',
        sourceType: 'distributor_record',
        target: 'extraction',
      }).success,
    ).toBe(false);
    // Wrong target.
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'distributor_record_to_extraction',
        evidenceHash: 'a'.repeat(64),
        sourceType: 'distributor_record',
        target: 'discovery',
      }).success,
    ).toBe(false);
    // Wrong source type.
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'distributor_record_to_extraction',
        evidenceHash: 'a'.repeat(64),
        sourceType: 'official_page',
        target: 'extraction',
      }).success,
    ).toBe(false);
    // Empty accepted attempts.
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'distributor_record_to_extraction',
        acceptedEvidenceAttemptIds: [],
        evidenceHash: 'a'.repeat(64),
        sourceType: 'distributor_record',
        target: 'extraction',
      }).success,
    ).toBe(false);
    // Non-canonical hash shape.
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'distributor_record_to_extraction',
        evidenceHash: 'XYZ',
        sourceType: 'distributor_record',
        target: 'extraction',
      }).success,
    ).toBe(false);
  });

  test('evidence_to_discovery requires ≥1 unique accepted attempt and the discovery target', () => {
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'evidence_to_discovery',
        sourceType: 'official_page',
        target: 'discovery',
      }).success,
    ).toBe(true);
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'evidence_to_discovery',
        acceptedEvidenceAttemptIds: [],
        sourceType: 'official_page',
        target: 'discovery',
      }).success,
    ).toBe(false);
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'evidence_to_discovery',
        acceptedEvidenceAttemptIds: ['a1', 'a1'],
        sourceType: 'official_page',
        target: 'discovery',
      }).success,
    ).toBe(false);
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'evidence_to_discovery',
        sourceType: 'official_page',
        target: 'extraction',
      }).success,
    ).toBe(false);
  });

  test('fallback requires zero accepted attempts; degraded keeps error providers', () => {
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'fallback_to_discovery',
        acceptedEvidenceAttemptIds: [],
        providerIds: [],
        sourceType: 'official_page',
        target: 'discovery',
      }).success,
    ).toBe(true);
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'fallback_to_discovery',
        acceptedEvidenceAttemptIds: ['a1'],
        sourceType: 'official_page',
        target: 'discovery',
      }).success,
    ).toBe(false);
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'degraded_fallback_to_discovery',
        acceptedEvidenceAttemptIds: [],
        providerIds: ['phillips'],
        sourceType: 'official_page',
        target: 'discovery',
      }).success,
    ).toBe(true);
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'degraded_fallback_to_discovery',
        acceptedEvidenceAttemptIds: [],
        providerIds: [],
        sourceType: 'official_page',
        target: 'discovery',
      }).success,
    ).toBe(false);
  });

  test('needs_input_conflict and retry_provider_errors stay in sourcing', () => {
    const hardConflict = {
      field: 'weight',
      providerValues: { phillips: '10 lb', bci: '20 lb' },
      severity: 'hard',
    };
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'needs_input_conflict',
        acceptedEvidenceAttemptIds: [],
        providerIds: ['phillips'],
        conflicts: [hardConflict],
        target: 'sourcing',
      }).success,
    ).toBe(true);
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'needs_input_conflict',
        acceptedEvidenceAttemptIds: [],
        providerIds: ['phillips'],
        conflicts: [hardConflict],
        target: 'discovery',
      }).success,
    ).toBe(false);
    // Amendment A: needs_input_conflict without a hard conflict is invalid.
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'needs_input_conflict',
        acceptedEvidenceAttemptIds: [],
        providerIds: ['phillips'],
        target: 'sourcing',
      }).success,
    ).toBe(false);
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'retry_provider_errors',
        acceptedEvidenceAttemptIds: [],
        providerIds: ['phillips'],
        target: 'sourcing',
      }).success,
    ).toBe(true);
  });

  test('bundle_to_curation is never creatable; legacy shape is rejected by the creatable schema', () => {
    expect(
      SourcingDecisionV2Schema.safeParse({ ...v2Base, route: 'bundle_to_curation' }).success,
    ).toBe(false);
    expect(
      CreatableSourcingDecisionSchema.safeParse({ ...v2Base, route: 'bundle_to_curation' }).success,
    ).toBe(false);
    // Legacy decision (no schemaVersion) is not creatable.
    expect(
      CreatableSourcingDecisionSchema.safeParse({
        route: 'evidence_to_discovery',
        origin: 'automatic_policy',
        acceptedEvidenceAttemptIds: ['a1'],
        providerIds: ['phillips'],
        decidedAt: '2026-08-13T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  test('read union hydrates legacy decisions including historical bundle_to_curation', () => {
    const legacy = {
      route: 'fallback_to_discovery',
      origin: 'operator_override',
      acceptedEvidenceAttemptIds: [],
      providerIds: [],
      decidedAt: '2026-08-13T00:00:00.000Z',
    };
    expect(LegacySourcingDecisionSchema.safeParse(legacy).success).toBe(true);
    expect(SourcingDecisionReadSchema.safeParse(legacy).success).toBe(true);
    const historical = {
      route: 'bundle_to_curation',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: [],
      providerIds: [],
      decidedAt: '2026-08-13T00:00:00.000Z',
    };
    expect(SourcingDecisionReadSchema.safeParse(historical).success).toBe(true);
    expect(SourcingDecisionV2Schema.safeParse(historical).success).toBe(false);
  });

  test('malformed V2 cannot downgrade to a legacy decision (read union fails closed)', () => {
    // A V2 needs_input_conflict with no hard conflict fails the V2 member…
    const malformedV2 = {
      schemaVersion: 2,
      route: 'needs_input_conflict',
      origin: 'automatic_policy',
      acceptedEvidenceAttemptIds: [],
      providerIds: ['phillips'],
      sourcingGenerationId: 'g1',
      target: 'sourcing',
      conflicts: [],
      decidedAt: '2026-08-13T00:00:00.000Z',
    };
    expect(SourcingDecisionV2Schema.safeParse(malformedV2).success).toBe(false);
    // …and MUST NOT be silently hydrated as legacy (schemaVersion guard).
    expect(SourcingDecisionReadSchema.safeParse(malformedV2).success).toBe(false);
  });

  test('unknown keys are rejected in V2 (strict)', () => {
    expect(
      SourcingDecisionV2Schema.safeParse({
        ...v2Base,
        route: 'fallback_to_discovery',
        acceptedEvidenceAttemptIds: [],
        providerIds: [],
        sourceType: 'official_page',
        target: 'discovery',
        sneaky: true,
      }).success,
    ).toBe(false);
  });
});

describe('Sourcing contracts — evidence writer contract forbids raw snapshots (ADR 0014)', () => {
  test('ProductEvidenceLookupResultSchema never carries a rawSnapshot field', () => {
    const parsed = ProductEvidenceLookupResultSchema.safeParse({
      providerId: 'phillips',
      providerType: 'distributor',
      outcome: 'found',
      confidence: 0.9,
      identity: { upc: '012345678905' },
      evidenceUrl: null,
      matchedFields: ['upc'],
      warnings: [],
      errorCode: null,
      errorMessage: null,
      rawSnapshot: { anything: true },
    });
    expect(parsed.success).toBe(true);
    // Zod strips unknown keys: rawSnapshot is never part of the contract.
    expect('rawSnapshot' in (parsed.success ? parsed.data : {})).toBe(false);
  });

  test('EvidenceAttemptSchema carries ADR 0014 generation/catalog/observed fields', () => {
    const parsed = EvidenceAttemptSchema.safeParse({
      id: 'a1',
      itemId: 'i1',
      providerId: 'phillips',
      distributorConnectionId: 'c1',
      catalogSnapshotId: 's1',
      lookupUpc: '012345678905',
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      catalogVersion: 'v2026.3',
      observedAt: '2026-08-13T00:00:00.000Z',
      expiresAt: '2026-09-13T00:00:00.000Z',
      sourcingGenerationId: 'g1',
      createdAt: '2026-08-13T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sourcingGenerationId).toBe('g1');
      expect(parsed.data.catalogVersion).toBe('v2026.3');
    }
  });

  test('InsertEvidenceAttempt type omits rawSnapshot (compile-time contract)', () => {
    const attempt: InsertEvidenceAttempt = {
      itemId: 'i1',
      providerId: 'phillips',
      lookupUpc: '012345678905',
      outcome: 'found',
      confidence: 0.9,
      evidenceUrl: null,
      matchedFields: ['upc'],
      identityJson: null,
      warningsJson: null,
      errorCode: null,
      errorMessage: null,
      sourcingGenerationId: 'g1',
      observedAt: '2026-08-13T00:00:00.000Z',
    };
    expect(attempt.sourcingGenerationId).toBe('g1');
    // @ts-expect-error — rawSnapshot is not part of the writer contract
    const _forbidden = attempt.rawSnapshot;
    expect(_forbidden).toBeUndefined();
  });
});

describe('Sourcing contracts — advisory retirement and conflict resolution', () => {
  test('advisory profile schemas and sourcing-policy exports are retired (issue #150)', () => {
    for (const retired of [
      'SourcingPolicyEnum',
      'BrandAdvisoryProfileSchema',
      'InsertBrandAdvisoryProfileSchema',
    ]) {
      expect(retired in DistributorSchemas).toBe(false);
    }
    // Connection/distributor schemas stay intact.
    expect(InsertDistributorConnectionSchema.safeParse({
      workspaceId: 'w1',
      distributorId: 'phillips',
      connectorType: 'api',
    }).success).toBe(true);
  });

  test('ResolveConflictRequestSchema accepts exactly the three ADR actions', () => {
    expect(ResolveConflictRequestSchema.safeParse({ action: 'resolve_candidate', candidateId: 'c1' }).success).toBe(true);
    expect(ResolveConflictRequestSchema.safeParse({ action: 'custom_value', customValue: '12 lb' }).success).toBe(true);
    expect(ResolveConflictRequestSchema.safeParse({ action: 'dismiss' }).success).toBe(true);
    expect(ResolveConflictRequestSchema.safeParse({ action: 'resolve_candidate' }).success).toBe(false);
    expect(ResolveConflictRequestSchema.safeParse({ action: 'auto_resolve' }).success).toBe(false);
  });
});
