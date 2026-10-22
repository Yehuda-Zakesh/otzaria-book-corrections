import { diffHunks } from './text-diff.js';
// Pending proposals are marked in Otzaria's reader as plugin highlights on the
// original words they replace. The host keeps highlights only while an
// instance of the plugin lives, so each instance draws them again after boot;
// equal ids from two instances are painted once.
export const MARK_SETTING_KEY = 'markPendingInReader';
// Read by the manifest's activationEvents: the background engine wakes to
// draw marks only while there is something to mark.
export const MARK_WAKE_KEY = 'readerMarksPending';
// Changed by whichever instance last synced; another live instance compares
// it while the user reads and redraws when it differs.
export const MARK_REVISION_KEY = 'readerMarksRevision';
export const MARK_STYLE = { backgroundColor: '#4CAF50', opacity: 0.45, borderRadius: 3, priority: 5 };
const markLimit = 300;
const signatureOf = target => `${target.bookUid}|${target.sectionIndex}|${target.start}|${target.text}`;
function revisionOf(targets, enabled) {
  if (!enabled) return 'off';
  let hash = 0x811c9dc5;
  for (const char of targets.map(target => `${target.id}=${signatureOf(target)}`).join(';')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `${targets.length}-${hash.toString(16)}`;
}

export async function marksEnabled(call) {
  return (await call('storage.get', { key: MARK_SETTING_KEY }).catch(() => null)) !== false;
}

// The words a hunk touches in the original. An insertion or a whitespace-only
// change marks the neighbouring word, so every proposal has a visible mark.
export function markSpan(text, start, end) {
  let s = start, e = end;
  if (!text.slice(s, e).trim()) {
    while (e < text.length && /\s/.test(text[e])) e++;
    while (e < text.length && !/\s/.test(text[e])) e++;
    if (!text.slice(s, e).trim()) {
      while (s > 0 && /\s/.test(text[s - 1])) s--;
      while (s > 0 && !/\s/.test(text[s - 1])) s--;
    }
  }
  while (s < e && /\s/.test(text[s])) s++;
  while (e > s && /\s/.test(text[e - 1])) e--;
  return e > s ? { start: s, end: e } : null;
}

export function markTargets(state) {
  const targets = [];
  for (const book of state.books.values()) {
    for (const item of book.pending) {
      if (typeof item.originalText !== 'string' || typeof item.proposedText !== 'string' || !book.bookId) continue;
      const spans = diffHunks(item.originalText, item.proposedText).map(hunk => markSpan(item.originalText, hunk.start, hunk.end)).filter(Boolean);
      spans.forEach((span, index) => targets.push({
        id: `nc-${String(item.key).replace(/[^A-Za-z0-9]/g, '').slice(0, 80)}-${index}`,
        bookId: book.bookId, bookUid: book.bookUid, sectionIndex: item.sectionIndex,
        text: item.originalText.slice(span.start, span.end), start: span.start, proposedText: item.proposedText
      }));
    }
  }
  return targets.slice(0, markLimit);
}

export function createReaderMarks(call, { now = () => Date.now(), retryDelay = 5000 } = {}) {
  const drawn = new Map();
  const misses = new Map();
  let running = null, pending = null, wake = null, revision = null;
  async function draw(target) {
    const found = await call('reader.findTextOccurrences', { bookId: target.bookId, bookUid: target.bookUid, sectionIndex: target.sectionIndex,
      query: target.text, layer: 'source', limit: 200 });
    // The source layer is the stripped text the proposal was made on; a
    // different offset means the source changed, and nothing is guessed.
    const occurrence = found?.results?.find(result => result.range?.start?.utf16 === target.start);
    if (!occurrence) return false;
    await call('reader.setHighlight', { highlightId: target.id, bookId: target.bookId, bookUid: target.bookUid, sectionIndex: target.sectionIndex,
      range: occurrence.range, style: MARK_STYLE, metadata: { note: `הצעת תיקון: ${target.proposedText}`.slice(0, 4000), tags: ['תיקון ממתין'] } });
    return true;
  }
  async function setWake(value) {
    if (wake === value) return;
    await call('storage.set', { key: MARK_WAKE_KEY, value });
    wake = value;
  }
  async function drawState(state, enabled) {
    const targets = enabled ? markTargets(state) : [];
    const wanted = new Map(targets.map(target => [target.id, target]));
    for (const id of misses.keys()) if (!wanted.has(id)) misses.delete(id);
    let failed = 0;
    for (const [id, signature] of drawn) {
      const target = wanted.get(id);
      if (target && signature === signatureOf(target)) continue;
      await call('reader.clearHighlight', { highlightId: id }).catch(() => {});
      drawn.delete(id);
    }
    for (const target of targets) {
      if (drawn.has(target.id)) continue;
      const signature = signatureOf(target), miss = misses.get(target.id);
      if (miss?.signature === signature && miss.retryAt > now()) continue;
      try {
        if (await draw(target)) { drawn.set(target.id, signature); misses.delete(target.id); }
        else misses.set(target.id, { signature, retryAt: now() + retryDelay });
      } catch { failed++; misses.set(target.id, { signature, retryAt: now() + retryDelay }); }
    }
    await setWake(enabled && targets.length > 0).catch(() => {});
    const next = revisionOf(targets, enabled);
    if (next !== revision) { await call('storage.set', { key: MARK_REVISION_KEY, value: next }).catch(() => {}); revision = next; }
    return { drawn: drawn.size, wanted: targets.length, failed };
  }
  // Keep one current draw and one latest requested state. Intermediate
  // reloads must not accumulate hundreds of obsolete reader lookups.
  function sync(state, enabled) {
    pending = { state, enabled };
    if (running) return running;
    running = Promise.resolve().then(async () => {
      let result;
      try {
        while (pending) {
          const next = pending; pending = null;
          result = await drawState(next.state, next.enabled);
        }
        return result;
      } finally { running = null; }
    });
    return running;
  }
  // True when another instance synced a different set of marks.
  async function outdated() {
    if ([...misses.values()].some(miss => miss.retryAt <= now())) return true;
    if (revision === null) return false;
    return (await call('storage.get', { key: MARK_REVISION_KEY }).catch(() => revision)) !== revision;
  }
  async function clearAll() {
    drawn.clear(); misses.clear();
    await call('reader.clearAllHighlights', {}).catch(() => {});
  }
  return { sync, outdated, clearAll, drawn };
}
