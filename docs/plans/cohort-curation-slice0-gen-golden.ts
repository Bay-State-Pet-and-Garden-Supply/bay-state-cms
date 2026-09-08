// Slice 0 golden generator — pure functions only, no DB, no network.
// Run: bun docs/plans/cohort-curation-slice0-gen-golden.ts
import { computeCohortTitleInputHash } from '../../src/onboarding/cohort-curation/titles';
import { buildCohortPageAuthorityBundle, computeCohortPageInputHash } from '../../src/onboarding/cohort-curation/pages';
import { computeExtractionHash, computeMembershipHash } from '../../src/db/repositories/curation-cohort-repo';

function memberV1(id: string, sku: string, ordinal: number) {
  return {
    onboardingItemId: id,
    ordinal,
    productSku: sku,
    extractionComplete: true as const,
    sourceUrl: 'https://brand.example/p1',
    extractionSourceUrl: 'https://brand.example/p1',
    sourcingDecision: null,
    spreadsheetIdentity: {
      name: 'RAW CHKN 5LB', expectedName: 'Chicken 5 lb', brandHint: 'PawCo',
      departmentHint: 'Food', price: '19.99', quantity: 1, rowNumber: 2, upc: sku,
    },
    extraction: {
      title: 'PawCo Chicken Recipe 5 lb', description: 'desc', brand: 'PawCo',
      weight: '5 lb', bulletPoints: [], searchKeywords: 'chicken',
      primaryImage: null, additionalImages: [], customFields: {},
      fieldProvenance: {}, manualEvidenceAttestationId: null, manualReferenceUrl: null,
      packagingTitle: 'PawCo Chicken 5 lb Pouch',
      ocr: { outcome: null, packagingOcrData: null, ocrInputHash: 'ocr-input-hash-1', ocrExecutionDigest: 'ocr-exec-digest-1' },
      piEvidence: [], piImportComplete: true as const,
    },
    evidenceHash: `member-evidence-hash-${ordinal}`,
  };
}

const run: any = {
  id: 'run-slice0', workspaceId: 'ws-slice0', cohortId: 'cohort-slice0',
  candidateMembershipHash: 'candidate-membership-slice0',
  finalMembershipHash: 'final-membership-slice0',
  executionProductTypeId: 'type-1', productTypeConfidence: 0.9,
  productTypeOutcome: 'coherent',
};
const projection: any = { version: 'execution-evidence-v1' as const, members: [memberV1('item-1', 'SKU-1', 0), memberV1('item-2', 'SKU-2', 1)] };

const titleHash = computeCohortTitleInputHash({ run, projection });
const bundle = buildCohortPageAuthorityBundle({
  run, projection,
  pagePlan: { pages: [{ id: 'page-1', name: 'Dog Food', parentName: null }], selectionMode: 'single', maxPages: 1 },
});
const pageHash = computeCohortPageInputHash(bundle);
const syntheticItem: any = {
  extractionData: { title: 'PawCo Chicken Recipe 5 lb', brand: 'PawCo' },
  sourcingDecision: null, sourceUrl: 'https://brand.example/p1',
  sourceType: 'official_page', acceptedEvidenceAttemptIds: [],
};
const h2 = computeExtractionHash(syntheticItem);
const membership = computeMembershipHash(['item-2', 'item-1']);

const out = {
  generatedBy: 'slice0-baseline',
  implementationHashes: {
    'src/onboarding/cohort-title-hash.ts': '1707317d7fc8d4bc205ad2429253d909f0826451c56c9c0c74a41a486e10392d',
    'src/onboarding/cohort-page-hash.ts': '47810346b9a1f076514d9b6a6a33b528d17bcdfaaff77667a992af4c886139a4',
  },
  inputs: { run, projection, pagePlan: { pages: [{ id: 'page-1', name: 'Dog Food', parentName: null }], selectionMode: 'single', maxPages: 1 } },
  expected: { titleHashV2: titleHash, pageHashV1: pageHash, extractionHashH2: h2, membershipHash: membership },
  canonicalDraftContract: 'PR8 DECISION-E: hashCanonicalJson over curatedTitle/titleSource/suggestedPages/searchKeywords/curatedDescription/curatedWeight/suggestedProductType/packagingOcrTitle + projection{fieldAssignments,pageAssignments,title}; ids/timestamps excluded; proven by pr8-acceptance.test.ts retry byte-identity',
};
console.log(JSON.stringify(out, null, 2));
