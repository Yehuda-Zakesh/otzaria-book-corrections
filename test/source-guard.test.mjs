import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBook } from '../plugin/book.js';
import { createSourceGuard } from '../plugin/source-guard.js';

async function fixture() {
  const state = { raw: 'first\nsecond\nthird\nlast', maps: ['first', 'second', 'third', 'last'], loads: 0, fail: false, hold: null };
  const call = async (method, args) => {
    if (method === 'library.getBookDetails') {
      state.loads++;
      if (state.fail) throw new Error('network unavailable');
      if (state.hold) await state.hold;
      return { type: 'text', source: 'library', lineCount: state.maps.length };
    }
    if (method === 'library.getBookContent') return state.raw.slice(args.offset, args.offset + args.limit);
    if (method === 'reader.getSectionTextMap') return { sourceText: state.maps[args.sectionIndex] };
    throw new Error(method);
  };
  const book = await loadBook(call, { bookId: 'test' });
  state.loads = 0;
  return { state, book, guard: createSourceGuard(call) };
}

test('unchanged source passes and later checks read fresh content', async () => {
  const { state, book, guard } = await fixture();
  await guard.check(book);
  state.raw = 'first\nSECOND\nthird\nlast';
  state.maps[1] = 'SECOND';
  await assert.rejects(guard.check(book), /מקור הספר השתנה/);
  assert.equal(state.loads, 2);
});

test('targeted maps detect internal section shifts with identical content and count', async () => {
  const { state, book, guard } = await fixture();
  state.maps[1] = 'second\nthird';
  state.maps[2] = '';
  await guard.check(book);
  await assert.rejects(guard.check(book, [1, 2]), /מקור הספר השתנה/);
});

test('section count changes block submission', async () => {
  const { state, book, guard } = await fixture();
  state.maps = ['first\nsecond', 'third', 'last'];
  await assert.rejects(guard.check(book), /מקור הספר השתנה/);
});

test('silent restoration failures do not poison a later retry', async () => {
  const { state, book, guard } = await fixture();
  state.fail = true;
  await guard.restore(book);
  await assert.rejects(guard.check(book), /network unavailable/);
  state.fail = false;
  await guard.check(book);
  assert.equal(state.loads, 3);
});

test('concurrent checks share full loading but each validates its requested sections', async () => {
  const { state, book, guard } = await fixture();
  let release;
  state.hold = new Promise(resolve => { release = resolve; });
  state.maps[1] = 'shifted';
  const first = guard.check(book);
  const second = guard.check(book, [1]);
  const rejected = assert.rejects(second, /מקור הספר השתנה/);
  release();
  await Promise.all([first, rejected]);
  assert.equal(state.loads, 1);
});

test('restoration loads books sequentially while submission bypasses queued books', async () => {
  const { state, book, guard } = await fixture();
  const other = { ...book };
  let release;
  state.hold = new Promise(resolve => { release = resolve; });
  const restored = guard.restore(book);
  const queued = guard.restore(other);
  await Promise.resolve();
  assert.equal(state.loads, 1);
  const submitted = guard.check(other);
  assert.equal(state.loads, 2);
  release();
  await Promise.all([restored, queued, submitted]);
});
