import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorrectionStore } from '../../plugin/correction-store.js';
import { createSessionController } from '../../plugin/correction-sessions.js';
import { createReaderMarks } from '../../plugin/reader-marks.js';
import { createStorage, createFakeOtzaria } from '../fake-otzaria.mjs';

const change = text => ({ sectionIndex: 0, originalSourceText: 'מקור', originalText: 'מקור', proposedText: text });
const source = (id = 'first', version = 1, text = 'תיקון') => ({ bookUid: 'id:1', bookId: 'QA', libraryVersion: '1',
  draftId: id, version, changes: [change(text)], conflicts: [] });
async function fixture() {
  const storage = createStorage(), calls = [];
  const call = (method, args) => { calls.push({ method, args }); return storage.call(method, args); };
  const store = createCorrectionStore(call); await store.saveVersion(source());
  return { storage, calls, call, store };
}
test('QA home cache: repeated loads list keys but fetch no cached immutable records', async () => {
  const f = await fixture(); await f.store.load(); f.calls.length = 0;
  await Promise.all([f.store.load(), f.store.load(), f.store.load()]);
  assert.equal(f.calls.filter(c => c.method === 'storage.get').length, 0);
  assert.equal(f.calls.filter(c => c.method === 'storage.list').length, 3);
});
test('QA home cache: foreign immutable additions and removals are discovered', async () => {
  const f = await fixture(); await f.store.load();
  const foreign = createCorrectionStore(f.storage.call); await foreign.saveVersion(source('foreign', 2, 'נוסח אחר'));
  f.calls.length = 0;
  let book = (await f.store.load()).books.get('id:1');
  assert.equal(book.pending.length, 2); assert.equal(f.calls.filter(c => c.method === 'storage.get').length, 1);
  const removed = [...f.storage.data.keys()].find(k => k.includes(':foreign:'));
  f.storage.data.delete(removed); f.calls.length = 0;
  book = (await f.store.load()).books.get('id:1');
  assert.deepEqual(book.pending.map(p => p.proposedText), ['תיקון']);
  assert.equal(f.calls.filter(c => c.method === 'storage.get').length, 0);
});
test('QA home cache: caller mutations cannot corrupt later loads', async () => {
  const f = await fixture(), state = await f.store.load(), book = state.books.get('id:1');
  book.entries[0].changes[0].proposedText = 'corrupt'; book.pending.length = 0; book.bookId = 'corrupt';
  const fresh = (await f.store.load()).books.get('id:1');
  assert.equal(fresh.bookId, 'QA'); assert.deepEqual(fresh.pending.map(p => p.proposedText), ['תיקון']);
});
test('QA home cache: a failed explicit durable readback cannot acknowledge a warmed record', async () => {
  const host = createFakeOtzaria(), storage = createStorage(), native = host.instance(storage);
  let armed = false, reads = 0;
  const call = async (method, args) => {
    if (armed && method === 'storage.get' && args.key.startsWith('nc:e:') && ++reads === 2) throw new Error('readback unavailable');
    return native(method, args);
  };
  const store = createCorrectionStore(call), controller = createSessionController({ call, store });
  const session = await controller.begin(host.openTab('id:1')); host.edit(session.sessionId, 0, 'תיקון');
  const snapshot = await native('reader.getCorrectionSession', { sessionId: session.sessionId });
  await store.saveVersion(snapshot, { sessionId: session.sessionId, revision: snapshot.revision }); await store.load();
  const before = host.acks.length; armed = true;
  await assert.rejects(controller.save(session.sessionId), /readback unavailable/);
  assert.equal(host.acks.length, before); assert.equal(host.drafts.get('d-id:1').content, true);
});

const markState = text => ({ books: new Map([['id:1', { bookUid: 'id:1', bookId: 'QA', pending: [
  { key: text, ...change(text) }
] }]]) });
test('QA home marks: repeated lazy-source misses are retried only after the clock expires', async () => {
  let clock = 0, finds = 0;
  const marks = createReaderMarks(async method => {
    if (method === 'reader.findTextOccurrences') { finds++; return { results: [] }; }
    return true;
  }, { now: () => clock, retryDelay: 5000 });
  await marks.sync(markState('אחר'), true); assert.equal(finds, 1);
  await marks.sync(markState('אחר'), true); assert.equal(finds, 1);
  clock = 4999; await marks.sync(markState('אחר'), true); assert.equal(finds, 1);
  clock = 5001; await marks.sync(markState('אחר'), true); assert.equal(finds, 2);
});
test('QA home marks: queued syncs discard obsolete intermediate states', async () => {
  let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const finds = [];
  const marks = createReaderMarks(async (method, args) => {
    if (method === 'reader.findTextOccurrences') {
      finds.push(args.query);
      if (finds.length === 1) { entered(); await gate; }
      return { results: [] };
    }
    return true;
  });
  // Different original text gives distinguishable source lookup queries.
  const state = text => ({ books: new Map([['id:1', { bookUid: 'id:1', bookId: 'QA', pending: [
    { key: text, sectionIndex: 0, originalText: text, originalSourceText: text, proposedText: 'שונה' }
  ] }]]) });
  const first = marks.sync(state('ראשון'), true); await began;
  const middle = marks.sync(state('אמצע'), true), last = marks.sync(state('אחרון'), true);
  release(); await Promise.all([first, middle, last]);
  assert.deepEqual(finds, ['ראשון', 'אחרון']);
});
