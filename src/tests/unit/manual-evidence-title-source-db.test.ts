// Ticket #104 (parent #101) — manual title-source eligibility, isolated lane.
//
// Runs in its OWN test:db segment: neighboring suites mock
// `../../onboarding/title-consolidation` at module level, and bun shares
// the module registry per process — co-running would exercise the mock
// instead of the real consolidator. Uses bun:sqlite imports, so vitest
// cannot collect it. No database needed (deterministic no-LLM path is
// DB-free); no initDb/runMigrations here.
import { describe, test, expect } from 'bun:test';
import { nameConsolidationStage } from '../../classification/stages/name-consolidation';
import { consolidateProductTitle } from '../../onboarding/title-consolidation';
import type { ClassificationEvidence } from '../../shared/types';

describe('full set: manual title eligibility (no LLM, deterministic)', () => {
  test('operator-verified manual title wins with source manual; OCR still outranks', async () => {
    const manual = await consolidateProductTitle(
      { name: 'BUTCHER PUP TREATS', manualTitle: 'Butcher\u2019s Pup Chicken Recipe' },
      null,
      undefined,
    );
    expect(manual.title).toBe('Butcher\u2019s Pup Chicken Recipe');
    expect(manual.source).toBe('manual');
    const ocr = await consolidateProductTitle(
      { name: 'BUTCHER PUP TREATS', manualTitle: 'Manual Title', ocrTitle: 'OCR Title' },
      null,
      undefined,
    );
    expect(ocr.source).toBe('ocr');
    const legacy = await consolidateProductTitle({ name: 'BUTCHER PUP TREATS' }, null, undefined);
    expect(legacy.source).toBe('web');
  });

  test('name-consolidation emits titleSource manual for operator-manual evidence', async () => {
    const evidence = (source: string, sourceField: string, value: string): ClassificationEvidence => ({
      id: `e-${source}-${sourceField}`,
      runId: 'run-1',
      stageName: 'evidence_extraction',
      productSku: 'upc-manual-1',
      attributeId: null,
      source: source as ClassificationEvidence['source'],
      reliability: 'low',
      sourceUrl: null,
      sourceField,
      snippet: value.slice(0, 300),
      value,
      metadata: { provenance: 'manual_evidence' },
      capturedAt: new Date().toISOString(),
    });
    const result = await nameConsolidationStage.execute(
      {
        sku: 'upc-manual-1',
        evidence: [
          evidence('spreadsheet', 'name', 'BUTCHER PUP TREATS'),
          evidence('operator_manual', 'name', 'Butcher\u2019s Pup Chicken Recipe'),
        ],
        acceptedProposals: [],
        allProposals: [],
      },
      {
        workspacePath: '/tmp/ws',
        workspaceId: 'ws-1',
        configSnapshotRef: { id: 'snap', hash: 'hash', sourceCommit: null, createdAt: new Date().toISOString() },
        runId: 'run-1',
      },
    );
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    const metadata = (result.output as { metadata?: Record<string, unknown> }).metadata ?? {};
    expect(metadata.titleSource).toBe('manual');
    expect(metadata.curatedTitle).toBe('Butcher\u2019s Pup Chicken Recipe');
  });

  test('non-manual evidence keeps the legacy fallback order byte-identical', async () => {
    const evidence = (source: string, sourceField: string, value: string): ClassificationEvidence => ({
      id: `e2-${source}-${sourceField}`,
      runId: 'run-2',
      stageName: 'evidence_extraction',
      productSku: 'upc-manual-2',
      attributeId: null,
      source: source as ClassificationEvidence['source'],
      reliability: 'low',
      sourceUrl: null,
      sourceField,
      snippet: value.slice(0, 300),
      value,
      metadata: { provenance: 'spreadsheet_import' },
      capturedAt: new Date().toISOString(),
    });
    const result = await nameConsolidationStage.execute(
      {
        sku: 'upc-manual-2',
        evidence: [evidence('spreadsheet', 'name', 'BUTCHER PUP TREATS')],
        acceptedProposals: [],
        allProposals: [],
      },
      {
        workspacePath: '/tmp/ws',
        workspaceId: 'ws-1',
        configSnapshotRef: { id: 'snap', hash: 'hash', sourceCommit: null, createdAt: new Date().toISOString() },
        runId: 'run-2',
      },
    );
    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    const metadata = (result.output as { metadata?: Record<string, unknown> }).metadata ?? {};
    expect(metadata.titleSource).toBe('web');
    expect(metadata.curatedTitle).toBe('BUTCHER PUP TREATS');
  });
});
