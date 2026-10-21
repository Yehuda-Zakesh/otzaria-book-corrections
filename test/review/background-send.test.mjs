import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionController } from '../../plugin/correction-sessions.js';
import { plugin, waitFor, editInReader, clickWhenReady, createFakeOtzaria, createStorage, createCorrectionStore } from './page-harness.mjs';

const background = { app: { runMode: 'background' } };
async function seed(host, storage, bookUid = 'id:1') {
  const call = host.instance(storage), store = createCorrectionStore(call);
  const controller = createSessionController({ call, store });
  const session = await controller.begin(host.openTab(bookUid));
  host.edit(session.sessionId, 0, `${host.books[bookUid].lines[0]} תיקון QA`);
  await controller.end(session.sessionId);
  return store;
}
const send = (page, payload, context = false) => page.emit(context ? 'contextMenu.itemClicked' : 'reader.toolbar_item_clicked', { itemId: 'send-book-corrections', ...payload });

test('QA: closed-plugin send arriving before boot confirms once, submits once and stays in reader', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const store = await seed(host, storage);
  const page = await plugin({ host, storage, boot: background, autoBoot: false });
  send(page, { bookUid: 'id:1' });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(page.rpcCalls, [], 'no RPC is attempted before plugin.boot');
  page.start();
  await waitFor(() => host.shownMessages?.some(text => /נשלחו דרך אוצריא/.test(text)), 'background delivery summary');
  assert.equal(host.submissions.size, 1);
  assert.deepEqual(host.confirms, ['שליחת תיקוני הספר']);
  assert.equal(host.activations ?? 0, 0);
  assert.equal((await store.load()).books.get('id:1').pending.length, 0);
  assert.equal(page.rpcCalls.filter(({ method }) => method === 'feedback.submitBookCorrection').length, 1);
});

test('QA: refusal from reader context menu keeps the proposal and sends nothing', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const store = await seed(host, storage);
  const page = await plugin({ host, storage, boot: background, confirm: false });
  send(page, { selection: { bookUid: 'id:1' } }, true);
  await waitFor(() => host.confirms?.length === 1 && !page.el('refresh').disabled, 'refusal completed');
  assert.equal(host.submissions.size, 0);
  assert.equal((await store.load()).books.get('id:1').pending.length, 1);
  assert.equal(page.rpcCalls.filter(({ method }) => method === 'feedback.submitBookCorrection').length, 0);
});

test('QA: currentId selects the right book even when two books have the same title', async () => {
  const host = createFakeOtzaria({ books: {
    'id:1': { bookId: 'אותו שם', lines: ['ראשון'] },
    'id:2': { bookId: 'אותו שם', lines: ['שני'] }
  } }), storage = createStorage();
  const store = await seed(host, storage, 'id:1');
  await seed(host, storage, 'id:2');
  const page = await plugin({ host, storage, boot: background });
  send(page, { currentId: 2, currentBook: 'אותו שם' });
  await waitFor(() => host.shownMessages?.some(text => /נשלחו דרך אוצריא/.test(text)), 'second book sent');
  assert.equal(host.submissions.size, 1);
  assert.equal([...host.submissions.values()][0].params.bookUid, 'id:2');
  const books = (await store.load()).books;
  assert.equal(books.get('id:1').pending.length, 1);
  assert.equal(books.get('id:2').pending.length, 0);
});

test('QA: a live draft not yet saved by Otzaria blocks background submission', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const page = await plugin({ host, storage, boot: background });
  const session = await editInReader(page, host, [[0, 'שינוי שמור']]);
  host.persist = false;
  host.edit(session.sessionId, 0, 'שינוי אחרון שטרם נשמר');
  page.emit('reader.correctionSessionChanged', { sessionId: session.sessionId });
  send(page, { currentId: 1 });
  await waitFor(() => host.shownErrors?.some(text => /שמירת התיקונים עדיין לא הושלמה/.test(text)), 'save refusal shown in host');
  assert.equal(host.submissions.size, 0);
  assert.equal(host.confirms?.length ?? 0, 0, 'does not offer to send stale content');
  assert.equal(host.sessions.get(session.sessionId).changes[0].proposedText, 'שינוי אחרון שטרם נשמר');
});

test('QA: an unknown book never submits another book with the same title', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  await seed(host, storage);
  const page = await plugin({ host, storage, boot: background });
  send(page, { currentId: 999, currentBook: 'ספר' });
  await waitFor(() => host.shownMessages?.some(text => /אין תיקונים ממתינים/.test(text)), 'unknown book notice');
  assert.equal(host.submissions.size, 0);
  assert.equal(host.confirms?.length ?? 0, 0);
});

test('QA: ending from the page removes the successfully saved live-session card', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const page = await plugin({ host, storage });
  await editInReader(page, host, [[0, 'תיקון לסיום']]);
  await clickWhenReady(page, 'live-list', 'סיום עריכה');
  await waitFor(() => /העריכה הסתיימה והתיקונים נקלטו/.test(page.el('status').textContent), 'ended and saved');
  await waitFor(() => !/ממתין לשמירה|פסקאות מתוקנות/.test(page.el('live-list').allText), 'saved session card cleared');
  assert.match(page.el('book-list').allText, /תיקון לסיום/);
});

test('QA: plugin storage failure prevents submission and preserves the native draft', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const page = await plugin({ host, storage, boot: background });
  const session = await editInReader(page, host, [[0, 'טיוטה שלא נשלחה']]);
  await waitFor(() => /פסקאות מתוקנות/.test(page.el('live-list').allText), 'live snapshot loaded');
  storage.failSet = true;
  send(page, { bookUid: 'id:1' });
  await waitFor(() => host.shownErrors?.length, 'storage error surfaced to reader');
  assert.equal(host.submissions.size, 0);
  assert.equal(host.confirms?.length ?? 0, 0);
  assert.equal(host.drafts.get('d-id:1').changes[0].proposedText, 'טיוטה שלא נשלחה');
  assert.equal(host.sessions.get(session.sessionId).changes[0].proposedText, 'טיוטה שלא נשלחה');
  storage.failSet = false;
});

test('QA: ambiguous title without a numeric identity refuses to guess a book', async () => {
  const host = createFakeOtzaria({ books: {
    'id:1': { bookId: 'אותו שם', lines: ['ראשון'] },
    'id:2': { bookId: 'אותו שם', lines: ['שני'] }
  } }), storage = createStorage();
  await seed(host, storage, 'id:1');
  await seed(host, storage, 'id:2');
  const page = await plugin({ host, storage, boot: background });
  send(page, { currentBook: 'אותו שם' });
  await waitFor(() => host.shownErrors?.some(text => /לא זוהה הספר/.test(text)), 'ambiguous identity reported');
  assert.equal(host.submissions.size, 0);
  assert.equal(host.confirms?.length ?? 0, 0);
});
