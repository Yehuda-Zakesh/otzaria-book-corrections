import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPendingCorrections, createSendVisibility, SEND_VISIBILITY_KEY } from '../../plugin/send-visibility.js';
import { changeKey, createCorrectionStore } from '../../plugin/correction-store.js';
import { createSessionController } from '../../plugin/correction-sessions.js';
import { createFakeOtzaria, createStorage } from '../fake-otzaria.mjs';

test('QA visibility: live unsaved changes appear and resetting the reader hides them', async () => {
  const host = createFakeOtzaria(), storage = createStorage(), call = host.instance(storage);
  const store = createCorrectionStore(call), controller = createSessionController({ call, store });
  const session = await controller.begin(host.openTab('id:1'));
  const visibility = createSendVisibility(call);
  await visibility.sync(await store.load(), controller.sessions);
  assert.equal(storage.data.get(SEND_VISIBILITY_KEY), false);
  host.persist = false;
  host.edit(session.sessionId, 0, 'טיוטה שלא נשמרה');
  await controller.changed({ sessionId: session.sessionId });
  await visibility.sync(await store.load(), controller.sessions);
  assert.equal(storage.data.get(SEND_VISIBILITY_KEY), true);
  await controller.reset(session.sessionId, 0);
  await visibility.sync(await store.load(), controller.sessions);
  assert.equal(storage.data.get(SEND_VISIBILITY_KEY), false);
});
test('QA visibility: a handled live wording stays hidden while a later different wording reappears', () => {
  const change = { sectionIndex: 0, originalSourceText: 'אב', originalText: 'אב', proposedText: 'אם' };
  const key = changeKey('id:1', change);
  const state = { books: new Map([['id:1', { bookUid: 'id:1', pending: [], resolutions: new Map([[key, [{}]]]) }]]) };
  const sessions = new Map([['live', { snapshot: { sessionId: 'live', bookUid: 'id:1', changes: [change] }, ended: false }]]);
  assert.equal(hasPendingCorrections(state, sessions), false);
  sessions.get('live').snapshot.changes[0] = { ...change, proposedText: 'נוסח חדש' };
  assert.equal(hasPendingCorrections(state, sessions), true);
});
test('QA visibility: resetting inherited old wording never hides an independent newer proposal', () => {
  const change = { sectionIndex: 0, originalSourceText: 'אב', originalText: 'אב', proposedText: 'הצעה חדשה' };
  const pending = { ...change, key: changeKey('id:1', change), sessionId: 'later', version: 5 };
  const book = { bookUid: 'id:1', pending: [pending], resolutions: new Map(), inherited: new Map([['old-reset', new Map([[0, 3]])]]) };
  const state = { books: new Map([['id:1', book]]) };
  const sessions = new Map([['old-reset', { snapshot: { sessionId: 'old-reset', bookUid: 'id:1', changes: [] }, ended: false }]]);
  assert.equal(hasPendingCorrections(state, sessions), true);
  book.pending[0] = { ...pending, version: 2 };
  assert.equal(hasPendingCorrections(state, sessions), false, 'the actually inherited older wording is suppressed');
});
test('QA visibility: pending drafts in another live instance remain visible without reader marks', () => {
  const empty = { books: new Map() };
  assert.equal(hasPendingCorrections(empty, new Map(), new Map([['d', { changeCount: 1 }]])), true);
  assert.equal(hasPendingCorrections(empty, new Map(), new Map([['d', { changeCount: 0 }]])), false);
});
test('QA visibility: an older snapshot of the same session cannot hide a newer durable proposal', () => {
  const change = { sectionIndex: 0, originalSourceText: 'אב', originalText: 'אב', proposedText: 'נוסח חדש שנשמר' };
  const pending = { ...change, key: changeKey('id:1', change), sessionId: 'live', draftId: 'draft', version: 5 };
  const book = { bookUid: 'id:1', pending: [pending], resolutions: new Map(), inherited: new Map(),
    entries: [{ sessionId: 'live', draftId: 'draft', version: 5, revision: 2, changes: [change] }] };
  const state = { books: new Map([['id:1', book]]) };
  const sessions = new Map([['live', { snapshot: { sessionId: 'live', bookUid: 'id:1', revision: 1,
    draft: { version: 3, persisted: true }, changes: [] }, ended: false }]]);
  assert.equal(hasPendingCorrections(state, sessions), true, 'another instance has a newer persisted version');
  sessions.get('live').snapshot.revision = 3;
  sessions.get('live').snapshot.draft = { version: null, persisted: false };
  assert.equal(hasPendingCorrections(state, sessions), false, 'a newer reader reset may suppress its own older proposal');
});
