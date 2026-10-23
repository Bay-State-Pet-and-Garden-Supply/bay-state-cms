#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { matchOfficialPageIdentity } from '../src/onboarding/official-page-identity';
import { parseVariantMatrix } from '../src/onboarding/variant-resolver';
import type { VariantMatrix } from '../src/shared/schemas/variant-resolution';
export const PRIVATE_ROOT = path.resolve('.baystate-cms/qualification');
export type Bucket = 'no_domain' | 'no_candidates' | 'ambiguous' | 'confirmation_required';
 
export type InputRow = { row_id?: string; upc: string; register_name: string; price: unknown; brand?: string | null; brand_hint?: string | null; [key: string]: unknown };
type Item = { id: string; upc: string; name: string; brand_hint: string | null; status: string; error_message: string | null; row_number: number; price: string | null };
type Candidate = { id: string; url: string; title: string | null; snippet: string | null; domain: string | null; metadata_json: string | null };
const sha = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
function within(root: string, candidate: string): boolean { const rel = path.relative(root, candidate); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); }
function privatePath(value: string, root: string, label: string): string {
  const resolved = path.resolve(value);
  if (!within(root, resolved)) throw new Error(`${label} must remain under ${root}`);
  const canonical = realpathSync(resolved);
  if (!within(realpathSync(root), canonical)) throw new Error(`${label} symlink escapes private root`);
  return canonical;
}
function readRepository(attempt: string) {
  const dbPath = privatePath(path.join(attempt, 'db/evaluation.sqlite'), PRIVATE_ROOT, 'attempt database');
  const db = new Database(dbPath, { readonly: true });
  return {
    items(): Item[] { return db.query(`SELECT id,upc,name,brand_hint,status,error_message,row_number,price FROM onboarding_items WHERE is_duplicate=0 ORDER BY row_number`).all() as Item[]; },
    candidates(itemId: string): Candidate[] { return db.query(`SELECT id,url,title,snippet,domain,metadata_json FROM onboarding_sources WHERE item_id=? ORDER BY id`).all(itemId) as Candidate[]; },
 
    close() { db.close(); },
  };
}
function bucket(item: Item, candidates: Candidate[]): Bucket {
  const reason = `${item.error_message ?? ''} ${item.status}`.toLowerCase();
  if (!candidates.length) return /setup|domain/.test(reason) ? 'no_domain' : 'no_candidates';
  if (candidates.every(candidate => !candidate.domain)) return 'no_domain';
  if (candidates.length > 1 || /ambig|variant/.test(reason)) return 'ambiguous';
  return 'confirmation_required';
}
function artifactPath(attempt: string, candidate: Candidate): string | null {
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(candidate.metadata_json ?? '{}') as Record<string, unknown>; } catch { return null; }
  const ref = [metadata.artifactPath, metadata.artifact_path, metadata.retainedArtifactPath, metadata.artifact].find(v => typeof v === 'string') as string | undefined;
  if (!ref) return null;
  const resolved = path.resolve(attempt, ref);
  return existsSync(resolved) && within(attempt, resolved) && within(realpathSync(attempt), realpathSync(resolved)) ? resolved : null;
}
function inspectHtml(html: string, url: string, expected: InputRow) {
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() ?? null;
  const variants = [...html.matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)].map(m => m[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const gtins = [...new Set((html.match(/(?:gtin(?:8|12|13|14)?|barcode|upc)["'\s:=]+["']?([0-9]{8,14})/gi) ?? []).map(x => x.match(/[0-9]{8,14}/)?.[0]).filter((x): x is string => !!x))];
  let matrix: VariantMatrix | null = null;
  try { matrix = parseVariantMatrix(html, url); } catch { /* malformed page remains an observation with no parsed matrix */ }
  const identity = heading ? matchOfficialPageIdentity({ registerName: expected.register_name, registerUpc: expected.upc, brandHint: expected.brand_hint ?? expected.brand ?? null, pageName: heading, pageBrand: null, pageKind: 'product', variants: variants.map((label, index) => ({ key: String(index), label, gtin: null })), observedGtins: gtins }) : null;
  const parsedVariants = matrix?.candidates.map(candidate => ({ variant_key: candidate.variantKey, title: candidate.title, options: candidate.options.map(option => ({ axis: option.axis, value: option.value })), gtin_observations: candidate.identifiers.filter(identifier => identifier.kind === 'gtin').map(identifier => identifier.value) })) ?? [];
  return { heading, variant_options: variants, gtin_observations: gtins, parsed_variant_observations: parsedVariants, parser_matrix_observed: matrix !== null, identity_observation: identity };
}
export function runDiagnostics(options: { developmentInputPath: string; developmentInputSha256: string; sourceAttemptPath: string; outputPath: string }): unknown {
  const attempt = privatePath(options.sourceAttemptPath, PRIVATE_ROOT, 'source attempt');
  const output = path.resolve(options.outputPath);
  let outputAncestor = path.dirname(output);
  while (!existsSync(outputAncestor) && within(PRIVATE_ROOT, outputAncestor)) outputAncestor = path.dirname(outputAncestor);
  if (!within(PRIVATE_ROOT, output) || existsSync(output) || !within(realpathSync(PRIVATE_ROOT), realpathSync(outputAncestor))) throw new Error('Output must be a new path under private qualification root');
  const repo = readRepository(attempt);
  try {
    const input = privatePath(options.developmentInputPath, PRIVATE_ROOT, 'development input');
    const inputBytes = readFileSync(input);
    const inputHash = sha(inputBytes);
    if (inputHash !== options.developmentInputSha256.toLowerCase()) throw new Error('Development input SHA-256 mismatch');
    const parsed: unknown = JSON.parse(inputBytes.toString('utf8'));
    const rows: InputRow[] = (Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' && 'rows' in parsed && Array.isArray(parsed.rows) ? parsed.rows : []) as InputRow[];
    if (!rows.length || rows.some(r => !r || typeof r.row_id !== 'string' || typeof r.upc !== 'string' || typeof r.register_name !== 'string' || !Object.hasOwn(r, 'price')) || new Set(rows.map(r => r.row_id)).size !== rows.length) throw new Error('Development input must contain unique row IDs and rows with UPC, register name and original price');
    const items = repo.items();
    const unused = [...items];
    const sourceRows = rows.map(row => {
      const matchIndex = unused.findIndex(item => item.upc === row.upc && item.name === row.register_name);
      const item = matchIndex < 0 ? undefined : unused.splice(matchIndex, 1)[0];
      return { row, item };
    });
    const eligible = sourceRows.filter((x): x is { row: InputRow; item: Item } => x.item !== undefined).map(({row,item}) => {
      const candidates = repo.candidates(item.id);
      return { row, item, candidates, bucket: bucket(item, candidates) };
    });
    const selections: Array<{bucket:Bucket;row_id:string;item_id:string;row_hash:string}> = [];
    for (const b of ['no_domain','no_candidates','ambiguous','confirmation_required'] as const) {
      const group = eligible.filter(x => x.bucket === b).sort((a,c) => {
        const left = sha(a.row.row_id!);
        const right = sha(c.row.row_id!);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      if (group[0]) selections.push({ bucket:b, row_id:group[0].row.row_id!, item_id:group[0].item.id, row_hash:sha(group[0].row.row_id!) });
      if (group[1] && group[0] && group[1].candidates.some(c => !group[0]!.candidates.some(d => d.domain === c.domain))) selections.push({ bucket:b, row_id:group[1].row.row_id!, item_id:group[1].item.id, row_hash:sha(group[1].row.row_id!) });
    }
    if (selections.length > 8) throw new Error('Sample exceeds eight rows');
    const commitmentPath = path.join(output, 'sample-commitment.json');
    mkdirSync(output, { recursive: true });
    const commitmentBase = { schema_version:1, created_at:new Date().toISOString(), development_input_sha256:inputHash, source_attempt:path.relative(PRIVATE_ROOT,attempt), selected:selections };
    const commitment = { ...commitmentBase, commitment_sha256:sha(JSON.stringify(commitmentBase)) };
    writeFileSync(commitmentPath, JSON.stringify(commitment,null,2)+'\n', { flag:'wx', mode:0o600 });
    const byItemId = new Map(eligible.map(x => [x.item.id, x]));
    const observations = selections.map(s => {
      const selected = byItemId.get(s.item_id)!;
      return { row_id:s.row_id, item_id:selected.item.id, bucket:s.bucket, imported_price: selected.row.price, candidates:selected.candidates.map(c => {
        const meta = (() => { try { return JSON.parse(c.metadata_json ?? '{}') as Record<string,unknown>; } catch { return {}; } })();
        const artifact = artifactPath(attempt,c);
        const originalUrl = typeof meta.originalUrl === 'string' ? meta.originalUrl : c.url;
        const finalUrl = typeof meta.finalUrl === 'string' ? meta.finalUrl : null;
        const domainAuthority = { status: 'unverified', provenance: 'No independent approval receipt is present in the copied source attempt.' };
        if (!artifact || (meta.artifactComplete !== true && meta.artifact_complete !== true)) return { candidate_id:c.id, original_url:originalUrl, final_url:finalUrl, title:c.title, snippet:c.snippet, declared_domain:c.domain, domain_authority:domainAuthority, artifact_status:'page_artifact_unavailable', artifact_unavailable_reason: artifact ? 'complete_artifact_bytes_not_attested' : 'retained_artifact_reference_missing', artifact_ref:artifact ? path.relative(attempt,artifact) : null, artifact_sha256:null, observations:null };
        try {
          const bytes = readFileSync(artifact);
          const content = bytes.toString('utf8');
          return { candidate_id:c.id, original_url:originalUrl, final_url:finalUrl, title:c.title, snippet:c.snippet, declared_domain:c.domain, domain_authority:domainAuthority, artifact_status:'retained_complete_bytes_inspected', artifact_ref:path.relative(attempt,artifact), artifact_sha256:sha(bytes), observations:inspectHtml(content,finalUrl ?? c.url,selected.row) };
        } catch {
          return { candidate_id:c.id, original_url:originalUrl, final_url:finalUrl, title:c.title, snippet:c.snippet, declared_domain:c.domain, domain_authority:domainAuthority, artifact_status:'page_artifact_unavailable', artifact_unavailable_reason:'retained_artifact_unreadable', artifact_ref:path.relative(attempt,artifact), artifact_sha256:null, observations:null };
        }
      }) };
    });
    const result = { schema_version:1, sample_commitment: path.basename(commitmentPath), input_sha256:inputHash, source_attempt:path.relative(PRIVATE_ROOT,attempt), source_row_count:rows.length, matched_source_rows:eligible.length, unmatched_source_rows:rows.length - eligible.length, sampled_row_count:observations.length, bucket_counts: Object.fromEntries(['no_domain','no_candidates','ambiguous','confirmation_required'].map(name => [name, eligible.filter(x => x.bucket === name).length])), observations };
    const reportPath = path.join(output,'diagnostics.json');
    writeFileSync(reportPath,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    return result;
  } finally {
    repo.close();
  }
}
function main(argv: string[]) {
  const options: Record<string,string> = {};
  if (argv[0] !== 'inspect') throw new Error('Usage: bun scratch/comparison-diagnostics.ts inspect --development-input PATH --input-sha256 HEX --source-attempt PATH --output PATH');
  for (let i=1;i<argv.length;i++) { const key=argv[i]; if (!key?.startsWith('--') || options[key]) throw new Error('Invalid or repeated option'); options[key]=argv[++i] ?? ''; }
  const result = runDiagnostics({ developmentInputPath:options['--development-input']!, developmentInputSha256:options['--input-sha256']!, sourceAttemptPath:options['--source-attempt']!, outputPath:options['--output']! });
  console.log(JSON.stringify(result,null,2));
}
if (import.meta.main) main(process.argv.slice(2));
