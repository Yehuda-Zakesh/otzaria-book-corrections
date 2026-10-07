import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortLibraryTree } from '../plugin/library-order.js';

test('library order follows Otzaria root priorities and nested category/book metadata', () => {
  const tree = { categories: [
    { title: 'ספרות עזר', order: 0 }, { title: 'חסידות', order: 1 },
    { title: 'תנ״ך', order: 900, categories: [
      { title: 'שלילי', order: -1 }, { title: 'אחרון', order: 30 }, { title: 'ראשון', order: 2 }
    ], books: [{ title: 'ב', order: 10 }, { title: 'ג', order: 999 }, { title: 'א', order: -2 }] },
    { title: 'שו״ת', order: 0 }, { title: 'אישי', order: 999 }
  ] };
  const snapshot = structuredClone(tree), sorted = sortLibraryTree(tree);
  assert.deepEqual(sorted.categories.map(c => c.title), ['תנ״ך', 'שו״ת', 'חסידות', 'ספרות עזר', 'אישי']);
  assert.deepEqual(sorted.categories[0].categories.map(c => c.title), ['ראשון', 'אחרון', 'שלילי']);
  assert.deepEqual(sorted.categories[0].books.map(b => b.title), ['א', 'ב', 'ג']);
  assert.deepEqual(tree, snapshot, 'sorting must not modify the SDK response');
});

test('older hosts retain unknown metadata order while known root categories are sorted', () => {
  const tree = { categories: [{ title: 'חסידות' }, { title: 'משנה' }, { title: 'תנ"ך' }, { title: 'אחר א' }, { title: 'אחר ב' }] };
  assert.deepEqual(sortLibraryTree(tree).categories.map(c => c.title), ['תנ"ך', 'משנה', 'חסידות', 'אחר א', 'אחר ב']);
  assert.equal(sortLibraryTree(null), null);
});
