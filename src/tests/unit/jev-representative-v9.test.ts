/**
 * bay-state-v9 representative corpus — mechanical re-baseline invariants.
 *
 * The v9 corpus was re-bound from v8 to the bay-state-v9 authority
 * (authorityHash ff17dc31…) by `scripts/build-jev-representative-v9.ts` and
 * applies the owner-decided safety-toe-type retirement. Labels, evidence, and
 * citations are copied verbatim. The independent peer pass (separate agent,
 * 0 model calls / 0 network calls) re-derived every number from the artifact
 * bytes and wrote development-peer-receipt.json; this suite pins the core
 * receipt claims alongside the corpus invariants.
 *
 * Public-boundary only: reads the approved public corpus, never holdout
 * custody; deterministic floor only — no live calls, no writes.
 */
import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { loadDevReplayInputs } from '../../classification/jev-benchmark-replay';
import { buildQualificationPredictionsFromCode } from '../../classification/benchmark-prediction';
import { sha256Hex } from '../../shared/stable-id';

const V9_DIR = 'docs/audits/jev-representative-v9';
const V9_AUTHORITY = 'ff17dc313076c4657e87fa557ae7fa182796ddfcb53ce385f7525ebc03a33026';
const V8_AUTHORITY = '78f550f0b31c51c5a3c4b5f614e0bc953a90fdbe49749b7b39d6cd2ceeeef2de';

const loadV9 = () => loadDevReplayInputs({
  manifestPath: `${V9_DIR}/development-manifest-v9.json`,
  goldPath: `${V9_DIR}/development-gold-v9.json`,
  taxonomyPath: `${V9_DIR}/taxonomy.json`,
});

describe('bay-state-v9 representative corpus', () => {
  it('loads with the v9 authority agreed across gold, manifest, and taxonomy', () => {
    const loaded = loadV9();
    expect(loaded.authorityHash).toBe(V9_AUTHORITY);
    expect(loaded.entryCount).toBe(23);
    expect(loaded.familyCount).toBe(23);
    expect(loaded.goldEntries.every(e => e.split === 'dev')).toBe(true);
  });

  it('freezes the v9 taxonomy (74 types, 18 species options, 212 pages)', () => {
    const loaded = loadV9();
    expect(loaded.frozenSnapshot.productTypes.length).toBe(74);
    expect(loaded.frozenSnapshot.pages.length).toBe(212);
    const species = loaded.frozenSnapshot.attributeTargets.find(t => t.targetId === 'species');
    expect(species?.options.length).toBe(18);
    expect(species?.options).toContain('Wild Bird');
    expect(species?.options).toContain('Bee');
  });

  it('retires safety-toe-type: gold carries 8 controlled targets and 184 states', () => {
    const loaded = loadV9();
    const gold = JSON.parse(fs.readFileSync(`${V9_DIR}/development-gold-v9.json`, 'utf8')) as {
      qualificationTargetSet: { controlledAttributes: string[] };
      explicitFieldContract: { controlledAttributes: string[]; rule: string };
      authorityBinding: { release: string; authorityHash: string; configHash: string };
    };
    expect(gold.qualificationTargetSet.controlledAttributes).toEqual([
      'breed-size', 'flavor', 'food-form', 'fuel-type', 'hose-length', 'life-stage', 'packaging-type', 'species',
    ]);
    expect(gold.qualificationTargetSet.controlledAttributes).not.toContain('safety-toe-type');
    expect(gold.explicitFieldContract.controlledAttributes).not.toContain('safety-toe-type');
    expect(gold.explicitFieldContract.rule).toContain('all 8 inapplicable');

    const states = loaded.goldEntries.flatMap(e => e.gold.fieldAssignments);
    expect(states.length).toBe(184);
    expect(states.some(f => f.targetId === 'safety-toe-type')).toBe(false);
    expect(states.filter(f => f.state === 'known').length).toBe(16);

    expect(gold.authorityBinding.release).toBe('bay-state-v9');
    expect(gold.authorityBinding.authorityHash).toBe(V9_AUTHORITY);
  });

  it('captures the deterministic floor against the v9 frozen snapshot', () => {
    const loaded = loadV9();
    const artifact = buildQualificationPredictionsFromCode(loaded.goldEntries, loaded.frozenSnapshot);
    expect(artifact.entryCount).toBe(23);
    expect(artifact.captureMode).toBe('deterministic_floor');
    expect(artifact.artifactHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('leaves the frozen v8 corpus untouched', () => {
    const v8Gold = JSON.parse(
      fs.readFileSync('docs/audits/jev-representative-v4/development-gold-v8.json', 'utf8'),
    ) as { authorityHash: string };
    expect(v8Gold.authorityHash).toBe(V8_AUTHORITY);
  });

  it('ships the peer receipt whose commitments match the corpus bytes', () => {
    // The peer pass (independent agent, 0 model calls / 0 network calls)
    // wrote development-peer-receipt.json after re-deriving every number
    // from the artifact bytes. This test pins the receipt's core claims so
    // any future corpus mutation breaks loudly.
    const receipt = JSON.parse(
      fs.readFileSync(path.join(V9_DIR, 'development-peer-receipt.json'), 'utf8'),
    ) as {
      authorityHash: string;
      hashCommitments: Record<string, string>;
      status: string;
      counts: { goldEntries: number; fieldStatesTotal: number; fieldStatesKnown: number };
    };
    expect(receipt.authorityHash).toBe(V9_AUTHORITY);
    for (const [key, file] of Object.entries({
      devGold: 'development-gold-v9.json',
      devAdjudication: 'development-adjudication-v9.json',
      devSupport: 'development-support-v9.json',
      devManifest: 'development-manifest-v9.json',
      taxonomy: 'taxonomy.json',
      sourceBank: 'source-development.json',
    })) {
      expect(sha256Hex(fs.readFileSync(path.join(V9_DIR, file)))).toBe(receipt.hashCommitments[key]);
    }
    expect(receipt.status).toBe('peer-verified-development-only-qualification-ineligible');
    expect(receipt.counts.goldEntries).toBe(23);
    expect(receipt.counts.fieldStatesTotal).toBe(184);
    expect(receipt.counts.fieldStatesKnown).toBe(16);
  });
});
