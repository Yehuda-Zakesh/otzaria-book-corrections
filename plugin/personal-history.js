import { diffBook } from './changes.js';
const prefix = 'correction-history:';
const statusPrefix = 'correction-status:';
export const historyStatus = {
  unchecked: 'טרם נבדק', present: 'הנוסח המוצע נמצא בספרייה', unchanged: 'המקור עדיין ללא התיקון',
  changed: 'המקור השתנה — נדרשת בדיקה', unavailable: 'לא ניתן לבדוק כעת'
};
export function historyRecord(book, item) {
  return { id: item.submission.reportId, identity: book.identity, title: book.details.title ?? book.identity.bookId,
    location: item.payload.current_ref, sentAt: item.sentAt ?? Date.now(), submission: item.submission,
    status: 'unchecked', correctionSupported: item.correctionSupported === true };
}
export function classifyCorrection(record, lines) {
  const s = record?.submission, snapshots = s?.snapshots;
  if (!Array.isArray(snapshots) || !snapshots.length) return 'changed';
  if (!Array.isArray(lines) || snapshots.some(snapshot => !Number.isInteger(snapshot?.index) || snapshot.index < 0 || typeof snapshot.text !== 'string')) return 'changed';
  const current = snapshots.map(({ index }) => lines[index]);
  if (current.some(line => typeof line !== 'string')) return 'changed';
  if (current.every((line, i) => line === snapshots[i].text)) return 'unchanged';
  if (snapshots.length !== 1 || !Number.isInteger(s.sourceStart) || !Number.isInteger(s.sourceEnd)) return 'changed';
  const before = snapshots[0].text;
  if (s.sourceStart < 0 || s.sourceEnd < s.sourceStart || s.sourceEnd > before.length || typeof s.original !== 'string' || typeof s.proposed !== 'string') return 'changed';
  if (before.slice(s.sourceStart, s.sourceEnd) !== s.original) return 'changed';
  const expected = before.slice(0, s.sourceStart) + s.proposed + before.slice(s.sourceEnd);
  if (current[0] === expected) return 'present';
  if (before.length > 50000 || current[0].length > 50000) return 'changed';
  // Independent corrections in the same paragraph may already be present together.
  const exact = diffBook(before, current[0]).some(change => change.start === s.sourceStart && change.end === s.sourceEnd && change.proposed === s.proposed);
  return exact ? 'present' : 'changed';
}
export function createPersonalHistory(call) {
  // Keep scan results separate from immutable report archives: another reader
  // WebView can finish archiving after this view has already scanned the report.
  const pending = new Map();
  function update(key, operation) {
    const next = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    pending.set(key, next);
    return next.finally(() => { if (pending.get(key) === next) pending.delete(key); });
  }
  return {
    async save(book, item) {
      const key = prefix + item.submission.reportId;
      return update(key, async () => {
        if (!await call('storage.get', { key })) await call('storage.set', { key, value: historyRecord(book, item) });
      });
    },
    async list() {
      const keys = await call('storage.list');
      const result = [];
      for (const key of keys ?? []) if (key.startsWith(prefix)) {
        const item = await call('storage.get', { key });
        if (item?.submission && item.identity && typeof item.id === 'string' && (typeof item.identity.bookUid === 'string' || typeof item.identity.bookId === 'string')) {
          const state = await call('storage.get', { key: statusPrefix + item.id });
          result.push(state && Object.hasOwn(historyStatus, state.status) && Number.isFinite(state.checkedAt)
            ? { ...item, status: state.status, checkedAt: state.checkedAt } : item);
        }
      }
      return result.sort((a, b) => b.sentAt - a.sentAt);
    },
    async check(record, lines) {
      const next = { ...record, status: classifyCorrection(record, lines), checkedAt: Date.now() };
      const key = statusPrefix + record.id;
      await update(key, () => call('storage.set', { key, value: { status: next.status, checkedAt: next.checkedAt } }));
      return next;
    },
    async checkUnavailable(record) {
      const next = { ...record, status: 'unavailable', checkedAt: Date.now() };
      const key = statusPrefix + record.id;
      await update(key, () => call('storage.set', { key, value: { status: next.status, checkedAt: next.checkedAt } }));
      return next;
    }
  };
}
