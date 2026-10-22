import { loadBook } from './book.js';

// Keep only one active session's source, in memory. Every application still
// validates all source paragraphs in Otzaria; cache never authorizes a write.
export function createReplacementBookLoader(call) {
  let cached = null;
  return {
    clear() { cached = null; },
    async load(snapshot, onProgress) {
      if (!snapshot?.sessionId || !snapshot.bookUid || !snapshot.libraryVersion) {
        throw new Error('נדרש סשן עריכה פעיל ומזוהה כדי לטעון את הספר להחלפה.');
      }
      const key = JSON.stringify([snapshot.sessionId, snapshot.bookUid, snapshot.libraryVersion]);
      if (cached?.key === key) return cached.promise;
      const entry = { key, promise: loadBook(call, { bookId: snapshot.bookId, bookUid: snapshot.bookUid }, onProgress,
        { includeRaw: true, deferSourceValidation: true }) };
      cached = entry;
      try { return await entry.promise; }
      catch (error) { if (cached === entry) cached = null; throw error; }
    }
  };
}
const replaceWordCharacter = /[\p{L}\p{N}\p{M}_]/u;
const replaceUnsupportedText = /[<>\r\n\u2028\u2029]|&(?:#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/;
function replacementFailure(message, code = 'invalid_params') {
  throw Object.assign(new Error(message), { code: `error.${code}`, userMessage: message });
}
function replacementWordAt(text, index) {
  if (index < 0 || index >= text.length) return false;
  if (/[\uDC00-\uDFFF]/.test(text[index]) && index > 0) index--;
  return replaceWordCharacter.test(String.fromCodePoint(text.codePointAt(index)));
}

export function replaceLiteral(text, query, replacement, wholeWords = true, { maxLength = Infinity } = {}) {
  if (!query) replacementFailure('כתבו מילה או ביטוי לחיפוש.');
  let from = 0, count = 0, length = text.length;
  const pieces = [];
  for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, from)) {
    const end = at + query.length;
    const boundary = !wholeWords ||
      ((!replacementWordAt(query, 0) || !replacementWordAt(text, at - 1)) &&
       (!replacementWordAt(query, query.length - 1) || !replacementWordAt(text, end)));
    if (boundary) {
      length += replacement.length - query.length;
      if (length > maxLength) replacementFailure('נוסח ההחלפה יוצר פסקה ארוכה מהמותר. לא נעשה שינוי.', 'limit_exceeded');
      count++;
    }
    pieces.push(text.slice(from, at), boundary ? replacement : query);
    from = end;
  }
  pieces.push(text.slice(from));
  return { text: pieces.join(''), count };
}

export function planReplacements(book, snapshot, { query, replacement, wholeWords = true }) {
  if (typeof query !== 'string' || !query) replacementFailure('כתבו מילה או ביטוי לחיפוש.');
  if (typeof replacement !== 'string' || /[\r\n\u2028\u2029]/.test(query) || replaceUnsupportedText.test(replacement) ||
      [query, replacement].some(text => /[\uD800-\uDFFF]/u.test(text))) replacementFailure('אפשר להחליף טקסט פשוט בתוך פסקה, ללא תגיות או מעברי פסקה.');
  if (query === replacement) replacementFailure('הנוסח לחיפוש ולהחלפה זהה.');
  if (book.identity?.bookUid !== snapshot.bookUid) replacementFailure('הספר אינו תואם לסשן העריכה.', 'source_changed');
  if (!Array.isArray(book.rawLines) || book.rawLines.length !== book.sections.length) {
    replacementFailure('אי אפשר למפות בבטחה את פסקאות הספר הזה להחלפה גורפת. לא נעשה שינוי.', 'unsupported_context');
  }
  const current = new Map(snapshot.changes.map(change => [change.sectionIndex, { ...change }]));
  for (const change of current.values()) {
    if (book.rawLines[change.sectionIndex] !== change.originalSourceText || book.sections[change.sectionIndex]?.text !== change.originalText) {
      replacementFailure('מקור הספר השתנה. פתחו תצוגה מקדימה חדשה לפני החלפה.', 'source_changed');
    }
  }
  const previews = [];
  const limits = snapshot.capabilities ?? {};
  let occurrences = 0;
  for (const section of book.sections) {
    const before = current.get(section.index)?.proposedText ?? section.text;
    const result = replaceLiteral(before, query, replacement, wholeWords, { maxLength: limits.maxTextLength ?? 20000 });
    if (!result.count || result.text === before) continue;
    occurrences += result.count;
    previews.push({ sectionIndex: section.index, originalText: before, proposedText: result.text,
      originalSourceText: book.rawLines[section.index], occurrences: result.count });
    if (result.text === section.text) current.delete(section.index);
    else current.set(section.index, { sectionIndex: section.index, originalSourceText: book.rawLines[section.index],
      originalText: section.text, proposedText: result.text });
  }
  const changes = [...current.values()].sort((a, b) => a.sectionIndex - b.sectionIndex);
  if (changes.length > (limits.maxChanges ?? 500)) replacementFailure('ההחלפה חורגת ממספר הפסקאות המותר בטיוטה. לא נעשה שינוי.', 'limit_exceeded');
  let bytes = 0;
  for (const change of changes) {
    if (change.originalSourceText.length > (limits.maxTextLength ?? 20000) || change.proposedText.length > (limits.maxTextLength ?? 20000) ||
        !change.originalText || replaceUnsupportedText.test(change.originalText) || replaceUnsupportedText.test(change.proposedText) ||
        [change.originalSourceText, change.proposedText].some(text => /[\uD800-\uDFFF]/u.test(text))) {
      replacementFailure(`פסקה ${change.sectionIndex + 1} אינה נתמכת להחלפה או ארוכה מדי. לא נעשה שינוי.`, 'unsupported_context');
    }
    bytes += new TextEncoder().encode(JSON.stringify(change)).length;
  }
  if (bytes > (limits.maxChangesBytes ?? 1048576)) replacementFailure('ההחלפה חורגת מגודל הטיוטה המותר. לא נעשה שינוי.', 'limit_exceeded');
  return { sessionId: snapshot.sessionId, bookUid: snapshot.bookUid, bookId: snapshot.bookId,
    libraryVersion: snapshot.libraryVersion, revision: snapshot.revision, query, replacement, wholeWords, occurrences, previews, changes };
}
