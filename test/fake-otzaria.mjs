// In-memory model of the Otzaria 0.9.99 correction session/draft contract
// (docs/plugin-sdk/API_REFERENCE.md, "חוזה שמירה והתאוששות"), shared by
// several plugin instances. It is a contract model, not the host.
const fail = (code, message = code) => Object.assign(new Error(message), { code: `error.${code}` });

export function createStorage() {
  const data = new Map();
  const storage = { data, failSet: false, failGet: false, sets: 0,
    async call(method, args) {
      if (method === 'storage.list') return [...data.keys()];
      if (method === 'storage.get') {
        if (storage.failGet) throw fail('storage_failed');
        return data.has(args.key) ? structuredClone(data.get(args.key)) : null;
      }
      if (method === 'storage.set') {
        if (storage.failSet) throw fail('storage_failed', 'quota');
        storage.sets++; data.set(args.key, structuredClone(args.value)); return true;
      }
      if (method === 'storage.remove') { data.delete(args.key); return true; }
      return undefined;
    } };
  return storage;
}

export function createFakeOtzaria({ books = { 'id:1': { bookId: 'ספר', lines: ['אלף', '<b>בית</b> גימל', 'דלת', 'הא'] } } } = {}) {
  const host = { books, tabs: new Map(), sessions: new Map(), drafts: new Map(), nextVersion: 1, nextId: 1,
    libraryVersion: '1', persist: true, acks: [], calls: [], loseAckResponse: false, submissions: new Map(), submitMode: 'sent' };
  const strip = raw => raw.replace(/<[^>]*>/g, '');
  const draftIdOf = bookUid => `d-${bookUid}`;
  function draftOf(bookUid) {
    const id = draftIdOf(bookUid);
    if (!host.drafts.has(id)) host.drafts.set(id, { draftId: id, bookUid, bookId: books[bookUid].bookId, version: null,
      changes: [], conflicts: [], content: false, acked: null, libraryVersion: host.libraryVersion, updatedAt: 0 });
    return host.drafts.get(id);
  }
  function commit(session) {
    const draft = draftOf(session.bookUid);
    if (!host.persist) { session.persistedRevision = null; return; }
    draft.version = host.nextVersion++;
    draft.changes = structuredClone(session.changes);
    draft.conflicts = [...draft.conflicts];
    draft.content = draft.changes.length > 0 || draft.conflicts.length > 0;
    draft.updatedAt = Date.now();
    session.persistedRevision = session.revision;
  }
  function snapshot(session) {
    const draft = draftOf(session.bookUid);
    const persisted = session.persistedRevision === session.revision;
    return structuredClone({ sessionId: session.sessionId, tabId: session.tabId, bookId: books[session.bookUid].bookId,
      bookUid: session.bookUid, libraryVersion: host.libraryVersion, revision: session.revision, changes: session.changes,
      capabilities: { maxChanges: 500 },
      draft: { draftId: draft.draftId, version: persisted && !session.displaced ? draft.version : null, persisted,
        pending: !persisted, displaced: !!session.displaced, error: null, conflicts: draft.conflicts } });
  }
  function source(bookUid, index) { return books[bookUid].lines[index]; }
  function liveSession(sessionId) {
    const session = host.sessions.get(sessionId);
    if (!session || session.ended) throw fail('not_found');
    return session;
  }
  host.openTab = (bookUid, tabId = `tab-${host.nextId++}`) => { host.tabs.set(tabId, bookUid); return tabId; };
  host.edit = (sessionId, sectionIndex, proposedText) => {
    const session = liveSession(sessionId), raw = source(session.bookUid, sectionIndex);
    session.changes = session.changes.filter(change => change.sectionIndex !== sectionIndex);
    if (proposedText !== strip(raw)) session.changes.push({ sectionIndex, originalSourceText: raw, originalText: strip(raw), proposedText });
    session.changes.sort((a, b) => a.sectionIndex - b.sectionIndex);
    session.revision++; commit(session);
    return { sessionId, revision: session.revision, sectionIndices: [sectionIndex] };
  };
  host.endByUser = (sessionId, reason = 'user') => {
    const session = liveSession(sessionId); session.ended = true;
    return { sessionId, reason, snapshot: snapshot(session) };
  };
  const methods = {
    'reader.beginCorrectionSession'({ tabId }) {
      const bookUid = host.tabs.get(tabId);
      if (!bookUid) throw fail('not_found');
      for (const session of host.sessions.values()) {
        if (session.ended || session.bookUid !== bookUid) continue;
        if (session.tabId === tabId) return { ...snapshot(session), recovery: null };
        throw fail('correction_busy');
      }
      const session = { sessionId: `s-${host.nextId++}`, tabId, bookUid, revision: 1, changes: [], persistedRevision: null };
      const draft = draftOf(bookUid);
      let recovery = null;
      if (draft.content) {
        const restored = [], conflicts = [...draft.conflicts];
        for (const change of draft.changes) {
          const raw = source(bookUid, change.sectionIndex);
          if (raw === undefined) conflicts.push({ ...change, reason: 'not_found' });
          else if (raw === change.originalSourceText && strip(raw) === change.originalText) { session.changes.push(change); restored.push(change.sectionIndex); }
          else conflicts.push({ ...change, reason: 'source_changed' });
        }
        draft.conflicts = conflicts;
        recovery = { draftId: draft.draftId, fromVersion: draft.version, restoredSectionIndices: restored, conflicts };
      }
      host.sessions.set(session.sessionId, session);
      if (recovery) commit(session);
      return { ...snapshot(session), recovery };
    },
    'reader.getCorrectionSession'({ sessionId }) {
      const session = host.sessions.get(sessionId);
      if (!session) throw fail('not_found');
      return snapshot(session);
    },
    'reader.resetCorrection'({ sessionId, sectionIndex, expectedRevision }) {
      const session = liveSession(sessionId);
      if (expectedRevision !== session.revision) throw fail('revision_conflict');
      if (!session.changes.some(change => change.sectionIndex === sectionIndex)) return snapshot(session);
      session.changes = session.changes.filter(change => change.sectionIndex !== sectionIndex);
      session.revision++; commit(session); return snapshot(session);
    },
    'reader.restoreCorrectionDraft'({ sessionId, bookUid, libraryVersion, expectedRevision, changes }) {
      const session = liveSession(sessionId);
      if (bookUid !== session.bookUid) throw fail('invalid_params');
      if (expectedRevision !== session.revision) throw fail('revision_conflict');
      if (libraryVersion !== host.libraryVersion) throw fail('source_changed');
      for (const change of changes) {
        const raw = source(bookUid, change.sectionIndex);
        if (raw !== change.originalSourceText || strip(raw) !== change.originalText) throw fail('source_changed');
      }
      session.changes = structuredClone(changes.filter(change => change.proposedText !== change.originalText));
      session.revision++; commit(session); return snapshot(session);
    },
    'reader.endCorrectionSession'({ sessionId, expectedRevision }) {
      const session = liveSession(sessionId);
      if (expectedRevision !== session.revision) throw fail('revision_conflict');
      session.ended = true; return snapshot(session);
    },
    'reader.acknowledgeCorrectionDraft'({ draftId, version }) {
      const draft = host.drafts.get(draftId);
      host.acks.push({ draftId, version });
      if (!draft) throw fail('not_found');
      if (draft.acked === version) return { draftId, version, acknowledged: true, duplicate: true };
      if (!draft.content) throw fail('not_found');
      if (draft.version !== version) throw fail('revision_conflict');
      draft.changes = []; draft.conflicts = []; draft.content = false; draft.acked = version;
      if (host.loseAckResponse) { host.loseAckResponse = false; throw fail('timeout', 'response lost'); }
      return { draftId, version, acknowledged: true, duplicate: false };
    },
    'reader.listCorrectionDrafts'() {
      return { drafts: [...host.drafts.values()].filter(draft => draft.content).map(draft => ({ draftId: draft.draftId,
        bookId: draft.bookId, bookUid: draft.bookUid, bookSource: 'library', libraryVersion: draft.libraryVersion,
        version: draft.version, updatedAt: new Date(draft.updatedAt).toISOString(),
        active: [...host.sessions.values()].some(session => !session.ended && session.bookUid === draft.bookUid),
        changeCount: draft.changes.length, conflictCount: draft.conflicts.length })) };
    },
    'reader.getCorrectionDraft'({ draftId }) {
      const draft = host.drafts.get(draftId);
      if (!draft?.content) throw fail('not_found');
      return structuredClone({ draftId, bookId: draft.bookId, bookUid: draft.bookUid, bookSource: 'library',
        libraryVersion: draft.libraryVersion, version: draft.version, updatedAt: '', active: false,
        changes: draft.changes, conflicts: draft.conflicts });
    },
    'feedback.submitBookCorrection'(params) {
      const previous = host.submissions.get(params.reportId);
      const content = JSON.stringify({ ...params, reportId: undefined, requireTextCorrection: undefined, allowQueue: undefined });
      if (previous && previous.content !== content) throw fail('report_id_conflict');
      if (params.requireTextCorrection && host.textCorrectionUnavailable) throw fail('text_correction_unavailable');
      if (host.submitFails) throw fail(host.submitFails);
      const status = host.submitMode;
      host.submissions.set(params.reportId, { content, params, count: (previous?.count ?? 0) + 1 });
      if (host.loseSubmitResponse) { host.loseSubmitResponse = false; throw fail('timeout', 'response lost'); }
      return { status, reportId: params.reportId, nativeReportId: `n-${params.reportId}`, message: '', duplicate: !!previous,
        reportKind: params.requireTextCorrection || !params.forceFreeText ? 'text_correction' : 'free_text',
        correctionSupported: status === 'sent' ? true : null };
    },
    'feedback.hasReporterEmail'() { return { hasEmail: true }; }
  };
  host.instance = storage => async (method, args = {}) => {
    host.calls.push(method);
    if (method.startsWith('storage.')) return storage.call(method, args);
    if (!methods[method]) throw new Error(`Unexpected method ${method}`);
    return methods[method](structuredClone(args));
  };
  return host;
}
