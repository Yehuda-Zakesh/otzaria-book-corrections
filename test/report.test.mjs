import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, canonical, sendReport, validateSelection, ENDPOINT } from '../plugin/report.js';

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
test('builds legacy error report with both texts, source routing and 1-based line number', async () => {
  const payload = await buildReport(draft(), 'me@example.com');
  assert.equal(payload.line_number, 43);
  assert.equal(payload.report_id, 'stable-id');
  assert.equal(payload.source_folder, 'Sefaria');
  assert.equal(payload.context_text, line);
  assert.equal(payload.selected_text, 'אָב');
  assert.match(payload.error_details, /מקור: אָב\nמוצע: אֵם/);
  assert.equal('correction' in payload, false);
  assert.equal('selection_offset' in payload, false);
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
