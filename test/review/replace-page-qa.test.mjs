import test from 'node:test';
import assert from 'node:assert/strict';
import { plugin, waitFor, editInReader, clickWhenReady, createFakeOtzaria, createStorage } from './page-harness.mjs';

const input = (page, id, value, event = 'input') => {
  page.el(id).value = value;
  for (const handler of page.el(id).handlers[event] ?? []) handler({ target: page.el(id) });
};
async function preview({ confirm = true } = {}) {
  const host = createFakeOtzaria({ books: { 'id:1': { bookId: 'ספר QA', lines: ['אב אב', 'שמור', 'אב'] } } }), storage = createStorage();
  const page = await plugin({ host, storage, confirm: args => typeof confirm === 'function' ? confirm(args, host) : confirm });
  const session = await editInReader(page, host, [[1, 'שמור חדש']]);
  await clickWhenReady(page, 'live-list', 'חיפוש והחלפה');
  await waitFor(() => !page.el('screen-replace').hidden, 'replacement screen visible');
  input(page, 'replace-query', 'אב');
  input(page, 'replace-with', 'אם');
  page.el('replace-whole-words').checked = true;
  page.el('replace-preview').click();
  await waitFor(() => /3 התאמות/.test(page.el('replace-summary').textContent) && !page.el('replace-apply').disabled, 'preview ready');
  return { page, host, session, storage };
}
test('QA replacement page: declining confirmation changes neither reader drafts nor book submissions', async () => {
  const { page, host, session } = await preview({ confirm: false });
  page.el('replace-apply').click();
  await waitFor(() => host.confirms?.includes('החלפת כל ההתאמות') && !page.el('replace-query').disabled, 'decline handled');
  assert.deepEqual(host.sessions.get(session.sessionId).changes.map(c => c.proposedText), ['שמור חדש']);
  assert.equal(page.rpcCalls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
  assert.equal(host.submissions.size, 0);
});
test('QA replacement page: confirmed bulk replacement uses one restore and preserves unrelated reader edits', async () => {
  const { page, host, session } = await preview();
  page.el('replace-apply').click();
  await waitFor(() => /3 החלפות הוחלו/.test(page.el('status').textContent) && !page.el('replace-query').disabled, 'replacement applied');
  assert.deepEqual(host.sessions.get(session.sessionId).changes.map(c => c.proposedText), ['אם אם', 'שמור חדש', 'אם']);
  assert.equal(page.rpcCalls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 1);
  assert.deepEqual(host.books['id:1'].lines, ['אב אב', 'שמור', 'אב']);
  assert.equal(page.rpcCalls.filter(c => c.method.startsWith('feedback.')).length, 0);
});
test('QA replacement page: editing replacement fields invalidates the preview before application', async () => {
  const { page } = await preview();
  input(page, 'replace-with', 'מילה אחרת');
  assert.equal(page.el('replace-apply').disabled, true);
  assert.equal(page.el('replace-results').children.length, 0);
  assert.equal(page.rpcCalls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
});
test('QA replacement page: a reader edit during the confirmation prevents overwriting that edit', async () => {
  const { page, host, session } = await preview({ confirm: (args, native) => {
    if (args.title === 'החלפת כל ההתאמות') {
      const live = [...native.sessions.values()].find(s => !s.ended);
      native.edit(live.sessionId, 0, 'הקלדה בזמן האישור');
    }
    return true;
  } });
  page.el('replace-apply').click();
  await waitFor(() => /השתנה/.test(page.el('status').textContent) && !page.el('replace-query').disabled, 'revision conflict shown');
  assert.equal(page.rpcCalls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
  assert.equal(host.sessions.get(session.sessionId).changes[0].proposedText, 'הקלדה בזמן האישור');
  assert.equal(host.submissions.size, 0);
});
