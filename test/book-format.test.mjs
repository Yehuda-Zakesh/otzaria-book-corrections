import test from 'node:test';
import assert from 'node:assert/strict';
import { bookFormatRuns, formattedDiffParts, appendFormattedDiff } from '../plugin/book-format.js';

globalThis.DOMParser = class {
  parseFromString(value) { return { body: { textContent: ({ amp: '&', quot: '"', lt: '<', gt: '>' })[value.slice(7, -8)] ?? '' } }; }
};

test('book formatting follows unchanged and replaced words without changing canonical text', () => {
  const raw = '<h2><b>כותרת</b> ו<i>מילה</i></h2>', plain = ' כותרת ומילה ';
  const parts = formattedDiffParts(plain, ' כותרת ונוסח ', raw);
  assert.equal(parts.filter(p => p.op !== 'added').map(p => p.text).join(''), plain);
  assert.equal(parts.filter(p => p.op !== 'removed').map(p => p.text).join(''), ' כותרת ונוסח ');
  assert.ok(parts.some(p => p.text === 'כותרת' && p.formats.some(f => f.name === 'b') && p.formats.some(f => f.name === 'h2')));
  assert.equal(parts[0].hidden, true, 'synthetic heading indentation is hidden only in the preview');
  assert.ok(parts.some(p => p.op === 'added' && p.formats.some(f => f.name === 'i')));
});

test('formatting never guesses when raw HTML does not match canonical source', () => {
  assert.equal(bookFormatRuns('<b>מקור אחר</b>', 'מקור'), null);
  assert.ok(formattedDiffParts('מקור', 'מתוקן', '<b>מקור אחר</b>').every(p => p.formats.length === 0));
});

test('nested block wrappers do not introduce indentation, and legacy font sizes survive', () => {
  const parts = formattedDiffParts('  מילה  ', '  מילה  ', '<div><p><font size="5">מילה</font></p></div>');
  assert.ok(parts.filter(p => p.text.trim() === '').every(p => p.hidden));
  assert.ok(parts.find(p => p.text === 'מילה').formats.some(f => f.css === 'font-size:1.5em'));
});

test('entities, nesting and CSS are preserved with no executable markup or resources', () => {
  const created = [];
  const doc = { createElement(tag) {
    const item = { tag, children: [], attributes: {}, append(child) { this.children.push(child); }, setAttribute(k, v) { this.attributes[k] = v; } };
    created.push(item); return item;
  } };
  const raw = '<span onclick="evil()" style="font-weight:700;background-image:url(https://invalid.test);color:#123;position:fixed"><u>אב&amp;ג</u></span><img src="https://invalid.test" onerror="evil()"><script>literal</script>';
  const plain = 'אב&gliteral'.replace('g', 'ג');
  appendFormattedDiff(doc.createElement('div'), plain, plain + '!', raw, doc);
  assert.ok(created.some(n => n.tag === 'u'));
  assert.ok(created.some(n => n.attributes.style?.includes('font-weight:700')));
  assert.ok(created.every(n => !['script', 'img', 'iframe', 'a'].includes(n.tag)));
  assert.doesNotMatch(JSON.stringify(created), /onclick|onerror|background-image|position:fixed|https:/);
  assert.ok(created.some(n => n.textContent?.includes('&')));
});

test('plain and legacy previews retain all diff text, including emoji and literal spaces', () => {
  for (const [before, after] of [['😀 א', '😁 א'], [' אב ', ' אב  '], ['', 'חדש'], ['טקסט', '']]) {
    const parts = formattedDiffParts(before, after);
    assert.equal(parts.filter(p => p.op !== 'added').map(p => p.text).join(''), before);
    assert.equal(parts.filter(p => p.op !== 'removed').map(p => p.text).join(''), after);
  }
});
