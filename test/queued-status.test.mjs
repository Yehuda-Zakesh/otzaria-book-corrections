import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorrectionStore } from '../plugin/correction-store.js';
import { createSessionController } from '../plugin/correction-sessions.js';
import { submitItem, deliveryLabel } from '../plugin/correction-submit.js';
import { queuedReports, refreshQueuedStatuses } from '../plugin/queued-status.js';
import { createFakeOtzaria, createStorage } from './fake-otzaria.mjs';

async function queued(host, storage = createStorage()) {
  const call = host.instance(storage), store = createCorrectionStore(call);
  const controller = createSessionController({ call, store });
  const { sessionId } = await controller.begin(host.openTab('id:1'));
  host.edit(sessionId, 0, 'אלף מתוקן');
  await controller.end(sessionId);
  const book = (await store.load()).books.get('id:1');
  host.submitMode = 'queued';
  await submitItem({ call, store, book, item: book.pending[0] });
  return { call, store, storage };
}
const historyOf = async store => (await store.load()).books.get('id:1');

test('a queued report stays queued until Otzaria says it was sent, then the label updates', async () => {
  const host = createFakeOtzaria(), { call, store } = await queued(host);
  let state = await store.load();
  assert.equal(queuedReports(state).length, 1);
  let result = await refreshQueuedStatuses({ call, store, state });
  assert.deepEqual(result, { sent: 0, supported: true });
  let book = await historyOf(store);
  assert.match(deliveryLabel(book.history[0].record.result), /טרם נשלח לאתר/);

  host.deliverQueue();
  state = await store.load();
  result = await refreshQueuedStatuses({ call, store, state });
  assert.deepEqual(result, { sent: 1, supported: true });
  book = await historyOf(store);
  assert.equal(book.history[0].record.status, 'sent');
  assert.doesNotMatch(deliveryLabel(book.history[0].record.result), /טרם נשלח לאתר/);
  assert.match(deliveryLabel(book.history[0].record.result), /נשלח מהתור של אוצריא/);
  assert.deepEqual(book.pending, []);

  // Idempotent: nothing is asked or written again once sent.
  state = await store.load();
  assert.equal(queuedReports(state).length, 0);
  const calls = host.calls.length;
  assert.deepEqual(await refreshQueuedStatuses({ call, store, state }), { sent: 0, supported: true });
  assert.equal(host.calls.length, calls);
});

test('an older Otzaria without the status method degrades silently', async () => {
  const host = createFakeOtzaria(), { call, store } = await queued(host);
  host.statusUnsupported = true;
  const result = await refreshQueuedStatuses({ call, store, state: await store.load() });
  assert.deepEqual(result, { sent: 0, supported: false });
  assert.match(deliveryLabel((await historyOf(store)).history[0].record.result), /טרם נשלח לאתר/);
});

test('transient failures and unknown answers change nothing and are retried', async () => {
  const host = createFakeOtzaria(), { call, store } = await queued(host);
  host.statusFails = 'timeout';
  assert.deepEqual(await refreshQueuedStatuses({ call, store, state: await store.load() }), { sent: 0, supported: true });
  host.statusFails = null;
  host.submissions.clear(); // Otzaria no longer knows the ID: "unknown" is not final
  assert.deepEqual(await refreshQueuedStatuses({ call, store, state: await store.load() }), { sent: 0, supported: true });
  assert.equal((await historyOf(store)).history[0].record.status, 'queued');
});

test('two instances upgrading the same report write one record', async () => {
  const host = createFakeOtzaria(), { call, store, storage } = await queued(host);
  host.deliverQueue();
  const other = createCorrectionStore(host.instance(storage));
  const state = await store.load();
  await Promise.all([refreshQueuedStatuses({ call, store, state }), refreshQueuedStatuses({ call: host.instance(storage), store: other, state })]);
  const book = await historyOf(store);
  assert.equal(book.history.length, 1);
  assert.equal(book.history[0].record.status, 'sent');
});
