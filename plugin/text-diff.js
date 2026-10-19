// Port of Otzaria's computeTextDiff (lib/text_book/view/text_correction_editor.dart):
// a word-level diff. A word stays whole (with its nikud), and whitespace runs
// are separate tokens so that a changed space is shown.
const diffTokenPattern = /\s+|\S+/g;
// LCS cell limit; beyond it the middle is shown as one replacement.
const maxLcsCells = 400000;

export function computeTextDiff(before, after) {
  const a = before.match(diffTokenPattern) ?? [], b = after.match(diffTokenPattern) ?? [];
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const segments = [];
  const add = (op, text) => {
    if (!text) return;
    if (segments.length && segments.at(-1).op === op) segments.at(-1).text += text;
    else segments.push({ op, text });
  };
  add('equal', a.slice(0, prefix).join(''));
  const midA = a.slice(prefix, a.length - suffix), midB = b.slice(prefix, b.length - suffix);
  if (midA.length * midB.length > maxLcsCells) { add('removed', midA.join('')); add('added', midB.join('')); }
  else for (const segment of lcsDiff(midA, midB)) add(segment.op, segment.text);
  add('equal', a.slice(a.length - suffix).join(''));
  return segments;
}

function lcsDiff(a, b) {
  const n = a.length, m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { result.push({ op: 'equal', text: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { result.push({ op: 'removed', text: a[i] }); i++; }
    else { result.push({ op: 'added', text: b[j] }); j++; }
  }
  for (; i < n; i++) result.push({ op: 'removed', text: a[i] });
  for (; j < m; j++) result.push({ op: 'added', text: b[j] });
  return result;
}

// Edits of one proposal as character ranges of the shared original text.
export function diffHunks(before, after) {
  const hunks = [];
  let position = 0, open = null;
  for (const segment of computeTextDiff(before, after)) {
    if (segment.op === 'equal') { open = null; position += segment.text.length; continue; }
    if (!open) { open = { start: position, end: position, insert: '' }; hunks.push(open); }
    if (segment.op === 'removed') { position += segment.text.length; open.end = position; }
    else open.insert += segment.text;
  }
  return hunks;
}
/** Combines independent proposals made against the same original paragraph.
 * Returns null when two proposals touch the same words (or insert at the
 * same point): the user must then decide, nothing is guessed. */
export function mergeProposals(original, proposals) {
  const hunks = proposals.flatMap(proposed => diffHunks(original, proposed)).sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < hunks.length; i++) {
    const previous = hunks[i - 1], hunk = hunks[i];
    if (hunk.start < previous.end || hunk.start === previous.start) return null;
  }
  let result = '', cursor = 0;
  for (const hunk of hunks) { result += original.slice(cursor, hunk.start) + hunk.insert; cursor = hunk.end; }
  return result + original.slice(cursor);
}
