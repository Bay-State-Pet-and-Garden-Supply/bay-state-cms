#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { PRIVATE_ROOT, runDiagnostics } from './comparison-diagnostics';

const root = mkdtempSync(path.join(PRIVATE_ROOT, 'diagnostics-smoke-'));
try {
  const inputDirectory = path.join(root, 'onboarding-outcome-v1');
  const attempt = path.join(root, 'attempt');
  const output = path.join(root, 'output');
  mkdirSync(path.join(attempt, 'db'), { recursive: true });
  mkdirSync(path.join(attempt, 'artifacts'), { recursive: true });
  mkdirSync(inputDirectory, { recursive: true });
  const inputBytes = JSON.stringify([
    { row_id: 'smoke-html', upc: '100000000001', register_name: 'Smoke Product 8 oz', price: '3.25' },
    { row_id: 'smoke-url-only', upc: '100000000002', register_name: 'Smoke Product 16 oz', price: '5.25' },
  ]);
  const inputPath = path.join(inputDirectory, 'development-input.json');
  writeFileSync(inputPath, inputBytes);
  const db = new Database(path.join(attempt, 'db/evaluation.sqlite'));
  db.exec(`CREATE TABLE onboarding_items(id TEXT PRIMARY KEY,upc TEXT,name TEXT,brand_hint TEXT,status TEXT,error_message TEXT,row_number INTEGER,price TEXT,is_duplicate INTEGER DEFAULT 0);
    CREATE TABLE onboarding_sources(id TEXT PRIMARY KEY,item_id TEXT,url TEXT,title TEXT,snippet TEXT,domain TEXT,metadata_json TEXT);`);
  db.query(`INSERT INTO onboarding_items VALUES('html','100000000001','Smoke Product 8 oz','Smoke','imported','No matching product pages found',1,'3.25',0)`).run();
  db.query(`INSERT INTO onboarding_items VALUES('url','100000000002','Smoke Product 16 oz','Smoke','imported','No matching product pages found',2,'5.25',0)`).run();
  writeFileSync(path.join(attempt, 'artifacts/retained.html'), '<html><h1>Smoke Product 8 oz</h1><select><option>8 oz</option></select></html>');
  db.query(`INSERT INTO onboarding_sources VALUES('retained','html','https://smoke.example/item','old title','old snippet','smoke.example',?1)`).run(JSON.stringify({ originalUrl: 'https://smoke.example/item', finalUrl: 'https://smoke.example/actual', artifactPath: 'artifacts/retained.html', artifactComplete: true }));
  db.query(`INSERT INTO onboarding_sources VALUES('url-only','url','https://smoke-other.example/old','URL record title','URL record snippet','smoke-other.example',?1)`).run(JSON.stringify({ originalUrl: 'https://smoke-other.example/old' }));
  db.close();
  const inputHash = createHash('sha256').update(inputBytes).digest('hex');
  const report = runDiagnostics({ developmentInputPath: inputPath, developmentInputSha256: inputHash, sourceAttemptPath: attempt, outputPath: output }) as { observations: Array<{ row_id:string; candidates:Array<{artifact_status:string;observations:{heading:string}|null}> }> };
  const retained = report.observations.find(row => row.row_id === 'smoke-html')?.candidates[0];
  const urlOnly = report.observations.find(row => row.row_id === 'smoke-url-only')?.candidates[0];
  if (retained?.artifact_status !== 'retained_complete_bytes_inspected' || retained.observations?.heading !== 'Smoke Product 8 oz') throw new Error('Retained HTML was not inspected');
  if (urlOnly?.artifact_status !== 'page_artifact_unavailable' || urlOnly.observations !== null) throw new Error('URL-only candidate was incorrectly treated as page evidence');
  const commitment = JSON.parse(readFileSync(path.join(output, 'sample-commitment.json'), 'utf8')) as { selected: unknown[] };
  if (commitment.selected.length !== 2) throw new Error('Unexpected sample commitment');
  console.log(JSON.stringify({ status: 'PASS', retained_html: retained.artifact_status, url_only: urlOnly.artifact_status, sample_rows: commitment.selected.length }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
