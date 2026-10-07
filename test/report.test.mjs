import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildReport, canonical, reportContentDigest, reportDeliveryMessage, sendReport, validateSelection, ENDPOINT } from '../plugin/report.js';
import { reportSha256 } from '../plugin/report-digest.js';

const line = 'אָב 😀 אָב סוף';
const start = line.lastIndexOf('אָב');
const selection = {
  id: 183, bookId: 'ספר לדוגמה', bookTitle: 'ספר לדוגמה', type: 'text', source: 'library',
  sectionIndex: 42, currentRef: 'פרק ג',
  sourceRange: { layer: 'source', start: { utf16: start }, end: { utf16: start + 3 }, exactText: 'אָב', sourceTextHash: 'a' }
};
const map = { sourceText: line, sourceTextHash: 'a' };
function draft(proposed = 'אֵם') {
  return { id: 'stable-id', createdAt: '2026-10-06T12:00:00Z', target: validateSelection(selection, map), selection,
    details: { id: 183, libraryPath: 'תנך/ספר לדוגמה', textSource: { key: 'Sefaria' } }, proposed, note: '' };
}

test('uses precise UTF-16 range for repeated pointed Hebrew after an emoji', () => {
  const target = validateSelection(selection, map);
  assert.equal(target.start, start);
  assert.equal(target.original, 'אָב');
  assert.equal(target.line.slice(0, start), 'אָב 😀 ');
});
test('rejects a stale source hash even if selected words still match', () => {
  assert.throws(() => validateSelection(selection, { ...map, sourceTextHash: 'b' }));
});
test('rejects wrong offsets rather than searching for the first occurrence', () => {
  assert.throws(() => validateSelection({ ...selection, sourceRange: { ...selection.sourceRange, start: { utf16: start - 1 } } }, map));
});
test('rejects a multi-paragraph selection and personal books', () => {
  assert.throws(() => validateSelection({ ...selection, sections: [{}, {}] }, map));
  assert.throws(() => validateSelection({ ...selection, source: 'user' }, map));
});
test('builds v2 free-text report with both texts, source routing and 1-based line number', async () => {
  const payload = await buildReport(draft(), 'me@example.com');
  assert.equal(payload.line_number, 43);
  assert.equal(payload.report_id, 'stable-id');
  assert.equal(payload.source_folder, 'Sefaria');
  assert.equal(payload.context_text, line);
  assert.equal(payload.current_ref, 'פרק ג');
  assert.ok(payload.error_details.startsWith('ספר: ספר לדוגמה\nמיקום: פרק ג\nמספר שורה במקור: 43\n\n'));
  assert.equal(payload.selected_text, 'אָב');
  assert.match(payload.error_details, /מקור: אָב\nמוצע: אֵם/);
  assert.equal('correction' in payload, false);
  assert.equal('selection_offset' in payload, false);
  assert.equal(payload.schema_version, 2);
  assert.equal(payload.report_kind, 'free_text');
  assert.deepEqual(payload.location, { line_index: 42, book_id: null, library_build_id: null, he_ref: null });
  assert.equal(payload.content_digest, reportContentDigest(payload));
});
test('missing or blank references retain a readable source location in the report body', async () => {
  for (const currentRef of [undefined, null, '', '   ']) {
    const value = draft();
    value.selection = { ...selection, currentRef };
    value.note = 'הערת המדווח';
    const payload = await buildReport(value, 'me@example.com');
    assert.equal(payload.current_ref, 'פסקה 43');
    assert.equal(payload.line_number, 43);
    assert.ok(payload.error_details.startsWith('ספר: ספר לדוגמה\nמיקום: פסקה 43\nמספר שורה במקור: 43\n\nהערת המדווח\n\n'));
  }
});
test('preserves whitespace, nikud and punctuation without normalization', async () => {
  const payload = await buildReport(draft(' אֵם!\n'), 'me@example.com');
  assert.ok(payload.error_details.endsWith('מוצע:  אֵם!\n'));
});
test('an empty proposal is a deletion', async () => {
  const payload = await buildReport(draft(''), 'me@example.com');
  assert.ok(payload.error_details.endsWith('מוצע: (מחיקה)'));
});
test('rejects unchanged text, invalid email and corrupt Unicode', async () => {
  await assert.rejects(buildReport(draft('אָב'), 'me@example.com'));
  await assert.rejects(buildReport(draft(), 'not-an-email'));
  await assert.rejects(buildReport(draft('\ud800'), 'me@example.com'));
});
test('rejects excessive text and missing locations', async () => {
  await assert.rejects(buildReport(draft('א'.repeat(20001)), 'me@example.com'));
  const value = draft(); value.selection = { ...selection, sectionIndex: -1 };
  await assert.rejects(buildReport(value, 'me@example.com'));
});

function host(status, body, seen = []) {
  return { call: async function* (method, args) {
    seen.push({ method, args });
    yield { type: 'response', status };
    yield { type: 'data', body: body.slice(0, 7) };
    yield { type: 'data', body: body.slice(7) };
  } };
}
test('sends via native bridge and joins split JSON response chunks', async () => {
  const seen = [], payload = await buildReport(draft(), 'me@example.com');
  assert.deepEqual(await sendReport(host(200, '{"success":true}', seen), payload), { success: true });
  assert.equal(seen[0].method, 'network.fetchStream');
  assert.equal(seen[0].args.url, ENDPOINT);
  assert.deepEqual(JSON.parse(seen[0].args.body), payload);
});
test('retries the same payload with the same id and accepts duplicate receipt', async () => {
  const seen = [], payload = await buildReport(draft(), 'me@example.com');
  await assert.rejects(sendReport(host(503, '{}', seen), payload));
  const response = await sendReport(host(200, '{"success":true,"duplicate":true}', seen), payload);
  assert.equal(response.duplicate, true);
  assert.equal(seen[0].args.body, seen[1].args.body);
});
test('a content-filter HTML page with status 200 is not a successful send', async () => {
  await assert.rejects(sendReport(host(200, '<html>blocked</html>'), {}));
});

test('intake success with failed email remains retryable using the same report id', async () => {
  const seen = [], payload = await buildReport(draft(), 'me@example.com');
  await assert.rejects(sendReport(host(200, JSON.stringify({ success: true, accepted: true,
    savedToDatabase: true, email_sent: false, duplicate: false }), seen), payload), /המייל לנמען/);
  const response = await sendReport(host(200, JSON.stringify({ success: true, email_sent: true }), seen), payload);
  assert.equal(response.email_sent, true);
  assert.equal(seen[0].args.body, seen[1].args.body);
});

test('email deduplication is a receipt for an already emailed report', async () => {
  const response = await sendReport(host(200, '{"success":true,"email_sent":false,"duplicate":true}'), {});
  assert.equal(response.duplicate, true);
});
test('an explicit server failure, 409 and 429 retain the report', async () => {
  await assert.rejects(sendReport(host(200, '{"success":false}'), {}));
  await assert.rejects(sendReport(host(409, '{}'), {}), /מזהה/);
  await assert.rejects(sendReport(host(429, '{}'), {}), /מאוחר/);
});
test('canonical validation rejects noninteger values and lone surrogates', () => {
  assert.equal(canonical({ z: 'א', a: 1 }), '{"a":1,"z":"א"}');
  assert.throws(() => canonical(1.5));
  assert.throws(() => canonical('\udfff'));
});

test('portable SHA-256 matches Node for UTF-8 text and block padding boundaries', () => {
  for (const text of ['', 'abc', 'אָב 😀', ...[55, 56, 63, 64, 65, 1000, 20000].map(n => 'א'.repeat(n))]) {
    assert.equal(reportSha256(text), createHash('sha256').update(text).digest('hex'));
  }
});

test('free-text digest matches the golden fixture in Otzaria, not just a JS round trip', () => {
  assert.equal(reportContentDigest({ report_kind: 'free_text', book_title: 'בראשית', current_ref: 'בראשית א',
    location: { line_index: 2 }, selected_text: 'בראשית ברא', error_details: 'חסר ניקוד',
    context_text: '(א) בראשית ברא אלהים', file_path: 'אוצריא/תנך/תורה/בראשית.txt',
    source_folder: 'ToratEmetToOtzaria', library_version: '27' }),
  '139b1100852541c25d512a7e4081315d2b11d1e93cbb0c880101ed478222465c');
});

test('digest matches the exact published Dart digest field set', async () => {
  const value = draft();
  value.sourceBookId = 183;
  value.correction = { original_line: line, original_selection: 'אָב',
    selection_offset: { unit: 'utf16_code_units', start, end: start + 3 },
    proposed_text: 'אֵם', context_before: line.slice(0, start), context_after: line.slice(start + 3) };
  const payload = await buildReport(value, 'me@example.com');
  assert.equal(payload.report_kind, 'text_correction');
  const serverDigest = createHash('sha256').update(canonical({
    v: 1, report_kind: 'text_correction', book_title: payload.book_title, current_ref: payload.current_ref,
    line_index: 42, selected_text: payload.selected_text, error_details: payload.error_details,
    context_text: payload.context_text, source_folder: payload.source_folder, file_path: payload.file_path,
    library_version: payload.library_version, correction: { original_line: line, original_selection: 'אָב',
      proposed_text: 'אֵם', selection_offset: { unit: 'utf16_code_units', start, end: start + 3 } }
  })).digest('hex');
  assert.equal(payload.content_digest, serverDigest);
  const changedId = { ...payload, report_id: 'new-id' };
  assert.equal(reportContentDigest(changedId), payload.content_digest);
  assert.notEqual(reportContentDigest({ ...payload, correction: { ...payload.correction, proposed_text: '' } }), payload.content_digest);
  await assert.rejects(buildReport({ ...value, correction: { ...value.correction, selection_offset: { unit: 'utf16_code_units', start: 0, end: 3 } } }, 'me@example.com'));
});

test('delivery summary distinguishes server-confirmed corrections from free or unsupported reports', () => {
  const structured = { payload: { report_kind: 'text_correction' }, sent: true, correctionSupported: true };
  const unsupported = { ...structured, correctionSupported: false };
  const free = { payload: { report_kind: 'free_text' }, sent: true };
  const legacy = { payload: {}, sent: true };
  assert.match(reportDeliveryMessage([structured, unsupported, free, legacy, { ...structured, sent: false }]),
    /1 הצעות תיקון מובנות אושרו באתר; 2 הצעות נשלחו כדיווח חופשי.*1 הצעות נשלחו, אך האתר לא אישר/);
});
