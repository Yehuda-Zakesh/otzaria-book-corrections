import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareReports } from '../plugin/book-reports.js';

function fixture(lines, overrides = {}) {
  let position = 0, nextId = 0;
  const sections = lines.map((text, index) => {
    const start = position;
    position += text.length + 1;
    return { index, start, end: start + text.length, text };
  });
  const requests = [];
  const session = { book: {
    identity: { bookId: 'ספר בדיקה', bookUid: 'id:18' },
    details: { title: 'ספר בדיקה', libraryPath: 'ספרים/בדיקה', textSource: { key: 'Sefaria' } },
    originalText: lines.join('\n'), sections
  } };
  const call = async (method, args) => {
    assert.equal(method, 'reader.getSectionTextMap');
    assert.equal(args.bookUid, 'id:18');
    assert.equal(args.layer, 'source');
    requests.push(args.sectionIndex);
    return { sourceText: overrides[args.sectionIndex] ?? lines[args.sectionIndex], currentRef: `פסקה ${args.sectionIndex + 1}` };
  };
  return { session, requests, call, id: () => `report-${++nextId}` };
}
const prepare = (f, changes) => prepareReports(f.session, changes, 'reader@example.com', f.call, f.id);

test('early inserted paragraph does not shift later original line numbers', async () => {
  const f = fixture(['פתיחה', 'אמצע', 'סיום']);
  const end = f.session.book.sections[2];
  const queue = await prepare(f, [
    { start: 0, end: 0, original: '', proposed: 'פסקה חדשה\n' },
    { start: end.start, end: end.end, original: end.text, proposed: 'סוף מתוקן' }
  ]);
  assert.deepEqual(queue.map(q => q.payload.line_number), [1, 3]);
  assert.deepEqual(queue.map(q => q.payload.current_ref), ['פסקה 1', 'פסקה 3']);
  assert.deepEqual(f.requests, [0, 2]);
});

test('multi paragraph deletion validates every touched original section once', async () => {
  const f = fixture(['אחד', 'שניים', 'שלושה', 'ארבעה']);
  const end = f.session.book.sections[2].end;
  const queue = await prepare(f, [{ start: 0, end, original: f.session.book.originalText.slice(0, end), proposed: '' }]);
  assert.deepEqual(f.requests, [0, 1, 2]);
  assert.equal(queue[0].payload.selected_text, 'אחד\nשניים\nשלושה');
  assert.match(queue[0].payload.error_details, /פסקה 1 עד 3/);
  assert.match(queue[0].payload.error_details, /\(מחיקה\)/);
});

test('a changed middle source prevents returning any prepared reports', async () => {
  const f = fixture(['אחד', 'שניים', 'שלושה'], { 1: 'מקור חדש' });
  await assert.rejects(prepare(f, [{ start: 0, end: f.session.book.originalText.length, original: f.session.book.originalText, proposed: 'חדש' }]), /מקור הספר השתנה/);
  assert.deepEqual(f.requests, [0, 1]);
});

test('original and proposed preserve pointed Hebrew, emoji, RTL marks and line breaks', async () => {
  const original = 'אָב 😀\u200f\nבֵּן';
  const proposed = 'אֵם 🕯️\u200f\nבַּת';
  const f = fixture([original]);
  const [{ payload, sent }] = await prepare(f, [{ start: 0, end: original.length, original, proposed }]);
  assert.equal(payload.selected_text, original);
  assert.ok(payload.error_details.endsWith(`מקור: ${original}\nמוצע: ${proposed}`));
  assert.equal(sent, false);
});

test('huge edits split at safe UTF-16 boundaries and remain below the report byte limit', async () => {
  const original = 'א'.repeat(7999) + '😀' + 'ב'.repeat(17000);
  const proposed = 'ג'.repeat(7999) + '🕯️' + 'ד'.repeat(19000);
  const f = fixture([original]);
  const queue = await prepare(f, [{ start: 0, end: original.length, original, proposed }]);
  assert.equal(queue.length, 4);
  assert.equal(queue.map(q => q.payload.selected_text).join(''), original);
  const proposedParts = queue.map(q => q.payload.error_details.split('\nמוצע: ').at(-1));
  assert.equal(proposedParts.join(''), proposed);
  assert.equal(new Set(queue.map(q => q.payload.report_id)).size, queue.length);
  for (let i = 0; i < queue.length; i++) {
    const payload = queue[i].payload;
    assert.match(payload.error_details, new RegExp(`חלק ${i + 1} מתוך 4`));
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).length <= 256 * 1024);
  }
});

test('context truncation does not cut an emoji surrogate pair', async () => {
  const original = 'א'.repeat(19999) + '😀';
  const f = fixture([original]);
  const [{ payload }] = await prepare(f, [{ start: 0, end: 1, original: 'א', proposed: 'ב' }]);
  assert.ok(payload.context_text.length <= 20000);
  assert.doesNotMatch(payload.context_text, /[\uD800-\uDBFF]$/u);
});

test('oversized metadata cannot produce a payload above 256 KiB', async () => {
  const f = fixture(['א']);
  f.session.book.details.libraryPath = 'א'.repeat(140000);
  await assert.rejects(prepare(f, [{ start: 0, end: 1, original: 'א', proposed: 'ב' }]), /גדול מדי לשליחה/);
});
