import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCorrection, createPersonalHistory } from '../plugin/personal-history.js';
test('out of bounds source ranges cannot prove a correction', () => {
  const submission = { snapshots: [{ index: 0, text: 'abc' }], sourceStart: 0, sourceEnd: 99, original: 'abc', proposed: 'x' };
  assert.equal(classifyCorrection({ submission }, ['x']), 'changed');
  assert.equal(classifyCorrection({ submission: { ...submission, sourceStart: -1, sourceEnd: 0, original: '' } }, ['abxabc']), 'changed');
  assert.equal(classifyCorrection(null, []), 'changed');
});
test('multiple independent edits before and after a correction retain original offsets', () => {
  const submission = { snapshots: [{ index: 0, text: 'alpha typo omega' }], sourceStart: 6, sourceEnd: 10, original: 'typo', proposed: 'fix' };
  assert.equal(classifyCorrection({ submission }, ['ALPHA fix OMEGA']), 'present');
  assert.equal(classifyCorrection({ submission }, ['ALPHA typo fix']), 'changed');
  assert.equal(classifyCorrection({ submission: { ...submission, proposed: 'correct' } }, ['ALPHA correct omega appended']), 'present');
});
test('concurrent archive and scan cannot replace the checked status with unchecked', async () => {
  const store = new Map();
  let releaseRead;
  const held = new Promise(resolve => { releaseRead = resolve; });
  const call = async (method, args = {}) => {
    if (method === 'storage.list') return [...store.keys()];
    if (method === 'storage.get') { const value = structuredClone(store.get(args.key)); await held; return value; }
    if (method === 'storage.set') store.set(args.key, structuredClone(args.value));
  };
  const history = createPersonalHistory(call);
  const book = { identity: { bookUid: 'one' }, details: { title: 'Book' } };
  const item = { submission: { reportId: 'one', snapshots: [{ index: 0, text: 'bad' }], sourceStart: 0, sourceEnd: 3, original: 'bad', proposed: 'good' }, payload: {} };
  const saving = history.save(book, item);
  await Promise.resolve(); await Promise.resolve();
  const scanning = history.check({ id: 'one', identity: book.identity, submission: item.submission }, ['good']);
  releaseRead();
  await Promise.all([saving, scanning]);
  assert.equal(store.get('correction-status:one').status, 'present');
  await history.checkUnavailable(store.get('correction-history:one'));
  assert.equal((await history.list())[0].status, 'unavailable');
  assert.ok((await history.list())[0].checkedAt);
});
test('a late archive from another reader cannot overwrite scan results', async () => {
  const store = new Map();
  let releaseRead, readStarted;
  const held = new Promise(resolve => { releaseRead = resolve; });
  const started = new Promise(resolve => { readStarted = resolve; });
  let holdArchiveRead = true;
  const call = async (method, args = {}) => {
    if (method === 'storage.list') return [...store.keys()];
    if (method === 'storage.get') {
      const value = structuredClone(store.get(args.key));
      if (holdArchiveRead && args.key === 'correction-history:cross-view') {
        holdArchiveRead = false; readStarted(); await held;
      }
      return value;
    }
    if (method === 'storage.set') store.set(args.key, structuredClone(args.value));
  };
  const archiver = createPersonalHistory(call), scanner = createPersonalHistory(call);
  const book = { identity: { bookUid: 'book' }, details: { title: 'Book' } };
  const item = { submission: { reportId: 'cross-view', snapshots: [{ index: 0, text: 'bad' }], sourceStart: 0, sourceEnd: 3, original: 'bad', proposed: 'good' }, payload: {} };
  const saving = archiver.save(book, item);
  await started;
  await scanner.check({ id: 'cross-view', identity: book.identity, submission: item.submission }, ['good']);
  releaseRead(); await saving;
  assert.equal((await scanner.list())[0].status, 'present');
  assert.equal(store.get('correction-history:cross-view').status, 'unchecked');
  assert.equal(store.get('correction-status:cross-view').status, 'present');
});
test('legacy archived scan status remains available until a new scan replaces it', async () => {
  const archived = { id: 'legacy', identity: { bookUid: 'book' }, submission: {}, status: 'present', checkedAt: 123 };
  const store = new Map([['correction-history:legacy', archived], ['correction-history:broken', { submission: {} }]]);
  const call = async (method, args = {}) => {
    if (method === 'storage.list') return [...store.keys()];
    if (method === 'storage.get') return structuredClone(store.get(args.key));
    if (method === 'storage.set') store.set(args.key, structuredClone(args.value));
  };
  const history = createPersonalHistory(call);
  assert.deepEqual(await history.list(), [archived]);
  await history.checkUnavailable(archived);
  assert.equal((await history.list())[0].status, 'unavailable');
  assert.equal(store.get('correction-history:legacy').status, 'present');
});
test('repeated personal-area openings and persistence archive each stable report only once across views', async () => {
  const store = new Map();
  const call = async (method, args = {}) => {
    if (method === 'storage.list') return [...store.keys()];
    if (method === 'storage.get') return structuredClone(store.get(args.key));
    if (method === 'storage.set') store.set(args.key, structuredClone(args.value));
  };
  const firstView = createPersonalHistory(call), secondView = createPersonalHistory(call);
  const book = { identity: { bookUid: 'same-book' }, details: { title: 'Book' } };
  const item = { submission: { reportId: 'stable-report', snapshots: [{ index: 0, text: 'bad' }], sourceStart: 0, sourceEnd: 3, original: 'bad', proposed: 'good' }, payload: {}, sentAt: 123 };
  await firstView.save(book, item); // Persisting a successfully sent report.
  await firstView.save(book, item); // Opening the personal area archives it again.
  const initial = await firstView.list();
  assert.equal(initial.length, 1);
  await secondView.check(initial[0], ['good']);
  for (let opening = 0; opening < 3; opening++) {
    await Promise.all([firstView.save(book, item), secondView.save(book, structuredClone(item))]);
    for (const view of [firstView, secondView]) {
      const listed = await view.list();
      assert.equal(listed.length, 1, 'reopening cannot duplicate the report');
      assert.equal(listed[0].id, 'stable-report');
      assert.equal(listed[0].status, 'present', 'archiving cannot reset a scan result');
      assert.equal(listed[0].sentAt, 123);
    }
  }
  assert.deepEqual([...store.keys()].sort(), ['correction-history:stable-report', 'correction-status:stable-report']);
});
const record = { submission: { snapshots: [{ index: 1, text: 'לפני טעות אחרי' }], sourceStart: 5, sourceEnd: 9, original: 'טעות', proposed: 'תיקון' } };
test('local correction scan distinguishes original, exact proposal and unrelated changes', () => {
  assert.equal(classifyCorrection(record, ['', 'לפני טעות אחרי']), 'unchanged');
  assert.equal(classifyCorrection(record, ['', 'לפני תיקון אחרי']), 'present');
  assert.equal(classifyCorrection(record, ['', 'טקסט אחר עם תיקון']), 'changed');
  assert.equal(classifyCorrection(record, ['לפני תיקון אחרי']), 'changed');
});
test('deletion and insertion require the full expected paragraph including context', () => {
  assert.equal(classifyCorrection({ submission: { ...record.submission, proposed: '' } }, ['', 'לפני  אחרי']), 'present');
  const insertion = { submission: { ...record.submission, sourceEnd: 5, original: '', proposed: 'חדש ' } };
  assert.equal(classifyCorrection(insertion, ['', 'לפני חדש טעות אחרי']), 'present');
});
test('ambiguous free text and invalid source ranges never count as applied', () => {
  assert.equal(classifyCorrection({ submission: { ...record.submission, sourceStart: undefined } }, ['', 'לפני תיקון אחרי']), 'changed');
  assert.equal(classifyCorrection({ submission: { ...record.submission, snapshots: [{ index: 0, text: 'א' }, { index: 1, text: 'ב' }] } }, ['ג', 'ד']), 'changed');
});
test('independent corrections elsewhere in the paragraph do not mask an exact applied edit', () => {
  assert.equal(classifyCorrection(record, ['', 'לפני תיקון אחרי תוספת']), 'present');
  assert.equal(classifyCorrection({ submission: { ...record.submission, proposed: '' } }, ['', 'נוסח אחר']), 'changed', 'an unrelated rewrite cannot prove a deletion');
});
test('sent history survives removed drafts and repeated archival preserves check results', async () => {
  const store = new Map();
  const call = async (method, args = {}) => {
    if (method === 'storage.list') return [...store.keys()];
    if (method === 'storage.get') return structuredClone(store.get(args.key));
    if (method === 'storage.set') store.set(args.key, structuredClone(args.value));
  };
  const history = createPersonalHistory(call), book = { identity: { bookId: 'ספר', bookUid: 'id:1' }, details: { title: 'ספר' } };
  const item = { submission: { ...record.submission, reportId: 'one' }, payload: { current_ref: 'פרק א' }, sentAt: 123 };
  await history.save(book, item);
  const saved = (await history.list())[0];
  await history.check(saved, ['', 'לפני תיקון אחרי']);
  await history.save(book, item);
  assert.equal((await history.list()).length, 1);
  assert.equal((await history.list())[0].status, 'present');
  assert.equal((await history.list())[0].sentAt, 123);
});
