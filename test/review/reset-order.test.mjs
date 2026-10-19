import test from 'node:test';
import assert from 'node:assert/strict';
import { createCorrectionStore } from '../../plugin/correction-store.js';
import { createSessionController } from '../../plugin/correction-sessions.js';
import { createFakeOtzaria, createStorage } from '../fake-otzaria.mjs';

for (const delayedFinal of [false, true]) {
  test(`review: reset without a saved version preserves later proposals with ${delayedFinal ? 'delayed final delivery' : 'equal timestamps'}`, async () => {
    const host = createFakeOtzaria(), storage = createStorage();
    let clock = 1000;
    const call = host.instance(storage), store = createCorrectionStore(call, { now: () => clock });
    const controller = createSessionController({ call, store });
    const first = await controller.begin(host.openTab('id:1'));
    host.edit(first.sessionId, 0, 'old proposal');
    await controller.end(first.sessionId);

    clock = delayedFinal ? 2000 : 1000;
    await store.markInherited('reset-without-save', 'id:1', [0]);
    const final = { bookUid: 'id:1', sessionId: 'reset-without-save', changes: [] };
    if (!delayedFinal) await store.recordFinal(final);
    // The reset session has ended in the host. Its event can wait behind
    // other plugin work while another instance saves a later session.
    clock = delayedFinal ? 3000 : 1000;
    const later = await controller.begin(host.openTab('id:1'));
    host.edit(later.sessionId, 0, 'new proposal');
    await controller.end(later.sessionId);
    if (delayedFinal) { clock = 4000; await store.recordFinal(final); }

    const restarted = createCorrectionStore(call);
    const state = (await restarted.load()).books.get('id:1');
    assert.ok(state.entries.some(entry => entry.sessionId === later.sessionId && entry.changes.some(change => change.proposedText === 'new proposal')));
    assert.deepEqual(state.pending.map(item => item.proposedText), ['new proposal'],
      'local storage timestamps must not let an older reset hide a later proposal');
  });
}

test('review: an inherited reset must not cancel a future independent proposal', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const call = host.instance(storage), store = createCorrectionStore(call);
  const controller = createSessionController({ call, store });
  const read = async () => (await store.load()).books.get('id:1');

  const first = await controller.begin(host.openTab('id:1'));
  host.edit(first.sessionId, 0, 'first proposal');
  await controller.end(first.sessionId);
  const original = (await read()).pending[0];

  const reset = await controller.begin(host.openTab('id:1'));
  await controller.restore(reset.sessionId, [original]);
  await controller.reset(reset.sessionId, 0);
  await controller.end(reset.sessionId);
  assert.deepEqual((await read()).pending, [], 'the inherited proposal was cancelled');

  const later = await controller.begin(host.openTab('id:1'));
  host.edit(later.sessionId, 0, 'new independent proposal');
  await controller.end(later.sessionId);

  const state = await read();
  assert.ok(state.entries.some(entry => entry.sessionId === later.sessionId &&
    entry.changes.some(change => change.proposedText === 'new independent proposal')),
  'the later proposal is durably stored');
  assert.deepEqual(state.pending.map(item => item.proposedText), ['new independent proposal'],
    'a reset from an older session cannot hide the later proposal');

  const restarted = createCorrectionStore(host.instance(storage));
  const afterRestart = (await restarted.load()).books.get('id:1');
  assert.deepEqual(afterRestart.pending.map(item => item.proposedText), ['new independent proposal'],
    'the later proposal survives a restart');
});

test('review: a reset whose session ended without a saved version cancels only the older proposal', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  let clock = 1000;
  const now = () => ++clock;
  const call = host.instance(storage), store = createCorrectionStore(call, { now });
  const controller = createSessionController({ call, store });
  const read = async () => (await store.load()).books.get('id:1');

  const first = await controller.begin(host.openTab('id:1'));
  host.edit(first.sessionId, 0, 'older proposal');
  await controller.end(first.sessionId);
  const original = (await read()).pending[0];

  await store.markInherited('reset-without-save', 'id:1', [0]);
  await store.recordFinal({ bookUid: 'id:1', sessionId: 'reset-without-save', changes: [] });
  assert.deepEqual((await read()).pending, [], 'the inherited proposal is cancelled when its reset session ends');

  const later = await controller.begin(host.openTab('id:1'));
  host.edit(later.sessionId, 0, 'later independent proposal');
  await controller.end(later.sessionId);

  const restarted = createCorrectionStore(host.instance(storage));
  const state = (await restarted.load()).books.get('id:1');
  assert.deepEqual(state.pending.map(item => item.proposedText), ['later independent proposal'],
    'a later proposal is not cancelled by an earlier session that ended without a saved version, even after a restart');
});

test('review: two plugin instances sharing storage keep the later proposal and cancel only the older one', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const windowA = createSessionController({ call: host.instance(storage), store: createCorrectionStore(host.instance(storage)) });
  const storeB = createCorrectionStore(host.instance(storage));
  const first = await windowA.begin(host.openTab('id:1'));
  host.edit(first.sessionId, 0, 'older proposal');
  await windowA.end(first.sessionId);

  await storeB.markInherited('reset-in-window-b', 'id:1', [0]);
  await storeB.recordFinal({ bookUid: 'id:1', sessionId: 'reset-in-window-b', changes: [] });

  const later = await windowA.begin(host.openTab('id:1'));
  host.edit(later.sessionId, 0, 'later proposal from window A');
  await windowA.end(later.sessionId);

  const state = (await createCorrectionStore(host.instance(storage)).load()).books.get('id:1');
  assert.deepEqual(state.pending.map(item => item.proposedText), ['later proposal from window A'],
    'a reset recorded by another window cancels only the proposal it built on');
});
