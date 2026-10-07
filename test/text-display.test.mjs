import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectNikud, applyDisplayEdit, readNikudDisplay } from '../plugin/text-display.js';
import { diffBook } from '../plugin/changes.js';
import { prepareReports } from '../plugin/book-reports.js';

test('hidden vowels map UTF-16 boundaries and leave punctuation and cantillation intact', () => {
  const source = '😀 שָׁלוֹם\nבַּיִת֑־סוֹףֽ׃';
  const map = projectNikud(source, true);
  assert.equal(map.text, '😀 שלום\nבית֑־סוףֽ׃');
  for (let offset = 0; offset <= map.text.length; offset++) {
    assert.equal(map.toDisplay(map.toSource(offset)), offset);
  }
  assert.equal(map.toSource(map.text.length), source.length);
  assert.equal(projectNikud(source).text, source);
});

test('display-only changes create no reports and sparse edits retain untouched vowels', () => {
  const source = 'שָׁלוֹם בַּיִת\nשָׁלוֹם 😀';
  const map = projectNikud(source, true);
  assert.equal(applyDisplayEdit(map, 0, map.text.length, map.text), source);
  const edited = applyDisplayEdit(map, 0, map.text.length, 'שלומ בית\nשלום 😀!');
  assert.equal(edited, 'שָׁלוֹמ בַּיִת\nשָׁלוֹם 😀!');
  assert.deepEqual(diffBook(source, edited).map(change => [change.original, change.proposed]), [['ם', 'מ'], ['', '!']]);
});

test('window edits, insertion, deletion and undo retain original source offsets', () => {
  const source = 'אָב\nגַּד\nסוֹף';
  const map = projectNikud(source, true);
  assert.equal(applyDisplayEdit(map, 3, 5, 'גז'), 'אָב\nגַּז\nסוֹף');
  assert.equal(applyDisplayEdit(map, 0, map.text.length, 'אב!\nגד\nסוף'), 'אָב!\nגַּד\nסוֹף');
  assert.equal(applyDisplayEdit(map, 0, map.text.length, 'אב\n\nסוף'), 'אָב\n\nסוֹף');
  const insertion = applyDisplayEdit(map, 0, map.text.length, 'אב!\nגד\nסוף');
  const next = projectNikud(insertion, true);
  assert.equal(applyDisplayEdit(next, 0, next.text.length, map.text), source);
});

test('host display normalization determines per-book flag independently of rendered holy names', async () => {
  const book = { identity: { bookId: 'ספר', bookUid: 'id:1' }, sections: [{ index: 0, text: 'כותרת' }, { index: 1, text: 'שָׁלוֹם' }] };
  for (const hidden of [true, false]) {
    let calls = 0;
    assert.equal(await readNikudDisplay(async (method, args) => {
      assert.equal(method, 'reader.getSectionTextMap');
      assert.equal(args.sectionIndex, 1); assert.equal(args.bookUid, 'id:1');
      assert.equal(args.normalize.profile, 'display');
      if (++calls === 1) return { chars: [{ text: 'ש', normalizedText: 'ש' }], hasMore: true, nextCursor: 'next' };
      assert.equal(args.cursor, 'next');
      return { chars: [{ text: 'לָ', normalizedText: hidden ? 'ל' : 'לָ' }], hasMore: false };
    }, book), hidden);
  }
});

test('unpointed books and older hosts leave source display intact', async () => {
  assert.equal(await readNikudDisplay(() => assert.fail('no request needed'), { sections: [{ text: 'ספר' }] }), false);
  assert.equal(await readNikudDisplay(async () => ({ sourceText: 'סֵפֶר' }), { identity: { bookId: 'ספר' }, sections: [{ text: 'סֵפֶר', index: 0 }] }), false);
});

test('a correction in the hidden display reports the pointed original on the correct source line', async () => {
  const lines = ['שָׁלוֹם', 'שָׁלוֹם בַּיִת😀'];
  const originalText = lines.join('\n');
  const map = projectNikud(originalText, true);
  const editedText = applyDisplayEdit(map, 0, map.text.length, 'שלום\nשלום סית😀');
  const session = { editedText, book: { originalText, identity: { bookId: 'ספר' },
    details: { title: 'ספר', source: 'library', type: 'text', libraryPath: 'book.txt' },
    sections: [{ index: 0, start: 0, end: lines[0].length, text: lines[0] },
      { index: 1, start: lines[0].length + 1, end: originalText.length, text: lines[1] }] } };
  const reports = await prepareReports(session, diffBook(originalText, editedText), 'test@example.com',
    async (method, args) => ({ sourceText: lines[args.sectionIndex], currentRef: 'פסקה ב' }), () => 'nikud-test');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].payload.line_number, 2);
  assert.equal(reports[0].payload.selected_text, 'בַּ');
  assert.match(reports[0].payload.error_details, /מוצע: ס/);
  assert.equal(session.book.originalText, originalText);
});
