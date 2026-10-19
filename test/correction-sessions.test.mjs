import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorrectionStore, changeKey } from '../plugin/correction-store.js';
import { createSessionController, ackable } from '../plugin/correction-sessions.js';
import { createFakeOtzaria, createStorage } from './fake-otzaria.mjs';

function instance(host, storage = createStorage()) {
  const call = host.instance(storage);
  const store = createCorrectionStore(call);
  return { storage, call, store, controller: createSessionController({ call, store }) };
}
const pending = async store => {
  const state = await store.load();
  return [...state.books.values()].flatMap(book => book.pending.map(item => `${item.sectionIndex}:${item.proposedText}`));
};
const conflicts = async store => [...(await store.load()).books.values()].flatMap(book => book.conflicts.map(item => `${item.sectionIndex}:${item.reason}`));

test('a failed plugin save never acknowledges, and Otzaria keeps its draft', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const tab = host.openTab('id:1');
  const { sessionId } = await plugin.controller.begin(tab);
  host.edit(sessionId, 0, 'אלף מתוקן');
  plugin.storage.failSet = true;
  await assert.rejects(plugin.controller.end(sessionId), /quota/);
  assert.deepEqual(host.acks, []);
  assert.equal(host.drafts.get('d-id:1').content, true);
  // The next startup discovery saves and then acknowledges.
  plugin.storage.failSet = false;
  const report = await plugin.controller.recoverOrphans();
  assert.equal(report.acknowledged, 1);
  assert.deepEqual(await pending(plugin.store), ['0:אלף מתוקן']);
  assert.equal(host.drafts.get('d-id:1').content, false);
});

test('a save that cannot be read back is not acknowledged', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const { sessionId } = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'x');
  const originalCall = plugin.storage.call;
  plugin.storage.call = async (method, args) => method === 'storage.set' ? true : originalCall(method, args);
  await assert.rejects(plugin.controller.end(sessionId), /לא אומתה/);
  assert.deepEqual(host.acks, []);
});

test('null, unpersisted and displaced snapshots are never acknowledged', async () => {
  assert.equal(ackable({ draft: { version: null, persisted: true, displaced: false } }), false);
  assert.equal(ackable({ draft: { version: 4, persisted: false, displaced: false } }), false);
  assert.equal(ackable({ draft: { version: 4, persisted: true, displaced: true } }), false);
  const host = createFakeOtzaria(), plugin = instance(host);
  const { sessionId } = await plugin.controller.begin(host.openTab('id:1'));
  host.persist = false; host.edit(sessionId, 0, 'x');
  const event = host.endByUser(sessionId);
  assert.equal(event.snapshot.draft.version, null);
  await plugin.controller.ended(event);
  assert.deepEqual(host.acks, []);
  assert.equal([...plugin.storage.data.keys()].filter(key => key.startsWith('nc:e:')).length, 0, 'no version taken over');
});

test('conflicts stay in the plugin after acknowledgement and a later empty snapshot deletes nothing', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  let tab = host.openTab('id:1');
  let { sessionId } = await plugin.controller.begin(tab);
  host.edit(sessionId, 1, 'בית גימל דלת');
  host.endByUser(sessionId, 'app_exit'); // the end event is lost
  host.books['id:1'].lines[1] = '<b>בית</b> גימל!'; // the source changed
  tab = host.openTab('id:1');
  const begun = await plugin.controller.begin(tab);
  assert.deepEqual(begun.recovery.conflicts.map(item => item.reason), ['source_changed']);
  const ended = await plugin.controller.end(begun.sessionId);
  assert.equal(ended.acknowledged, true);
  assert.deepEqual(host.drafts.get('d-id:1').conflicts, []);
  // New empty session: recovery null, changes [], conflicts [].
  const empty = await plugin.controller.begin(host.openTab('id:1'));
  assert.equal(empty.recovery, null); assert.deepEqual(empty.draft.conflicts, []);
  await plugin.controller.end(empty.sessionId);
  assert.deepEqual(await conflicts(plugin.store), ['1:source_changed']);
});

test('a reset paragraph is not revived, in the same session or from an inherited draft', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const { sessionId } = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'א1'); host.edit(sessionId, 2, 'ד1');
  await plugin.controller.save(sessionId); // acknowledged with both paragraphs
  await plugin.controller.reset(sessionId, 0);
  await plugin.controller.end(sessionId);
  assert.deepEqual(await pending(plugin.store), ['2:ד1']);
  // Saved and acknowledged ה1, then an unsaved ה2 and a crash.
  const crashed = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(crashed.sessionId, 3, 'ה1');
  await plugin.controller.save(crashed.sessionId);
  host.edit(crashed.sessionId, 3, 'ה2');
  host.endByUser(crashed.sessionId, 'app_exit'); // end event never delivered
  const recovered = await plugin.controller.begin(host.openTab('id:1'));
  assert.deepEqual(recovered.recovery.restoredSectionIndices, [3]);
  await plugin.controller.reset(recovered.sessionId, 3);
  await plugin.controller.end(recovered.sessionId);
  assert.deepEqual(await pending(plugin.store), ['2:ד1'], 'neither ה1 nor ה2 returns');
});

test('a reset of a fresh edit in a new session does not cancel an older acknowledged proposal', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const first = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(first.sessionId, 0, 'א1');
  await plugin.controller.end(first.sessionId);
  const second = await plugin.controller.begin(host.openTab('id:1'));
  assert.equal(second.recovery, null); // acknowledged: the reader shows the source
  host.edit(second.sessionId, 0, 'א2');
  await plugin.controller.save(second.sessionId);
  await plugin.controller.reset(second.sessionId, 0);
  await plugin.controller.end(second.sessionId);
  assert.deepEqual(await pending(plugin.store), ['0:א1']);
});

test('restoring a stored proposal into the reader and resetting it there cancels it', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const first = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(first.sessionId, 0, 'א1');
  await plugin.controller.end(first.sessionId);
  const [item] = (await plugin.store.load()).books.get('id:1').pending;
  const second = await plugin.controller.begin(host.openTab('id:1'));
  await plugin.controller.restore(second.sessionId, [item]);
  await plugin.controller.save(second.sessionId);
  await plugin.controller.reset(second.sessionId, 0);
  await plugin.controller.end(second.sessionId);
  assert.deepEqual(await pending(plugin.store), []);
});

test('duplicate end events save once and acknowledge idempotently', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const { sessionId } = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'x');
  const event = host.endByUser(sessionId);
  await Promise.all([plugin.controller.ended(event), plugin.controller.ended(structuredClone(event))]);
  assert.equal(host.acks.length, 2);
  assert.equal([...plugin.storage.data.keys()].filter(key => key.startsWith('nc:e:')).length, 1);
  assert.deepEqual(await pending(plugin.store), ['0:x']);
});

test('a lost acknowledgement response is retried as a duplicate', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const { sessionId } = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'x');
  host.loseAckResponse = true;
  const event = host.endByUser(sessionId);
  await plugin.controller.ended(event);
  assert.match(plugin.controller.sessions.get(sessionId).error, /response lost/);
  assert.deepEqual(await pending(plugin.store), ['0:x']); // saved before the ack
  const retry = await plugin.controller.keep(event.snapshot);
  assert.deepEqual([retry.acknowledged, retry.duplicate], [true, true]);
});

test('a newer version created during acknowledgement is not deleted and is taken over later', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const { sessionId } = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'v1');
  const stale = await host.instance(createStorage())('reader.getCorrectionSession', { sessionId });
  host.edit(sessionId, 2, 'v2'); // new version before the ack of the stale snapshot
  const result = await plugin.controller.keep(stale);
  assert.deepEqual([result.saved, result.acknowledged, result.newer], [true, false, true]);
  assert.equal(host.drafts.get('d-id:1').content, true);
  await plugin.controller.end(sessionId);
  assert.deepEqual(await pending(plugin.store), ['0:v1', '2:v2']);
  assert.equal(host.drafts.get('d-id:1').content, false);
});

test('restart: a new instance reads the same durable state', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const first = instance(host, storage);
  const { sessionId } = await first.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 3, 'הא!');
  await first.controller.end(sessionId);
  const restarted = instance(host, storage);
  assert.deepEqual(await pending(restarted.store), ['3:הא!']);
  const report = await restarted.controller.recoverOrphans();
  assert.equal(report.saved, 0);
});

test('two windows: concurrent discovery, saves and resolutions lose nothing', async () => {
  const host = createFakeOtzaria({ books: {
    'id:1': { bookId: 'א', lines: ['a', 'b', 'c'] }, 'id:2': { bookId: 'ב', lines: ['d', 'e'] } } });
  const storage = createStorage();
  const one = instance(host, storage), two = instance(host, storage);
  const s1 = await one.controller.begin(host.openTab('id:1'));
  const s2 = await two.controller.begin(host.openTab('id:2'));
  host.edit(s1.sessionId, 0, 'A'); host.edit(s2.sessionId, 1, 'E');
  // Window one already holds the book open in another tab: busy, never shared.
  await assert.rejects(two.controller.begin(host.openTab('id:1')), { code: 'error.correction_busy' });
  host.endByUser(s1.sessionId, 'window_closed'); host.endByUser(s2.sessionId, 'window_closed');
  const [a, b] = await Promise.all([one.controller.recoverOrphans(), two.controller.recoverOrphans()]);
  assert.equal(a.saved + b.saved, 4); // both windows saved both drafts (same immutable keys)
  const state = await one.store.load();
  const [first] = state.books.get('id:1').pending, [second] = state.books.get('id:2').pending;
  await Promise.all([one.store.resolve('id:1', first.key, 'dismissed'), two.store.recordSubmission('id:2', second.key, 'r', 'attempt')]);
  const merged = await two.store.load();
  assert.equal(merged.books.get('id:1').pending.length, 0);
  assert.equal(merged.books.get('id:2').inFlight.length, 1);
  assert.deepEqual([...host.drafts.values()].map(draft => draft.content), [false, false]);
});

test('discovery skips active drafts and keeps the local copy after not_found', async () => {
  const host = createFakeOtzaria(), plugin = instance(host), other = instance(host, plugin.storage);
  const { sessionId } = await other.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'x');
  const report = await plugin.controller.recoverOrphans();
  assert.deepEqual([report.active, report.saved], [1, 0]);
  assert.equal(plugin.controller.activeElsewhere.size, 1);
  assert.deepEqual(host.acks, []);
  await other.controller.end(sessionId);
  const kept = new Map(plugin.storage.data);
  // Listed, then acknowledged by another window before getCorrectionDraft: not_found.
  const second = await other.controller.begin(host.openTab('id:1'));
  host.edit(second.sessionId, 1, 'y'); host.endByUser(second.sessionId, 'app_exit');
  const racing = createSessionController({ store: plugin.store, call: async (method, args) => {
    if (method === 'reader.getCorrectionDraft') await other.controller.recoverOrphans();
    return plugin.call(method, args);
  } });
  const raced = await racing.recoverOrphans();
  assert.deepEqual(raced.failed, []);
  for (const [key, value] of kept) assert.deepEqual(plugin.storage.data.get(key), value);
  assert.deepEqual(await pending(plugin.store), ['0:x', '1:y']);
});

test('restore: revision conflicts are not retried blindly, and a changed source applies nothing', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const first = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(first.sessionId, 1, 'בית!');
  await plugin.controller.end(first.sessionId);
  const [item] = (await plugin.store.load()).books.get('id:1').pending;
  const second = await plugin.controller.begin(host.openTab('id:1'));
  const restores = () => host.calls.filter(method => method === 'reader.restoreCorrectionDraft').length;
  host.books['id:1'].lines[1] = 'בית שונה';
  await assert.rejects(plugin.controller.restore(second.sessionId, [item]), { code: 'error.source_changed' });
  assert.deepEqual((await host.instance(createStorage())('reader.getCorrectionSession', { sessionId: second.sessionId })).changes, []);
  host.books['id:1'].lines[1] = '<b>בית</b> גימל';
  // Simulate the reader changing between the read and the restore.
  const originalEdit = host.edit;
  const call = plugin.call;
  let raced = false;
  const racing = createSessionController({ store: plugin.store, call: async (method, args) => {
    const result = await call(method, args);
    if (method === 'reader.getCorrectionSession' && !raced) { raced = true; originalEdit(second.sessionId, 3, 'הא?'); }
    return result;
  } });
  const before = restores();
  await assert.rejects(racing.restore(second.sessionId, [item]), { code: 'error.revision_conflict' });
  assert.equal(restores(), before + 1);
});

test('compaction removes only fully handled versions and ignores late duplicates', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const { sessionId } = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'x');
  const ended = await plugin.controller.end(sessionId);
  let state = await plugin.store.load();
  assert.equal(await plugin.store.compact(state, 'id:1'), 0); // still pending
  const [item] = state.books.get('id:1').pending;
  await plugin.store.resolve('id:1', item.key, 'sent', { reportId: 'r' });
  state = await plugin.store.load();
  assert.equal(await plugin.store.compact(state, 'id:1'), 1);
  // A late duplicate of the same version is saved again but stays inert.
  await plugin.store.saveVersion(ended.snapshot, { sessionId });
  state = await plugin.store.load();
  assert.deepEqual(state.books.get('id:1').pending, []);
  assert.ok([...plugin.storage.data.keys()].some(key => key.startsWith('nc:r:')), 'sent records are kept');
  assert.equal(changeKey('id:1', item), item.key);
});

test('all proposals reset and the end event lost: the old proposal is flagged, never silently certain', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const { sessionId } = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'בוטל?');
  await plugin.controller.save(sessionId);
  await plugin.controller.reset(sessionId, 0);
  host.endByUser(sessionId, 'app_exit'); // empty draft: Otzaria does not list it
  const restarted = instance(host, plugin.storage);
  const report = await restarted.controller.recoverOrphans();
  assert.equal(report.saved, 0);
  const [item] = (await restarted.store.load()).books.get('id:1').pending;
  assert.equal(item.openSession, sessionId, 'the contract carries no final state here; the user must decide');
});

test('an orphan is attributed to its own session only: an independent ended session keeps its proposal', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const first = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(first.sessionId, 0, 'עצמאי');
  await plugin.controller.end(first.sessionId);
  const second = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(second.sessionId, 2, 'שני'); host.endByUser(second.sessionId, 'app_exit');
  await instance(host, plugin.storage).controller.recoverOrphans();
  const book = (await plugin.store.load()).books.get('id:1');
  assert.deepEqual(book.pending.map(item => [item.sectionIndex, item.openSession]), [[0, null], [2, null]]);
  assert.equal(book.entries.at(-1).sessionId, second.sessionId);
});

test('an unrecorded begin (crash after the intent) prevents a guessed attribution', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const { sessionId } = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'א'); await plugin.controller.save(sessionId);
  await plugin.controller.reset(sessionId, 0); host.edit(sessionId, 2, 'ג');
  host.endByUser(sessionId, 'app_exit');
  await plugin.store.beginIntent(); // a later begin whose session was never recorded
  await instance(host, plugin.storage).controller.recoverOrphans();
  const book = (await plugin.store.load()).books.get('id:1');
  assert.equal(book.entries.at(-1).sessionId, null, 'not attributed');
  assert.deepEqual(book.pending.map(item => [item.sectionIndex, !!item.openSession]), [[0, true], [2, false]],
    'nothing lost; the possibly reset proposal needs the user');
});

test('a restored conflict stays actionable until a saved version contains it, also after a host crash', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const old = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(old.sessionId, 0, 'הצלה');
  const snap = await plugin.call('reader.getCorrectionSession', { sessionId: old.sessionId });
  snap.draft.conflicts = [{ ...snap.changes[0], reason: 'displaced' }]; snap.changes = [];
  await plugin.store.saveVersion(snap, { sessionId: 'lost' });
  await plugin.controller.reset(old.sessionId, 0);
  const [conflict] = (await plugin.store.load()).books.get('id:1').conflicts;
  host.persist = false;
  await plugin.controller.restore(old.sessionId, [conflict]);
  assert.equal((await plugin.controller.save(old.sessionId)).saved, false);
  assert.equal((await plugin.store.load()).books.get('id:1').conflicts.length, 1, 'still listed while unsaved');
  host.sessions.get(old.sessionId).ended = true; // host crash: the reader copy is gone
  assert.equal((await plugin.store.load()).books.get('id:1').conflicts.length, 1, 'still listed after the crash');
  const again = await plugin.controller.begin(host.openTab('id:1'));
  host.persist = true;
  await plugin.controller.restore(again.sessionId, [conflict]);
  await plugin.controller.save(again.sessionId);
  const book = (await plugin.store.load()).books.get('id:1');
  assert.deepEqual([book.conflicts.length, book.pending.map(item => item.proposedText)], [0, ['הצלה']]);
});

test('sent history survives compaction and a reload', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const { sessionId } = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'נשלח'); await plugin.controller.end(sessionId);
  const { submitItem } = await import('../plugin/correction-submit.js');
  const book = (await plugin.store.load()).books.get('id:1');
  await submitItem({ call: plugin.call, store: plugin.store, book, item: book.pending[0] });
  assert.ok(await plugin.store.compact(await plugin.store.load(), 'id:1') > 0);
  const reloaded = createCorrectionStore(host.instance(plugin.storage));
  const after = (await reloaded.load()).books.get('id:1');
  assert.deepEqual(after.history.map(item => [item.sectionIndex, item.proposedText, item.record.status]), [[0, 'נשלח', 'sent']]);
});

test('an independent later edit in the same paragraph does not hide an earlier unsent proposal', async () => {
  const host = createFakeOtzaria(), plugin = instance(host);
  const first = await plugin.controller.begin(host.openTab('id:1'));
  host.edit(first.sessionId, 1, 'בית גימל!');
  await plugin.controller.end(first.sessionId); // acknowledged: the reader no longer shows it
  const second = await plugin.controller.begin(host.openTab('id:1'));
  assert.equal(second.recovery, null);
  host.edit(second.sessionId, 1, 'ביתא גימל'); // a fresh edit of the same paragraph
  await plugin.controller.end(second.sessionId);
  assert.deepEqual(await pending(plugin.store), ['1:בית גימל!', '1:ביתא גימל']);
});
