import { diffBook } from './changes.js';
// Immutable source books and copy-on-write drafts. The workspace index is the
// commit point: a failed draft/index write never damages the previous snapshot.
function textPatch(source, text) {
  return diffBook(source, text).map(change => ({ start: change.start, end: change.end, text: change.proposed }));
}
function restorePatch(source, patch) {
  if (Array.isArray(patch)) {
    const parts = []; let cursor = 0;
    for (const change of patch) {
      if (!change || !Number.isInteger(change.start) || !Number.isInteger(change.end) ||
          change.start < cursor || change.end < change.start || change.end > source.length || typeof change.text !== 'string') {
        throw new Error('לא ניתן לשחזר את טיוטת הספר. נתוני הטיוטה נשמרו.');
      }
      parts.push(source.slice(cursor, change.start), change.text); cursor = change.end;
    }
    parts.push(source.slice(cursor)); return parts.join('');
  }
  if (!patch || !Number.isInteger(patch.start) || !Number.isInteger(patch.end) ||
      patch.start < 0 || patch.end < patch.start || patch.end > source.length || typeof patch.text !== 'string') {
    throw new Error('לא ניתן לשחזר את טיוטת הספר. נתוני הטיוטה נשמרו.');
  }
  return source.slice(0, patch.start) + patch.text + source.slice(patch.end);
}
export function decodeStoredDraft(book, draft) {
  const { editedPatch, reportedPatch, ...state } = draft;
  const restoredBook = { ...book, sections: book.sections.map(section => ({ ...section,
    text: book.originalText.slice(section.start, section.end) })) };
  return { ...state, book: restoredBook, editedText: restorePatch(book.originalText, editedPatch),
    ...(reportedPatch ? { reportedText: restorePatch(book.originalText, reportedPatch) } : {}) };
}
export function createDraftStorage(call, idFactory) {
  let committed = new Map();
  const patches = new Map(), garbage = new Set();
  function patchFor(id, kind, source, text) {
    const key = `${id}:${kind}`, previous = patches.get(key);
    if (previous?.source === source && previous.text === text) return previous.patch;
    const patch = textPatch(source, text); patches.set(key, { source, text, patch }); return patch;
  }
  async function read() {
    const index = await call('storage.get', { key: 'book-session' });
    if (index?.schemaVersion !== 3) return index;
    const sessions = [], restored = new Map();
    for (const ref of index.sessions) {
      const book = await call('storage.get', { key: ref.bookKey });
      const draft = await call('storage.get', { key: ref.draftKey });
      if (!book || !draft) throw new Error('לא ניתן לקרוא את טיוטת הספר. נתוני הטיוטה נשמרו.');
      const item = decodeStoredDraft(book, draft);
      sessions.push(item); restored.set(ref.id, { ...ref, serialized: JSON.stringify(draft), book: item.book });
    }
    committed = restored;
    return { ...index, schemaVersion: 2, sessions };
  }
  async function write(snapshot) {
    const next = new Map();
    for (const item of snapshot?.sessions ?? []) {
      const old = committed.get(item.id), { book, editedText, reportedText, ...state } = item;
      const draft = { ...state, editedPatch: patchFor(item.id, 'edited', book.originalText, editedText),
        ...(reportedText !== undefined ? { reportedPatch: patchFor(item.id, 'reported', book.originalText, reportedText) } : {}) };
      const serialized = JSON.stringify(draft);
      let bookKey = old?.bookKey;
      if (!bookKey || old.book !== book) {
        bookKey = `book-source:${idFactory()}`; garbage.add(bookKey);
        await call('storage.set', { key: bookKey, value: { ...book,
          sections: book.sections.map(({ text, ...section }) => section) } });
      }
      let draftKey = old?.draftKey;
      if (!draftKey || old.serialized !== serialized) {
        draftKey = `book-draft:${idFactory()}`; garbage.add(draftKey);
        await call('storage.set', { key: draftKey, value: draft });
      }
      next.set(item.id, { id: item.id, bookKey, draftKey, serialized, book });
    }
    if (snapshot) await call('storage.set', { key: 'book-session', value: { ...snapshot, schemaVersion: 3,
      sessions: [...next.values()].map(({ id, bookKey, draftKey }) => ({ id, bookKey, draftKey })) } });
    else await call('storage.remove', { key: 'book-session' });
    for (const ref of committed.values()) { garbage.add(ref.bookKey); garbage.add(ref.draftKey); }
    committed = next;
    for (const ref of next.values()) { garbage.delete(ref.bookKey); garbage.delete(ref.draftKey); }
    for (const key of patches.keys()) if (!next.has(key.slice(0, key.lastIndexOf(':')))) patches.delete(key);
    // Cleanup failure is harmless and retried on the next successful save.
    for (const key of garbage) {
      try { await call('storage.remove', { key }); garbage.delete(key); } catch { /* retain for retry */ }
    }
  }
  return { read, write };
}
