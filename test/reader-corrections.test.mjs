import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReaderCorrections } from '../plugin/reader-corrections.js';

const change = (proposedText = 'תיקון 😀') => ({ sectionIndex: 2, originalSourceText: 'מָקוֹר 😀', originalText: 'מָקוֹר 😀', proposedText });
function setup(storage = new Map()) {
  let snapshot = { sessionId: 'runtime-1', tabId: 'tab-1', bookId: 'ספר', bookUid: 'id:9', libraryVersion: 'v1', revision: 0, changes: [] };
  const calls = [], handlers = new Map(); let failed = false, next = 0;
  const call = async (method, args) => {
    calls.push({ method, args: structuredClone(args) });
    if (handlers.has(method)) return handlers.get(method)(args);
    if (method === 'storage.get') return storage.get(args.key);
    if (method === 'reader.getCurrentState') return { openTabs: [] };
    if (method === 'storage.set') { storage.set(args.key, structuredClone(args.value)); return; }
    if (method === 'reader.beginCorrectionSession' || method === 'reader.getCorrectionSession') return structuredClone(snapshot);
    if (method === 'reader.restoreCorrectionDraft') {
      assert.equal(args.expectedRevision, snapshot.revision);
      snapshot.changes = structuredClone(args.changes); snapshot.revision++;
      return structuredClone(snapshot);
    }
    if (method === 'reader.resetCorrection') {
      assert.equal(args.expectedRevision, snapshot.revision);
      snapshot.changes = snapshot.changes.filter(item => item.sectionIndex !== args.sectionIndex); snapshot.revision++;
      return structuredClone(snapshot);
    }
    if (method === 'feedback.submitBookCorrection') {
      assert.ok(storage.get('reader-correction-drafts')[0].deliveries.some(item => item.reportId === args.reportId));
      if (failed) throw new Error('offline');
      return { status: 'sent', correctionSupported: true };
    }
  };
  return { controller: createReaderCorrections(call, () => `report-${++next}`), storage, calls, handlers,
    get snapshot() { return snapshot; }, set snapshot(value) { snapshot = value; }, set failed(value) { failed = value; } };
}
test('reader drafts survive tab closure and restore by UID/version into a new runtime tab', async () => {
  const first = setup(); await first.controller.read(); await first.controller.begin('tab-1');
  first.snapshot.changes = [change()]; first.snapshot.revision++;
  await first.controller.ended({ sessionId: 'runtime-1', reason: 'tab_closed', snapshot: first.snapshot });
  assert.equal(first.controller.current, null);
  assert.ok(!JSON.stringify([...first.storage.values()]).includes('tab-1'));
  assert.ok(!JSON.stringify([...first.storage.values()]).includes('runtime-1'));
  const second = setup(first.storage); second.snapshot.sessionId = 'runtime-2'; second.snapshot.tabId = 'tab-2';
  await second.controller.read(); await second.controller.begin('tab-2');
  assert.deepEqual(second.controller.current.snapshot.changes, [change()]);
  assert.equal(second.calls.find(item => item.method === 'reader.restoreCorrectionDraft').args.sessionId, 'runtime-2');
});
test('a delayed reset response cannot replace a newer changed-event snapshot', async () => {
  const env = setup(); await env.controller.read(); await env.controller.begin('tab-1');
  let release;
  env.handlers.set('reader.resetCorrection', () => new Promise(resolve => { release = resolve; }));
  const resetting = env.controller.reset(2);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  env.snapshot.revision = 3; env.snapshot.changes = [change('חדש')]; await env.controller.refresh();
  release({ ...env.snapshot, revision: 2, changes: [] }); await resetting;
  assert.equal(env.controller.current.snapshot.revision, 3);
  assert.deepEqual(env.controller.current.draft.changes, [change('חדש')]);
});
test('persisting a closed session cannot clear a new runtime session', async () => {
  const env = setup(); await env.controller.read(); await env.controller.begin('tab-1');
  let release;
  env.handlers.set('storage.set', args => new Promise(resolve => { release = () => { env.storage.set(args.key, args.value); resolve(); }; }));
  const closing = env.controller.ended({ sessionId: 'runtime-1', snapshot: { ...env.snapshot, revision: 2, changes: [change('סופי')] } });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const finishOldWrite = release; env.handlers.delete('storage.set');
  env.snapshot = { ...env.snapshot, sessionId: 'runtime-2', tabId: 'tab-2', changes: [], revision: 0 };
  const opening = env.controller.begin('tab-2');
  finishOldWrite(); await Promise.all([closing, opening]);
  assert.equal(env.controller.current.snapshot.sessionId, 'runtime-2');
  assert.deepEqual(env.controller.current.draft.changes, [change('סופי')]);
});
test('rejected source restoration retains the draft and manages the session until explicit end', async () => {
  const env = setup(); await env.controller.read(); await env.controller.begin('tab-1');
  env.snapshot.changes = [change()]; await env.controller.refresh(); await env.controller.end(); env.snapshot.changes = [];
  env.handlers.set('reader.restoreCorrectionDraft', async () => { throw new Error('source mismatch'); });
  await assert.rejects(env.controller.begin('tab-1'), /source mismatch/);
  assert.equal(env.controller.current.restoreRejected, true);
  await assert.rejects(env.controller.send(), /מקור הספר/);
  await env.controller.ended({ sessionId: 'runtime-1', snapshot: env.snapshot });
  assert.deepEqual(env.controller.drafts[0].changes, [change()]);
});
test('library version mismatch keeps old drafts without restoring against another source', async () => {
  const env = setup(); await env.controller.read(); await env.controller.begin('tab-1');
  env.snapshot.changes = [change()]; await env.controller.refresh(); await env.controller.end();
  env.snapshot.libraryVersion = 'v2'; env.snapshot.changes = []; await env.controller.begin('tab-1');
  assert.equal(env.calls.filter(item => item.method === 'reader.restoreCorrectionDraft').length, 0);
  assert.equal(env.controller.drafts.length, 2);
  assert.deepEqual(env.controller.drafts[0].changes, [change()]);
});
test('HTML reader corrections submit the canonical source while retaining raw HTML in the draft', async () => {
  const env = setup(); await env.controller.read(); await env.controller.begin('tab-1');
  env.snapshot.changes = [{ sectionIndex: 8, originalSourceText: '<b>בגמרא</b> חנן התם',
    originalText: 'בגמרא חנן התם', proposedText: 'בגמרא תנן התם' }];
  await env.controller.send();
  const submission = env.calls.find(item => item.method === 'feedback.submitBookCorrection').args;
  assert.deepEqual(submission.snapshots, [{ index: 8, text: 'בגמרא חנן התם' }]);
  assert.equal(submission.original, 'בגמרא חנן התם');
  assert.equal(env.storage.get('reader-correction-drafts')[0].changes[0].originalSourceText, '<b>בגמרא</b> חנן התם');
});

test('native delivery preserves report IDs before sending, retries failures and does not resend receipts', async () => {
  const env = setup(); await env.controller.read(); await env.controller.begin('tab-1');
  env.snapshot.changes = [change()]; env.failed = true;
  await assert.rejects(env.controller.send(), /offline/);
  env.failed = false; await env.controller.send(); await env.controller.send();
  const submissions = env.calls.filter(item => item.method === 'feedback.submitBookCorrection');
  assert.equal(submissions.length, 2); assert.equal(submissions[0].args.reportId, submissions[1].args.reportId);
  assert.deepEqual(submissions[1].args.snapshots, [{ index: 2, text: 'מָקוֹר 😀' }]);
  assert.equal(submissions[1].args.allowQueue, false);
  env.snapshot.changes = [change('נוסח חדש')]; await env.controller.send();
  assert.equal(env.controller.current.draft.deliveries.length, 2);
});
test('a new foreground adopts an owned background session without beginning another one', async () => {
  const background = setup(); await background.controller.read(); await background.controller.begin('tab-1');
  background.snapshot.changes = [change()]; await background.controller.send();
  const foreground = setup(background.storage); foreground.snapshot.changes = [change()];
  foreground.handlers.set('reader.getCurrentState', () => ({ currentCorrectionSessionId: 'runtime-1',
    openTabs: [{ correctionSessionId: 'runtime-1' }] }));
  await foreground.controller.read();
  assert.equal(foreground.controller.current.snapshot.sessionId, 'runtime-1');
  assert.equal(foreground.calls.some(item => item.method === 'reader.beginCorrectionSession'), false);
  assert.equal(foreground.controller.current.draft.deliveries[0].status, 'sent');
  assert.ok(!JSON.stringify([...foreground.storage.values()]).includes('runtime-1'));
});

test('session discovery preserves drafts when a runtime handle is stale', async () => {
  const env = setup(); await env.controller.read(); await env.controller.begin('tab-1');
  env.snapshot.changes = [change()]; await env.controller.refresh();
  env.handlers.set('reader.getCurrentState', () => ({ openTabs: [{ correctionSessionId: 'gone' }] }));
  env.handlers.set('reader.getCorrectionSession', () => { throw Object.assign(new Error('closed'), { code: 'error.not_found' }); });
  await env.controller.resume();
  assert.equal(env.controller.current, null);
  assert.deepEqual(env.storage.get('reader-correction-drafts')[0].changes, [change()]);
});

test('a returning engine loads delivery receipts written by the foreground', async () => {
  const background = setup(); await background.controller.read(); await background.controller.begin('tab-1');
  background.snapshot.changes = [change()]; await background.controller.refresh();
  const foreground = setup(background.storage); foreground.snapshot.changes = [change()];
  await foreground.controller.read(); await foreground.controller.begin('tab-1'); await foreground.controller.send();
  await background.controller.begin('tab-1'); await background.controller.send();
  assert.equal(background.calls.some(item => item.method === 'feedback.submitBookCorrection'), false);
  assert.equal(background.controller.current.draft.deliveries[0].status, 'sent');
});

test('a foreground without an adopted session retains the final owned snapshot on closure', async () => {
  const env = setup(); await env.controller.read();
  env.snapshot.changes = [change('סופי')];
  await env.controller.ended({ sessionId: 'runtime-1', snapshot: env.snapshot });
  assert.equal(env.controller.current, null);
  assert.deepEqual(env.storage.get('reader-correction-drafts')[0].changes, [change('סופי')]);
});

test('reset and explicit end use fresh revisions and retain the latest durable draft', async () => {
  const env = setup(); await env.controller.read(); await env.controller.begin('tab-1');
  env.snapshot.changes = [change()]; env.snapshot.revision = 8;
  await env.controller.reset(2); assert.equal(env.controller.current.snapshot.changes.length, 0);
  env.snapshot.changes = [change('סופי')]; env.snapshot.revision = 10;
  await env.controller.end(); assert.equal(env.controller.current, null);
  assert.equal(env.calls.find(item => item.method === 'reader.endCorrectionSession').args.expectedRevision, 10);
  assert.deepEqual(env.controller.drafts[0].changes, [change('סופי')]);
});
