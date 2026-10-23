import { findItemById } from '../../../db/repositories/onboarding-item-repo';
import type { Database } from '../../../db/driver';
import { submitManualEvidence } from '../../../onboarding/manual-evidence-service';
import { refreshItemEvidence } from '../../../onboarding/item-evidence';
import { refreshListingEvidenceRunCurrentness } from './listing-evidence-authority';
import { upsertBrandSite } from '../../../db/repositories/brand-site-repo';
import { proposePageCandidate, recordOfficialPageDecision } from '../../../db/repositories/official-page-decision-repo';
import { insertExtraction } from '../../../db/repositories/onboarding-extraction-repo';

/**
 * Admit per-item listing evidence for a hand-rolled promotion run and bind
 * the execution-currentness receipt to that run. Shared by the promotion
 * suites whose fixtures build their own proposals/decisions instead of the
 * draft-promoter seedAcceptedCategoryProposal helper.
 *
 * With attest=true the operator transcription is created first (official
 * path: stage must be collect_details/failed for admission); with
 * attest=false the existing accepted snapshot is re-accepted under the
 * current item state (e.g. after repointing classificationRunId at a new
 * run). Distributor-record items never attest — their sourcing generation
 * is the authority and refreshItemEvidence re-admits from it.
 *
 * The service's manual extraction becomes the canonical item payload (the
 * manual row must equal current extraction_data_json), so the fixture's
 * pre-written extraction is NOT restored. Draft images ride via
 * reviewedMedia in curation; price stays spreadsheet-only (the manual
 * extraction carries identity/copy only, never price).
 *
 * Receipt LAST: it hashes proposals, so every run proposal must exist first.
 * Callers approve AFTER this helper — authority writes invalidate durable
 * approval.
 */
export function seedPromotionEvidenceAuthority(
  workspaceId: string,
  db: Database,
  sku: string,
  runId: string,
  attest: boolean,
): void {
  const row = db.query(
    'SELECT id, source_type, curation_data_json, extraction_data_json FROM onboarding_items WHERE upc = ? ORDER BY created_at DESC LIMIT 1',
  ).get(sku) as unknown as {
    id: string;
    source_type: string | null;
    curation_data_json: string | null;
    extraction_data_json: string | null;
  };
  const fullItem = findItemById(row.id);
  if (!fullItem) throw new Error(`seed fixture item missing for SKU ${sku}`);
  const isDistributor = (row.source_type ?? (fullItem as { sourceType?: string }).sourceType) === 'distributor_record';
  if (attest && !isDistributor) {
    const extractionData = row.extraction_data_json ? JSON.parse(row.extraction_data_json) as Record<string, unknown> : {};
    const curatedForAttest = row.curation_data_json ? JSON.parse(row.curation_data_json) as Record<string, unknown> : {};
    const curatedTitleForAttest = typeof curatedForAttest.curatedTitle === 'string' && curatedForAttest.curatedTitle.trim()
      ? curatedForAttest.curatedTitle.trim()
      : null;
    const attestedTitle = curatedTitleForAttest ?? (typeof extractionData.title === 'string' ? extractionData.title : fullItem.name);
    const attestedBrand = typeof extractionData.brand === 'string' ? extractionData.brand : fullItem.brandHint ?? 'Test Brand';
    const attestedDescription = typeof extractionData.description === 'string' ? extractionData.description : undefined;
    const attestedWeight = typeof extractionData.weight === 'string' ? extractionData.weight : undefined;
    db.run(
      `UPDATE onboarding_items SET stage = 'collect_details', stage_status = 'failed', error_message = 'No extractor profile for this domain' WHERE id = ?`,
      [row.id],
    );
    const submitted = submitManualEvidence(
      {
        itemId: row.id,
        workspaceId,
        operatorId: 'promotion-test-operator',
        title: attestedTitle,
        brand: attestedBrand,
        ...(attestedDescription ? { description: attestedDescription } : {}),
        ...(attestedWeight ? { weight: attestedWeight } : {}),
        attestation: { noFamilyInheritance: true, perSkuVerified: true, rightsAttested: true },
        familyPageOnlyConfirmed: true,
      },
      { findProfileByDomain: () => null },
    );
    if (!submitted.ok) throw new Error(`seed fixture evidence submission failed for SKU ${sku}: ${submitted.code}`);
    const admitted = refreshItemEvidence(workspaceId, row.id);
    if (admitted.status !== 'accepted' || !admitted.evidence) {
      throw new Error(`seed fixture evidence admission failed for SKU ${sku}: ${admitted.status}`);
    }
    const testPrimaryImage = typeof extractionData.primaryImage === 'string' && extractionData.primaryImage.trim()
      ? extractionData.primaryImage.trim()
      : null;
    const testAdditionalImages = Array.isArray(extractionData.additionalImages)
      ? extractionData.additionalImages.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
      : [];
    const curationData = row.curation_data_json ? JSON.parse(row.curation_data_json) : {};
    curationData.classificationRunId = runId;
    if (testPrimaryImage || testAdditionalImages.length > 0) {
      curationData.reviewedMedia = { primaryImage: testPrimaryImage, orderedAdditional: testAdditionalImages, suppressed: [] };
    }
    db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify(curationData), row.id]);
    db.run(`UPDATE onboarding_items SET stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?`, [row.id]);
  }
  const reaccepted = refreshItemEvidence(workspaceId, row.id);
  if (reaccepted.status !== 'accepted' || !reaccepted.evidence) {
    throw new Error(
      `seed fixture evidence re-acceptance failed for SKU ${sku}: ${reaccepted.status} (${reaccepted.findings.map((f) => f.code + ':' + f.reason).join(' | ')})`,
    );
  }
  refreshListingEvidenceRunCurrentness(workspaceId, row.id, runId);
}

/**
 * Admit extractor-path (official-page) evidence for a hand-rolled promotion
 * run and bind the execution-currentness receipt to that run. Unlike the
 * manual path, the official observation preserves the staged rich extraction
 * (variantAttributes, color, seoFileName, price) — the naming gate's
 * measurement/color holds and the seo-slug preference need those fields.
 *
 * Fixture contract (mirrors accepted-item-evidence-db official pattern):
 * - item at find_product_page/failed with sourceType official_page;
 * - brand-site approval for the URL domain (upsertBrandSite);
 * - operator-confirmed page decision bound to a discovery run;
 * - extraction row whose payload equals the item payload and whose
 *   raw_structured_data_json equals the fieldProvenance (direct sources);
 * - distinctive item/page titles so identity matching is unambiguous.
 *
 * The caller stages the rich extraction (with direct-source fieldProvenance)
 * on the item BEFORE calling; this helper normalizes provenance, creates the
 * source/decision/extraction rows, admits evidence, restores promotion stage,
 * and binds the receipt LAST (proposals must exist first).
 */
export function seedOfficialEvidenceAuthority(
  workspaceId: string,
  db: Database,
  sku: string,
  runId: string,
  sourceUrl: string,
): void {
  const row = db.query(
    'SELECT id, name, brand_hint, source_type, stage, curation_data_json, extraction_data_json FROM onboarding_items WHERE upc = ? ORDER BY created_at DESC LIMIT 1',
  ).get(sku) as unknown as {
    id: string;
    name: string;
    brand_hint: string | null;
    source_type: string | null;
    stage: string;
    curation_data_json: string | null;
    extraction_data_json: string | null;
  };
  const fullItem = findItemById(row.id);
  if (!fullItem) throw new Error(`seed fixture item missing for SKU ${sku}`);
  const brandHint = row.brand_hint ?? 'Test Brand';
  const domain = new URL(sourceUrl).hostname.toLowerCase();
  upsertBrandSite(brandHint, domain);
  // Official-path items enter through find_product_page; the decision API
  // fails closed otherwise.
  db.run(`UPDATE onboarding_items SET source_type = 'official_page', stage = 'find_product_page', stage_status = 'failed' WHERE id = ?`, [row.id]);
  const source = proposePageCandidate({ itemId: row.id, url: sourceUrl, origin: 'operator' });
  const sourceRunId = `discovery-${row.id.slice(0, 8)}`;
  db.run('UPDATE onboarding_sources SET discovery_run_id = ? WHERE id = ?', [sourceRunId, source.id]);
  const title = row.name;
  recordOfficialPageDecision({
    workspaceId,
    itemId: row.id,
    sourceId: source.id,
    evidenceKind: 'operator_name',
    pageTitle: title,
    variantKey: null,
    signals: {
      pageTitle: title,
      isProductDetailPage: true,
      brand: brandHint,
      observedGtins: [],
      originalUrl: sourceUrl,
      finalUrl: sourceUrl,
    },
    sourceRunId,
  });
  // Normalize the staged extraction to direct-source provenance so the
  // official observation admits every structured field. The extraction row
  // payload must equal the item payload byte-for-byte, and raw_structured
  // must equal the provenance map.
  const staged = row.extraction_data_json ? JSON.parse(row.extraction_data_json) as Record<string, unknown> : {};
  const provenance: Record<string, string> = {};
  for (const field of Object.keys(staged)) {
    if (field === 'fieldProvenance' || field === 'sourceType' || field === 'sourceUrl' || field === 'confidence') continue;
    const value = staged[field];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0) continue;
    provenance[field] = 'json-ld';
  }
  const payload = { ...staged, sourceType: 'official_page', sourceUrl, fieldProvenance: provenance };
  const payloadJson = JSON.stringify(payload);
  insertExtraction({
    itemId: row.id,
    sourceType: 'official_page',
    sourceUrl,
    extractionMethod: 'static_extraction',
    extractionDataJson: payloadJson,
    rawStructuredDataJson: JSON.stringify(provenance),
    confidence: 1,
  });
  db.run('UPDATE onboarding_items SET extraction_data_json = ? WHERE id = ?', [payloadJson, row.id]);
  const admitted = refreshItemEvidence(workspaceId, row.id);
  if (admitted.status !== 'accepted' || !admitted.evidence) {
    throw new Error(
      `seed fixture official evidence admission failed for SKU ${sku}: ${admitted.status} (${admitted.findings.map((f) => f.code + ':' + f.reason).join(' | ')})`,
    );
  }
  const curationData = row.curation_data_json ? JSON.parse(row.curation_data_json) : {};
  curationData.classificationRunId = runId;
  db.run('UPDATE onboarding_items SET curation_data_json = ? WHERE id = ?', [JSON.stringify(curationData), row.id]);
  db.run(`UPDATE onboarding_items SET stage = 'promotion', stage_status = 'pending', status = 'ready' WHERE id = ?`, [row.id]);
  const reaccepted = refreshItemEvidence(workspaceId, row.id);
  if (reaccepted.status !== 'accepted' || !reaccepted.evidence) {
    throw new Error(
      `seed fixture official evidence re-acceptance failed for SKU ${sku}: ${reaccepted.status} (${reaccepted.findings.map((f) => f.code + ':' + f.reason).join(' | ')})`,
    );
  }
  refreshListingEvidenceRunCurrentness(workspaceId, row.id, runId);
}

