// Otzaria reader correction sessions (0.9.99): Otzaria edits and keeps the
// durable draft; the plugin takes over a version only after its own durable
// copy (changes and conflicts) was saved and read back. All operations of one
// instance run in one queue. Other instances share nothing but storage, which
// the store keeps append-only.
export const codeOf = error => error?.code?.replace(/^error\./, '') ?? null;

export function ackable(snapshot) {
  const draft = snapshot?.draft;
  return !!draft && draft.persisted === true && draft.displaced !== true && Number.isSafeInteger(draft.version);
}

export function createSessionController({ call, store, onChange = () => {}, onNotice = () => {} }) {
  const sessions = new Map(); // sessionId -> { snapshot, ended, reason, error }
  const activeElsewhere = new Map(); // draftId -> list summary
  let queue = Promise.resolve();
  const refreshing = new Set();
  function enqueue(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }
  function track(snapshot, patch = {}) {
    if (!snapshot?.sessionId) return null;
    const previous = sessions.get(snapshot.sessionId);
    // Events can arrive out of order; never replace a newer revision.
    const keep = previous?.snapshot && previous.snapshot.revision > snapshot.revision && !patch.ended ? previous.snapshot : snapshot;
    const next = { ...previous, ...patch, snapshot: keep };
    sessions.set(snapshot.sessionId, next);
    return next;
  }
  async function acknowledge(draftId, version) {
    try {
      const result = await call('reader.acknowledgeCorrectionDraft', { draftId, version });
      return { acknowledged: true, duplicate: result?.duplicate === true };
    } catch (error) {
      const code = codeOf(error);
      // A newer version exists: it is acknowledged with the next snapshot.
      if (code === 'revision_conflict') return { acknowledged: false, newer: true };
      // Already emptied or acknowledged elsewhere; the plugin copy stays.
      if (code === 'not_found') return { acknowledged: false, gone: true };
      throw error;
    }
  }
  /** Save the complete version, then acknowledge it. Never acknowledges after
   * a failed save, a null version, an unpersisted or a displaced snapshot. */
  async function keep(snapshot, sessionId = snapshot?.sessionId ?? null) {
    if (!ackable(snapshot)) return { saved: false, acknowledged: false };
    await store.saveVersion(snapshot, { sessionId, revision: snapshot.revision ?? null });
    const ack = await acknowledge(snapshot.draft.draftId, snapshot.draft.version);
    return { saved: true, ...ack };
  }
  async function latest(sessionId) {
    const snapshot = await call('reader.getCorrectionSession', { sessionId });
    track(snapshot);
    return snapshot;
  }
  const controller = {
    sessions,
    activeElsewhere,
    enqueue,
    keep,
    /** Begin (or rejoin) the session of one exact reader tab. */
    begin(tabId) {
      return enqueue(async () => {
        if (typeof tabId !== 'string' || !tabId) throw Object.assign(new Error('לא זוהתה לשונית ספר לעריכה.'), { code: 'error.invalid_params' });
        // The intent is recorded first, so a session that begins but is never
        // recorded (crash) makes later orphan attribution refuse to guess.
        const intent = await store.beginIntent();
        let snapshot;
        try { snapshot = await call('reader.beginCorrectionSession', { tabId }); }
        catch (error) { await store.intentDone(intent).catch(() => {}); throw error; }
        await store.recordSession(snapshot, intent);
        track(snapshot, { ended: false, reason: null });
        if (snapshot.recovery?.restoredSectionIndices?.length) {
          await store.markInherited(snapshot.sessionId, snapshot.bookUid, snapshot.recovery.restoredSectionIndices, snapshot.draft?.version ?? null);
        }
        onChange();
        return snapshot;
      });
    },
    /** Event: pull the full snapshot. Coalesced; not a save confirmation. */
    changed(event) {
      if (!event?.sessionId || refreshing.has(event.sessionId)) return queue;
      refreshing.add(event.sessionId);
      return enqueue(async () => {
        refreshing.delete(event.sessionId);
        if (sessions.get(event.sessionId)?.ended) return;
        try { await latest(event.sessionId); }
        catch (error) { if (codeOf(error) !== 'not_found') throw error; }
        onChange();
      });
    },
    /** Event: the final snapshot. Duplicates are harmless (idempotent save, duplicate ack). */
    ended(event) {
      return enqueue(async () => {
        const snapshot = event?.snapshot;
        if (!snapshot?.sessionId) return;
        track(snapshot, { ended: true, reason: event.reason ?? null });
        try {
          await store.recordFinal(snapshot, event.reason ?? null);
          const result = await keep(snapshot);
          sessions.get(snapshot.sessionId).saved = result.saved;
          if (!result.saved) onNotice('pending-save', snapshot);
        } catch (error) {
          sessions.get(snapshot.sessionId).error = error.message;
          onNotice('save-failed', snapshot, error);
        }
        onChange();
      });
    },
    /** End editing from the plugin, then take over the final version. */
    end(sessionId) {
      return enqueue(async () => {
        let current = await latest(sessionId), ended;
        try { ended = await call('reader.endCorrectionSession', { sessionId, expectedRevision: current.revision }); }
        catch (error) {
          if (codeOf(error) !== 'revision_conflict') throw error;
          // Typing continued: read the new state once and end that exact state.
          current = await latest(sessionId);
          ended = await call('reader.endCorrectionSession', { sessionId, expectedRevision: current.revision });
        }
        track(ended, { ended: true, reason: 'explicit' });
        await store.recordFinal(ended, 'explicit');
        const result = await keep(ended);
        sessions.get(sessionId).saved = result.saved;
        onChange();
        return { snapshot: ended, ...result };
      });
    },
    /** Take over the current version of a live session (before sending). */
    save(sessionId) {
      return enqueue(async () => {
        const snapshot = await latest(sessionId);
        const result = await keep(snapshot);
        onChange();
        return { snapshot, ...result };
      });
    },
    inspect(sessionId) {
      return enqueue(async () => { const snapshot = await latest(sessionId); onChange(); return snapshot; });
    },
    applyReplacements(plan) {
      return enqueue(async () => {
        const current = await latest(plan.sessionId);
        if (current.revision !== plan.revision) {
          onChange();
          throw Object.assign(new Error('הנוסח בקורא השתנה. הציגו התאמות מחדש לפני החלפה.'), { code: 'error.revision_conflict' });
        }
        if (current.bookUid !== plan.bookUid || current.libraryVersion !== plan.libraryVersion) {
          throw Object.assign(new Error('מקור הספר השתנה.'), { code: 'error.source_changed' });
        }
        const snapshot = await call('reader.restoreCorrectionDraft', { sessionId: plan.sessionId, bookUid: plan.bookUid,
          libraryVersion: plan.libraryVersion, expectedRevision: plan.revision, changes: plan.changes });
        track(snapshot); onChange();
        try { return { snapshot, ...await keep(snapshot) }; }
        catch (error) { throw new Error(`ההחלפה הוחלה בקורא, אך השמירה בתוסף נכשלה. הטיוטה נשארה באוצריא: ${error.message}`); }
      });
    },
    reset(sessionId, sectionIndex) {
      return enqueue(async () => {
        const current = await latest(sessionId);
        try {
          const snapshot = await call('reader.resetCorrection', { sessionId, sectionIndex, expectedRevision: current.revision });
          track(snapshot); onChange(); return snapshot;
        } catch (error) {
          // The user's newer edit wins; show it rather than reset it blindly.
          if (codeOf(error) === 'revision_conflict') { await latest(sessionId); onChange(); }
          throw error;
        }
      });
    },
    /** Explicitly restore stored items into the live session. The host
     * verifies every paragraph against the current source; nothing is applied
     * on mismatch, and a revision conflict is shown, never retried blindly. */
    restore(sessionId, items) {
      return enqueue(async () => {
        const current = await latest(sessionId);
        const sections = new Set(items.map(item => item.sectionIndex));
        const clash = current.changes.find(change => sections.has(change.sectionIndex));
        if (clash) throw Object.assign(new Error(`בפסקה ${clash.sectionIndex + 1} כבר יש תיקון פעיל בקורא. בטלו אותו בקורא לפני השחזור.`), { code: 'error.correction_busy' });
        const changes = [...current.changes, ...items.map(({ sectionIndex, originalSourceText, originalText, proposedText }) =>
          ({ sectionIndex, originalSourceText, originalText, proposedText }))].sort((a, b) => a.sectionIndex - b.sectionIndex);
        let snapshot;
        try {
          snapshot = await call('reader.restoreCorrectionDraft', { sessionId, bookUid: current.bookUid,
            libraryVersion: current.libraryVersion, expectedRevision: current.revision, changes });
        } catch (error) {
          if (codeOf(error) === 'revision_conflict') { await latest(sessionId); onChange(); }
          throw error;
        }
        track(snapshot);
        await store.markInherited(sessionId, snapshot.bookUid, [...sections], snapshot.draft?.version ?? null);
        onChange();
        return snapshot;
      });
    },
    /** Startup discovery: drafts whose end event was never delivered. */
    recoverOrphans() {
      return enqueue(async () => {
        const { drafts = [] } = await call('reader.listCorrectionDrafts', {}) ?? {};
        const report = { saved: 0, acknowledged: 0, active: 0, failed: [] };
        activeElsewhere.clear();
        for (const meta of drafts) {
          const ours = [...sessions.values()].some(item => !item.ended && item.snapshot?.draft?.draftId === meta.draftId);
          if (meta.active) { if (!ours) activeElsewhere.set(meta.draftId, meta); report.active++; continue; }
          try {
            const draft = await call('reader.getCorrectionDraft', { draftId: meta.draftId });
            // An inactive draft is the last durable state of the session that
            // wrote it. Attribute it only when that session is known for sure.
            const sessionId = await store.attributionFor(draft.bookUid);
            await store.saveVersion({ ...draft, draft: { draftId: draft.draftId, version: draft.version, conflicts: draft.conflicts } },
              { sessionId, attributed: !!sessionId });
            if (sessionId) await store.recordFinal({ sessionId, bookUid: draft.bookUid, changes: draft.changes }, 'recovered');
            report.saved++;
            if ((await acknowledge(draft.draftId, draft.version)).acknowledged) report.acknowledged++;
          } catch (error) {
            // not_found: acknowledged or emptied meanwhile. Other failures keep
            // Otzaria's copy for the next attempt; the local copy is untouched.
            if (codeOf(error) !== 'not_found') report.failed.push({ draftId: meta.draftId, bookId: meta.bookId, message: error.message });
          }
        }
        onChange();
        return report;
      });
    }
  };
  return controller;
}
