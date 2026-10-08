export function createReaderCorrections(call, idFactory, changed = () => {}) {
  let current = null, drafts = [], writes = Promise.resolve();
  const sameBook = (a, b) => a.bookUid === b.bookUid && a.libraryVersion === b.libraryVersion;
  const pending = draft => draft.changes.filter(change => !draft.deliveries.some(item =>
    item.status && JSON.stringify(item.change) === JSON.stringify(change)));
  function save() {
    const value = structuredClone(drafts);
    const write = writes.catch(() => {}).then(() => call('storage.set', { key: 'reader-correction-drafts', value }));
    writes = write; return write;
  }
  function updateDraft(snapshot) {
    let draft = drafts.find(item => sameBook(item, snapshot));
    if (!draft) { draft = { bookId: snapshot.bookId, bookUid: snapshot.bookUid,
      libraryVersion: snapshot.libraryVersion, changes: [], deliveries: [] }; drafts.push(draft); }
    draft.changes = structuredClone(snapshot.changes);
    return draft;
  }
  async function accept(snapshot) {
    if (current?.snapshot.sessionId === snapshot.sessionId && snapshot.revision < current.snapshot.revision) return current;
    const draft = updateDraft(snapshot);
    current = { snapshot, draft };
    await save(); changed(current);
    return current;
  }
  async function refresh() {
    if (!current) return;
    if (current.restoreRejected) throw new Error('לא ניתן לשחזר את הטיוטה מול מקור הספר הנוכחי. הטיוטה נשמרה.');
    const sessionId = current.snapshot.sessionId;
    const snapshot = await call('reader.getCorrectionSession', { sessionId });
    if (current?.snapshot.sessionId !== sessionId || snapshot.revision < current.snapshot.revision) return;
    return accept(snapshot);
  }
  async function reloadDrafts() {
    await writes;
    drafts = await call('storage.get', { key: 'reader-correction-drafts' }) ?? [];
    if (current) current.draft = drafts.find(item => sameBook(item, current.snapshot)) ?? current.draft;
  }
  async function resume() {
    await reloadDrafts();
    if (!drafts.length && !current) return;
    const state = await call('reader.getCurrentState');
    const ids = (state?.openTabs ?? []).map(tab => tab.correctionSessionId).filter(Boolean);
    const sessionId = ids.includes(current?.snapshot.sessionId) ? current.snapshot.sessionId
      : state?.currentCorrectionSessionId ?? ids[0];
    if (!sessionId) { current = null; changed(current); return; }
    try { return await accept(await call('reader.getCorrectionSession', { sessionId })); }
    catch (error) {
      if (error.code !== 'error.not_found') throw error;
      current = null; changed(current);
    }
  }
  async function begin(tabId) {
    await reloadDrafts();
    if (current && current.snapshot.tabId !== tabId) throw new Error('סיימו תחילה את העריכה בקורא בספר הנוכחי.');
    if (current && !current.restoreRejected) await refresh();
    const snapshot = await call('reader.beginCorrectionSession', { tabId });
    const draft = drafts.find(item => sameBook(item, snapshot));
    if (draft?.changes.length && !snapshot.changes.length) {
      // Keep the durable draft if validation rejects a changed library source.
      current = { snapshot, draft, restoreRejected: true };
      try {
        const restored = await call('reader.restoreCorrectionDraft', { sessionId: snapshot.sessionId,
          bookUid: draft.bookUid, libraryVersion: draft.libraryVersion,
          expectedRevision: snapshot.revision, changes: draft.changes });
        return accept(restored);
      } catch (error) { changed(current); throw error; }
    }
    return accept(snapshot);
  }
  async function send() {
    const sessionId = current?.snapshot.sessionId;
    await refresh();
    const active = current;
    if (!active || active.snapshot.sessionId !== sessionId) throw new Error('פתחו את הספר בקורא כדי לשלוח את התיקונים.');
    for (const change of pending(active.draft)) {
      let delivery = active.draft.deliveries.find(item => JSON.stringify(item.change) === JSON.stringify(change));
      if (!delivery) { delivery = { change: structuredClone(change), reportId: idFactory() }; active.draft.deliveries.push(delivery); }
      await save();
      const result = await call('feedback.submitBookCorrection', { reportId: delivery.reportId,
        bookId: active.draft.bookId, bookUid: active.draft.bookUid, sectionIndex: change.sectionIndex,
        snapshots: [{ index: change.sectionIndex, text: change.originalText }],
        original: change.originalText, proposed: change.proposedText, allowQueue: false });
      if (!['sent', 'queued'].includes(result?.status)) throw new Error('אוצריא לא אישרה את קבלת התיקון. הטיוטה נשמרה.');
      delivery.status = result.status; delivery.correctionSupported = result.correctionSupported;
      await save(); changed(current);
    }
  }
  async function end() {
    const sessionId = current?.snapshot.sessionId;
    if (!current?.restoreRejected) await refresh();
    if (!current || current.snapshot.sessionId !== sessionId) return;
    const active = current;
    await call('reader.endCorrectionSession', { sessionId: active.snapshot.sessionId, expectedRevision: active.snapshot.revision });
    if (current === active) { current = null; changed(current); }
  }
  async function ended(event) {
    if (!current) {
      await reloadDrafts();
      if (current) return;
      updateDraft(event.snapshot);
      await save(); changed(current);
      return;
    }
    if (event.sessionId !== current?.snapshot.sessionId) return;
    if (!current.restoreRejected && event.snapshot.revision >= current.snapshot.revision) updateDraft(event.snapshot);
    current = null; changed(current);
    await save();
  }
  async function reset(sectionIndex) {
    const sessionId = current?.snapshot.sessionId;
    await refresh();
    if (!current || current.snapshot.sessionId !== sessionId) return;
    const snapshot = await call('reader.resetCorrection', { sessionId,
      sectionIndex, expectedRevision: current.snapshot.revision });
    if (current?.snapshot.sessionId === sessionId) return accept(snapshot);
  }
  return { begin, refresh, resume, send, end, ended, reset, pending,
    read: resume,
    get current() { return current; }, get drafts() { return drafts; } };
}
