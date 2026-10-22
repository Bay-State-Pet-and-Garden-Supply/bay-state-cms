import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { PRIVATE_ROOT, runDiagnostics } from '../../../scratch/comparison-diagnostics';

const created: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(PRIVATE_ROOT, 'diagnostics-test-'));
  created.push(root);
  const inputDirectory = path.join(root, 'onboarding-outcome-v1');
  const attempt = path.join(root, 'attempt');
  mkdirSync(path.join(attempt, 'db'), { recursive: true });
  mkdirSync(path.join(attempt, 'artifacts'), { recursive: true });
  const inputPath = path.join(inputDirectory, 'development-input.json');
  mkdirSync(inputDirectory, { recursive: true });
  const inputs = [
    { row_id: 'row-a', upc: '123456789012', register_name: 'Acme Dog Food 12 oz', price: '4.50' },
    { row_id: 'row-b', upc: '123456789013', register_name: 'Acme Dog Food 24 oz', price: '8.50' },
  ];
  const inputBytes = JSON.stringify(inputs);
  writeFileSync(inputPath, inputBytes);
  const db = new Database(path.join(attempt, 'db/evaluation.sqlite'));
  db.exec(`CREATE TABLE onboarding_items(id TEXT PRIMARY KEY,upc TEXT,name TEXT,brand_hint TEXT,status TEXT,error_message TEXT,row_number INTEGER,price TEXT,is_duplicate INTEGER DEFAULT 0);
    CREATE TABLE onboarding_sources(id TEXT PRIMARY KEY,item_id TEXT,url TEXT,title TEXT,snippet TEXT,domain TEXT,metadata_json TEXT);`);
  db.query(`INSERT INTO onboarding_items VALUES('item-a','123456789012','Acme Dog Food 12 oz','Acme','imported','No matching product pages found',1,'4.50',0)`).run();
  db.query(`INSERT INTO onboarding_items VALUES('item-b','123456789013','Acme Dog Food 24 oz','Acme','imported','No matching product pages found',2,'8.50',0)`).run();
  const html = '<html><h1>Acme Dog Food 12 oz</h1><select><option>12 oz</option></select><script type="application/ld+json">{"@type":"Product","name":"Acme Dog Food 12 oz"}</script></html>';
  writeFileSync(path.join(attempt, 'artifacts/page.html'), html);
  db.query(`INSERT INTO onboarding_sources VALUES('source-a','item-a','https://acme.example/item','historical title','historical snippet','acme.example',?1)`).run(JSON.stringify({ originalUrl: 'https://acme.example/item', finalUrl: 'https://acme.example/final', artifactPath: 'artifacts/page.html', artifactComplete: true }));
  db.query(`INSERT INTO onboarding_sources VALUES('source-b','item-b','https://acme-other.example/other','URL-only title','URL-only snippet','acme-other.example',?1)`).run(JSON.stringify({ originalUrl: 'https://acme-other.example/other' }));
  db.close();
  return { root, attempt, inputPath, inputHash: createHash('sha256').update(inputBytes).digest('hex') };
}
afterEach(() => { for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('offline source comparison diagnostics', () => {
  test('commits deterministic development sample before inspecting retained bytes and keeps URL-only evidence unavailable', () => {
    const f = fixture();
    const output = path.join(f.root, 'diagnostics');
    const result = runDiagnostics({ developmentInputPath: f.inputPath, developmentInputSha256: f.inputHash, sourceAttemptPath: f.attempt, outputPath: output }) as { observations: Array<{ row_id: string; imported_price: string; candidates: Array<{ artifact_status: string; original_url: string; final_url: string | null; artifact_sha256: string | null; observations: { heading: string } | null }> }> };
    expect(result.observations).toHaveLength(2);
    const retained = result.observations.find(row => row.row_id === 'row-a')!.candidates[0]!;
    expect(retained.artifact_status).toBe('retained_complete_bytes_inspected');
    expect(retained.original_url).toBe('https://acme.example/item');
    expect(retained.final_url).toBe('https://acme.example/final');
    expect(retained.observations?.heading).toBe('Acme Dog Food 12 oz');
    expect(retained.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    const unavailable = result.observations.find(row => row.row_id === 'row-b')!.candidates[0]!;
    expect(unavailable.artifact_status).toBe('page_artifact_unavailable');
    expect(unavailable.observations).toBeNull();
    expect(unavailable.original_url).toBe('https://acme-other.example/other');
    expect(result.observations.find(row => row.row_id === 'row-a')!.imported_price).toBe('4.50');
  });

  test('rejects input hash mismatch and existing diagnostic outputs', () => {
    const f = fixture();
    expect(() => runDiagnostics({ developmentInputPath: f.inputPath, developmentInputSha256: '0'.repeat(64), sourceAttemptPath: f.attempt, outputPath: path.join(f.root, 'bad') })).toThrow(/SHA-256 mismatch/);
    const output = path.join(f.root, 'existing');
    mkdirSync(output);
    expect(() => runDiagnostics({ developmentInputPath: f.inputPath, developmentInputSha256: f.inputHash, sourceAttemptPath: f.attempt, outputPath: output })).toThrow(/new path/);
  });
});
