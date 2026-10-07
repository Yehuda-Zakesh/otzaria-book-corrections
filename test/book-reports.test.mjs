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

test('missing SDK references use the source heading hierarchy, independent of reader position', async () => {
  const f = fixture(['ספר', 'פרק א', 'טקסט', 'פרק ב', 'טקסט נוסף']);
  f.session.book.toc = [
    { text: 'ספר', index: 0, level: 1 },
    { text: 'פרק א', index: 1, level: 2 },
    { text: 'פרק ב', index: 3, level: 2 }
  ];
  f.session.location = { sectionIndex: 4 };
  const section = f.session.book.sections[2];
  for (const currentRef of [undefined, '', '   ']) {
    const call = async (method, args) => ({ sourceText: f.session.book.sections[args.sectionIndex].text, currentRef });
    const [{ payload }] = await prepareReports(f.session,
      [{ start: section.start, end: section.end, original: section.text, proposed: 'תיקון' }],
      'reader@example.com', call, f.id);
    assert.equal(payload.current_ref, 'ספר, פרק א');
    assert.equal(payload.line_number, 3);
    assert.match(payload.error_details, /מיקום: ספר, פרק א\nמספר שורה במקור: 3/);
  }
});

test('split reports use each source chunk location and context', async () => {
  const f = fixture(Array.from({ length: 70 }, (_, index) => `שורה ${index}`));
  const original = f.session.book.originalText;
  const queue = await prepare(f, [{ start: 0, end: original.length, original, proposed: '' }]);
  assert.ok(queue.length > 1);
  let offset = 0;
  for (const { payload } of queue) {
    const section = f.session.book.sections.find(s => s.start <= offset && s.end + 1 > offset);
    assert.equal(payload.line_number, section.index + 1);
    assert.equal(payload.current_ref, `פסקה ${section.index + 1}`);
    assert.equal(payload.context_text, section.text);
    offset += payload.selected_text.length;
  }
  assert.equal(offset, original.length);
});

function verifiedSource(f, rawLines = f.session.book.sections.map(section => section.text)) {
  return { ...f.session.book, details: { ...f.session.book.details, source: 'library', type: 'text', id: 18 }, rawLines };
}
const structuredPrepare = (f, changes, sourceBook = verifiedSource(f)) =>
  prepareReports(f.session, changes, 'reader@example.com', f.call, f.id, undefined, { sourceBook,
    client: { app_version: '0.9.98+801', platform: 'windows' } });

test('verified raw lines produce v2 selection, deletion and whole-line insertion on SDK 0.9.98', async () => {
  const f = fixture(['אָב 😀 אָב']);
  const changes = [
    { start: 7, end: 10, original: 'אָב', proposed: 'אֵם' },
    { start: 0, end: 3, original: 'אָב', proposed: '' },
    { start: 3, end: 3, original: '', proposed: ' חדש' }
  ];
  const queue = await structuredPrepare(f, changes);
  assert.ok(queue.every(item => item.payload.report_kind === 'text_correction'));
  assert.equal(queue[0].payload.correction.selection_offset.start, 7);
  assert.equal(queue[1].payload.correction.proposed_text, '');
  assert.equal(queue[2].payload.correction.proposed_text, 'אָב חדש 😀 אָב');
  assert.equal(queue[2].payload.correction.selection_offset, null);
  assert.equal(queue[0].payload.location.book_id, 18);
  assert.equal(queue[0].payload.location.library_build_id, null);
  assert.equal(queue[0].payload.client.app_version, '0.9.98+801');
});

test('same paragraph boundaries yield exact independent corrections; paragraph merges remain free', async () => {
  const f = fixture(['אב', 'גד']);
  const queue = await structuredPrepare(f, [{ start: 0, end: 5, original: 'אב\nגד', proposed: 'אם\nגה' }]);
  assert.equal(queue.length, 2);
  assert.deepEqual(queue.map(item => item.payload.location.line_index), [0, 1]);
  assert.deepEqual(queue.map(item => item.payload.correction.proposed_text), ['אם', 'גה']);
  assert.ok(queue.every(item => item.payload.report_kind === 'text_correction'));
  const free = await structuredPrepare(f, [{ start: 2, end: 3, original: '\n', proposed: '' }]);
  assert.equal(free[0].payload.report_kind, 'free_text');
  assert.equal('correction' in free[0].payload, false);
});

test('raw HTML is verified per targeted section before a source correction is constructed', async () => {
  const f = fixture(['פתיחה', 'אָב']);
  const change = { start: 6, end: 9, original: 'אָב', proposed: 'אֵם' };
  const [{ payload }] = await structuredPrepare(f, [change], verifiedSource(f, ['פתיחה', '<b>אָב</b>']));
  assert.equal(payload.correction.original_line, '<b>אָב</b>');
  assert.equal(payload.correction.selection_offset.start, 3);
  assert.equal(payload.context_text, '<b>אָב</b>');
  const [free] = await structuredPrepare(f, [change], verifiedSource(f, ['פתיחה', 'מקור אחר']));
  assert.equal(free.payload.report_kind, 'free_text');
});

test('unavailable raw mapping and cross-tag changes remain explicit free-text proposals', async () => {
  const f = fixture(['מילה']);
  const change = { start: 0, end: 4, original: 'מילה', proposed: 'חדש' };
  for (const rawLines of [null, ['מי<b>לה</b>']]) {
    const [{ payload }] = await structuredPrepare(f, [change], verifiedSource(f, rawLines));
    assert.equal(payload.report_kind, 'free_text');
    assert.equal('correction' in payload, false);
    assert.match(payload.error_details, /הצעה לבדיקה ידנית כדיווח חופשי:/);
  }
});

test('valid 20,000-unit source corrections are not unnecessarily split at the free-text chunk limit', async () => {
  const original = 'א'.repeat(20000), proposed = 'ב'.repeat(20000);
  const f = fixture([original]);
  const queue = await structuredPrepare(f, [{ start: 0, end: original.length, original, proposed }]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].payload.correction.proposed_text, proposed);
  assert.ok(queue[0].payload.selected_text.length <= 10000);
});
