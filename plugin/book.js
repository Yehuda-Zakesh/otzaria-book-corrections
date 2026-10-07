export const MAX_BOOK_BYTES = 10 * 1024 * 1024;
const CHUNK_SIZE = 5000;
const breakingTags = /<\/?(?:address|article|aside|blockquote|br|caption|center|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)(?:[^>a-zA-Z0-9][^>]*)?>/gi;
const entityPattern = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;
const namedEntities = new Set(['amp', 'lt', 'gt', 'quot', 'apos', 'hellip', 'ndash', 'mdash', 'laquo', 'raquo', 'middot']);
const spaces = new Set(['nbsp', 'thinsp', 'ensp', 'emsp']);
const decoded = new Map();

// Match Otzaria's stripHtmlIfNeeded, not generic HTML textContent: block tags
// become spaces, inline tags disappear, and unknown named entities disappear.
// DOMParser receives only whitelisted entity tokens, never book HTML or URLs.
export function sourceText(raw) {
  return raw.replace(breakingTags, ' ').replace(/<[^>]*>/g, '').replace(entityPattern, (_, token) => {
    if (token.startsWith('#')) {
      const hex = token[1] === 'x' || token[1] === 'X';
      const digits = token.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-f]+$/i : /^\d+$/).test(digits)) return '';
      const value = Number.parseInt(digits, hex ? 16 : 10);
      return value >= 0x20 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    }
    const name = token.toLowerCase();
    if (spaces.has(name)) return ' ';
    if (!namedEntities.has(name)) return '';
    if (!decoded.has(name)) {
      if (typeof DOMParser === 'undefined') throw new Error('מפענח הטקסט אינו זמין.');
      decoded.set(name, new DOMParser().parseFromString(`<body>&${name};</body>`, 'text/html').body.textContent);
    }
    return decoded.get(name);
  });
}

function aborted(signal) {
  if (signal?.aborted) throw new DOMException('הטעינה בוטלה.', 'AbortError');
}

async function request(call, method, args, signal) {
  aborted(signal);
  if (!signal) return call(method, args);
  let listener;
  try {
    return await Promise.race([
      call(method, args),
      new Promise((_, reject) => {
        listener = () => reject(new DOMException('הטעינה בוטלה.', 'AbortError'));
        signal.addEventListener('abort', listener, { once: true });
      })
    ]);
  } finally { signal.removeEventListener('abort', listener); }
}

function tooLarge() { throw new Error('הספר גדול מדי לעריכה בתוסף (עד 10 MB).'); }
function bytes(text) { return new TextEncoder().encode(text).length; }

/** call resolves SDK data (not the RPC envelope). identity: {bookId, bookUid?}.
 * Returned offsets are UTF-16 offsets into originalText, end exclusive.
 * Do not derive later section indexes from edited text; retain these anchors.
 */
export async function loadBook(call, identity, onProgress = () => {}, { signal, includeRaw = false } = {}) {
  if (typeof identity?.bookId !== 'string' || !identity.bookId) throw new Error('חסר זיהוי של הספר.');
  const details = await request(call, 'library.getBookDetails', identity, signal);
  if (details?.source !== 'library' || details?.type !== 'text') throw new Error('אפשר לערוך ספרי טקסט מספריית אוצריא בלבד.');
  const bookIdentity = { bookId: identity.bookId, ...(identity.bookUid ? { bookUid: identity.bookUid } : details.bookUid ? { bookUid: details.bookUid } : {}) };
  const chunks = [];
  let offset = 0;
  for (;;) {
    const chunk = await request(call, 'library.getBookContent', { ...bookIdentity, offset, limit: CHUNK_SIZE }, signal);
    if (typeof chunk !== 'string' || chunk.length > CHUNK_SIZE) throw new Error('תוכן הספר שהתקבל אינו תקין.');
    chunks.push(chunk);
    offset += chunk.length;
    if (offset > MAX_BOOK_BYTES) tooLarge();
    onProgress({ phase: 'content', loaded: offset, total: null });
    if (chunk.length < CHUNK_SIZE) break;
  }
  const raw = chunks.join('');
  if (bytes(raw) > MAX_BOOK_BYTES) tooLarge();
  const count = details.lineCount;
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BOOK_BYTES) throw new Error('לא התקבל מספר פסקאות אמין; לא ניתן למפות דיווחים לספר.');
  let lines = raw.split('\n').map(sourceText);
  const mapFor = index => request(call, 'reader.getSectionTextMap', { ...bookIdentity, sectionIndex: index, layer: 'source' }, signal);
  // A DB section may contain an embedded newline. A matching count plus source
  // checks guards the fast path; mismatches use authoritative section maps.
  let trusted = lines.length === count;
  if (trusted) {
    for (const index of new Set([0, count - 1])) {
      const map = await mapFor(index);
      if (map?.sourceText !== lines[index]) { trusted = false; break; }
    }
  }
  if (!trusted) {
    lines = new Array(count);
    let next = 0, completed = 0, totalBytes = 0, failed = false;
    await Promise.all(Array.from({ length: Math.min(4, count) }, async () => {
      try {
        while (!failed && next < count) {
          const index = next++;
          const map = await mapFor(index);
          if (failed) return;
          if (typeof map?.sourceText !== 'string') throw new Error('לא ניתן למפות פסקה בספר.');
          totalBytes += bytes(map.sourceText) + 1;
          if (totalBytes > MAX_BOOK_BYTES) tooLarge();
          lines[index] = map.sourceText;
          onProgress({ phase: 'sections', loaded: ++completed, total: count });
        }
      } catch (error) { failed = true; throw error; }
    }));
  }
  aborted(signal);
  let position = 0;
  const sections = lines.map((text, index) => {
    const start = position;
    position += text.length + 1;
    return { index, start, end: start + text.length, text };
  });
  const originalText = lines.join('\n');
  if (bytes(originalText) > MAX_BOOK_BYTES) tooLarge();
  onProgress({ phase: 'done', loaded: sections.length, total: sections.length });
  return { details, identity: bookIdentity, originalText, sections,
    ...(includeRaw ? { rawLines: trusted ? raw.split('\n') : null } : {}) };
}
