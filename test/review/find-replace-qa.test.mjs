import test from 'node:test';
import assert from 'node:assert/strict';
import { planReplacements, replaceLiteral } from '../../plugin/find-replace.js';
import { sourceText } from '../../plugin/book.js';
import { createSessionController } from '../../plugin/correction-sessions.js';
import { createCorrectionStore } from '../../plugin/correction-store.js';
import { createFakeOtzaria, createStorage } from '../fake-otzaria.mjs';

function bookOf(lines) {
  return { identity: { bookUid: 'id:1', bookId: 'ספר QA' }, rawLines: [...lines],
    sections: lines.map((raw, index) => ({ index, text: sourceText(raw) })) };
}
const snapshotOf = (changes = []) => ({ sessionId: 'qa-session', bookUid: 'id:1', bookId: 'ספר QA', libraryVersion: '1', revision: 4, changes });
async function fixture(lines = ['אב אב', 'שמור', 'אב']) {
  const host = createFakeOtzaria({ books: { 'id:1': { bookId: 'ספר QA', lines } } }), storage = createStorage();
  const native = host.instance(storage), calls = [];
  const call = (method, args) => { calls.push({ method, args: structuredClone(args) }); return native(method, args); };
  const store = createCorrectionStore(call), controller = createSessionController({ call, store });
  const session = await controller.begin(host.openTab('id:1'));
  return { host, storage, call, calls, store, controller, session, book: bookOf(lines),
    latest: () => native('reader.getCorrectionSession', { sessionId: session.sessionId }) };
}

test('QA replacement: Hebrew and astral word boundaries are Unicode aware', () => {
  assert.deepEqual(replaceLiteral('אב אבות מאב אב.', 'אב', 'אם', true), { text: 'אם אבות מאב אם.', count: 2 });
  assert.equal(replaceLiteral('אב אבות מאב אב.', 'אב', 'אם', false).count, 4);
  assert.deepEqual(replaceLiteral('𐤀אב אב𐤀 אב', 'אב', 'אם', true), { text: '𐤀אב אב𐤀 אם', count: 1 });
});
test('QA replacement: query punctuation and replacement dollar tokens are literal', () => {
  assert.deepEqual(replaceLiteral('אב אב', 'אב', '$& $$', true), { text: '$& $$ $& $$', count: 2 });
  assert.deepEqual(replaceLiteral('[אב] [אב]', '[', 'X', false), { text: 'Xאב] Xאב]', count: 2 });
});
test('QA replacement: planning preserves unrelated edits and does not mutate its input', () => {
  const book = bookOf(['אב אב', 'שמור', '<b>אב</b>']);
  const snapshot = snapshotOf([{ sectionIndex: 1, originalSourceText: 'שמור', originalText: 'שמור', proposedText: 'שמור חדש' }]);
  const original = structuredClone({ book, snapshot });
  const plan = planReplacements(book, snapshot, { query: 'אב', replacement: 'אם' });
  assert.equal(plan.occurrences, 3);
  assert.equal(plan.previews.length, 2);
  assert.deepEqual(plan.changes.map(c => c.proposedText), ['אם אם', 'שמור חדש', 'אם']);
  assert.equal(plan.changes[2].originalSourceText, '<b>אב</b>');
  assert.deepEqual({ book, snapshot }, original);
});
test('QA replacement: reverting a live correction produces an intentional empty restore plan', () => {
  const plan = planReplacements(bookOf(['אב']), snapshotOf([{ sectionIndex: 0, originalSourceText: 'אב', originalText: 'אב', proposedText: 'אם' }]), { query: 'אם', replacement: 'אב' });
  assert.equal(plan.occurrences, 1);
  assert.deepEqual(plan.changes, []);
});
test('QA replacement: unsafe mapping, wrong identity and too many changed paragraphs fail before application', () => {
  const book = bookOf(['אב', 'אב']), snapshot = snapshotOf();
  assert.throws(() => planReplacements({ ...book, rawLines: null }, snapshot, { query: 'אב', replacement: 'אם' }));
  assert.throws(() => planReplacements(book, { ...snapshot, bookUid: 'id:2' }, { query: 'אב', replacement: 'אם' }), { code: 'error.source_changed' });
  assert.throws(() => planReplacements(book, { ...snapshot, capabilities: { maxChanges: 1 } }, { query: 'אב', replacement: 'אם' }), { code: 'error.limit_exceeded' });
  assert.throws(() => planReplacements(book, snapshot, { query: 'אב', replacement: 'אם\nאם' }));
});
test('QA replacement: one restore preserves existing edits and saves the whole result', async () => {
  const p = await fixture();
  p.host.edit(p.session.sessionId, 1, 'שמור חדש');
  const plan = planReplacements(p.book, await p.latest(), { query: 'אב', replacement: 'אם' });
  const result = await p.controller.applyReplacements(plan);
  const restores = p.calls.filter(c => c.method === 'reader.restoreCorrectionDraft');
  assert.equal(restores.length, 1);
  assert.equal(restores[0].args.expectedRevision, plan.revision);
  assert.deepEqual((await p.latest()).changes.map(c => c.proposedText), ['אם אם', 'שמור חדש', 'אם']);
  assert.equal(result.saved, true);
  assert.equal((await p.store.load()).books.get('id:1').pending.length, 3);
});
test('QA replacement: typing after preview prevents restore rather than overwriting the newer wording', async () => {
  const p = await fixture();
  const plan = planReplacements(p.book, await p.latest(), { query: 'אב', replacement: 'אם' });
  p.host.edit(p.session.sessionId, 0, 'הקלדה אחרי תצוגה מקדימה');
  await assert.rejects(p.controller.applyReplacements(plan), { code: 'error.revision_conflict' });
  assert.equal(p.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
  assert.equal((await p.latest()).changes[0].proposedText, 'הקלדה אחרי תצוגה מקדימה');
});
test('QA replacement: changed source in the second paragraph cannot partially replace the first', async () => {
  const p = await fixture(['אב', 'אב']);
  p.host.edit(p.session.sessionId, 0, 'אב מקומי');
  const plan = planReplacements(p.book, await p.latest(), { query: 'אב', replacement: 'אם' });
  p.host.books['id:1'].lines[1] = 'מקור אחר';
  await assert.rejects(p.controller.applyReplacements(plan), { code: 'error.source_changed' });
  assert.deepEqual((await p.latest()).changes.map(c => c.proposedText), ['אב מקומי']);
  assert.equal(p.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 1, 'no automatic retry');
});
test('QA replacement: applying back to the original clears an already stored proposal', async () => {
  const p = await fixture(['אב']);
  p.host.edit(p.session.sessionId, 0, 'אם');
  await p.controller.save(p.session.sessionId);
  const plan = planReplacements(p.book, await p.latest(), { query: 'אם', replacement: 'אב' });
  await p.controller.applyReplacements(plan);
  assert.deepEqual((await p.latest()).changes, []);
  assert.deepEqual((await p.store.load()).books.get('id:1').pending, []);
});
test('QA replacement: a host write still pending is applied but never acknowledged as plugin-saved', async () => {
  const p = await fixture(['אב']);
  const plan = planReplacements(p.book, await p.latest(), { query: 'אב', replacement: 'אם' });
  p.host.persist = false;
  const result = await p.controller.applyReplacements(plan);
  assert.equal(result.saved, false);
  assert.equal(p.host.acks.length, 0);
  assert.equal((await p.latest()).changes[0].proposedText, 'אם');
});
test('QA replacement: plugin storage failure after restore preserves the recoverable native draft', async () => {
  const p = await fixture(['אב']);
  const plan = planReplacements(p.book, await p.latest(), { query: 'אב', replacement: 'אם' });
  p.storage.failSet = true;
  await assert.rejects(p.controller.applyReplacements(plan), /ההחלפה הוחלה בקורא/);
  assert.equal((await p.latest()).changes[0].proposedText, 'אם');
  assert.equal(p.host.drafts.get('d-id:1').changes[0].proposedText, 'אם');
  assert.equal(p.host.acks.length, 0);
});
