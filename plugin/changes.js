// All public offsets use JavaScript UTF-16 offsets into the ORIGINAL book.
// Myers handles repeated lines as well as unique lines. Bounded edit distance
// keeps completely rewritten books from consuming quadratic time or memory.
function editRuns(a, b, limit = 256) {
  let frontier = new Map([[1, 0]]);
  const trace = [];
  for (let distance = 0; distance <= Math.min(a.length + b.length, limit); distance++) {
    trace.push(new Map(frontier));
    for (let k = -distance; k <= distance; k += 2) {
      let x = k === -distance || (k !== distance && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
        ? frontier.get(k + 1) ?? 0 : (frontier.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) { x++; y++; }
      frontier.set(k, x);
      if (x >= a.length && y >= b.length) {
        const operations = [];
        for (let d = distance; d >= 0; d--) {
          const v = trace[d], diagonal = x - y;
          const previousK = diagonal === -d || (diagonal !== d && (v.get(diagonal - 1) ?? -1) < (v.get(diagonal + 1) ?? -1))
            ? diagonal + 1 : diagonal - 1;
          const previousX = v.get(previousK) ?? 0, previousY = previousX - previousK;
          while (x > previousX && y > previousY) { operations.push('equal'); x--; y--; }
          if (d > 0) {
            if (x === previousX) { operations.push('insert'); y--; }
            else { operations.push('delete'); x--; }
          }
        }
        return operations.reverse();
      }
    }
  }
  return null;
}

function commonEdges(original, proposed) {
  let start = 0, end = original.length, nextEnd = proposed.length;
  while (start < end && start < nextEnd && original[start] === proposed[start]) start++;
  // Never put a range boundary between an emoji's UTF-16 surrogate pair.
  if (start > 0 && /[\uDC00-\uDFFF]/.test(original[start] ?? proposed[start] ?? '')) start--;
  while (end > start && nextEnd > start && original[end - 1] === proposed[nextEnd - 1]) { end--; nextEnd--; }
  if (end < original.length && /[\uDC00-\uDFFF]/.test(original[end])) { end++; nextEnd++; }
  return { start, end, nextEnd };
}

function changedRuns(a, b, operations, offset, refine) {
  const changes = [];
  let i = 0, j = 0, position = offset, pending = null;
  function flush() {
    if (!pending) return;
    changes.push(...(refine ? refine(pending.original, pending.proposed, pending.start) : [pending]));
    pending = null;
  }
  for (const operation of operations) {
    if (operation === 'equal') { flush(); position += a[i++].length; j++; continue; }
    pending ??= { start: position, end: position, original: '', proposed: '' };
    if (operation === 'delete') {
      const value = a[i++]; pending.original += value; position += value.length; pending.end = position;
    } else pending.proposed += b[j++];
  }
  flush();
  return changes;
}

function diffCharacters(original, proposed, offset, mergeWords = true) {
  const { start, end, nextEnd } = commonEdges(original, proposed);
  const before = original.slice(start, end), after = proposed.slice(start, nextEnd);
  if (!before && !after) return [];
  const a = Array.from(before), b = Array.from(after);
  const operations = editRuns(a, b, 128);
  if (!operations) return [{ start: offset + start, end: offset + end, original: before, proposed: after }];
  const hunks = changedRuns(a, b, operations, offset + start), merged = [];
  for (const hunk of hunks) {
    const previous = merged.at(-1);
    const gap = previous ? original.slice(previous.end - offset, hunk.start - offset) : '';
    // Shared letters inside a changed word should not turn one correction into
    // several tiny reports. Whitespace keeps independently edited words apart.
    if (mergeWords && previous && !/\s/u.test(gap)) {
      previous.original += gap + hunk.original;
      previous.proposed += gap + hunk.proposed;
      previous.end = hunk.end;
    } else merged.push(hunk);
  }
  return merged;
}

export function diffBook(original, edited, { mergeWords = true } = {}) {
  if (typeof original !== 'string' || typeof edited !== 'string') throw new TypeError('Book text must be a string');
  if (original === edited) return [];
  const { start, end, nextEnd } = commonEdges(original, edited);
  const before = original.slice(start, end), after = edited.slice(start, nextEnd);
  const a = before.match(/[^\n]*\n|[^\n]+$/g) ?? [], b = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const operations = editRuns(a, b);
  if (!operations) return diffCharacters(before, after, start, mergeWords);
  return changedRuns(a, b, operations, start, (a, b, offset) => diffCharacters(a, b, offset, mergeWords));
}
