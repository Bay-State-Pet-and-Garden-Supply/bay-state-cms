/**
 * Unit tests for `src/classification/curation-target-ranker.ts`.
 *
 * Tests the ranker's parameter acceptance and behavior without
 * an active LLM configuration (returns null gracefully).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { unlinkSync, existsSync } from 'node:fs';
import { initDb, closeDb, resetDb } from '../../db/connection';
import { runMigrations } from '../../db/migrations';
import { llmRankOptions } from '../../classification/curation-target-ranker';
import { buildEvidenceText } from '../../classification/curation-target-matcher';
import type { ClassificationEvidence } from '../../shared/schemas/classification';

const TEST_DB = 'src/tests/unit/curation-target-ranker-test.db';

beforeAll(() => {
  try { resetDb(); } catch { /* ok */ }
  initDb(TEST_DB);
  runMigrations();
});

afterAll(() => {
  closeDb();
  try { if (existsSync(TEST_DB)) unlinkSync(TEST_DB); } catch { /* ok */ }
  try { if (existsSync(`${TEST_DB}-wal`)) unlinkSync(`${TEST_DB}-wal`); } catch { /* ok */ }
  try { if (existsSync(`${TEST_DB}-shm`)) unlinkSync(`${TEST_DB}-shm`); } catch { /* ok */ }
});

describe('Curation Target Ranker', () => {
  describe('llmRankOptions with no LLM config', () => {
    it('returns null when evidence text is too short', async () => {
      const result = await llmRankOptions({
        targetLabel: 'Flavor',
        options: [{ value: 'Chicken', label: 'Chicken' }],
        selectionMode: 'single',
        evidenceText: 'ab',
      });
      expect(result).toBeNull();
    });

    it('returns null when options are empty', async () => {
      const result = await llmRankOptions({
        targetLabel: 'Flavor',
        options: [],
        selectionMode: 'single',
        evidenceText: 'Chicken flavored dog food',
      });
      expect(result).toBeNull();
    });

    it('returns null when no LLM config exists (no task configs configured)', async () => {
      const result = await llmRankOptions({
        targetLabel: 'Flavor',
        options: [
          { value: 'Chicken', label: 'Chicken' },
          { value: 'Beef', label: 'Beef' },
        ],
        selectionMode: 'single',
        evidenceText: 'Chicken flavored dog food recipe',
      });
      // No task configs configured → getLlmConfigForTask returns null → ranker returns null
      expect(result).toBeNull();
    });
  });

  describe('llmRankOptions accepts task parameter', () => {
    it('accepts product_type_classification task param without crashing', async () => {
      const result = await llmRankOptions({
        targetLabel: 'Product Type',
        options: [
          { value: 'dry-dog-food', label: 'Dry Dog Food' },
          { value: 'wet-dog-food', label: 'Wet Dog Food' },
        ],
        selectionMode: 'single',
        evidenceText: 'Premium dry dog food for adult dogs',
        task: 'product_type_classification',
      });
      // No LLM config → returns null gracefully (not an error)
      expect(result).toBeNull();
    });

    it('accepts category_page_assignment task param without crashing', async () => {
      const result = await llmRankOptions({
        targetLabel: 'Category Page',
        options: [
          { value: 'Dog Food', label: 'Dog Food' },
          { value: 'Dog Treats', label: 'Dog Treats' },
        ],
        selectionMode: 'multiple',
        evidenceText: 'Dog food for large breed adult dogs',
        task: 'category_page_assignment',
      });
      expect(result).toBeNull();
    });

    it('accepts attribute_value_classification task param without crashing', async () => {
      const result = await llmRankOptions({
        targetLabel: 'Flavor',
        options: [
          { value: 'Chicken', label: 'Chicken' },
          { value: 'Salmon', label: 'Salmon' },
        ],
        selectionMode: 'single',
        evidenceText: 'Salmon and sweet potato recipe',
        task: 'attribute_value_classification',
      });
      expect(result).toBeNull();
    });
  });

  describe('buildEvidenceText', () => {
    it('produces text and collects IDs from evidence (no DB needed)', () => {
      const evidence: ClassificationEvidence[] = [
        { id: 'e1', runId: '', stageName: 'evidence_extraction', productSku: '', attributeId: null, source: 'spreadsheet', reliability: 'medium', sourceUrl: null, sourceField: 'name', snippet: 'Dog Food', value: 'Dog Food', metadata: {}, capturedAt: '' },
        { id: 'e2', runId: '', stageName: 'evidence_extraction', productSku: '', attributeId: null, source: 'official_product_page', reliability: 'medium', sourceUrl: null, sourceField: 'title', snippet: 'Premium Dog Food', value: 'Premium Dog Food', metadata: {}, capturedAt: '' },
      ];
      const result = buildEvidenceText(evidence);
      expect(result.text).toBe('Dog Food Premium Dog Food');
      expect(result.evidenceIds).toEqual(['e1', 'e2']);
    });

    it('returns empty for empty evidence', () => {
      const result = buildEvidenceText([]);
      expect(result.text).toBe('');
      expect(result.evidenceIds).toEqual([]);
    });
  });
});
