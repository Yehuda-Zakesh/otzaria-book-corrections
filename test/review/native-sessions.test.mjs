// Independent review regressions. Run explicitly with:
// node --test test/review/native-sessions.test.mjs (also part of npm test)
// These assert the required behavior; all four failed on the reviewed revision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorrectionStore } from '../../plugin/correction-store.js';
import { createSessionController } from '../../plugin/correction-sessions.js';
import { submitItem } from '../../plugin/correction-submit.js';
import { createFakeOtzaria, createStorage } from '../fake-otzaria.mjs';

function setup() {
  const host = createFakeOtzaria(), storage = createStorage();
  const call = host.instance(storage), store = createCorrectionStore(call);
  const controller = createSessionController({ call, store });
  return { host, storage, call, store, controller };
}
const book = async p => (await p.store.load()).books.get('id:1');

test('review: orphan recovery must retain a reset from the original session', async () => {
  const p = setup(), s = await p.controller.begin(p.host.openTab('id:1'));
  p.host.edit(s.sessionId, 0, 'cancel me');
  await p.controller.save(s.sessionId);
  await p.controller.reset(s.sessionId, 0);
  p.host.edit(s.sessionId, 2, 'keep me');
  p.host.endByUser(s.sessionId); // page closed: the end event is not delivered
  const restarted = createSessionController({ call: p.call, store: p.store });
  await restarted.recoverOrphans();
  assert.deepEqual((await book(p)).pending.map(item => item.sectionIndex), [2]);
});

test('review: compaction must preserve sent history', async () => {
  const p = setup(), s = await p.controller.begin(p.host.openTab('id:1'));
  p.host.edit(s.sessionId, 0, 'edited');
  await p.controller.end(s.sessionId);
  const b = await book(p);
  await submitItem({ ...p, book: b, item: b.pending[0] });
  assert.equal((await book(p)).handled.length, 1);
  await p.store.compact(await p.store.load(), 'id:1');
  assert.equal((await book(p)).handled.length, 1);
});

test('review: an ID conflict must not authorize a new ID without user consent', async () => {
  const p = setup(), s = await p.controller.begin(p.host.openTab('id:1'));
  p.host.edit(s.sessionId, 0, 'edited');
  await p.controller.end(s.sessionId);
  let b = await book(p);
  p.host.submitFails = 'report_id_conflict';
  const first = await submitItem({ ...p, book: b, item: b.pending[0] });
  assert.equal(first.status, 'id_conflict');
  // User declines the app's confirmation; no consent operation is performed.
  b = await book(p);
  p.host.submitFails = null;
  const later = await submitItem({ ...p, book: b, item: b.pending[0] });
  assert.equal(later.record?.reportId ?? later.reportId, first.reportId);
});

test('review: restoring a conflict must leave a durable actionable copy', async () => {
  const p = setup(), s = await p.controller.begin(p.host.openTab('id:1'));
  p.host.edit(s.sessionId, 0, 'rescued text');
  const snap = await p.call('reader.getCorrectionSession', { sessionId: s.sessionId });
  snap.draft.conflicts = [{ ...snap.changes[0], reason: 'displaced' }];
  snap.changes = [];
  await p.store.saveVersion(snap, { sessionId: 'old' });
  await p.controller.reset(s.sessionId, 0);
  const conflict = (await book(p)).conflicts[0];
  p.host.persist = false;
  const restored = await p.controller.restore(s.sessionId, [conflict]);
  assert.equal(restored.draft.persisted, false);
  // Exact restoreConflict() sequence in app.js, before the host write succeeds.
  await p.store.resolve('id:1', conflict.key, 'restored');
  const b = await book(p);
  assert.ok(b.pending.length + b.conflicts.length > 0,
    'original conflict is hidden while the restored proposal exists only in reader memory');
});
