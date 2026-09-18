// Tier 0 static analyzer (#236) — dependency-free.
//
// Executes the fixed application-authored read plan over broker-approved
// captures INSIDE the investigation container: bounded title/meta/script/
// image reads, strict script-JSON parsing, captured-response inspection,
// and own-property JSON-pointer reads. Captures arrive on stdin as JSON
// (host broker fetch); typed observations leave on stdout. There are no
// clicks, typing, submissions, logins, or executable code paths anywhere
// in this module.
//
// Zero-dependency discipline: this file has no imports and performs no
// network or subprocess calls of its own. Every page byte it touches
// arrived via a broker-approved capture from the host. The host never
// parses page bytes; only this analyzer (in-container) and the explicit
// in-process test double (labeled in the test file) ever run it.
//
// Behavior parity: op sequence, read charging, budget clamps, gap strings,
// and observation shapes mirror the fixed plan previously executed in the
// host harness, so existing behavioral expectations transfer unchanged.

export const TIER0_ANALYSIS_PROTOCOL_VERSION = 1;

/** Stable analyzer failure codes. The host maps these to provider errors. */
export const TIER0_ANALYZER_CODES = {
  budgetExhausted: 'budget_exhausted',
  invalidInput: 'invalid_input',
};

// fallow-ignore-next-line unused-exports — CLI/tests/sibling #233 port
// (thrown throughout the analyzer; matched by code at every boundary)
export class Tier0AnalyzerError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'Tier0AnalyzerError';
    // Stable machine-readable code: budget_exhausted | invalid_input.
    this.code = code;
  }
}

// ─── Small grammar-faithful helpers (inlined so this file stays import-free) ─

const REF_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const ARTIFACT_REF_RE = /^artifact:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})$/;
const RESPONSE_REF_RE = /^response:([A-Za-z0-9_-]{1,128}):([A-Za-z0-9_-]{1,128})$/;

function assertRefId(id) {
  if (typeof id !== 'string' || !REF_ID_RE.test(id)) {
    throw new Tier0AnalyzerError('invalid_input', 'invalid reference scope id');
  }
}

/** Parse an opaque ref and bind it to the running investigation (fail closed). */
function scopedRefKind(raw, investigationId) {
  let m = ARTIFACT_REF_RE.exec(raw);
  if (m && m[1] === investigationId) return 'artifact';
  m = RESPONSE_REF_RE.exec(raw);
  if (m && m[1] === investigationId) return 'response';
  return null;
}

/** Cap model-visible text at a UTF-8 byte budget; clipped output is marked incomplete. */
function capObservationText(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, clipped: false };
  return { text: buf.subarray(0, clampUtf8(buf, maxBytes)).toString('utf8'), clipped: true };
}

/** Back off to a UTF-8 character boundary, never splitting a sequence. */
function clampUtf8(buf, maxBytes) {
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  if (startsMultibyte(buf, end, maxBytes)) end -= 1;
  return end;
}

/** True when the byte before `end` opens a sequence the budget truncates. */
function startsMultibyte(buf, end, maxBytes) {
  if (end <= 0 || end >= buf.length || (buf[end - 1] & 0x80) === 0) return false;
  const lead = buf[end - 1];
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  return buf.length - (end - 1) < expected || end - 1 + expected > maxBytes;
}

/** Strict JSON parse with size/depth/node limits. Never evaluates code. */
function parseStrictScriptJson(text, limits) {
  if (Buffer.byteLength(text, 'utf8') > limits.maxBytes) {
    throw new Tier0AnalyzerError('invalid_input', 'script JSON exceeds size limit');
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    throw new Tier0AnalyzerError('invalid_input', 'script content is not strict JSON');
  }
  let value;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Tier0AnalyzerError('invalid_input', 'script content is not strict JSON');
  }
  const nodeCount = countJsonNodes(value, limits);
  return { value, nodeCount };
}

function countJsonNodes(value, limits) {
  let count = 0;
  const visit = (node, depth) => {
    if (depth > limits.maxDepth) {
      throw new Tier0AnalyzerError('invalid_input', 'JSON depth exceeds limit');
    }
    count += 1;
    if (count > limits.maxNodes) {
      throw new Tier0AnalyzerError('invalid_input', 'JSON node count exceeds limit');
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
    } else if (node && typeof node === 'object') {
      for (const key of Object.keys(node)) visit(node[key], depth + 1);
    }
  };
  visit(value, 0);
  return count;
}

/** Own-property pointer walk. Prototype traversal is impossible by construction. */
function readOwnJsonPointer(value, pointer) {
  let current = value;
  for (const token of pointer) {
    if (current === null || typeof current !== 'object') {
      throw new Tier0AnalyzerError('invalid_input', 'pointer traverses a non-container value');
    }
    if (!Object.prototype.hasOwnProperty.call(current, token)) {
      throw new Tier0AnalyzerError('invalid_input', 'pointer references a missing own property');
    }
    current = current[token];
  }
  return current;
}

/** Clipped observations cannot certify field absence. */
function certifyFieldAbsence(observations) {
  if (observations.some((o) => o.incomplete)) {
    throw new Tier0AnalyzerError('invalid_input', 'clipped observations cannot certify field absence');
  }
}

// ─── Minimal deterministic HTML scan (no DOM library in the container) ─────
// Single-pass tokenizer: skips comments/declarations, treats script/style/
// title/textarea as raw-text units, and records elements with lowercased
// tag/attribute names in document order. Fixed-plan queries run over the
// element list. Untrusted bytes stay untrusted text throughout.

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'title', 'textarea']);

/** Decode the common named entities plus numeric refs; unknown names pass through. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–',
  hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  laquo: '«', raquo: '»', divide: '÷', times: '×', plusmn: '±',
  deg: '°', para: '¶', sect: '§', bull: '•', middot: '·',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isSafeInteger(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)
      ? NAMED_ENTITIES[body]
      : match;
  });
}

function parseAttributes(source) {
  const attrs = {};
  const re = /([^\s"'`>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`>/=]+)))?/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) {
      attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
    }
  }
  return attrs;
}

/**
 * Skip non-element markup at `lt`: comments, declarations, processing
 * instructions, and top-level close tags. Returns the resume index, or
 * -1 when `lt` opens a real element.
 */
function skipNonElement(html, lt, len) {
  if (html.startsWith('<!--', lt)) {
    const end = html.indexOf('-->', lt + 4);
    return end === -1 ? len : end + 3;
  }
  if (html.startsWith('<!', lt) || html.startsWith('<?', lt) || html[lt + 1] === '/') {
    const end = html.indexOf('>', lt + 2);
    return end === -1 ? len : end + 1;
  }
  return -1;
}

/** Read one open-tag head: name, attributes, self-close flag, and tag end. */
function readTagHead(html, lt, len) {
  const tagMatch = /^<([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*)?)(\/?)>/.exec(html.slice(lt, lt + 4096));
  if (tagMatch) {
    return {
      tagName: tagMatch[1].toLowerCase(),
      attrs: parseAttributes(tagMatch[2] ?? ''),
      selfClosing: tagMatch[3] === '/',
      tagEnd: lt + tagMatch[0].length,
    };
  }
  // Fallback for long open tags beyond the fast-path window.
  const nameMatch = /^<([a-zA-Z][a-zA-Z0-9]*)/.exec(html.slice(lt, lt + 128));
  if (!nameMatch) return null;
  const end = html.indexOf('>', lt + nameMatch[0].length);
  if (end === -1) return null;
  const selfClosing = html[end - 1] === '/';
  return {
    tagName: nameMatch[1].toLowerCase(),
    attrs: parseAttributes(html.slice(lt + nameMatch[0].length, selfClosing ? end - 1 : end)),
    selfClosing,
    tagEnd: end + 1,
  };
}

/** Consume a raw-text unit (script/style/title/textarea) through its close tag. */
function consumeRawText(html, tagName, tagEnd, len) {
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'ig');
  closeRe.lastIndex = tagEnd;
  const close = closeRe.exec(html);
  if (!close) return { inner: html.slice(tagEnd), next: len };
  return { inner: html.slice(tagEnd, close.index), next: close.index + close[0].length };
}

/** Scan HTML into flat elements: { tag, attrs, inner } in document order. */
function scanHtml(html) {
  const elements = [];
  const len = html.length;
  let i = 0;
  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const skipped = skipNonElement(html, lt, len);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const head = readTagHead(html, lt, len);
    if (!head) {
      // Unparseable `<`: neither a tag nor skippable markup. The `indexOf`
      // fallback (`end === -1 → break`) lives inside readTagHead as null.
      const end = html.indexOf('>', lt + 2);
      if (end === -1) break;
      i = lt + 1;
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(head.tagName)) {
      const raw = consumeRawText(html, head.tagName, head.tagEnd, len);
      elements.push({ tag: head.tagName, attrs: head.attrs, inner: raw.inner });
      i = raw.next;
      continue;
    }
    // Container elements record empty inner (the fixed plan never reads
    // container text; title/script/style/textarea cover its needs).
    elements.push({ tag: head.tagName, attrs: head.attrs, inner: '' });
    i = head.tagEnd;
  }
  return elements;
}

// ─── Fixed read plan ────────────────────────────────────────────────────────

const MAX_SCRIPT_BLOCKS = 20;
const MAX_IMAGE_MATCHES = 20;
const MAX_META_ENTRIES = 100;

function truncateUrl(url) {
  return url.length > 120 ? `${url.slice(0, 120)}…` : url;
}

function failureReason(err) {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

function detectPlatformSignals(html, signals) {
  const lowered = html.slice(0, 200_000).toLowerCase();
  if (
    lowered.includes('cdn.shopify.com') ||
    lowered.includes('shopify.shop') ||
    lowered.includes('__shopify__') ||
    lowered.includes('shopify.checkout')
  ) {
    signals.add('shopify');
  }
  if (lowered.includes('woocommerce')) signals.add('woocommerce');
  if (lowered.includes('__next_data__') || lowered.includes('__next_f')) signals.add('nextjs');
  if (lowered.includes('__nuxt__')) signals.add('nuxt');
}

/**
 * Analyze broker-approved captures into typed observations.
 *
 * @param request { investigationId, budget: { maxSelectorLength,
 *   maxSelectorMatches, maxObservationBytesPerOperation,
 *   maxJsonNodesVisited, maxJsonPointerDepth, maxResponseBytesPerResponse,
 *   maxReads }, captures: [{ pageIndex, bodyBase64, contentType, pageUrl,
 *   artifactHash, artifactRef, responseRef }] }
 * @returns { observations, gaps, platformSignals, domSignals, readsPerformed }
 * @throws Tier0AnalyzerError with code budget_exhausted (whole run fails) or
 *   invalid_input (malformed request envelope).
 */
export function analyzeTier0Captures(request) {
  const { investigationId, budget, captures } = request ?? {};
  assertRefId(investigationId);
  for (const key of [
    'maxSelectorLength',
    'maxSelectorMatches',
    'maxObservationBytesPerOperation',
    'maxJsonNodesVisited',
    'maxJsonPointerDepth',
    'maxResponseBytesPerResponse',
    'maxReads',
  ]) {
    if (!Number.isSafeInteger(budget?.[key]) || budget[key] <= 0) {
      throw new Tier0AnalyzerError('invalid_input', `budget cap ${key} must be a positive integer`);
    }
  }
  if (!Array.isArray(captures)) {
    throw new Tier0AnalyzerError('invalid_input', 'captures must be an array');
  }

  const state = {
    investigationId,
    budget,
    observations: [],
    gaps: [],
    platformSignals: new Set(),
    domSignals: { title: false, meta: false, jsonLd: false, images: false },
    readsPerformed: 0,
  };
  for (const capture of captures) {
    try {
      readCapture(state, capture);
    } catch (err) {
      // Read-budget exhaustion fails the whole run; any other page failure
      // is a visible gap and analysis continues with the next capture.
      if (err instanceof Tier0AnalyzerError && err.code === 'budget_exhausted') throw err;
      state.gaps.push(
        `page ${capture?.pageIndex + 1} (${truncateUrl(String(capture?.pageUrl ?? ''))}): read failed (${failureReason(err)})`,
      );
    }
  }
  return {
    observations: state.observations,
    gaps: state.gaps,
    platformSignals: [...state.platformSignals].sort(),
    domSignals: state.domSignals,
    readsPerformed: state.readsPerformed,
  };
}

/** Charge one grammar-op read against the run budget (fail closed past the cap). */
function chargeRead(state) {
  state.readsPerformed += 1;
  if (state.readsPerformed > state.budget.maxReads) {
    throw new Tier0AnalyzerError(
      'budget_exhausted',
      `reads would exceed maxReads ${state.budget.maxReads}`,
    );
  }
}

/** Bound a fixed-plan selector to the investigation caps. */
function boundSelector(selector, requestedMax, budget) {
  if (selector.length > budget.maxSelectorLength) {
    throw new Tier0AnalyzerError('invalid_input', 'selector exceeds investigation length cap');
  }
  return { selector, maxMatches: Math.min(requestedMax, budget.maxSelectorMatches) };
}

function pushObservation(state, capture, kind, detail) {
  const capped = capObservationText(detail, state.budget.maxObservationBytesPerOperation);
  state.observations.push({
    kind,
    sourceUrl: capture.pageUrl,
    artifactHash: capture.artifactHash,
    ...(capped.text ? { detail: capped.text } : {}),
    incomplete: capped.clipped,
    artifactRef: capture.artifactRef,
  });
}

function readCapture(state, capture) {
  const body = Buffer.from(capture.bodyBase64, 'base64');
  const { contentType, pageUrl } = capture;
  // inspect_network_response over the already-captured broker-approved
  // response. A foreign or stale ref fails closed: the page is skipped.
  chargeRead(state);
  if (scopedRefKind(capture.responseRef, state.investigationId) !== 'response') {
    state.gaps.push(`page (${truncateUrl(pageUrl)}): stale response reference; capture discarded`);
    return;
  }
  pushObservation(
    state,
    capture,
    'network_response',
    `captured ${contentType} (${body.length} B, sha256 ${capture.artifactHash}); projection is metadata only, never raw body bypass`,
  );

  const base = contentType.split(';')[0].trim().toLowerCase();
  if (base === 'application/json' || base === 'application/ld+json') {
    readJsonCapture(state, capture, body);
    return;
  }
  if (!base.startsWith('text/html') && base !== 'application/xhtml+xml') {
    pushObservation(
      state,
      capture,
      'network_body',
      `captured ${base} response (${body.length} B); DOM inspection not applicable`,
    );
    return;
  }
  readHtmlCapture(state, capture, body);
}

/** Captured-JSON path: own-property pointer read over the response value. */
function readJsonCapture(state, capture, body) {
  // read_json_pointer over the captured value (fixed pointer [root]).
  chargeRead(state);
  if (scopedRefKind(capture.responseRef, state.investigationId) !== 'response') {
    throw new Tier0AnalyzerError('invalid_input', 'foreign response reference');
  }
  if (1 > state.budget.maxJsonPointerDepth) {
    throw new Tier0AnalyzerError('invalid_input', 'pointer exceeds investigation depth cap');
  }
  const parsed = parseStrictScriptJson(body.toString('utf8'), {
    maxBytes: state.budget.maxResponseBytesPerResponse,
    maxDepth: Math.min(state.budget.maxJsonPointerDepth, 32),
    maxNodes: state.budget.maxJsonNodesVisited,
  });
  readOwnJsonPointer({ root: parsed.value }, ['root']);
  pushObservation(
    state,
    capture,
    'network_json',
    `captured JSON response (${body.length} B, ${parsed.nodeCount} nodes)`,
  );
}

/** Static-DOM path: bounded title/meta/script/image reads over the capture. */
function readHtmlCapture(state, capture, body) {
  const html = body.toString('utf8');
  detectPlatformSignals(html, state.platformSignals);
  const elements = scanHtml(html);
  readTitleSurface(state, capture, elements);
  readMetaSurface(state, capture, elements);
  readScriptSurface(state, capture, elements);
  readImageSurface(state, capture, elements);
}

/** query_selector_all(title): bounded selector query, text only. */
function readTitleSurface(state, capture, elements) {
  chargeRead(state);
  if (scopedRefKind(capture.artifactRef, state.investigationId) !== 'artifact') {
    throw new Tier0AnalyzerError('invalid_input', 'foreign page reference');
  }
  const titleBound = boundSelector('title', 1, state.budget);
  void titleBound;
  const titleEl = elements.find((el) => el.tag === 'title');
  const titleText = titleEl ? decodeEntities(titleEl.inner).trim() : '';
  if (titleText) {
    state.domSignals.title = true;
    pushObservation(state, capture, 'page_title', `title: ${titleText}`);
    return;
  }
  // Absence is certifiable only when nothing was clipped.
  try {
    certifyFieldAbsence(state.observations.filter((o) => o.sourceUrl === capture.pageUrl));
    state.gaps.push('title not observed in captured document');
  } catch {
    state.gaps.push('title observation incomplete; absence uncertifiable within budget');
  }
}

/** One `name=content` entry from a meta element, or null when not applicable. */
function metaEntryOf(el) {
  if (el.tag !== 'meta') return null;
  if (!('name' in el.attrs) && !('property' in el.attrs)) return null;
  // Attribute values decode entities, matching HTML parsing semantics.
  const name = decodeEntities(el.attrs.name ?? el.attrs.property ?? '');
  if (!name) return null;
  return `${name}=${decodeEntities(el.attrs.content ?? '')}`;
}

/** read_meta: bounded meta reads — observations, never trust grants. */
function readMetaSurface(state, capture, elements) {
  chargeRead(state);
  if (scopedRefKind(capture.artifactRef, state.investigationId) !== 'artifact') {
    throw new Tier0AnalyzerError('invalid_input', 'foreign page reference');
  }
  const metas = [];
  for (const el of elements) {
    const entry = metaEntryOf(el);
    if (entry) metas.push(entry);
    if (metas.length >= MAX_META_ENTRIES) break;
  }
  if (metas.length > 0) state.domSignals.meta = true;
  pushObservation(state, capture, 'page_meta', metas.join('\n'));
}

/** read_script_json over indexed ld+json blocks: strict parse only, never evaluated. */
function readScriptSurface(state, capture, elements) {
  const blocks = elements.filter(
    (el) => el.tag === 'script' && (el.attrs.type ?? '').trim() === 'application/ld+json',
  );
  if (blocks.length > MAX_SCRIPT_BLOCKS) {
    state.gaps.push(`only the first ${MAX_SCRIPT_BLOCKS} JSON-LD blocks examined within budget`);
  }
  for (const block of blocks.slice(0, MAX_SCRIPT_BLOCKS)) {
    chargeRead(state);
    if (scopedRefKind(capture.artifactRef, state.investigationId) !== 'artifact') {
      throw new Tier0AnalyzerError('invalid_input', 'foreign page reference');
    }
    try {
      const parsed = parseStrictScriptJson(block.inner, {
        maxBytes: state.budget.maxResponseBytesPerResponse,
        maxDepth: Math.min(state.budget.maxJsonPointerDepth, 32),
        maxNodes: state.budget.maxJsonNodesVisited,
      });
      state.domSignals.jsonLd = true;
      pushObservation(state, capture, 'page_json_ld', `JSON-LD block (${parsed.nodeCount} nodes): ${block.inner}`);
    } catch {
      state.gaps.push('a JSON-LD block was not strict JSON or exceeded bounds; skipped without evaluation');
    }
  }
}

/** query_selector_all + read_attribute over the image surface; URLs stay untrusted text. */
function readImageSurface(state, capture, elements) {
  // query_selector_all over img[src]: a discovered URL gains no permission.
  chargeRead(state);
  if (scopedRefKind(capture.artifactRef, state.investigationId) !== 'artifact') {
    throw new Tier0AnalyzerError('invalid_input', 'foreign page reference');
  }
  const bounded = boundSelector('img[src]', MAX_IMAGE_MATCHES, state.budget);
  void bounded;
  const refs = elements
    .filter((el) => el.tag === 'img' && 'src' in el.attrs)
    .slice(0, Math.min(MAX_IMAGE_MATCHES, state.budget.maxSelectorMatches));
  let withSrc = 0;
  for (const el of refs) {
    // read_attribute returns the URL as text only.
    chargeRead(state);
    if ((el.attrs.src ?? '').trim()) withSrc += 1;
  }
  if (refs.length > 0) state.domSignals.images = true;
  pushObservation(
    state,
    capture,
    'page_images',
    `image elements observed: ${refs.length} (${withSrc} with sources; URLs untrusted; membership uncertified from this read)`,
  );
}
