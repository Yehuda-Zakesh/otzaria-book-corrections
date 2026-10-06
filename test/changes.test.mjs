import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffBook } from '../plugin/changes.js';

function check(original, edited) {
  const hunks = diffBook(original, edited);
  let previous = 0, rebuilt = '';
  for (const hunk of hunks) {
    assert.ok(hunk.start >= previous);
    assert.ok(hunk.end >= hunk.start);
    assert.equal(original.slice(hunk.start, hunk.end), hunk.original);
    rebuilt += original.slice(previous, hunk.start) + hunk.proposed;
    previous = hunk.end;
  }
  rebuilt += original.slice(previous);
  assert.equal(rebuilt, edited);
  return hunks;
}

test('unchanged book has no corrections', () => assert.deepEqual(check('א\nב', 'א\nב'), []));
test('insertion at beginning retains original offsets', () => {
  assert.deepEqual(check('אב\nגד', 'הקדמה\nאב\nגד'), [{ start: 0, end: 0, original: '', proposed: 'הקדמה\n' }]);
});
test('deleting newline produces an exact deletion', () => {
  assert.deepEqual(check('אב\nגד', 'אבגד'), [{ start: 2, end: 3, original: '\n', proposed: '' }]);
});
test('independent corrections survive earlier length changes', () => {
  const hunks = check('first\nunchanged\nlast', 'a longer first\nunchanged\nLAST');
  assert.equal(hunks.length, 2);
  assert.equal(hunks[1].start, 16);
});
test('repeated paragraphs keep distant edits separate', () => {
  const original = 'same\nsame\nsame\nsame\nsame\n';
  const hunks = check(original, 'first\nsame\nsame\nsame\nlast\n');
  assert.equal(hunks.length, 2);
});
test('nikud and emoji use UTF-16 offsets without splitting surrogate pairs', () => {
  check('שָׁלוֹם 😀 סוף', 'שָׁלֹם 😃 סיום');
  assert.deepEqual(check('a😀b', 'a😃b'), [{ start: 1, end: 3, original: '😀', proposed: '😃' }]);
});
test('one megabyte sparse edits avoid replacing the whole book', () => {
  const original = Array.from({ length: 25000 }, (_, i) => `paragraph ${i} ${'x'.repeat(30)}\n`).join('');
  const edited = original.replace('paragraph 100 ', 'paragraph one hundred ').replace('paragraph 24000 ', 'paragraph twenty four thousand ');
  const hunks = check(original, edited);
  assert.equal(hunks.length, 2);
  assert.ok(hunks.every(hunk => hunk.original.length < 20));
});
test('many small randomized edits reconstruct exactly', () => {
  let seed = 7;
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  for (let iteration = 0; iteration < 200; iteration++) {
    let original = '', edited = '';
    for (let i = 0; i < 40; i++) original += ['א', 'ב', '\n', '😀'][random(4)];
    edited = original;
    for (let i = 0; i < 4; i++) {
      const points = Array.from(edited), at = random(points.length + 1);
      points.splice(at, random(3), ['ג', '\n', '😃'][random(3)]);
      edited = points.join('');
    }
    check(original, edited);
  }
});
