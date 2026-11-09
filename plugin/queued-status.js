import { codeOf } from './correction-sessions.js';

// A report Otzaria queued (offline) is sent later by Otzaria's own queue; the
// plugin is not told. Ask the host (feedback.getBookCorrectionStatus, 0.9.99)
// and upgrade queued records to sent. Anything unclear leaves the record as it
// is: the label never claims more than the host confirmed.
const MAX_PER_ROUND = 20;
const unsupportedCodes = new Set(['unknown_method', 'method_not_found', 'not_supported', 'unsupported', 'not_implemented', 'permission_denied']);

export function queuedReports(state) {
  const found = [];
  for (const book of state?.books?.values?.() ?? []) {
    for (const [itemKey, list] of book.resolutions ?? []) {
      if (list.some(record => record.status === 'sent')) continue;
      const queued = list.find(record => record.status === 'queued');
      const reportId = queued?.result?.reportId;
      if (typeof reportId === 'string' && reportId) found.push({ bookUid: book.bookUid, itemKey, reportId, record: queued });
    }
  }
  return found.sort((a, b) => (a.record.at ?? 0) - (b.record.at ?? 0));
}

const isUnsupported = error => unsupportedCodes.has(codeOf(error)) ||
  /unknown method|method not found|not supported|unsupported/i.test(String(error?.message ?? ''));

/** Returns how many records were upgraded to sent. `supported` goes false when
 * the host has no such method, and the caller then stops asking. */
export async function refreshQueuedStatuses({ call, store, state }) {
  const result = { sent: 0, supported: true };
  for (const { bookUid, itemKey, reportId, record } of queuedReports(state).slice(0, MAX_PER_ROUND)) {
    let answer;
    try { answer = await call('feedback.getBookCorrectionStatus', { reportId }); }
    catch (error) {
      if (isUnsupported(error)) { result.supported = false; return result; }
      continue; // transient: asked again next round
    }
    if (answer?.status !== 'sent') continue; // queued / rejected / unknown: no change
    const sent = { ...record.result, status: 'sent', nativeReportId: answer.nativeReportId ?? record.result.nativeReportId ?? null,
      duplicate: false, fromQueue: true };
    await store.recordSubmission(bookUid, itemKey, reportId, 'sent', { result: sent });
    await store.resolve(bookUid, itemKey, 'sent', { result: sent, sectionIndex: record.sectionIndex, originalText: record.originalText,
      originalSourceText: record.originalSourceText, proposedText: record.proposedText, title: record.title ?? null });
    result.sent++;
  }
  return result;
}
