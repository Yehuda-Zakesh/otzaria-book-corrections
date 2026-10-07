import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorRange, replaceEditorRange, EDITOR_CHUNK, editorSegments } from '../plugin/editor-window.js';

test('large Hebrew books render bounded chunks and preserve every UTF-16 character', () => {
  const text = ('א'.repeat(EDITOR_CHUNK - 1) + '😀\n').repeat(70);
  let offset = 0, reconstructed = '';
  while (offset < text.length) {
    const range = editorRange(text, offset, true);
    const value = text.slice(range.start, range.end);
    assert.ok(value.length <= EDITOR_CHUNK + 1);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(value));
    reconstructed += value; offset = range.end;
  }
  assert.equal(reconstructed, text);
});

test('editing a middle chunk preserves the hidden prefix and suffix after insertion and deletion', () => {
  const original = 'א'.repeat(60000), range = editorRange(original, 20000);
  let edited = replaceEditorRange(original, range, 'תיקון😀');
  assert.equal(edited, original.slice(0, range.start) + 'תיקון😀' + original.slice(range.end));
  const updatedRange = { start: range.start, end: range.start + 'תיקון😀'.length };
  edited = replaceEditorRange(edited, updatedRange, '');
  assert.equal(edited, original.slice(0, range.start) + original.slice(range.end));
});

test('navigation to book end and edited chunk boundaries stays bounded', () => {
  const text = 'א'.repeat(EDITOR_CHUNK * 3);
  assert.equal(editorRange(text, text.length).end, text.length);
  const next = editorRange(text, EDITOR_CHUNK + 350, true);
  assert.equal(next.start, EDITOR_CHUNK + 350);
  assert.equal(next.end, EDITOR_CHUNK * 2 + 350);
});

test('continuous segments preserve paragraph boundaries, Unicode and terminal book offsets', () => {
  const text = ('פסקה 😀\n'.repeat(1000) + 'א'.repeat(20000)).repeat(4);
  const segments = editorSegments(text);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1).end, text.length);
  assert.equal(segments.map(s => text.slice(s.start, s.end)).join(''), text);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i], value = text.slice(segment.start, segment.end);
    assert.ok(value.length <= EDITOR_CHUNK + 1);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(value));
    if (i) assert.equal(segment.start, segments[i - 1].end);
  }
  assert.deepEqual(editorSegments(''), [{ start: 0, end: 0 }]);
});
