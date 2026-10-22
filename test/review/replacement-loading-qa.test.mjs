import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBook } from '../../plugin/book.js';
import { createReplacementBookLoader, planReplacements } from '../../plugin/find-replace.js';
import { createSessionController } from '../../plugin/correction-sessions.js';
import { createDiagnostics } from '../../plugin/diagnostics.js';
import { plugin, waitFor, editInReader, clickWhenReady, createFakeOtzaria, createStorage, createCorrectionStore } from './page-harness.mjs';

const snapshot = { sessionId: 'session-qa', bookUid: 'id:1', bookId: 'QA', libraryVersion: '1', revision: 0, changes: [] };
function fixture({ raw = 'אב אב\nשמור\nאב', count = 3 } = {}) {
  const calls = []; let fail = false;
  const call = async (method, args) => {
    calls.push({ method, args });
    if (method === 'library.getBookDetails') return { source: 'library', type: 'text', lineCount: count, bookUid: 'id:1' };
    if (method === 'library.getBookContent') {
      if (fail) throw new Error('transient content failure');
      return raw.slice(args.offset, args.offset + args.limit);
    }
    if (method === 'reader.getSectionTextMap') return { sourceText: '' }; // Native lazy-reader placeholder.
    throw new Error(method);
  };
  return { call, calls, setFail: value => { fail = value; }, maps: () => calls.filter(c => c.method === 'reader.getSectionTextMap').length };
}
test('QA loading: ordinary loader still validates lazy endpoint maps and loses raw anchors', async () => {
  const f = fixture();
  const book = await loadBook(f.call, snapshot, undefined, { includeRaw: true });
  assert.equal(book.rawLines, null); assert(f.maps() >= 3);
});
test('QA loading: deferred replacement preview keeps exact raw anchors with zero reader maps', async () => {
  const f = fixture(), loader = createReplacementBookLoader(f.call);
  const book = await loader.load(snapshot);
  assert.deepEqual(book.rawLines, ['אב אב', 'שמור', 'אב']);
  assert.equal(planReplacements(book, snapshot, { query: 'אב', replacement: 'אם' }).occurrences, 3);
  assert.equal(f.maps(), 0);
});
test('QA loading: embedded raw newlines with wrong authoritative count fail without guessing boundaries', async () => {
  const f = fixture({ raw: 'אב\nembedded\nשמור', count: 2 });
  await assert.rejects(createReplacementBookLoader(f.call).load(snapshot), /גבולות הפסקאות/);
  assert.equal(f.maps(), 0);
});
test('QA loading: cache coalesces concurrent reads and invalidates session, book and library version', async () => {
  const f = fixture(), loader = createReplacementBookLoader(f.call);
  const [first, second] = await Promise.all([loader.load(snapshot), loader.load(snapshot)]);
  assert.equal(first, second);
  let reads = f.calls.length;
  assert.equal(await loader.load({ ...snapshot, revision: 7 }), first);
  assert.equal(f.calls.length, reads, 'typing revision does not reload immutable source');
  for (const changed of [{ sessionId: 'other' }, { libraryVersion: '2' }, { bookUid: 'id:2' }]) {
    await loader.load({ ...snapshot, ...changed }); assert(f.calls.length > reads); reads = f.calls.length;
  }
  loader.clear(); await loader.load(snapshot); assert(f.calls.length > reads);
  assert.equal(f.maps(), 0);
});
test('QA loading: a transient load error is evicted and the next preview retries', async () => {
  const f = fixture(), loader = createReplacementBookLoader(f.call); f.setFail(true);
  await assert.rejects(loader.load(snapshot), /transient/);
  f.setFail(false); assert.equal((await loader.load(snapshot)).rawLines.length, 3);
});
test('QA loading: native restore rejects changed DB source atomically after deferred preview', async () => {
  const host = createFakeOtzaria({ books: { 'id:1': { bookId: 'QA', lines: ['אב אב', 'שמור', 'אב'] } } });
  const storage = createStorage(), native = host.instance(storage), controller = createSessionController({ call: native, store: createCorrectionStore(native) });
  const current = await controller.begin(host.openTab('id:1'));
  host.edit(current.sessionId, 1, 'שמור מקומי');
  const before = await native('reader.getCorrectionSession', { sessionId: current.sessionId });
  const book = await createReplacementBookLoader(fixture().call).load(before);
  const plan = planReplacements(book, before, { query: 'אב', replacement: 'אם' });
  host.books['id:1'].lines[2] = 'מקור שונה';
  await assert.rejects(controller.applyReplacements(plan), { code: 'error.source_changed' });
  const after = await native('reader.getCorrectionSession', { sessionId: current.sessionId });
  assert.deepEqual(after.changes, before.changes); assert.equal(after.revision, before.revision);
});
test('QA loading page: preview works with empty source maps from a lazily loaded reader', async () => {
  const host = createFakeOtzaria({ books: { 'id:1': { bookId: 'QA', lines: ['אב אב', 'שמור', 'אב'] } } });
  const page = await plugin({ host, storage: createStorage(), sdkOverrides: { 'reader.getSectionTextMap': () => ({ sourceText: '' }) } });
  await editInReader(page, host, []);
  await clickWhenReady(page, 'live-list', 'חיפוש והחלפה');
  page.el('replace-query').value = 'אב'; page.el('replace-with').value = 'אם'; page.el('replace-whole-words').checked = true;
  page.el('replace-preview').click();
  await waitFor(() => /3 התאמות/.test(page.el('replace-summary').textContent) && !page.el('replace-apply').disabled, 'preview ready despite lazy maps');
  assert.equal(page.rpcCalls.filter(c => c.method === 'reader.getSectionTextMap').length, 0);
  assert.equal(page.rpcCalls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
  assert.equal(host.submissions.size, 0);
});
test('QA loading diagnostics: storage success noise cannot erase the original loading error', async () => {
  const storage = createStorage(), d = createDiagnostics(storage.call, { id: 'qa', now: () => 1000, schedule: () => 1, cancel() {} });
  await d.start(); d.error('replacement.error', { code: 'error.original_loading_failure' });
  const call = d.wrap(storage.call);
  for (let i = 0; i < 400; i++) { await call('storage.list'); await call('storage.get', { key: 'nc:missing' }); }
  for (let i = 0; i < 300; i++) d.record('ui.action', { count: i });
  const data = JSON.parse(await d.exportText()).instances[0];
  assert(data.entries.some(e => e.code === 'error.original_loading_failure'));
  assert(data.entries.length <= 250); assert.equal(data.counters['storage.list'], 400);
  assert.match(await d.reportDetails('Loading failed'), /error.original_loading_failure/);
});
