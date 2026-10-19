import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStorage } from '../plugin/draft-storage.js';
import { readLegacyDrafts, readLegacyHistory, legacyParagraphChanges } from '../plugin/legacy-drafts.js';
import { createStorage } from './fake-otzaria.mjs';

function legacyBook(lines, identity = { bookId: 'ספר', bookUid: 'id:1' }) {
  let start = 0;
  const sections = lines.map((text, index) => { const section = { index, start, end: start + text.length, text }; start += text.length + 1; return section; });
  return { identity, details: { title: identity.bookId, source: 'library', type: 'text', id: 1 }, originalText: lines.join('\n'), sections };
}
// Writes the exact 0.2.2 schema-3 workspace with the 0.2.2 storage module.
async function writeLegacy(storage, key, sessions) {
  let id = 0;
  const legacy = createDraftStorage(storage.call, () => `${key}-${++id}`, { indexKey: key });
  await legacy.write({ schemaVersion: 2, activeId: sessions[0].id, libraryTabs: [], sessions });
}

test('0.2.2 drafts are decoded read-only, deduplicated and mapped per paragraph', async () => {
  const storage = createStorage();
  const book = legacyBook(['אלף בית', 'גימל דלת', 'הא וו']);
  const edited = book.originalText.replace('בית', 'ביתא').replace('גימל דלת\nהא', 'גימל\nדלת הא');
  await writeLegacy(storage, 'book-session', [{ id: 'a', book, editedText: edited, queue: null, completed: false }]);
  await writeLegacy(storage, 'draft-preview:x', [{ id: 'a', book, editedText: edited, queue: null, completed: false }]);
  const before = structuredClone([...storage.data]);
  const { drafts, failures } = await readLegacyDrafts(storage.call);
  assert.deepEqual(failures, []);
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0].keys, ['book-session', 'draft-preview:x']);
  assert.deepEqual(drafts[0].mapped.map(change => [change.sectionIndex, change.proposedText]), [[0, 'אלף ביתא']]);
  assert.equal(drafts[0].unmappable.length, 1);
  assert.equal(drafts[0].unmappable[0].reason, 'paragraph_boundaries');
  assert.deepEqual([...storage.data], before, 'reading wrote or removed nothing');
});

test('legacy queues keep report IDs and sent statuses; edits behind a queue are not re-derived', async () => {
  const storage = createStorage();
  const book = legacyBook(['אלף', 'בית']);
  const queue = [
    { payload: { report_id: 'old-1', report_kind: 'text_correction' }, submission: { reportId: 'old-1', sectionIndex: 0, original: 'אלף', proposed: 'אלפ' }, sent: true, sentAt: 5, correctionSupported: true },
    { payload: { report_id: 'old-2', report_kind: 'free_text', location: { line_index: 1 } }, sent: false }
  ];
  await writeLegacy(storage, 'reader-session:id%3A1:z', [{ id: 'r', book, editedText: 'אלפ\nבית!', queue, completed: false }]);
  const [draft] = (await readLegacyDrafts(storage.call)).drafts;
  assert.deepEqual(draft.queue.map(item => [item.reportId, item.sent, item.submission ? 'with' : 'without']),
    [['old-1', true, 'with'], ['old-2', false, 'without']]);
  assert.deepEqual(draft.mapped, []);
});

test('unsupported proposals stay unmappable; reported text is excluded', () => {
  const book = legacyBook(['a b', 'c']);
  const item = { book, reportedText: 'a B\nc', editedText: 'a B\nc <i>' };
  const result = legacyParagraphChanges(item);
  assert.deepEqual(result.mapped, []);
  assert.deepEqual(result.unmappable.map(change => change.reason), ['unsupported_text']);
});

test('a corrupt legacy draft is reported, not dropped or rewritten', async () => {
  const storage = createStorage();
  storage.data.set('book-session', { schemaVersion: 3, sessions: [{ id: 'q', bookKey: 'book-source:missing', draftKey: 'book-draft:missing' }] });
  const result = await readLegacyDrafts(storage.call);
  assert.equal(result.failures.length, 1);
  assert.ok(storage.data.has('book-session'));
});

test('legacy history is listed newest first', async () => {
  const storage = createStorage();
  storage.data.set('correction-history:a', { id: 'a', sentAt: 1, submission: {}, identity: {} });
  storage.data.set('correction-history:b', { id: 'b', sentAt: 2, submission: {}, identity: {} });
  assert.deepEqual((await readLegacyHistory(storage.call)).map(item => item.id), ['b', 'a']);
});
