import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originalToEditedOffset, readerPosition, positionInBook } from '../plugin/navigation.js';

test('insertion before source shifts caret, including insertion at source boundary', () => {
  assert.equal(originalToEditedOffset('abc\ndef', 'intro\nabc\ndef', 4), 10);
  assert.equal(originalToEditedOffset('abc', 'intro abc', 0), 6);
  assert.equal(originalToEditedOffset('abc', 'abc tail', 3), 8);
});
test('deleted target clamps to deletion boundary and following positions shift', () => {
  assert.equal(originalToEditedOffset('abc DEF xyz', 'abc  xyz', 5), 4);
  assert.equal(originalToEditedOffset('abc DEF xyz', 'abc  xyz', 8), 5);
  assert.equal(originalToEditedOffset('abc', '', 2), 0);
});
test('replacement target clamps to available new text', () => {
  assert.equal(originalToEditedOffset('aLONGb', 'aXb', 4), 2);
});
test('UTF-16 emoji boundaries and nikud remain consistent', () => {
  assert.equal(originalToEditedOffset('אב\n😀שָׁלוֹם', 'פתיח\nאב\n😀שָׁלוֹם', 5), 10);
  assert.equal(originalToEditedOffset('a😀b', 'a😀b', 2), 1);
  assert.equal(originalToEditedOffset('a😀b', 'a😃b', 3), 3);
});
test('toolbar, context selection, multipart selection and tab positions normalize', () => {
  assert.deepEqual(readerPosition({ itemId: 'correct-book', currentIndex: 7 }), { sectionIndex: 7, offset: 0 });
  assert.deepEqual(readerPosition({ selection: { sectionIndex: 4, currentIndex: 1, sourceRange: { start: { utf16: 8 } } } }), { sectionIndex: 4, offset: 8 });
  assert.deepEqual(readerPosition({ currentIndex: 3, currentRange: { start: { utf16: 2 } } }), { sectionIndex: 3, offset: 2 });
  assert.deepEqual(readerPosition({ bookId: 'book', index: 9 }), { sectionIndex: 9, offset: 0 });
  assert.deepEqual(readerPosition({ selection: { sections: [{ sectionIndex: 2, sourceRange: { start: { utf16: 1 } } }] } }), { sectionIndex: 2, offset: 1 });
  assert.deepEqual(readerPosition(null), { sectionIndex: 0, offset: 0 });
});
test('book section navigation uses original section anchors after edits', () => {
  const book = { originalText: 'אב\n😀גד', sections: [
    { index: 0, start: 0, end: 2 }, { index: 1, start: 3, end: 7 }
  ] };
  assert.equal(positionInBook(book, { sectionIndex: 1, offset: 2 }, 'הקדמה\nאב\n😀גד'), 11);
  assert.equal(positionInBook(book, { sectionIndex: 1, offset: 999 }), 7);
  assert.equal(positionInBook(book, { sectionIndex: 999, offset: 0 }), 3);
});
