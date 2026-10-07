import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctionForSource, officialReportBookId, verifyQueuedCorrectionSources } from '../plugin/correction-source.js';

globalThis.DOMParser = class {
  parseFromString(input) {
    const entities = { amp: '&', lt: '<', gt: '>' };
    return { body: { textContent: entities[input.slice(7, -8)] } };
  }
};

test('repeated pointed Hebrew after emoji maps to the selected raw occurrence', () => {
  const raw = '<b>אָב</b> 😀 <i>אָב</i> סוף';
  const correction = correctionForSource(raw, 'אָב 😀 אָב סוף', 7, 10, 'אֵם');
  assert.equal(correction.original_selection, 'אָב');
  assert.equal(correction.selection_offset.start, raw.lastIndexOf('אָב'));
  assert.equal(correction.context_before, '<b>אָב</b> 😀 <i>');
  assert.equal(correction.context_after, '</i> סוף');
});

test('entities map as complete raw tokens and replacement remains literal text', () => {
  const correction = correctionForSource('א&#38;ב', 'א&ב', 1, 2, '<וגם&>');
  assert.equal(correction.original_selection, '&#38;');
  assert.deepEqual(correction.selection_offset, { unit: 'utf16_code_units', start: 1, end: 6 });
  assert.equal(correction.proposed_text, '&lt;וגם&amp;&gt;');
  assert.equal(correctionForSource('&#x1F600;', '😀', 0, 1, 'א'), null, 'partial decoded token must not be guessed');
});

test('insertion builds one whole-line replacement preserving HTML', () => {
  const correction = correctionForSource('<b>אב</b>', 'אב', 1, 1, 'ג');
  assert.equal(correction.original_selection, null);
  assert.equal(correction.proposed_text, '<b>אגב</b>');
  assert.equal(correction.selection_offset, null);
  assert.equal(correctionForSource('', '', 0, 0, 'חדש').proposed_text, 'חדש');
});

test('unsafe formatting ranges, synthetic spaces, stale source and excess text do not become corrections', () => {
  assert.equal(correctionForSource('מי<b>לה</b>', 'מילה', 0, 4, 'חדש'), null);
  assert.equal(correctionForSource('אב<br>גד', 'אב גד', 2, 3, ''), null);
  assert.equal(correctionForSource('אב', 'שונה', 0, 1, 'ג'), null);
  assert.equal(correctionForSource('אב', 'אב', 0, 1, 'ג'.repeat(20001)), null);
  assert.equal(correctionForSource('א'.repeat(20001), 'א'.repeat(20001), 0, 1, 'ב'), null);
});

test('only matching official numeric identity may label a DB correction', () => {
  const book = { details: { id: 42, source: 'library', type: 'text' }, identity: { bookUid: 'id:42' }, rawLines: ['<b>אב</b>'] };
  assert.equal(officialReportBookId(book), 42);
  assert.equal(officialReportBookId({ ...book, identity: { bookUid: 'db:other:42' } }), null);
  assert.equal(officialReportBookId({ ...book, details: { ...book.details, source: 'user' } }), null);
  const payload = { location: { line_index: 0, book_id: 42 }, correction: { original_line: '<b>אב</b>' } };
  verifyQueuedCorrectionSources([{ sent: false, payload }], book);
  assert.throws(() => verifyQueuedCorrectionSources([{ sent: false, payload }], { ...book, rawLines: ['<i>אב</i>'] }), /מקור התיקון המובנה השתנה/);
  verifyQueuedCorrectionSources([{ sent: true, payload }], { ...book, rawLines: null });
});
