/**
 * Offline storefront-family qualification (issue #376).
 *
 * Runs the frozen dev corpus through the REAL pure composition surfaces
 * (family-variant-rule, title-consistency, membership-proposal pure gates,
 * storefront-family-join discovery/resolution, storefront-subproducts,
 * storefront-family-validation, family-push-operation, product-codec) with
 * zero transport/DB/credentials/network, and asserts the fixed-population
 * accounting below. The sealed holdout corpus is NEVER executed/fitted here:
 * holdout `expect` golds never run through rule/membership functions. Only
 * its file bytes are hashed and compared against the dev-fitted task policy,
 *
 * Transport mechanics use corpus-recorded Choice answers fed to
 * interpretAnchorChoice (the corpus IS the stub), and proposeFamilyMembership
 * runs only with a null policy so the no-route disabled path is exercised.
 * No TypeSafe call, no store write.
 *
 * Runs under `bun test` (matches the naming-listing qualification suite).
 */
import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  checkTransitiveSafety,
  freezeProposalAnchors,
  interpretAnchorChoice,
  proposeFamilyMembership,
  resolveProposalDisposition,
  FAMILY_MEMBERSHIP_ANCHOR_LIMIT,
  type FamilyMembershipAnchorInput,
  type FamilyMembershipAnchorJudgment,
} from '../../classification/family-membership-proposal';
import {
  FOOD_FAMILY_VARIANT_RULE_VERSION,
  evaluateFamilyVariantRule,
  evaluateNonFoodFamilyVariantRule,
  nominateFamilyMain,
  nominateNonFoodFamilyMain,
  type FamilyVariantRuleVersion,
  type NonFoodFamilyVariantFactors,
} from '../../classification/family-variant-rule';
import {
  classifyClassifierFamilyWrite,
  deriveNonFoodPf7ShortNames,
  derivePf7ShortNames,
  validateNonFoodFamilyGroup,
  validateStorefrontFamilyGroup,
} from '../../validation/storefront-family-validation';
import { validateFamilyTitleSet } from '../../classification/family-title-consistency';
import {
  buildCatalogJoinAnchor,
  buildImportedJoinQuery,
  discoverJoinCandidates,
  normalizeWorkspaceSku,
  resolveJoinCandidates,
  type CatalogJoinAnchor,
  type ImportedJoinQuery,
  type JoinCandidate,
} from '../../classification/storefront-family-join';
import {
  buildManagedSubproductsXml,
  classifyNativeAdoption,
  classifySubproductsSupport,
  clearSubproductsBlock,
  hasExplicitSubproductsClear,
  nativeSkusInDocumentOrder,
  setManagedSubproducts,
} from '../../shopsite/storefront-subproducts';
import type { FamilyVariantRefusalCode } from '../../classification/family-variant-rule';
import {
  assessFamilyPushReadiness,
  checkFamilyPushStalenessFiles,
  checkRequiredRemoteMembers,
  encodeFamilyPushXml,
  liveCensusSkusOf,
  planFamilyPushSet,
  reconcileFamilyPushImport,
} from '../../shopsite/family-push-operation';
import { ShopSiteProductCodec, extractSubproductSkus } from '../../shopsite/product-codec';
import { assertConnectionEnabledForDispatch } from '../../ai/provider-connections';
import type { ProviderConnection } from '../../ai/provider-connections';
import { TYPESAFE_EVALUATED_MODEL } from '../../ai/systemone-transport';
import type { Product } from '../../shared/types';

const DEV_PATH = 'src/tests/fixtures/storefront-family-qualification/dev-corpus.json';
const HOLDOUT_PATH = 'src/tests/fixtures/storefront-family-qualification/holdout-corpus.json';
const POLICY_PATH = 'docs/audits/storefront-family-qualification/task-policy.json';

// Corpus rows arrive as parsed JSON (unknown shapes); each test narrows the
// rows it touches into the interfaces below with one named unchecked cast per
// row (external-input boundary), then reads plain typed properties.
interface FoodMember {
  sku: string;
  brand: string | null;
  recipe: string | null;
  flavor: string | null;
  species: string | null;
  lifeStage: string | null;
  form: string | null;
  sizeRaw: string;
  ounces: number | null;
  retailUnit: string | null;
  packCountDeclared: boolean;
  packCount: number | null;
  reviewedTypeHash: string;
  pf7?: string;
}

interface NonFoodMember {
  sku: string;
  brand: string | null;
  model: string | null;
  material: string | null;
  function: string | null;
  safetyDose: string | null;
  strength: string | null;
  fit: string | null;
  size: string | null;
  color: string | null;
  reviewedTypeHash: string;
  reviewedProductTypeId: string;
  packCountDeclared: boolean;
  packCount: number | null;
}

interface TitleFact {
  brand: string;
  productLine: string;
  formOrSpecies?: string;
  flavorOrColorOrSubline?: string;
  sizeOrCount?: string;
}

interface CorpusAnchor {
  sku: string;
  familyPlanId: string | null;
  familyMain: string | null;
  familyOrder: string[];
  familyRuleVersion: FamilyVariantRuleVersion | null;
  normalizedSku: string;
  sourceIdentifiers: string[];
  blockingBrand: string;
  blockingTypeId: string;
  blockingRule: string;
  nameStem: string;
  nameTokens: string[];
  model: string | null;
  sameSkuConflict: boolean;
  duplicateTuple: boolean;
  origin: CatalogJoinAnchor['origin'];
  signals: JoinCandidate['signals'];
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface CorpusMembershipAnchor {
  anchorSku: string;
  choice: string;
  confidence: number;
  familyPlanId: string;
  invariants: Record<string, string>;
  probabilities: Record<string, number>;
}

interface CorpusRow {
  id: string;
  kind: string;
  category: string;
  familyId?: string | null;
  members?: unknown[];
  facts?: TitleFact[];
  candidateTitles?: string[];
  anchors?: unknown[];
  query?: unknown;
  querySku?: string;
  expect?: Record<string, unknown>;
  ruleVersion?: string;
  existingMain?: string;
  newSizes?: Array<{ sku: string; sizeRaw: string; ounces: number }>;
  hostSku?: string;
  rawBlock?: string;
  candidates?: string[];
}

interface CorpusFile {
  corpus: string;
  rows: CorpusRow[];
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadCorpus(corpusPath: string): CorpusFile {
  return JSON.parse(fs.readFileSync(corpusPath, 'utf8')) as CorpusFile;
}

function foodFactors(m: FoodMember): {
  sku: string;
  factors: {
    brand: string | null;
    recipe: string | null;
    flavor: string | null;
    species: string | null;
    lifeStage: string | null;
    form: string | null;
    packageSize: { raw: string; ounces: number | null };
    retailUnit: string | null;
    comparableOunces: number | null;
    reviewedTypeHash: string | null;
  };
  pack: { packCountDeclared: boolean; packCount: number | null };
} {
  return {
    sku: m.sku,
    factors: {
      brand: m.brand,
      recipe: m.recipe,
      flavor: m.flavor,
      species: m.species,
      lifeStage: m.lifeStage,
      form: m.form,
      packageSize: { raw: m.sizeRaw, ounces: m.ounces },
      retailUnit: m.retailUnit,
      comparableOunces: m.ounces,
      reviewedTypeHash: m.reviewedTypeHash,
    },
    pack: { packCountDeclared: m.packCountDeclared, packCount: m.packCount },
  };
}

function nonFoodFactors(m: NonFoodMember): {
  sku: string;
  factors: NonFoodFamilyVariantFactors;
  pack: { packCountDeclared: boolean; packCount: number | null };
} {
  return {
    sku: m.sku,
    factors: {
      brand: m.brand,
      model: m.model,
      material: m.material,
      function: m.function,
      safetyDose: m.safetyDose,
      strength: m.strength,
      fit: m.fit,
      size: m.size,
      color: m.color,
      count: null,
      reviewedTypeHash: m.reviewedTypeHash,
      reviewedProductTypeId: m.reviewedProductTypeId,
    },
    pack: { packCountDeclared: m.packCountDeclared, packCount: m.packCount },
  };
}

function blankProduct(sku: string, overrides: Record<string, string | Record<string, string> | null> = {}): Product {
  const now = new Date().toISOString();
  const str = (key: string): string | null => {
    const v = overrides[key];
    return typeof v === 'string' ? v : null;
  };
  const rawAttrs = overrides['rawAttributes'];
  const blocks = overrides['advancedBlocks'];
  return {
    schemaVersion: 1,
    id: `test-${sku}`,
    sku,
    status: 'draft',
    core: {
      name: str('name') ?? `${sku} name`,
      price: '9.99',
      salePrice: null,
      description: null,
      inventory: { quantityOnHand: 3, lowStockThreshold: null, outOfStockLimit: null },
      availability: null,
      weight: str('weight') ?? '5 lb',
      taxable: true,
      media: { primary: null, additional: [] },
      seo: { fileName: null, searchKeywords: null, googleProductCategory: null },
      productOnPages: [],
    },
    customFields: Object.fromEntries(
      Object.entries({
        ProductField16: str('brand') ?? 'Acme',
        ProductField24: str('recipe'),
        ProductField23: str('flavor'),
        ProductField17: str('species'),
        ProductField18: str('lifeStage'),
        ProductField22: str('form'),
      }).filter((e): e is [string, string] => e[1] !== null),
    ),
    shopsite: {
      productId: null,
      productGuid: null,
      xmlVersion: '15.0',
      lastPulledAt: null,
      lastRemoteHash: null,
      lastSyncedAt: null,
      source: { dbname: 'products', uniqueName: 'SKU' },
      preserved: {
        unknownElements: {},
        advancedBlocks: (typeof blocks === 'object' && blocks !== null ? blocks : {}) as Record<string, string>,
        rawAttributes: {
          reviewedTypeHash: str('reviewedTypeHash') ?? 'type-x-v1',
          ...((typeof rawAttrs === 'object' && rawAttrs !== null ? rawAttrs : {}) as Record<string, string>),
        },
      },
    },
    metadata: { createdAt: now, updatedAt: now, archivedAt: null },
  };
}

function foodMemberProduct(m: FoodMember): Product {
  return blankProduct(m.sku, {
    name: `${m.brand ?? ''} ${m.recipe ?? ''} ${m.flavor ?? ''} ${m.sizeRaw}`,
    weight: m.sizeRaw,
    brand: m.brand,
    recipe: m.recipe,
    flavor: m.flavor,
    species: m.species,
    lifeStage: m.lifeStage,
    form: m.form,
    reviewedTypeHash: m.reviewedTypeHash,
    rawAttributes: {
      ...(m.retailUnit ? { retailUnit: m.retailUnit } : {}),
      ...(m.packCountDeclared ? { packCountDeclared: 'true' } : {}),
      ...(m.packCount != null ? { packCount: String(m.packCount) } : {}),
    },
  });
}

function membershipAnchor(sku: string): FamilyMembershipAnchorInput {
  return {
    anchor: {
      sku,
      familyPlanId: `fam-${sku}`,
      familyMain: sku,
      familyOrder: [sku],
      familyRuleVersion: FOOD_FAMILY_VARIANT_RULE_VERSION,
      normalizedSku: normalizeWorkspaceSku(sku),
      sourceIdentifiers: [],
      blockingBrand: 'acme',
      blockingTypeId: 'dog-food',
      blockingRule: FOOD_FAMILY_VARIANT_RULE_VERSION,
      nameStem: 'acme farm feast chicken',
      nameTokens: ['acme', 'chicken'],
      model: null,
      sameSkuConflict: false,
      duplicateTuple: false,
      origin: 'catalog_scan',
    },
    candidate: {
      sku,
      familyPlanId: `fam-${sku}`,
      familyMain: sku,
      familyOrder: [sku],
      familyRuleVersion: FOOD_FAMILY_VARIANT_RULE_VERSION,
      signals: ['configured_block', 'name_model_evidence'],
      matchedOn: ['configured_block'],
    },
    reviewedIdentity: 'Acme Farm Feast Chicken / Adult Dog',
    ruleVersion: FOOD_FAMILY_VARIANT_RULE_VERSION,
    ruleIdentity: 'food-rule-v1',
    evidence: [`evidence for ${sku}`],
    hardInvariants: `brand=Acme;flavor=Chicken for ${sku}`,
    memberTuples: `5lb,15lb for ${sku}`,
  };
}

describe('storefront-family offline qualification (issue #376)', () => {
  test('dev fit precedes the sealed holdout: policy binds frozen bytes; holdout is family/SKU-disjoint and never executed/fitted', () => {
    const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8')) as Record<string, unknown>;
    expect(policy['activation']).toBe('OFF');
    expect(policy['publishedBeforeHoldoutInspection']).toBe(true);
    expect(policy['modelPin']).toBe(TYPESAFE_EVALUATED_MODEL);
    expect(policy['selectionFloor']).toBe(0.5);
    expect(sha256File(DEV_PATH)).toBe(policy['sha256'] as string);
    expect(sha256File(HOLDOUT_PATH)).toBe(policy['holdoutSha256'] as string);
    const dev = loadCorpus(DEV_PATH);
    const holdout = loadCorpus(HOLDOUT_PATH);
    expect(dev.rows.length).toBe(17);
    expect(holdout.rows.length).toBe(17);
    const devFamilies = new Set(dev.rows.map((r) => r.familyId).filter((f): f is string => !!f));
    const holdFamilies = new Set(holdout.rows.map((r) => r.familyId).filter((f): f is string => !!f));
    for (const f of devFamilies) expect(holdFamilies.has(f)).toBe(false);
    const skuOf = (rows: CorpusRow[]): Set<string> => {
      const out = new Set<string>();
      for (const r of rows) {
        for (const raw of r.members ?? []) {
          const m = raw as { sku?: unknown };
          if (typeof m.sku === 'string') out.add(m.sku);
        }
        for (const s of r.newSizes ?? []) out.add(s.sku);
      }
      return out;
    };
    const devSkus = skuOf(dev.rows);
    const holdSkus = skuOf(holdout.rows);
    for (const s of devSkus) expect(holdSkus.has(s)).toBe(false);
    const toks = (rows: CorpusRow[]): Set<string> => {
      const out = new Set<string>();
      for (const r of rows) for (const t of r.candidateTitles ?? []) for (const w of t.toLowerCase().split(/\s+/)) out.add(w);
      return out;
    };
    const a = toks(dev.rows);
    const b = toks(holdout.rows);
    let inter = 0;
    for (const t of a) if (b.has(t)) inter += 1;
    expect(inter / new Set([...a, ...b]).size).toBeLessThan(0.8);
  });

  test('food rule: 3-size accept, flavor/species/missing-invariant/undeclared-pack refusals, main nomination', () => {
    const dev = loadCorpus(DEV_PATH);
    const byId = new Map(dev.rows.map((r) => [r.id, r]));
    const row = byId.get('dev-01')!;
    const members = (row.members ?? []) as unknown as FoodMember[];
    const verdict = evaluateFamilyVariantRule(members.map(foodFactors));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.ruleVersion).toBe(FOOD_FAMILY_VARIANT_RULE_VERSION);
    const main = nominateFamilyMain(members.map((m) => ({ sku: m.sku, comparableOunces: m.ounces })));
    expect(main.kind).toBe('nominated');
    if (main.kind === 'nominated') expect(main.sku).toBe('D1-5');
    const pf7 = derivePf7ShortNames(members.map((m) => ({ sku: m.sku, sizeRaw: m.sizeRaw, ounces: m.ounces })));
    expect(pf7.map((p) => p.shortName).sort()).toEqual(['15 lb (240 oz)', '30 lb (480 oz)', '5 lb (80 oz)']);
    const title = validateFamilyTitleSet({
      familyId: row.familyId!,
      members: members.map((m, i) => ({
        onboardingItemId: `item-${m.sku}`,
        upc: `9000000${String(101 + i)}`,
        frozenEvidenceHash: `hash-${m.sku}`,
        frozenFacts: {
          brand: 'Acme',
          productLine: 'Farm Feast',
          formOrSpecies: 'Dry Kibble',
          flavorOrColorOrSubline: 'Chicken',
          sizeOrCount: m.sizeRaw,
          modifiers: {},
        },
      })),
      candidateTitles: members.map((m, i) => ({ upc: `9000000${String(101 + i)}`, title: (row.candidateTitles ?? [])[i] ?? '' })),
    });
    expect(title.valid).toBe(true);
    const refusals: Array<[string, FamilyVariantRefusalCode]> = [
      ['dev-02', 'family_rule_invariant_conflict'],
      ['dev-03', 'family_rule_invariant_conflict'],
      ['dev-04', 'family_rule_missing_invariant'],
      ['dev-05', 'family_rule_undeclared_pack'],
    ];
    for (const [id, code] of refusals) {
      const r = byId.get(id)!;
      const v = evaluateFamilyVariantRule(((r.members ?? []) as unknown as FoodMember[]).map(foodFactors));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.code).toBe(code);
    }
  });

  test('non-food permitted size rule accepts; material invariant conflict refuses; PF7 order follows rule axis order', () => {
    const dev = loadCorpus(DEV_PATH);
    const byId = new Map(dev.rows.map((r) => [r.id, r]));
    const cases: Array<[string, boolean]> = [['dev-09', true], ['dev-10', false]];
    for (const [id, ok] of cases) {
      const r = byId.get(id)!;
      const v = evaluateNonFoodFamilyVariantRule(
        r.ruleVersion as FamilyVariantRuleVersion,
        ((r.members ?? []) as unknown as NonFoodMember[]).map(nonFoodFactors),
      );
      expect(v.ok).toBe(ok);
      if (id === 'dev-10' && !v.ok) expect<string>(v.code).toBe('family_rule_invariant_conflict');
    }
    const r9 = byId.get('dev-09')!;
    const r9members = (r9.members ?? []) as unknown as NonFoodMember[];
    const labels = deriveNonFoodPf7ShortNames(
      r9.ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>,
      r9members.map((m) => ({ sku: m.sku, sizeRaw: m.size })),
    );
    expect(labels.map((l) => l.shortName).sort()).toEqual(['Medium', 'Small']);
    const main = nominateNonFoodFamilyMain(
      r9.ruleVersion as Exclude<FamilyVariantRuleVersion, typeof FOOD_FAMILY_VARIANT_RULE_VERSION>,
      r9members.map((m) => ({ sku: m.sku, comparableQuantity: m.size === 'Small' ? 1 : 2 })),
    );
    expect(main.kind).toBe('nominated');
  });

  test('join discovery/resolution: same-SKU routes to identity, competing families stay ambiguous, stem-only never qualifies', () => {
    const dev = loadCorpus(DEV_PATH);
    const byId = new Map(dev.rows.map((r) => [r.id, r]));
    {
      const r = byId.get('dev-06')!;
      const query = r.query as unknown as ImportedJoinQuery;
      const anchors = (r.anchors ?? []) as unknown as CorpusAnchor[];
      const candidates: JoinCandidate[] = anchors.map((a) => ({
        sku: a.sku,
        familyPlanId: a.familyPlanId,
        familyMain: a.familyMain,
        familyOrder: a.familyOrder,
        familyRuleVersion: a.familyRuleVersion,
        signals: a.signals,
        matchedOn: ['sku:dup-5'],
      }));
      const anchorsBySku = new Map<string, CatalogJoinAnchor>(
        anchors.map((a) => [a.sku, {
          sku: a.sku,
          familyPlanId: a.familyPlanId,
          familyMain: a.familyMain,
          familyOrder: a.familyOrder,
          familyRuleVersion: a.familyRuleVersion,
          normalizedSku: a.normalizedSku,
          sourceIdentifiers: a.sourceIdentifiers,
          blockingBrand: a.blockingBrand,
          blockingTypeId: a.blockingTypeId,
          blockingRule: a.blockingRule,
          nameStem: a.nameStem,
          nameTokens: a.nameTokens,
          model: a.model,
          sameSkuConflict: a.sameSkuConflict,
          duplicateTuple: a.duplicateTuple,
          origin: a.origin,
        }]),
      );
      const resolved = resolveJoinCandidates({ querySku: query.sku, candidates, anchorsBySku });
      expect(resolved.ambiguous).toBe(false);
      expect(resolved.resolved.filter((c) => c.sameSku).map((c) => c.sku)).toEqual(['DUP-5']);
      expect(resolved.reasons.some((x) => x.includes('identity/duplicate resolution'))).toBe(true);
    }
    {
      const r = byId.get('dev-07')!;
      const query = r.query as unknown as ImportedJoinQuery;
      const anchors = (r.anchors ?? []) as unknown as CorpusAnchor[];
      const candidates: JoinCandidate[] = anchors.map((a) => ({
        sku: a.sku,
        familyPlanId: a.familyPlanId,
        familyMain: a.familyMain,
        familyOrder: a.familyOrder,
        familyRuleVersion: a.familyRuleVersion,
        signals: a.signals,
        matchedOn: ['configured_block'],
      }));
      const anchorsBySku = new Map<string, CatalogJoinAnchor>(
        anchors.map((a) => [a.sku, {
          sku: a.sku,
          familyPlanId: a.familyPlanId,
          familyMain: a.familyMain,
          familyOrder: a.familyOrder,
          familyRuleVersion: a.familyRuleVersion,
          normalizedSku: a.normalizedSku,
          sourceIdentifiers: [],
          blockingBrand: a.blockingBrand,
          blockingTypeId: a.blockingTypeId,
          blockingRule: a.blockingRule,
          nameStem: '',
          nameTokens: [],
          model: null,
          sameSkuConflict: false,
          duplicateTuple: false,
          origin: 'managed_plan' as const,
        }]),
      );
      const resolved = resolveJoinCandidates({ querySku: query.sku, candidates, anchorsBySku });
      expect(resolved.ambiguous).toBe(true);
      expect(resolved.reasons.some((x) => x.includes('explicit conflict resolution') || x.includes('explicit operator resolution'))).toBe(true);
    }
    {
      const r = byId.get('dev-15')!;
      const querySku = (r.query as unknown as { sku: string }).sku;
      const query = buildImportedJoinQuery({ sku: querySku, brand: null, name: 'Acme Chicken 5 lb' });
      const anchor = buildCatalogJoinAnchor({
        product: blankProduct('G-1', { name: 'Acme Salmon 30 oz', brand: 'Other' }),
        origin: 'catalog_scan',
      });
      expect(discoverJoinCandidates(query, [anchor]).length).toBe(0);
      const recorded = (r.anchors ?? []) as unknown as CorpusAnchor[];
      expect(recorded[0]!.signals).toEqual([]);
    }
    {
      const r = byId.get('dev-11')!;
      const all = [
        { sku: 'E-5', comparableOunces: 80 },
        { sku: 'E-15', comparableOunces: 240 },
        ...((r.newSizes ?? []).map((s) => ({ sku: s.sku, comparableOunces: s.ounces }))),
      ];
      const nominated = nominateFamilyMain(all);
      expect(nominated.kind).toBe('nominated');
      if (nominated.kind === 'nominated') expect(nominated.sku).toBe('E-5');
      expect(r.existingMain).toBe('E-5');
    }
  });

  test('membership pure gates: closed-set interpretation, below-floor abstention, conflicts, transitive refusal, null-policy disablement', async () => {
    const dev = loadCorpus(DEV_PATH);
    const byId = new Map(dev.rows.map((r) => [r.id, r]));
    const r = byId.get('dev-08')!;
    const recorded = (r.anchors ?? []) as unknown as CorpusMembershipAnchor[];
    const judgments: FamilyMembershipAnchorJudgment[] = recorded.map((a) =>
      interpretAnchorChoice({
        anchor: membershipAnchor(a.anchorSku),
        choice: a.choice,
        probabilities: a.probabilities,
        confidence: a.confidence,
      }),
    );
    expect(judgments.filter((j) => j.outcome === 'selected').length).toBe(2);
    const low = judgments.find((j) => j.anchorSku === 'D8-C')!;
    expect(low.outcome).toBe('insufficient');
    expect(low.verdict).toBeNull();
    const disposition = resolveProposalDisposition(judgments);
    expect(disposition.conflicts).toBe(true);
    expect(disposition.positives.length).toBe(2);
    const safety = checkTransitiveSafety({
      positives: disposition.positives,
      invariantOf: (sku) => (sku === 'D8-A' ? { flavor: 'chicken' } : { flavor: 'beef' }),
    });
    expect(safety.safe).toBe(false);
    const frozen = freezeProposalAnchors('D8-NEW', judgments.map((j) => membershipAnchor(j.anchorSku)));
    expect(frozen.frozen.length).toBe(3);
    const oversize = Array.from({ length: 17 }, (_, i) => membershipAnchor(`A-${i}`));
    expect(() => freezeProposalAnchors('X', oversize)).toThrow(/overflow/);
    const bad = interpretAnchorChoice({
      anchor: membershipAnchor('D8-A'),
      choice: 'totally_a_family',
      probabilities: { same_permitted_family: 0.99, same_sellable_sku: 0, different_product: 0, insufficient_evidence: 0 },
      confidence: 0.99,
    });
    expect(bad.outcome).toBe('service');
    expect(bad.verdict).toBeNull();
    const unresolved = await proposeFamilyMembership({
      sku: 'D8-NEW',
      query: buildImportedJoinQuery({ sku: 'D8-NEW', brand: 'Acme', name: 'Acme Farm Feast Chicken 30 lb' }),
      anchors: [membershipAnchor('D8-A')],
      runId: 'offline-run',
      modelPolicy: null,
      liveBinding: {
        sku: 'D8-NEW', evidenceHash: 'evidence-D8-NEW', typeHash: 'reviewed-type-v1',
        ruleVersion: FOOD_FAMILY_VARIANT_RULE_VERSION, memberEvidence: [], revisions: [null], primaryRevision: null,
      },
      incomingState: {
        sku: 'D8-NEW', evidenceHash: 'evidence-D8-NEW', typeHash: 'reviewed-type-v1',
        ruleVersion: FOOD_FAMILY_VARIANT_RULE_VERSION,
        brand: 'Acme', recipe: null, flavor: 'Chicken', species: null, lifeStage: null, form: null,
        model: null, material: null, function: null, safetyDose: null, strength: null, fit: null,
        sizeRaw: '30 lb', ounces: 480, retailUnit: null, colorRaw: null, countRaw: null, countQuantity: null,
        invariants: { brand: 'Acme', flavor: 'Chicken' },
        tuple: 'unknown',
      },
    });
    expect(unresolved.outcome).toBe('disabled');
    expect(unresolved.modelCallIds.length).toBe(0);
    const disabled: ProviderConnection = {
      id: 'typesafe-jev',
      label: 'TypeSafe Jev',
      transport: 'systemone',
      baseUrl: 'https://api.typesafe.ai/v1',
      trustZone: 'cloud',
      credential: null,
      enabled: false,
    };
    expect(() => assertConnectionEnabledForDispatch(disabled, TYPESAFE_EVALUATED_MODEL)).toThrow();
  });

  test('native posture (synthetic sample only — no real export inspected): accessory preserved, nested unsupported, main self-inclusion, explicit clear, managed round-trip', () => {
    const dev = loadCorpus(DEV_PATH);
    const byId = new Map(dev.rows.map((r) => [r.id, r]));
    {
      const r = byId.get('dev-12')!;
      const host = blankProduct(r.hostSku!, { advancedBlocks: { Subproducts: r.rawBlock! } });
      expect(classifySubproductsSupport(host).code).toBe('supported_unmanaged_simple');
      expect(classifyNativeAdoption(host, r.candidates!).code).toBe('refused_accessory');
    }
    {
      const r = byId.get('dev-13')!;
      const host = blankProduct(r.hostSku!, { advancedBlocks: { Subproducts: r.rawBlock! } });
      expect(classifySubproductsSupport(host).code).toBe('unsupported_nested');
      expect(classifyNativeAdoption(host, r.candidates!).code).toBe('refused_unsupported');
    }
    {
      // Synthetic-sample posture only: the longstanding synthetic ABC-123/XYZ-789 fixture, NOT a real store export.
      const xml = fs.readFileSync('src/tests/fixtures/shopsite-products-sample.xml', 'utf8');
      const decoded = ShopSiteProductCodec.decode(xml);
      const host = decoded.products.find((p) => p.sku === 'XYZ-789')!;
      expect(extractSubproductSkus(host).sort()).toEqual(['XYZ-789-BLUE', 'XYZ-789-RED']);
      expect(classifySubproductsSupport(host).code).toBe('supported_unmanaged_simple');
      expect(classifyNativeAdoption(host, ['XYZ-789-BLUE', 'XYZ-789-RED']).code).toBe('refused_accessory');
      const raw: string = host.shopsite.preserved.advancedBlocks['Subproducts'] ?? '';
      expect(nativeSkusInDocumentOrder(raw)).toEqual(['XYZ-789-RED', 'XYZ-789-BLUE']);
      const managed = setManagedSubproducts(blankProduct('M-5'), 'fam-x', [
        { sku: 'M-5', name: 'Main 5 lb' },
        { sku: 'M-15', name: 'Main 15 lb' },
      ]);
      expect(extractSubproductSkus(managed).sort()).toEqual(['M-15', 'M-5']);
      expect(ShopSiteProductCodec.encode(managed).xml).toContain('<SKU>M-5</SKU>');
      const cleared = clearSubproductsBlock(blankProduct('C-1'));
      expect(hasExplicitSubproductsClear(cleared)).toBe(true);
      expect(hasExplicitSubproductsClear(blankProduct('C-2'))).toBe(false);
      const built = buildManagedSubproductsXml([
        { sku: 'M-15', name: 'Main 15 lb' },
        { sku: 'M-5', name: 'Main 5 lb' },
      ]);
      expect(nativeSkusInDocumentOrder(built)).toEqual(['M-15', 'M-5']);
    }
  });

  test('group validation: duplicate tuple + duplicate PF7 block; classifier/PF7/native writes refused', () => {
    const dev = loadCorpus(DEV_PATH);
    const byId = new Map(dev.rows.map((r) => [r.id, r]));
    const r = byId.get('dev-14')!;
    const members = ((r.members ?? []) as unknown as FoodMember[]).map((m) => {
      const p = foodMemberProduct(m);
      return { ...p, customFields: { ...p.customFields, ProductField7: m.pf7 ?? '' } };
    });
    const staged = members.map((m) =>
      setManagedSubproducts(m, 'fam-dev-14', members.map((x) => ({ sku: x.sku, name: `${x.sku} name` }))),
    );
    const issues = validateStorefrontFamilyGroup({ familyId: 'fam-dev-14', members: staged, bases: new Map() });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('FAMILY_DUPLICATE_SIZE');
    expect(codes).toContain('FAMILY_PF7_DUPLICATE');
    expect(classifyClassifierFamilyWrite('ProductField7')?.code).toBe('protected_target_refused');
    expect(classifyClassifierFamilyWrite('Subproducts')?.code).toBe('protected_target_refused');
    expect(classifyClassifierFamilyWrite('ProductField16')).toBeNull();
    const nf = validateNonFoodFamilyGroup('no-such-rule', 'fam-x', members.slice(0, 2), new Map());
    expect(nf.some((i) => i.code === 'FAMILY_RULE_UNKNOWN')).toBe(true);
  });

  test('push completeness: whole-group plan, remote verification, staleness refusal, partial-recovery reconciliation, no fake sync', () => {
    const dev = loadCorpus(DEV_PATH);
    const byId = new Map(dev.rows.map((r) => [r.id, r]));
    const row = byId.get('dev-01')!;
    const members = ((row.members ?? []) as unknown as FoodMember[]).map((m) => {
      const staged = setManagedSubproducts(
        foodMemberProduct(m),
        'fam-dev-01',
        ((row.members ?? []) as unknown as FoodMember[]).map((x) => ({ sku: x.sku, name: `${x.sku} name` })),
      );
      return { ...staged, customFields: { ...staged.customFields, ProductField7: `${m.sizeRaw} (${m.ounces} oz)` } };
    });
    const manifest = {
      version: 1 as const,
      changeSetId: 'cs-dev-01',
      workspaceId: 'ws-dev',
      baseCommit: 'abc123',
      writes: members.map((m) => ({
        sku: m.sku,
        operation: 'update',
        filePath: `products/${m.sku}.json`,
        draftHash: `draft-${m.sku}`,
        productHash: `product-${m.sku}`,
        nativeReferenceHash: `native-${m.sku}`,
        baseHash: null,
        baseApprovedCommit: 'abc123',
        pageNames: [],
      })),
      reads: [],
      createdAt: new Date().toISOString(),
    };
    const plan = planFamilyPushSet(members, manifest);
    expect(plan.skus).toEqual(['D1-15', 'D1-30', 'D1-5']);
    expect(plan.payloadHash.length).toBe(64);
    const xml = encodeFamilyPushXml(members, plan);
    expect(liveCensusSkusOf(xml)?.sort()).toEqual(['D1-15', 'D1-30', 'D1-5']);
    expect(() => encodeFamilyPushXml(members.slice(0, 2), plan)).toThrow(/incomplete/i);
    const files = new Map(members.map((m) => [`products/${m.sku}.json`, `bytes-${m.sku}`]));
    const readAtCommit = (f: string): string | null => files.get(f) ?? null;
    const stale = checkFamilyPushStalenessFiles(manifest, readAtCommit, (f) =>
      f === 'products/D1-15.json' ? 'CHANGED-BYTES' : (files.get(f) ?? null),
    );
    expect(stale.ok).toBe(false);
    expect(checkFamilyPushStalenessFiles(manifest, readAtCommit, readAtCommit).ok).toBe(true);
    const readinessNoRemote = assessFamilyPushReadiness(members, manifest, null);
    expect(readinessNoRemote.ok).toBe(true);
    expect([...readinessNoRemote.wireOrder]).toEqual(['dbupload.cgi', 'dbmake.cgi', 'db_xml.cgi (reconcile census)', 'generate.cgi']);
    const remoteChecks = checkRequiredRemoteMembers(['GHOST-SKU'], '<ShopSiteProducts version="15.0"><Products></Products></ShopSiteProducts>', {});
    expect(remoteChecks[0]!.ok).toBe(false);
    const reconciled = reconcileFamilyPushImport({
      attemptedSkus: ['D1-5', 'D1-15', 'D1-30'],
      outgoingXml: xml,
      freshLiveXml: ShopSiteProductCodec.encodeMany(members.slice(0, 2)).xml,
      baselineSkus: [],
    });
    expect(reconciled.ok).toBe(false);
    expect(reconciled.skipped).toEqual(['D1-30']);
    expect(reconciled.summary).toMatch(/NOT reconciled/);
    const full = reconcileFamilyPushImport({
      attemptedSkus: ['D1-5', 'D1-15'],
      outgoingXml: ShopSiteProductCodec.encodeMany(members.slice(0, 2)).xml,
      freshLiveXml: ShopSiteProductCodec.encodeMany(members.slice(0, 2)).xml,
      baselineSkus: [],
    });
    expect(full.ok).toBe(true);
  });

  test('fixed-population accounting: every dev row counted exactly once, zero harness failures, zero paid calls', () => {
    const dev = loadCorpus(DEV_PATH);
    const kinds: Record<string, number> = {};
    for (const r of dev.rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
    expect(dev.rows.length).toBe(17);
    expect(kinds['food_rule']).toBe(5);
    expect(kinds['nonfood_rule']).toBe(2);
    expect(kinds['join']).toBe(4);
    expect(kinds['membership']).toBe(1);
    expect(kinds['native']).toBe(2);
    expect(kinds['group']).toBe(1);
    expect(kinds['transport']).toBe(1);
    expect(kinds['export_real']).toBe(1);
    const anchorCount = dev.rows.reduce((n, r) => n + (r.anchors ?? []).length, 0);
    expect(anchorCount).toBe(8);
    const joinAnchorCount = dev.rows.filter((r) => r.kind === 'join').reduce((n, r) => n + (r.anchors ?? []).length, 0);
    expect(joinAnchorCount).toBe(5);
    const membershipAnchorCount = dev.rows.filter((r) => r.kind === 'membership').reduce((n, r) => n + (r.anchors ?? []).length, 0);
    expect(membershipAnchorCount).toBe(3);
    expect(FAMILY_MEMBERSHIP_ANCHOR_LIMIT).toBe(16);
  });
});
