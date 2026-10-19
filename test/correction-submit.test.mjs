import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorrectionStore } from '../plugin/correction-store.js';
import { createSessionController } from '../plugin/correction-sessions.js';
import { correctionRange, submissionParams, submitItem, deliveryLabel } from '../plugin/correction-submit.js';
import { createFakeOtzaria, createStorage } from './fake-otzaria.mjs';

async function stored(host, storage = createStorage(), edits = [[0, 'אלף מתוקן']]) {
  const call = host.instance(storage), store = createCorrectionStore(call);
  const controller = createSessionController({ call, store });
  const { sessionId } = await controller.begin(host.openTab('id:1'));
  for (const [index, text] of edits) host.edit(sessionId, index, text);
  await controller.end(sessionId);
  const book = (await store.load()).books.get('id:1');
  return { call, store, book, storage };
}
const reload = async store => (await store.load()).books.get('id:1');

test('minimal ranges in plain text and widening for repeated HTML wording', () => {
  assert.deepEqual(correctionRange({ originalText: 'אבג דהו', originalSourceText: 'אבג דהו', proposedText: 'אבג דזו' }),
    { sourceStart: 5, sourceEnd: 6, original: 'ה', proposed: 'ז' });
  const html = { originalText: 'בית גימל בית', originalSourceText: '<b>בית</b> גימל בית', proposedText: 'בית גימל ביתא' };
  const range = correctionRange(html);
  assert.equal(html.originalText.slice(range.sourceStart, range.sourceEnd), range.original);
  assert.equal(html.originalSourceText.indexOf(range.original), html.originalSourceText.lastIndexOf(range.original));
  assert.equal(html.originalText.slice(0, range.sourceStart) + range.proposed + html.originalText.slice(range.sourceEnd), html.proposedText);
  // Surrogate pairs are never split.
  const emoji = correctionRange({ originalText: 'a😀b', originalSourceText: 'a😀b', proposedText: 'a😁b' });
  assert.equal(emoji.original, '😀');
});

test('structured submission requires text_correction and records sent status', async () => {
  const host = createFakeOtzaria(), { call, store, book } = await stored(host);
  const [item] = book.pending;
  const params = submissionParams(book, item, 'r');
  assert.equal(params.requireTextCorrection, true);
  assert.equal(params.forceFreeText, undefined);
  assert.deepEqual(params.snapshots, [{ index: 0, text: 'אלף' }]);
  const result = await submitItem({ call, store, book, item });
  assert.equal(result.status, 'sent');
  assert.equal(deliveryLabel(result.record), 'התקבל באתר כתיקון מובנה');
  assert.deepEqual((await reload(store)).pending, []);
  // Never resent once confirmed.
  const again = await submitItem({ call, store, book, item: (await reload(store)).handled[0] });
  assert.equal(again.status, 'already');
  assert.equal(host.submissions.size, 1);
});

test('text_correction_unavailable needs an explicit decision; nothing is sent or resolved', async () => {
  const host = createFakeOtzaria(), { call, store, book } = await stored(host);
  host.textCorrectionUnavailable = true;
  const result = await submitItem({ call, store, book, item: book.pending[0] });
  assert.equal(result.status, 'needs_decision');
  assert.equal(host.submissions.size, 0);
  assert.equal((await reload(store)).pending.length, 1);
  const free = await submitItem({ call, store, book, item: (await reload(store)).pending[0], freeText: true });
  assert.equal(free.status, 'sent');
  assert.equal(host.submissions.get(free.record.reportId).params.requireTextCorrection, undefined);
});

test('queued is not presented as received by the site', async () => {
  const host = createFakeOtzaria(), { call, store, book } = await stored(host);
  host.submitMode = 'queued';
  const result = await submitItem({ call, store, book, item: book.pending[0] });
  assert.equal(result.status, 'queued');
  assert.equal(result.record.correctionSupported, null);
  assert.match(deliveryLabel(result.record), /טרם נשלח לאתר/);
  assert.deepEqual((await reload(store)).pending, []);
});

test('a lost response and a restart reuse the same report ID without duplicates', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const { call, store, book } = await stored(host, storage);
  host.loseSubmitResponse = true;
  await assert.rejects(submitItem({ call, store, book, item: book.pending[0] }), /response lost/);
  // Restart: a new store over the same storage.
  const restarted = createCorrectionStore(host.instance(storage));
  const after = await reload(restarted);
  assert.equal(after.inFlight.length, 1, 'the uncertain attempt is visible');
  const retry = await submitItem({ call, store: restarted, book: after, item: after.pending[0] });
  assert.equal(retry.record.duplicate, true);
  assert.equal(host.submissions.size, 1);
  assert.equal([...host.submissions.values()][0].count, 2);
});

test('a report ID conflict advances the ID only after explicit consent', async () => {
  const host = createFakeOtzaria(), { call, store, book } = await stored(host);
  const [item] = book.pending;
  host.submissions.set(`bc-${item.key}`, { content: 'other', params: {}, count: 1 });
  const conflict = await submitItem({ call, store, book, item });
  assert.equal(conflict.status, 'id_conflict');
  let next = (await reload(store)).pending[0];
  assert.deepEqual([next.generation, next.idConflict], [0, true], 'detection is not consent');
  const calls = host.calls.length;
  assert.equal((await submitItem({ call, store, book, item: next })).status, 'id_conflict', 'refusal or restart asks again');
  assert.equal(host.calls.filter(method => method === 'feedback.submitBookCorrection').length, 1, 'nothing resent without consent');
  assert.ok(host.calls.length >= calls);
  await store.consentNewReportId('id:1', next);
  next = (await reload(store)).pending[0];
  assert.deepEqual([next.generation, next.idConflict], [1, false]);
  const sent = await submitItem({ call, store, book, item: next });
  assert.equal(sent.record.reportId, `bc-${item.key}-1`);
});

test('a changed source blocks sending and keeps the proposal', async () => {
  const host = createFakeOtzaria(), { call, store, book } = await stored(host);
  host.submitFails = 'source_changed';
  assert.equal((await submitItem({ call, store, book, item: book.pending[0] })).status, 'source_changed');
  assert.equal((await reload(store)).pending.length, 1);
});
