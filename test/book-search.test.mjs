import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInBook } from '../plugin/book-search.js';

test('Hebrew nikud and cantillation are ignored while original ranges retain them', () => {
  const text = 'פתיח שָׁל֣וֹםָ סוף';
  const [match] = findInBook(text, 'שלום');
  assert.equal(match.offset, 5);
  assert.equal(text.slice(match.offset, match.end), 'שָׁל֣וֹםָ');
  assert.equal(findInBook(text, 'שָׁלוֹם').length, 1);
});
test('emoji and accented characters retain UTF-16 offsets', () => {
  const text = '😀 Café שָׁלוֹם 😃';
  const [hebrew] = findInBook(text, 'שלום');
  assert.equal(hebrew.offset, 8);
  assert.equal(text.slice(hebrew.offset, hebrew.end), 'שָׁלוֹם');
  const [emoji] = findInBook(text, '😃');
  assert.equal(emoji.end - emoji.offset, 2);
  assert.equal(findInBook(text, 'CAFÉ')[0].offset, 3);
});
test('repeated matches are non-overlapping and limited', () => {
  assert.deepEqual(findInBook('אב אב אב', 'אב', { limit: 2 }).map(hit => hit.offset), [0, 3]);
  assert.equal(findInBook('aaaa', 'aa').length, 2);
  assert.deepEqual(findInBook('אב', 'אב', { limit: 0 }), []);
  assert.deepEqual(findInBook('אב', 'אב', { limit: 0.5 }), []);
});
test('punctuation is literal and never a regular expression', () => {
  const [match] = findInBook('start [a.*]+? end', '[a.*]+?');
  assert.equal(match.offset, 6);
  assert.equal(findInBook('aaa', 'a.*').length, 0);
});
test('blank and mark-only queries have no matches', () => {
  for (const query of ['', ' ', '\n', '\u05b8\u0591']) assert.deepEqual(findInBook('אב', query), []);
});
test('spaces and newlines match exactly', () => {
  assert.equal(findInBook('אב\nגד אב גד', 'אב גד')[0].offset, 6);
  assert.equal(findInBook('אב\nגד אב גד', 'אב\nגד')[0].offset, 0);
  assert.equal(findInBook('אב  גד', 'אב גד').length, 0);
});
test('snippets cap Unicode context and preserve literal HTML as text', () => {
  const text = '😀'.repeat(100) + '<script>אב</script>' + '😃'.repeat(100);
  const [match] = findInBook(text, '<script>אב</script>');
  assert.equal(match.offset, 200);
  assert.equal(match.snippet, '…' + '😀'.repeat(60) + '<script>אב</script>' + '😃'.repeat(60) + '…');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(match.snippet));
});
test('large book search does not require a character offset array', () => {
  const text = 'x'.repeat(10 * 1024 * 1024) + ' שָׁלוֹם';
  const [match] = findInBook(text, 'שלום');
  assert.equal(match.offset, 10 * 1024 * 1024 + 1);
  assert.equal(match.end, text.length);
});
