import { createDraftStorage } from './draft-storage.js';
import { diffBook } from './changes.js';
import { reportSha256 } from './report-digest.js';
// Read-only access to 0.2.2 data. Legacy keys are never written or removed
// here: a migrated item is recorded as a new nc: resolution, so the old copy
// stays valid whatever happens to the new one.
const LEGACY_INDEX = /^(?:book-session$|reader-session:|draft-preview:)/;
export const legacyItemKey = (...parts) => reportSha256(JSON.stringify(['legacy', ...parts])).slice(0, 40);

function sectionAt(sections, offset) {
  let lo = 0, hi = sections.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (sections[mid].start <= offset) lo = mid; else hi = mid - 1; }
  return sections[lo];
}

/** Whole-book legacy edits become paragraph proposals when every edit stays
 * inside one paragraph and keeps paragraph boundaries; anything else is kept
 * as an unmappable item for the user to decide. */
export function legacyParagraphChanges(item) {
  const { book } = item;
  const reported = new Set(diffBook(book.originalText, item.reportedText ?? book.originalText).map(change => JSON.stringify(change)));
  const changes = diffBook(book.originalText, item.editedText).filter(change => !reported.has(JSON.stringify(change)));
  const bySection = new Map(), unmappable = [];
  for (const change of changes) {
    const section = sectionAt(book.sections, change.start);
    if (change.end > section.end || change.proposed.includes('\n') || change.proposed.includes('\r')) {
      unmappable.push({ ...change, reason: 'paragraph_boundaries', sectionIndex: section.index });
      continue;
    }
    if (!bySection.has(section.index)) bySection.set(section.index, { section, edits: [] });
    bySection.get(section.index).edits.push(change);
  }
  const mapped = [];
  for (const { section, edits } of bySection.values()) {
    const text = book.originalText.slice(section.start, section.end);
    let proposed = '', cursor = 0;
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
      proposed += text.slice(cursor, edit.start - section.start) + edit.proposed; cursor = edit.end - section.start;
    }
    proposed += text.slice(cursor);
    const unsupported = /[<>]|&(?:#x?[0-9a-f]+|[a-z][a-z0-9]*);/i.test(proposed) ? 'unsupported_text' :
      proposed.length > 20000 ? 'too_long' : null;
    const entry = { sectionIndex: section.index, originalText: text, proposedText: proposed };
    if (unsupported) unmappable.push({ ...entry, reason: unsupported }); else mapped.push(entry);
  }
  return { mapped: mapped.sort((a, b) => a.sectionIndex - b.sectionIndex), unmappable };
}

export async function readLegacyDrafts(call) {
  const keys = (await call('storage.list')) ?? [];
  const drafts = [], seen = new Map(), failures = [];
  for (const key of keys.filter(key => LEGACY_INDEX.test(key))) {
    let saved;
    try {
      // readKey only: this storage object never writes its (unused) indexKey.
      saved = await createDraftStorage(call, () => { throw new Error('read-only'); },
        { indexKey: `nc:never-written:${key}`, readKey: key }).read();
    } catch (error) { failures.push({ key, message: error.message }); continue; }
    const sessions = saved?.schemaVersion === 2 ? saved.sessions ?? [] : saved?.book ? [saved] : [];
    for (const item of sessions) {
      if (!item?.book?.identity || typeof item.editedText !== 'string') continue;
      const queue = (item.queue ?? []).map(report => ({ reportId: report.payload?.report_id ?? report.submission?.reportId ?? null,
        sent: report.sent === true, sentAt: report.sentAt ?? null, correctionSupported: report.correctionSupported ?? null,
        reportKind: report.payload?.report_kind ?? null, submission: report.submission ?? null,
        original: report.submission?.original ?? report.payload?.selected_text ?? '',
        proposed: report.submission?.proposed ?? report.payload?.correction?.proposed_text ?? '',
        sectionIndex: report.submission?.sectionIndex ?? report.payload?.location?.line_index ?? null }));
      const { mapped, unmappable } = item.queue ? { mapped: [], unmappable: [] } : legacyParagraphChanges(item);
      const signature = reportSha256(JSON.stringify([item.book.identity, item.editedText, item.reportedText ?? null, queue.map(report => [report.reportId, report.sent])]));
      // draft-preview copies duplicate a reader draft: show the content once.
      if (seen.has(signature)) { seen.get(signature).keys.push(key); continue; }
      const identity = item.book.identity;
      const draft = { keys: [key], id: legacyItemKey(signature), bookUid: identity.bookUid ?? null, bookId: identity.bookId,
        title: item.book.details?.title ?? identity.bookId, book: item.book, completed: !!item.completed,
        mapped: mapped.map(change => ({ ...change, key: legacyItemKey(signature, 'change', change.sectionIndex, change.proposedText) })),
        unmappable: unmappable.map(change => ({ ...change, key: legacyItemKey(signature, 'unmappable', change.sectionIndex ?? -1, change.proposed ?? change.proposedText) })),
        queue: queue.map(report => ({ ...report, key: legacyItemKey(signature, 'report', report.reportId) })) };
      seen.set(signature, draft); drafts.push(draft);
    }
  }
  return { drafts, failures };
}

/** Legacy personal history (sent reports of 0.2.2), read-only. */
export async function readLegacyHistory(call) {
  const keys = (await call('storage.list')) ?? [], items = [];
  for (const key of keys) {
    if (!key.startsWith('correction-history:')) continue;
    const item = await call('storage.get', { key });
    if (item?.submission && typeof item.id === 'string') items.push(item);
  }
  return items.sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0));
}
