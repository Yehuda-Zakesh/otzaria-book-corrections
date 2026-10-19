import { reportIdFor } from './correction-store.js';
import { codeOf } from './correction-sessions.js';
// Paragraph proposals become feedback.submitBookCorrection requests (0.9.99).
// Offsets are UTF-16 units in the stripped paragraph text (snapshots[].text).
const high = /[\uD800-\uDBFF]/, low = /[\uDC00-\uDFFF]/;
function minimalRange(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  // Never split a surrogate pair.
  if (start > 0 && high.test(before[start - 1])) start--;
  if (end > 0 && low.test(before[before.length - end])) end--;
  return { start, end: before.length - end, insert: after.slice(start, after.length - end) };
}
function insideTag(raw, index) {
  const open = raw.lastIndexOf('<', index), close = raw.lastIndexOf('>', index - 1);
  return open > close;
}
/** The host builds a structured correction for HTML paragraphs only when the
 * original wording occurs once in the raw source outside tags. Widen with
 * unchanged neighbouring text until that holds; the host verifies again. */
export function correctionRange(change) {
  const plain = change.originalText, raw = change.originalSourceText;
  const { start, end, insert } = minimalRange(plain, change.proposedText);
  const usable = (a, b) => {
    const original = plain.slice(a, b);
    if (raw === plain) return original.length > 0 || a === b;
    if (!original || original.includes('<') || original.includes('&')) return false;
    const at = raw.indexOf(original);
    return at >= 0 && at === raw.lastIndexOf(original) && !insideTag(raw, at);
  };
  let a = start, b = end;
  for (let step = 0; step <= 128 && !usable(a, b); step++) {
    if (a > 0) a--; if (b < plain.length) b++;
    if (a > 0 && low.test(plain[a])) a--;
    if (b < plain.length && low.test(plain[b])) b++;
    if (a === 0 && b === plain.length) break;
  }
  if (!usable(a, b)) { a = start; b = end; }
  return { sourceStart: a, sourceEnd: b, original: plain.slice(a, b), proposed: plain.slice(a, start) + insert + plain.slice(end, b) };
}

export function submissionParams(book, item, reportId, { freeText = false } = {}) {
  const range = correctionRange(item);
  return { reportId, bookId: book.bookId, bookUid: book.bookUid, sectionIndex: item.sectionIndex,
    snapshots: [{ index: item.sectionIndex, text: item.originalText }],
    original: range.original, proposed: range.proposed, sourceStart: range.sourceStart, sourceEnd: range.sourceEnd,
    details: `הצעת תיקון בפסקה ${item.sectionIndex + 1}. נשלח באמצעות תוסף תיקוני ספרים.`,
    allowQueue: true,
    // Free text only on the user's explicit decision; never a silent fallback.
    ...(freeText ? {} : { requireTextCorrection: true }) };
}

export function deliveryLabel(record) {
  const result = record?.result ?? record;
  if (!result?.status) return null;
  if (result.status === 'queued') return 'בתור הדיווחים של אוצריא — טרם נשלח לאתר';
  if (result.reportKind === 'free_text') return 'נשלח כדיווח חופשי — מגיע לדוא״ל בלבד ואינו בתור התיקונים באתר';
  if (result.correctionSupported === true) return 'התקבל באתר כתיקון מובנה';
  return 'נשלח, אך האתר לא אישר קליטה כתיקון מובנה';
}

/** Sends one stored proposal. An attempt record is written first, so after a
 * timeout or restart the same report ID is reused and Otzaria deduplicates. */
export async function submitItem({ call, store, book, item, freeText = false }) {
  if (item.resolution) return { status: 'already', record: item.resolution };
  const reportId = reportIdFor(item.key, item.generation ?? 0);
  // Detected conflict without the user's consent: nothing is sent, and the
  // same question is asked again after a refusal or a restart.
  if (item.idConflict) return { status: 'id_conflict', reportId };
  await store.recordSubmission(book.bookUid, item.key, reportId, 'attempt', { freeText });
  let result;
  try {
    result = await call('feedback.submitBookCorrection', submissionParams(book, item, reportId, { freeText }));
  } catch (error) {
    const code = codeOf(error);
    if (code === 'text_correction_unavailable') return { status: 'needs_decision', reportId };
    if (code === 'report_id_conflict') {
      // The ID already names different content (in Otzaria's queue or at the
      // site). Only a later consent record (consentNewReportId) advances it.
      await store.recordSubmission(book.bookUid, item.key, reportId, 'id_conflict', { generation: item.generation ?? 0 });
      return { status: 'id_conflict', reportId };
    }
    if (code === 'source_changed') return { status: 'source_changed', reportId };
    if (code === 'report_email_required') return { status: 'email_required', reportId };
    throw error;
  }
  if (result?.status !== 'sent' && result?.status !== 'queued') throw new Error('אוצריא החזירה תשובה לא מוכרת לשליחה. התיקון נשמר.');
  const record = { reportId: result.reportId ?? reportId, nativeReportId: result.nativeReportId ?? null,
    reportKind: result.reportKind ?? null, correctionSupported: result.correctionSupported ?? null,
    duplicate: result.duplicate === true, status: result.status };
  await store.recordSubmission(book.bookUid, item.key, record.reportId, result.status, { result: record });
  // The resolution keeps what was sent: history survives compaction.
  await store.resolve(book.bookUid, item.key, result.status, { result: record, sectionIndex: item.sectionIndex,
    originalText: item.originalText, proposedText: item.proposedText, title: book.bookId ?? null });
  return { status: result.status, record };
}
