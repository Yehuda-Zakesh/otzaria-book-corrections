import { changeKey } from './correction-store.js';

export const SEND_VISIBILITY_KEY = 'hasPendingCorrections';
export function hasPendingCorrections(state, sessions, activeElsewhere = new Map()) {
  const active = [...sessions.values()].filter(item => !item.ended);
  for (const book of state.books.values()) {
    for (const pending of book.pending) {
      const entry = book.entries?.find(entry => entry.sessionId === pending.sessionId &&
        entry.draftId === pending.draftId && entry.version === pending.version);
      const live = active.find(item => item.snapshot.bookUid === book.bookUid &&
        ((pending.sessionId === item.snapshot.sessionId &&
          !(Number.isInteger(entry?.revision) && Number.isInteger(item.snapshot.revision) &&
            item.snapshot.revision < entry.revision)) ||
          (book.inherited?.get(item.snapshot.sessionId)?.has(pending.sectionIndex) &&
           pending.version <= book.inherited.get(item.snapshot.sessionId).get(pending.sectionIndex))));
      if (!live || live.snapshot.changes.some(change => changeKey(book.bookUid, change) === pending.key)) return true;
    }
  }
  for (const item of active) {
    const book = state.books.get(item.snapshot.bookUid);
    if (item.snapshot.changes.some(change => !book?.resolutions?.has(changeKey(item.snapshot.bookUid, change)))) return true;
  }
  return [...activeElsewhere.values()].some(meta => meta.changeCount > 0);
}
export function createSendVisibility(call) {
  let queue = Promise.resolve();
  return { sync(state, sessions, activeElsewhere) {
    const visible = hasPendingCorrections(state, sessions, activeElsewhere);
    queue = queue.catch(() => {}).then(async () => {
      if (await call('storage.get', { key: SEND_VISIBILITY_KEY }) !== visible) {
        await call('storage.set', { key: SEND_VISIBILITY_KEY, value: visible });
      }
      return visible;
    });
    return queue;
  } };
}
