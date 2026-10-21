import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorrectionStore } from '../../plugin/correction-store.js';
import { createStorage, createFakeOtzaria, plugin, waitFor, clickWhenReady } from './page-harness.mjs';

const uid = 'id:1', original = 'alpha beta gamma';
const change = proposedText => ({ sectionIndex: 0, originalSourceText: original, originalText: original, proposedText });
async function fixture() {
  const storage = createStorage(), store = createCorrectionStore(storage.call);
  for (const [i, text] of ['ALPHA beta gamma', 'alpha beta GAMMA'].entries()) {
    await store.saveVersion({ bookUid: uid, bookId: 'QA', libraryVersion: '1', draftId: `draft-${i}`, version: i + 1,
      changes: [change(text)], conflicts: [] });
  }
  return { storage, store, items: (await store.load()).books.get(uid).pending };
}
const pending = async store => (await store.load()).books.get(uid).pending.map(p => p.proposedText).sort();

test('QA offline merge: one durable write survives restart and never needs native APIs', async () => {
  const f = await fixture(), calls = [];
  const store = createCorrectionStore((m, a) => { calls.push(m); return f.storage.call(m, a); });
  await store.saveMergedProposal(uid, f.items, 'ALPHA beta GAMMA');
  assert.deepEqual(await pending(createCorrectionStore(f.storage.call)), ['ALPHA beta GAMMA']);
  assert.equal(calls.filter(m => m === 'storage.set').length, 1);
  assert(calls.every(m => m.startsWith('storage.')));
});
test('QA offline merge: failed atomic write retains both original proposals', async () => {
  const f = await fixture(); f.storage.failSet = true;
  await assert.rejects(f.store.saveMergedProposal(uid, f.items, 'ALPHA beta GAMMA'));
  f.storage.failSet = false;
  assert.deepEqual(await pending(createCorrectionStore(f.storage.call)), ['ALPHA beta gamma', 'alpha beta GAMMA']);
});
test('QA offline merge: crash after commit before readback retains the complete merge', async () => {
  const f = await fixture(); let committed = false;
  const store = createCorrectionStore(async (m, a) => {
    if (committed && m === 'storage.get' && a.key.startsWith('nc:merged:')) throw new Error('process lost');
    const result = await f.storage.call(m, a);
    if (m === 'storage.set' && a.key.startsWith('nc:merged:')) committed = true;
    return result;
  });
  await assert.rejects(store.saveMergedProposal(uid, f.items, 'ALPHA beta GAMMA'));
  assert.deepEqual(await pending(createCorrectionStore(f.storage.call)), ['ALPHA beta GAMMA']);
});
test('QA offline merge: concurrent independent proposal is retained', async () => {
  const f = await fixture();
  await f.store.saveVersion({ bookUid: uid, bookId: 'QA', draftId: 'independent', version: 3,
    changes: [change('alpha BETA gamma')], conflicts: [] });
  await f.store.saveMergedProposal(uid, f.items, 'ALPHA beta GAMMA');
  assert.deepEqual(await pending(f.store), ['ALPHA beta GAMMA', 'alpha BETA gamma']);
});
test('QA offline merge: compaction preserves resolutions against late originals', async () => {
  const f = await fixture(), oldRecords = [...f.storage.data].map(([k,v]) => [k, structuredClone(v)]);
  await f.store.saveMergedProposal(uid, f.items, 'ALPHA beta GAMMA');
  let state = await f.store.load();
  const item = state.books.get(uid).pending[0];
  await f.store.resolve(uid, item.key, 'dismissed');
  await f.store.compact(await f.store.load(), uid);
  for (const [key,value] of oldRecords) f.storage.data.set(key,value);
  assert.deepEqual(await pending(createCorrectionStore(f.storage.call)), []);
  assert([...f.storage.data.keys()].some(key => key.startsWith('nc:merged:')));
});
test('QA offline merge page: enabled with reader closed, saves without opening or submitting', async () => {
  const f = await fixture(), host = createFakeOtzaria({ books: { [uid]: { bookId: 'QA', lines: [original] } } });
  const page = await plugin({ host, storage: f.storage });
  await clickWhenReady(page, 'book-list', 'איחוד לדיווח אחד');
  await waitFor(() => /אוחדו ונשמרו בתוסף/.test(page.el('status').textContent), 'offline merge completed');
  assert.deepEqual(await pending(f.store), ['ALPHA beta GAMMA']);
  assert.equal(host.tabs.size, 0); assert.equal(host.sessions.size, 0); assert.equal(host.submissions.size, 0);
  assert(!page.rpcCalls.some(c => /beginCorrectionSession|restoreCorrectionDraft|submitBookCorrection|activateTab|openBook/.test(c.method)));
});
