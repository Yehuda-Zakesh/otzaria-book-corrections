import { buildReport } from './report.js';
function sectionAt(sections, offset) {
  let lo = 0, hi = sections.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (sections[mid].start <= offset) lo = mid; else hi = mid - 1; }
  return sections[lo];
}
function pieces(text, size = 8000) {
  if (!text) return [''];
  const result = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + size, text.length);
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    result.push(text.slice(start, end)); start = end;
  }
  return result;
}
function contextPrefix(text) {
  let end = Math.min(20000, text.length);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}
function sourcePieces(book, change) {
  if (!change.original) return [''];
  const chunks = [];
  for (let cursor = change.start; cursor < change.end;) {
    const section = sectionAt(book.sections, cursor);
    let end = Math.min(cursor + 8000, change.end);
    // Keep large proposals split into bounded source sections.
    const next = book.sections[section.index + 32];
    if (next) end = Math.min(end, next.start - 1);
    if (end < change.end && /[\uDC00-\uDFFF]/.test(book.originalText[end])) end--;
    if (end <= cursor) throw new Error('לא ניתן לפצל את התיקון למיקומי מקור תקינים.');
    chunks.push(book.originalText.slice(cursor, end)); cursor = end;
  }
  return chunks;
}
export async function prepareReports(session, changes, email, call, idFactory, onProgress = () => {}) {
  const maps = new Map(), queue = [];
  async function checked(section) {
    if (!maps.has(section.index)) {
      const map = await call('reader.getSectionTextMap', { ...session.book.identity, sectionIndex: section.index, layer: 'source' });
      if (map?.sourceText !== section.text) throw new Error('מקור הספר השתנה מאז פתיחת העורך. התיקונים נשמרו; אין לשלוח אותם מול מקור שונה.');
      maps.set(section.index, map);
    }
    return maps.get(section.index);
  }
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i], first = sectionAt(session.book.sections, change.start);
    const last = sectionAt(session.book.sections, Math.max(change.start, change.end - 1));
    for (let index = first.index; index <= last.index; index++) await checked(session.book.sections[index]);
    const map = await checked(first), before = sourcePieces(session.book, change), after = pieces(change.proposed);
    const count = Math.max(before.length, after.length);
    for (let part = 0; part < count; part++) {
      const original = before[part] ?? '', proposed = after[part] ?? '';
      if (original === proposed) continue;
      const chunkNote = count > 1 ? `\nחלק ${part + 1} מתוך ${count} של תיקון רציף; יש לקרוא את החלקים לפי הסדר.` : '';
      const operation = change.original === '' ? 'הוספה במיקום המצוין. ' : change.proposed === '' ? 'מחיקה. ' : '';
      const note = `${operation}תיקון ${i + 1} מתוך ${changes.length}. מיקום במקור: פסקה ${first.index + 1}${last.index !== first.index ? ` עד ${last.index + 1}` : ''}, היסט UTF-16 בספר ${change.start}–${change.end}.${chunkNote}`;
      const payload = await buildReport({ id: idFactory(), createdAt: new Date().toISOString(),
        target: { original, line: contextPrefix(first.text) }, proposed, note, details: session.book.details,
        selection: { bookTitle: session.book.details.title ?? session.book.identity.bookId,
          bookId: session.book.identity.bookId, sectionIndex: first.index, currentRef: map.currentRef ?? '' }
      }, email);
      queue.push({ payload, sent: false, sourceSections: Array.from({ length: last.index - first.index + 1 }, (_, index) => first.index + index) });
    }
    onProgress(i + 1, changes.length);
  }
  return queue;
}
