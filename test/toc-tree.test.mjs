import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTocTree, flattenTocTree, activeTocKey, ensurePathExpanded, setAllExpanded } from '../plugin/toc-tree.js';

const entries = [
  { text: 'ספר ראשון', index: 0, level: 1 },
  { text: 'בְּרֵאשִׁית', index: 2, level: 2 },
  { text: 'פרק א', index: 3, level: 4 },
  { text: 'פרק ב', index: 7, level: 4 },
  { text: 'נח', index: 10, level: 2 },
  { text: 'ספר שני', index: 20, level: 1 },
  { text: 'פתיחה', index: 21, level: 2 }
];
test('levels build native hierarchy despite skipped heading levels', () => {
  const tree = buildTocTree(entries);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].children.length, 2);
  assert.deepEqual(tree[0].children[0].children.map(node => node.key), ['i:3', 'i:7']);
  assert.equal(tree[0].entry, entries[0]);
});
test('roots default open and Map overrides or explicit Set preserve collapsed state', () => {
  const tree = buildTocTree(entries);
  assert.deepEqual(flattenTocTree(tree).map(row => row.key), ['i:0', 'i:2', 'i:10', 'i:20', 'i:21']);
  assert.deepEqual(flattenTocTree(tree, new Set()).map(row => row.key), ['i:0', 'i:20']);
  const rows = flattenTocTree(tree, new Map([['i:2', true], ['i:20', false]]));
  assert.deepEqual(rows.map(row => row.depth), [0, 1, 2, 2, 1, 0]);
});
test('Hebrew search strips nikud, includes descendants and expands ancestors temporarily', () => {
  const tree = buildTocTree(entries), state = new Set();
  assert.deepEqual(flattenTocTree(tree, state, 'בראשית').map(row => row.key), ['i:0', 'i:2', 'i:3', 'i:7']);
  assert.deepEqual(flattenTocTree(tree, state, 'פרק ב').map(row => row.key), ['i:0', 'i:2', 'i:7']);
  assert.deepEqual(flattenTocTree(tree, state, 'missing'), []);
  assert.equal(state.size, 0);
});
test('active heading comes from greatest eligible anchor, not monotone traversal assumption', () => {
  const tree = buildTocTree(entries);
  assert.equal(activeTocKey(tree, -1), null);
  assert.equal(activeTocKey(tree, 5), 'i:3');
  assert.equal(activeTocKey(tree, 19), 'i:10');
  assert.equal(activeTocKey(tree, 999), 'i:21');
  const reordered = buildTocTree([{ text: 'later', index: 30, level: 1 }, { text: 'earlier', index: 5, level: 1 }]);
  assert.equal(activeTocKey(reordered, 40), 'i:30');
});
test('expand path and toggle all mutate the supplied Set', () => {
  const tree = buildTocTree(entries), state = new Set();
  assert.equal(ensurePathExpanded(tree, 'i:7', state), state);
  assert.deepEqual([...state], ['i:0', 'i:2']);
  assert.ok(flattenTocTree(tree, state).some(row => row.key === 'i:7'));
  setAllExpanded(tree, true, state);
  assert.equal(flattenTocTree(tree, state).length, entries.length);
  setAllExpanded(tree, false, state);
  assert.equal(flattenTocTree(tree, state).length, 2);
});
