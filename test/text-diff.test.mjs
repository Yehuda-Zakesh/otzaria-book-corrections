// Cases ported from Otzaria's test/text_book/view/text_correction_editor_test.dart
// (group computeTextDiff), so the plugin highlights changes like Otzaria.
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTextDiff } from '../plugin/text-diff.js';

test('a nikud change in one word is marked as a whole word', () => {
  assert.deepEqual(computeTextDiff('בָּרָא אֱלֹהִים את', 'בָּרָא אֱלֹקִים את'), [
    { op: 'equal', text: 'בָּרָא ' }, { op: 'removed', text: 'אֱלֹהִים' }, { op: 'added', text: 'אֱלֹקִים' }, { op: 'equal', text: ' את' }]);
});
test('full deletion', () => {
  assert.deepEqual(computeTextDiff('מילה', ''), [{ op: 'removed', text: 'מילה' }]);
});
test('an added trailing space is shown', () => {
  assert.deepEqual(computeTextDiff('טקסט', 'טקסט '), [{ op: 'equal', text: 'טקסט' }, { op: 'added', text: ' ' }]);
});
test('both sides are recovered from the segments', () => {
  const before = 'א ב ג ד ה', after = 'א ג ד ו ה ז', segments = computeTextDiff(before, after);
  const join = skip => segments.filter(segment => segment.op !== skip).map(segment => segment.text).join('');
  assert.equal(join('added'), before);
  assert.equal(join('removed'), after);
});
test('a one-word change in a long paragraph is a small highlighted segment', () => {
  const before = `${'מילה '.repeat(100)}והקשו התוס'`, after = `${'מילה '.repeat(100)}בדיקה התוס'`;
  const changed = computeTextDiff(before, after).filter(segment => segment.op !== 'equal');
  assert.deepEqual(changed, [{ op: 'removed', text: 'והקשו' }, { op: 'added', text: 'בדיקה' }]);
});

test('independent proposals for one paragraph merge into one wording', async () => {
  const { mergeProposals } = await import('../plugin/text-diff.js');
  const original = 'אלף בית גימל דלת הא';
  assert.equal(mergeProposals(original, ['אלף ביתא גימל דלת הא', 'אלף בית גימל דלת הא!']), 'אלף ביתא גימל דלת הא!');
  assert.equal(mergeProposals(original, ['אלף ביתא גימל דלת הא', 'אלף ביתב גימל דלת הא']), null, 'same word: no guess');
  assert.equal(mergeProposals(original, ['אלף בית גימל דלת', 'אלף בית דלת הא']), 'אלף בית דלת', 'deletions combine');
  assert.equal(mergeProposals(original, ['אלף בית גימל דלת הא', 'אלף בית גימל דלת הא']), original);
});

test('a mark covers whole words, and an insertion marks the neighbouring word', async () => {
  const { markSpan } = await import('../plugin/reader-marks.js');
  const text = 'אלף בית גימל';
  assert.deepEqual(markSpan(text, 4, 7), { start: 4, end: 7 }, 'a replaced word');
  assert.deepEqual(markSpan(text, 3, 3), { start: 4, end: 7 }, 'an insertion before a word marks that word');
  assert.deepEqual(markSpan(text, 12, 12), { start: 8, end: 12 }, 'an insertion at the end marks the last word');
  assert.deepEqual(markSpan(text, 3, 4), { start: 4, end: 7 }, 'a removed space');
  assert.equal(markSpan('', 0, 0), null);
});
