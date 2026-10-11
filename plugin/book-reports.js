import { buildReport } from './report.js';
import { sourceText } from './book.js';
import { correctionForSource, officialReportBookId } from './correction-source.js';
// Like Otzaria's refFromIndex: retain the heading chain up to the source line.
function reportTocRef(toc, index) {
  const path = [];
  for (const entry of toc ?? []) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index > index || !(entry.level > 0)) continue;
    while (path.length && path.at(-1).level >= entry.level) path.pop();
    path.push(entry);
  }
  return path.map(entry => String(entry.text ?? '').trim()).filter(Boolean).join(', ');
}
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
export async function prepareReports(session, changes, email, call, idFactory, onProgress = () => {}, { sourceBook, client } = {}) {
  const maps = new Map(), queue = [];
  const sourceBookId = officialReportBookId(sourceBook);
  // Equal paragraph boundaries can be reported as independent, exact line edits.
  // Adding/removing a newline remains one free-text proposal.
  const reportChanges = changes.flatMap(change => {
    const original = change.original.split('\n'), proposed = change.proposed.split('\n');
    const first = sectionAt(session.book.sections, change.start);
    const last = sectionAt(session.book.sections, Math.max(change.start, change.end - 1));
    if (first.index === last.index || original.length <= 1 || original.length !== proposed.length) return [change];
    let cursor = change.start;
    return original.flatMap((text, index) => {
      const start = cursor; cursor += text.length + 1;
      return text === proposed[index] ? [] : [{ start, end: start + text.length, original: text, proposed: proposed[index] }];
    });
  });
  async function checked(section) {
    if (!maps.has(section.index)) {
      const map = await call('reader.getSectionTextMap', { ...session.book.identity, sectionIndex: section.index, layer: 'source' });
      if (map?.sourceText !== section.text) throw new Error('מקור הספר השתנה מאז פתיחת העורך. התיקונים נשמרו; אין לשלוח אותם מול מקור שונה.');
      maps.set(section.index, map);
    }
    return maps.get(section.index);
  }
  for (let i = 0; i < reportChanges.length; i++) {
    const change = reportChanges[i], first = sectionAt(session.book.sections, change.start);
    const last = sectionAt(session.book.sections, Math.max(change.start, change.end - 1));
    for (let index = first.index; index <= last.index; index++) await checked(session.book.sections[index]);
    const firstMap = await checked(first), raw = sourceBook?.rawLines?.[first.index];
    const correction = sourceBookId != null && first.index === last.index && !change.proposed.includes('\n') &&
      typeof raw === 'string' && sourceText(raw) === firstMap.sourceText ?
      correctionForSource(raw, first.text, change.start - first.start, change.end - first.start, change.proposed) : null;
    // A valid single-line correction can use the full 20,000-unit v2 limit.
    // Chunk only the proposals that cannot be represented as one correction.
    const before = correction ? [change.original] : sourcePieces(session.book, change);
    const after = correction ? [change.proposed] : pieces(change.proposed);
    const count = Math.max(before.length, after.length);
    let sourceCursor = change.start;
    for (let part = 0; part < count; part++) {
      const original = before[part] ?? '', proposed = after[part] ?? '';
      const partStart = sourceCursor;
      sourceCursor += original.length;
      const partFirst = sectionAt(session.book.sections, partStart);
      const map = await checked(partFirst);
      if (original === proposed) continue;
      const chunkNote = count > 1 ? `\nחלק ${part + 1} מתוך ${count} של תיקון רציף; יש לקרוא את החלקים לפי הסדר.` : '';
      const operation = change.original === '' ? 'הוספה במיקום המצוין. ' : change.proposed === '' ? 'מחיקה. ' : '';
      const note = `${operation}תיקון ${i + 1} מתוך ${reportChanges.length}. מיקום במקור: פסקה ${first.index + 1}${last.index !== first.index ? ` עד ${last.index + 1}` : ''}, היסט UTF-16 בספר ${change.start}–${change.end}.${chunkNote}`;
      const reason = first.index !== last.index || change.proposed.includes('\n') ? 'השינוי משנה גבולות פסקאות.' :
        sourceBookId == null || typeof raw !== 'string' ? 'אין זיהוי ומיפוי גולמי מאומת של פסקת המקור.' :
        raw.length > 20000 || change.proposed.length > 20000 ? 'התיקון חורג ממגבלת האורך של תיקון מובנה.' :
        'לא ניתן למפות את הטווח למקור הגולמי בלי לשנות תגיות עיצוב או לנחש מיקום.';
      const reportNote = correction ? note : `${note}\nהצעה לבדיקה ידנית כדיווח חופשי: ${reason}`;
      const payload = await buildReport({ id: idFactory(), createdAt: new Date().toISOString(),
        target: { original, line: contextPrefix(partFirst.text) }, proposed, note: reportNote, details: session.book.details,
        correction, sourceBookId, client,
        selection: { bookTitle: session.book.details.title ?? session.book.identity.bookId,
          bookId: session.book.identity.bookId, sectionIndex: partFirst.index,
          currentRef: map.currentRef?.trim() || reportTocRef(session.book.toc, partFirst.index) }
      }, email);
      // Otzaria fills the library build, heRef, DB book ID and full source path itself.
      const partLast = sectionAt(session.book.sections, Math.max(partStart, partStart + original.length - 1));
      const localStart = partStart - partFirst.start;
      const submission = { reportId: payload.report_id, ...session.book.identity, sectionIndex: partFirst.index,
        ...(partLast.index !== partFirst.index ? { endSectionIndex: partLast.index } : {}),
        snapshots: session.book.sections.slice(partFirst.index, partLast.index + 1).map(({ index, text }) => ({ index, text })),
        original, proposed, details: reportNote, allowQueue: false, forceFreeText: !correction,
        ...(partLast.index === partFirst.index ? { sourceStart: localStart, sourceEnd: localStart + original.length } : {}) };
      queue.push({ payload, submission, sent: false, sourceSections: Array.from({ length: last.index - first.index + 1 }, (_, index) => first.index + index) });
    }
    onProgress(i + 1, reportChanges.length);
  }
  return queue;
}
