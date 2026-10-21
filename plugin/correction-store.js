import { reportSha256 } from './report-digest.js';
// Durable plugin copy of Otzaria correction drafts (contract 0.9.99).
// Every record is written once under its own key and never rewritten, so two
// plugin instances (windows, background/foreground) cannot overwrite each
// other: a key written twice always receives the same content. State is the
// merge of all records; nothing is removed unless a floor record proves it is
// fully handled. Legacy 0.2.2 keys (book-session, book-source:, book-draft:,
// reader-session:, correction-history:) are never written here.
export const PREFIX = 'nc:';
const ENTRY = `${PREFIX}e:`, INHERITED = `${PREFIX}inh:`, RESOLVED = `${PREFIX}r:`;
const SUBMISSION = `${PREFIX}sub:`, FLOOR = `${PREFIX}floor:`;
const SESSION = `${PREFIX}s:`, FINAL = `${PREFIX}fin:`, INTENT = `${PREFIX}intent:`, INTENT_DONE = `${PREFIX}intent-done:`;
export const SCHEMA = 1;
const hash = value => reportSha256(JSON.stringify(value)).slice(0, 40);
const keyPart = value => encodeURIComponent(String(value));
export const changeKey = (bookUid, change) =>
  hash(['change', bookUid, change.sectionIndex, change.originalSourceText, change.proposedText]);
// Same structured key as the Otzaria cookbook, scoped to the book.
export const conflictKey = (bookUid, conflict) =>
  hash(['conflict', bookUid, conflict.sectionIndex, conflict.originalSourceText, conflict.proposedText]);
// A report ID is stable for the same proposal, across restarts and windows.
// Only an explicit user consent after report_id_conflict advances it.
export const reportIdFor = (itemKey, generation = 0) => `bc-${itemKey}${generation ? `-${generation}` : ''}`;
const statusRank = { attempt: 1, queued: 2, sent: 3 };
const submissionStatuses = new Set([...Object.keys(statusRank), 'id_conflict', 'id_consent']);
const resolvedStatuses = new Set(['queued', 'sent', 'dismissed', 'restored', 'migrated']);

function validChange(change) {
  return change && Number.isInteger(change.sectionIndex) && change.sectionIndex >= 0 &&
    typeof change.originalSourceText === 'string' && typeof change.originalText === 'string' &&
    typeof change.proposedText === 'string';
}
function copyChange({ sectionIndex, originalSourceText, originalText, proposedText }) {
  return { sectionIndex, originalSourceText, originalText, proposedText };
}
const sameChange = (a, b) => a.sectionIndex === b.sectionIndex && a.originalSourceText === b.originalSourceText && a.proposedText === b.proposedText;

export function createCorrectionStore(call, { now = () => Date.now(), nonce = () => `${now()}-${Math.random().toString(36).slice(2)}` } = {}) {
  async function setOnce(key, value) {
    // Immutable record: an existing value is the same content and is kept.
    if (await call('storage.get', { key }) != null) return false;
    await call('storage.set', { key, value });
    return true;
  }
  const store = {
    /** Durably saves the complete content of one acknowledgeable version.
     * Throws on any storage failure; the caller must not acknowledge then. */
    async saveVersion(source, { sessionId = null, revision = null, attributed = false } = {}) {
      const draft = source.draft ?? source;
      const { draftId, version } = draft;
      const changes = source.changes, conflicts = draft.conflicts ?? source.conflicts;
      if (typeof draftId !== 'string' || !draftId || !Number.isSafeInteger(version) ||
          !Array.isArray(changes) || !Array.isArray(conflicts) || !changes.every(validChange) || !conflicts.every(validChange) ||
          typeof source.bookUid !== 'string' || !source.bookUid) {
        throw new Error('נתוני הטיוטה מאוצריא אינם שלמים; הטיוטה נשארה באוצריא.');
      }
      const key = `${ENTRY}${keyPart(source.bookUid)}:${keyPart(draftId)}:${version}`;
      const value = { schema: SCHEMA, draftId, version, bookUid: source.bookUid, bookId: source.bookId ?? null,
        libraryVersion: source.libraryVersion ?? null, sessionId, attributed, revision,
        changes: changes.map(copyChange),
        conflicts: conflicts.map(conflict => ({ ...copyChange(conflict), reason: conflict.reason ?? 'invalid' })),
        savedAt: now() };
      await setOnce(key, value);
      // Read back: acknowledgement deletes Otzaria's copy, so require proof.
      const stored = await call('storage.get', { key });
      if (!stored || stored.version !== version || stored.draftId !== draftId ||
          stored.changes?.length !== changes.length || stored.conflicts?.length !== conflicts.length) {
        throw new Error('שמירת הטיוטה בתוסף לא אומתה; הטיוטה נשארה באוצריא.');
      }
      return stored;
    },
    /** Written before beginCorrectionSession: an unmatched recent intent means
     * a session may exist that this plugin never recorded. */
    async beginIntent() {
      const id = nonce();
      await call('storage.set', { key: `${INTENT}${keyPart(id)}`, value: { schema: SCHEMA, nonce: id, at: now() } });
      return id;
    },
    async intentDone(id) { await setOnce(`${INTENT_DONE}${keyPart(id)}`, { schema: SCHEMA, nonce: id, at: now() }); },
    async recordSession(snapshot, intent) {
      await setOnce(`${SESSION}${keyPart(snapshot.bookUid)}:${keyPart(snapshot.sessionId)}`,
        { schema: SCHEMA, sessionId: snapshot.sessionId, bookUid: snapshot.bookUid, nonce: intent ?? null, beganAt: now() });
    },
    /** The final shape of a session (sections it still proposes), also when
     * the final snapshot is not acknowledgeable. Used only to cancel, never
     * as content: content is taken over only from saved versions. */
    async recordFinal(snapshot, reason = null) {
      await setOnce(`${FINAL}${keyPart(snapshot.bookUid)}:${keyPart(snapshot.sessionId)}`,
        { schema: SCHEMA, sessionId: snapshot.sessionId, bookUid: snapshot.bookUid, reason,
          sections: snapshot.changes.map(change => change.sectionIndex), at: now() });
    },
    /** The session that wrote an orphan draft, when this can be known: the
     * latest recorded session of the book that has no final record, with no
     * later unresolved begin intent. Otherwise null (the contract carries no
     * session identity in drafts). */
    async attributionFor(bookUid) {
      const records = await readAll(call);
      const sessions = records.filter(({ key, value }) => key.startsWith(SESSION) && value.bookUid === bookUid).map(({ value }) => value);
      const finals = new Set(records.filter(({ key, value }) => key.startsWith(FINAL) && value.bookUid === bookUid).map(({ value }) => value.sessionId));
      const latest = sessions.sort((a, b) => a.beganAt - b.beganAt).at(-1);
      if (!latest || finals.has(latest.sessionId)) return null;
      const matched = new Set(records.filter(({ key }) => key.startsWith(SESSION)).map(({ value }) => value.nonce).filter(Boolean));
      const done = new Set(records.filter(({ key }) => key.startsWith(INTENT_DONE)).map(({ value }) => value.nonce));
      const unknown = records.some(({ key, value }) => key.startsWith(INTENT) && !key.startsWith(INTENT_DONE) &&
        value.at >= latest.beganAt && !matched.has(value.nonce) && !done.has(value.nonce));
      return unknown ? null : latest.sessionId;
    },
    /** Paragraphs a session showed from an earlier draft (Otzaria recovery or
     * a restore by this plugin). A reset of such a paragraph cancels the older
     * proposals it was built on; a reset of a fresh edit cancels only itself.
     * [baseVersion] is the newest version the session built on, so proposals
     * with a higher version are later and independent. */
    async markInherited(sessionId, bookUid, sections, baseVersion = null) {
      const base = Number.isSafeInteger(baseVersion) ? baseVersion : await newestStoredVersion(call, bookUid);
      for (const sectionIndex of new Set(sections)) {
        await setOnce(`${INHERITED}${keyPart(bookUid)}:${keyPart(sessionId)}:${sectionIndex}`,
          { schema: SCHEMA, sessionId, bookUid, sectionIndex, base });
      }
    },
    async resolve(bookUid, itemKey, status, data = {}) {
      if (!resolvedStatuses.has(status)) throw new Error(`Unknown resolution ${status}`);
      await setOnce(`${RESOLVED}${keyPart(bookUid)}:${itemKey}:${status}`,
        { schema: SCHEMA, bookUid, itemKey, status, at: now(), ...data });
    },
    async recordSubmission(bookUid, itemKey, reportId, status, data = {}) {
      if (!submissionStatuses.has(status)) throw new Error(`Unknown submission status ${status}`);
      await setOnce(`${SUBMISSION}${keyPart(bookUid)}:${itemKey}:${keyPart(reportId)}:${status}`,
        { schema: SCHEMA, bookUid, itemKey, reportId, status, at: now(), ...data });
    },
    /** The user's explicit consent to replace a conflicting report ID. */
    async consentNewReportId(bookUid, item) {
      const generation = item.generation ?? 0;
      await store.recordSubmission(bookUid, item.key, reportIdFor(item.key, generation), 'id_consent', { generation });
    },
    async load() { return mergeRecords(await readAll(call)); },
    /** Removes only versions that are fully handled, after writing a floor that
     * makes the removal (and any late duplicate of those versions) inert.
     * Submission and resolution records (the history) are never removed. */
    async compact(state, bookUid) {
      const book = state.books.get(bookUid);
      if (!book || book.pending.length || book.conflicts.length || book.inFlight.length || !book.entries.length || book.openSessions.size) return 0;
      const floor = Math.max(...book.entries.map(entry => entry.version));
      await setOnce(`${FLOOR}${keyPart(bookUid)}:${floor}`, { schema: SCHEMA, bookUid, version: floor });
      let removed = 0;
      for (const entry of book.entries) {
        if (entry.version > floor) continue;
        try { await call('storage.remove', { key: entry.key }); removed++; } catch { /* retried next time */ }
      }
      return removed;
    }
  };
  return store;
}

async function newestStoredVersion(call, bookUid) {
  const versions = (await readAll(call)).filter(({ key, value }) => (key.startsWith(ENTRY) || key.startsWith(FLOOR)) &&
    value.bookUid === bookUid && Number.isSafeInteger(value.version)).map(({ value }) => value.version);
  return versions.length ? Math.max(...versions) : 0;
}

async function readAll(call) {
  const keys = (await call('storage.list')) ?? [];
  const records = [];
  for (const key of keys) {
    if (!key.startsWith(PREFIX)) continue;
    const value = await call('storage.get', { key });
    if (value?.schema === SCHEMA) records.push({ key, value });
  }
  return records;
}

export function mergeRecords(records) {
  const books = new Map();
  const book = (bookUid, bookId = null) => {
    if (!books.has(bookUid)) books.set(bookUid, { bookUid, bookId, libraryVersion: null, floor: 0, entries: [],
      inherited: new Map(), resolutions: new Map(), submissions: new Map(), began: new Map(), finals: new Map() });
    const item = books.get(bookUid); if (!item.bookId && bookId) item.bookId = bookId;
    return item;
  };
  const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
  for (const { key, value } of records) {
    if (key.startsWith(ENTRY) && Number.isSafeInteger(value.version) && Array.isArray(value.changes) && Array.isArray(value.conflicts)) {
      book(value.bookUid, value.bookId).entries.push({ ...value, key });
    } else if (key.startsWith(FLOOR) && Number.isSafeInteger(value.version)) {
      const item = book(value.bookUid); item.floor = Math.max(item.floor, value.version);
    } else if (key.startsWith(INHERITED)) {
      const item = book(value.bookUid);
      if (!item.inherited.has(value.sessionId)) item.inherited.set(value.sessionId, new Map());
      item.inherited.get(value.sessionId).set(value.sectionIndex, Number.isSafeInteger(value.base) ? value.base : 0);
    } else if (key.startsWith(RESOLVED)) push(book(value.bookUid).resolutions, value.itemKey, value);
    else if (key.startsWith(SUBMISSION)) push(book(value.bookUid).submissions, value.itemKey, value);
    else if (key.startsWith(SESSION)) book(value.bookUid).began.set(value.sessionId, value);
    else if (key.startsWith(FINAL)) book(value.bookUid).finals.set(value.sessionId, value);
  }
  for (const item of books.values()) {
    item.entries = item.entries.filter(entry => entry.version > item.floor).sort((a, b) => a.version - b.version);
    const latest = item.entries.at(-1);
    if (latest) { item.libraryVersion = latest.libraryVersion; item.bookId = latest.bookId ?? item.bookId; }
    computeBook(item);
  }
  return { books };
}

export function submissionState(records = []) {
  let best = null, generation = 0;
  for (const record of records) if (record.status === 'id_consent') generation = Math.max(generation, (record.generation ?? 0) + 1);
  // A conflict needs consent before a new ID is used; detection alone is not consent.
  const idConflict = records.some(record => record.status === 'id_conflict' && (record.generation ?? 0) === generation);
  for (const record of records) {
    if (!statusRank[record.status]) continue;
    if (!best || statusRank[record.status] > statusRank[best.status]) best = record;
  }
  return { best, generation, idConflict };
}

// A session's own proposals are cancelled by session id. An inherited paragraph
// also cancels the older proposals it was built on: versions up to its base.
function inheritedCancel(sectionIndex, sessionId, inherited) {
  if (!inherited.has(sectionIndex)) return { sectionIndex, version: 0, sessionId, broad: false };
  return { sectionIndex, version: inherited.get(sectionIndex) + 1, sessionId, broad: true };
}

function computeBook(book) {
  // A session is the unit of meaning: its latest entry is its final content,
  // and a final record (written at its end) is its final shape. Orphan drafts
  // that could not be attributed count as their own session.
  const sessions = new Map();
  for (const entry of book.entries) {
    const id = entry.sessionId ?? `draft:${entry.draftId}:${entry.version}`;
    if (!sessions.has(id)) sessions.set(id, { id, entries: [], had: new Set() });
    const session = sessions.get(id);
    session.entries.push(entry);
    for (const change of entry.changes) session.had.add(change.sectionIndex);
  }
  const proposals = [], cancels = [];
  for (const session of sessions.values()) {
    const final = session.entries.at(-1), fin = book.finals.get(session.id);
    const finalSections = new Set(fin ? fin.sections : final.changes.map(change => change.sectionIndex));
    for (const change of final.changes) {
      if (!finalSections.has(change.sectionIndex)) continue;
      proposals.push({ ...change, version: final.version, sessionId: session.id, draftId: final.draftId, libraryVersion: final.libraryVersion,
        // Begun, never seen ending: the reader may hold a newer state.
        openSession: book.began.has(session.id) && !fin ? session.id : null });
    }
    // An inherited paragraph was shown in this session even if it was reset
    // before any version of the session was saved. A reset cancels only the
    // older proposals this session built on: those saved before its first version.
    const inherited = book.inherited.get(session.id) ?? new Map();
    for (const sectionIndex of new Set([...session.had, ...inherited.keys()])) {
      if (!finalSections.has(sectionIndex)) cancels.push(inheritedCancel(sectionIndex, session.id, inherited));
    }
  }
  // A recorded end of a session without any saved version still cancels the
  // inherited paragraphs it reset.
  for (const [sessionId, fin] of book.finals) {
    if (sessions.has(sessionId)) continue;
    const finalSections = new Set(fin.sections);
    const inherited = book.inherited.get(sessionId) ?? new Map();
    for (const sectionIndex of inherited.keys()) {
      if (!finalSections.has(sectionIndex)) cancels.push(inheritedCancel(sectionIndex, sessionId, inherited));
    }
  }
  const live = proposals.filter(proposal => !cancels.some(cancel => cancel.sectionIndex === proposal.sectionIndex &&
    (cancel.sessionId === proposal.sessionId || (cancel.broad && proposal.version < cancel.version))));
  // A later proposal replaces an earlier one for the same paragraph only when
  // its session showed that paragraph from an earlier draft (it built on it).
  // A fresh edit in a session that never saw the earlier proposal is an
  // independent proposal: both stay pending. Identical proposals count once.
  const current = [], byKey = new Map();
  live.sort((a, b) => a.version - b.version);
  for (const proposal of live) {
    const replaced = live.some(later => later.version > proposal.version && later.sectionIndex === proposal.sectionIndex &&
      (book.inherited.get(later.sessionId)?.has(proposal.sectionIndex) ?? false));
    if (replaced) continue;
    const key = changeKey(book.bookUid, proposal);
    if (!byKey.has(key)) { byKey.set(key, proposal); current.push(proposal); }
  }
  book.pending = []; book.handled = []; book.inFlight = []; book.history = [];
  book.openSessions = new Set();
  for (const proposal of current.sort((a, b) => a.sectionIndex - b.sectionIndex || a.version - b.version)) {
    const key = changeKey(book.bookUid, proposal);
    const resolution = book.resolutions.get(key)?.[0] ?? null;
    const submission = submissionState(book.submissions.get(key));
    const item = { ...proposal, key, resolution, submission: submission.best, generation: submission.generation, idConflict: submission.idConflict };
    if (resolution) book.handled.push(item);
    else {
      book.pending.push(item);
      if (item.openSession) book.openSessions.add(item.openSession);
      if (submission.best?.status === 'attempt') book.inFlight.push(item);
    }
  }
  // History lives in resolution records, which compaction never removes.
  const handledKeys = new Set(book.handled.map(item => item.key));
  for (const [itemKey, list] of book.resolutions) {
    const record = list.find(entry => entry.status === 'sent') ?? list.find(entry => entry.status === 'queued');
    if (!record) continue;
    book.history.push({ key: itemKey, record, sectionIndex: record.sectionIndex ?? null, originalText: record.originalText ?? null,
      originalSourceText: record.originalSourceText ?? null, proposedText: record.proposedText ?? null, title: record.title ?? null });
    if (!handledKeys.has(itemKey) && Number.isInteger(record.sectionIndex)) {
      book.handled.push({ key: itemKey, sectionIndex: record.sectionIndex, originalText: record.originalText ?? '',
        proposedText: record.proposedText ?? '', resolution: record, fromHistory: true });
    }
  }
  book.history.sort((a, b) => b.record.at - a.record.at);
  const durable = book.entries.flatMap(entry => entry.changes.map(change => ({ change, version: entry.version })));
  const conflicts = new Map();
  for (const entry of book.entries) for (const conflict of entry.conflicts) {
    const key = conflictKey(book.bookUid, conflict);
    if (!conflicts.has(key)) conflicts.set(key, { ...conflict, key, version: entry.version, libraryVersion: entry.libraryVersion });
  }
  // A conflict is settled only by an explicit decision or by a later saved
  // version that contains it as a change (a durable restore).
  // 'restored' alone is not enough: the reader copy may never have been saved.
  book.conflicts = [...conflicts.values()].filter(conflict => !book.resolutions.get(conflict.key)?.some(record => record.status === 'dismissed') &&
    !durable.some(({ change, version }) => version > conflict.version && sameChange(change, conflict)))
    .sort((a, b) => a.sectionIndex - b.sectionIndex);
  book.durableChanges = durable.map(({ change }) => change);
}
