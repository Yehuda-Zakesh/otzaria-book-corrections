import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStorage, decodeStoredDraft } from '../plugin/draft-storage.js';

function fixture(initial = []) {
  const data = new Map(initial.map(([key, value]) => [key, structuredClone(value)]));
  const calls = [];
  let sequence = 0, failure;
  const call = async (method, args) => {
    calls.push({ method, ...structuredClone(args) });
    if (failure?.(method, args)) throw new Error('Injected storage failure');
    if (method === 'storage.get') return structuredClone(data.get(args.key));
    if (method === 'storage.set') data.set(args.key, structuredClone(args.value));
    if (method === 'storage.remove') data.delete(args.key);
  };
  return { data, calls, call, storage: createDraftStorage(call, () => String(++sequence)),
    fail: predicate => { failure = predicate; } };
}
function session(id = 'one', text = 'פתיחה 😀\nסיום') {
  return { id, book: { id, title: id, originalText: text,
    sections: [{ id: 'section', start: 0, end: text.length, text }] },
  editedText: text, reportedText: text, scrollTop: 30 };
}
const workspace = sessions => ({ schemaVersion: 2, sessions, activeSessionId: sessions[0]?.id });

test('sparse corrections at opposite ends of a million-character book store a small draft', async () => {
  const originalText = ('פסקה מקורית של הספר עם מילים רבות\n').repeat(32000);
  assert.ok(originalText.length >= 1_000_000);
  const item = session('large', originalText), f = fixture();
  item.editedText = 'תיקון ראשון\n' + originalText.slice(0, -1) + '\nתיקון אחרון';
  await f.storage.write(workspace([item]));
  const ref = f.data.get('book-session').sessions[0], draft = f.data.get(ref.draftKey);
  assert.ok(Array.isArray(draft.editedPatch));
  assert.ok(Buffer.byteLength(JSON.stringify(draft), 'utf8') < 1024);
  assert.equal((await f.storage.read()).sessions[0].editedText, item.editedText);
});

test('empty patch arrays reconstruct unchanged text and legacy object patches remain readable', () => {
  const item = session();
  const unchanged = decodeStoredDraft(item.book, { editedPatch: [], reportedPatch: [] });
  assert.equal(unchanged.editedText, item.book.originalText);
  assert.equal(unchanged.reportedText, item.book.originalText);
  const legacy = decodeStoredDraft(item.book, { editedPatch: { start: 0, end: 0, text: 'חדש ' } });
  assert.equal(legacy.editedText, 'חדש ' + item.book.originalText);
});

test('overlapping, unordered, and out-of-bounds sparse patches are rejected', () => {
  const item = session();
  for (const editedPatch of [
    [{ start: 0, end: 3, text: '' }, { start: 2, end: 4, text: 'x' }],
    [{ start: 3, end: 4, text: '' }, { start: 0, end: 1, text: 'x' }],
    [{ start: 0, end: item.book.originalText.length + 1, text: '' }],
    [{ start: -1, end: 0, text: '' }],
    [{ start: 0.5, end: 1, text: '' }],
    [{ start: 2, end: 1, text: '' }],
    [{ start: 0, end: 1, text: null }],
    [null],
  ]) assert.throws(() => decodeStoredDraft(item.book, { editedPatch }));
});

test('patches reconstruct Unicode, insertions, deletions, and independently reported text', async () => {
  for (const editedText of ['', 'פתיחה 😁\nסיום', 'חדש פתיחה 😀\nסיום', 'פתיחה 😀\nסיום חדש']) {
    const f = fixture(), item = session();
    item.editedText = editedText;
    item.reportedText = 'דווח 🕎';
    await f.storage.write(workspace([item]));
    const restored = await createDraftStorage(f.call, () => 'unused').read();
    assert.deepEqual(restored.sessions, [item]);
    const ref = f.data.get('book-session').sessions[0];
    assert.equal(f.data.get(ref.bookKey).sections[0].text, undefined);
    assert.equal(f.data.get(ref.draftKey).editedText, undefined);
    assert.equal(f.data.get(ref.draftKey).book, undefined);
  }
});

test('only changed sessions get new drafts and original source is written once', async () => {
  const f = fixture(), one = session(), two = session('two');
  await f.storage.write(workspace([one, two]));
  const before = structuredClone(f.data.get('book-session'));
  f.calls.length = 0;
  one.editedText += '!';
  await f.storage.write(workspace([one, two]));
  const writes = f.calls.filter(c => c.method === 'storage.set');
  assert.deepEqual(writes.map(c => c.key.split(':')[0]), ['book-draft', 'book-session']);
  const after = f.data.get('book-session');
  assert.equal(after.sessions[0].bookKey, before.sessions[0].bookKey);
  assert.notEqual(after.sessions[0].draftKey, before.sessions[0].draftKey);
  assert.deepEqual(after.sessions[1], before.sessions[1]);
  f.calls.length = 0;
  await f.storage.write(workspace([one, two]));
  assert.deepEqual(f.calls.filter(c => c.method === 'storage.set').map(c => c.key), ['book-session']);
});

test('a restarted storage instance reuses restored source and unchanged draft records', async () => {
  const f = fixture();
  await f.storage.write(workspace([session()]));
  const restarted = createDraftStorage(f.call, () => 'restart');
  const restored = await restarted.read();
  f.calls.length = 0;
  await restarted.write(restored);
  assert.deepEqual(f.calls.filter(c => c.method === 'storage.set').map(c => c.key), ['book-session']);
  restored.sessions[0].editedText += '!';
  f.calls.length = 0;
  await restarted.write(restored);
  assert.deepEqual(f.calls.filter(c => c.method === 'storage.set').map(c => c.key), ['book-draft:restart', 'book-session']);
});

for (const stage of ['draft', 'index']) {
  test(`failed ${stage} write leaves committed snapshot readable and retry succeeds`, async () => {
    const f = fixture(), item = session();
    await f.storage.write(workspace([item]));
    const before = structuredClone(f.data.get('book-session'));
    item.editedText += ' תיקון';
    f.fail((method, { key }) => method === 'storage.set' &&
      (stage === 'index' ? key === 'book-session' : key.startsWith('book-draft:')));
    await assert.rejects(f.storage.write(workspace([item])), /Injected/);
    assert.deepEqual(f.data.get('book-session'), before);
    const restored = await createDraftStorage(f.call, () => 'unused').read();
    assert.equal(restored.sessions[0].editedText, item.book.originalText);
    f.fail(undefined);
    await f.storage.write(workspace([item]));
    assert.equal((await f.storage.read()).sessions[0].editedText, item.editedText);
    const refs = f.data.get('book-session').sessions;
    assert.deepEqual([...f.data.keys()].sort(), ['book-session', ...refs.flatMap(r => [r.bookKey, r.draftKey])].sort());
  });
}

test('legacy workspace remains readable and migration commits only after successful index write', async () => {
  const legacy = workspace([session()]), f = fixture([['book-session', legacy]]);
  assert.deepEqual(await f.storage.read(), legacy);
  f.fail((method, { key }) => method === 'storage.set' && key === 'book-session');
  await assert.rejects(f.storage.write(legacy), /Injected/);
  assert.deepEqual(f.data.get('book-session'), legacy);
  f.fail(undefined);
  await f.storage.write(legacy);
  assert.equal(f.data.get('book-session').schemaVersion, 3);
  assert.deepEqual(await f.storage.read(), legacy);
});

test('cleanup failures are retried without failing a committed save', async () => {
  const f = fixture(), item = session();
  await f.storage.write(workspace([item]));
  const obsolete = f.data.get('book-session').sessions[0].draftKey;
  item.editedText += '!';
  f.fail((method, { key }) => method === 'storage.remove' && key === obsolete);
  await f.storage.write(workspace([item]));
  assert.ok(f.data.has(obsolete));
  assert.equal((await f.storage.read()).sessions[0].editedText, item.editedText);
  f.fail(undefined);
  await f.storage.write(workspace([item]));
  assert.equal(f.data.has(obsolete), false);
  await f.storage.write(null);
  assert.equal(f.data.size, 0);
});

test('invalid patches and missing referenced records reject without deleting stored data', async () => {
  const item = session();
  assert.throws(() => decodeStoredDraft(item.book, { editedPatch: { start: -1, end: 0, text: '' } }));
  const f = fixture();
  await f.storage.write(workspace([item]));
  f.data.delete(f.data.get('book-session').sessions[0].draftKey);
  const before = structuredClone([...f.data]);
  await assert.rejects(createDraftStorage(f.call, () => 'unused').read());
  assert.deepEqual([...f.data], before);
});
