import { decodeStoredDraft } from '../plugin/draft-storage.js';
export function storedWorkspace(storage) {
  const index = storage.get('book-session');
  if (index?.schemaVersion !== 3) return index;
  return { ...index, sessions: index.sessions.map(ref => decodeStoredDraft(storage.get(ref.bookKey), storage.get(ref.draftKey))) };
}
