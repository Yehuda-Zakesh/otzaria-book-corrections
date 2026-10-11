import { diffBook } from './changes.js';

// Otzaria's removeNikudOnly: meteg and cantillation are separate from vowels.
const displayNikud = /[\u05b0-\u05bc\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7]/;

export async function readNikudDisplay(call, book) {
  const section = book.sections.find(section => displayNikud.test(section.text));
  if (!section) return false;
  let cursor;
  do {
    const map = await call('reader.getSectionTextMap', { ...book.identity,
      sectionIndex: section.index, layer: 'source', includeChars: true, limit: 2000,
      normalize: { profile: 'display', overrides: { normalizeWhitespace: false } },
      ...(cursor ? { cursor } : {}) });
    // Source tokens normalized with the host's display policy expose the actual
    // per-pane flag, even when holy names or punctuation are also transformed.
    const token = map?.chars?.find(token => displayNikud.test(token.text));
    if (token && typeof token.normalizedText === 'string') return !displayNikud.test(token.normalizedText);
    if (!map?.hasMore || !map.nextCursor || map.nextCursor === cursor) return false;
    cursor = map.nextCursor;
  } while (cursor);
  return false;
}

function displayLowerBound(values, offset, inclusive = false) {
  let low = 0, high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid] < offset || inclusive && values[mid] === offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function projectNikud(source, hidden = false, normalizeWhitespace = false, originalSource = source) {
  const removed = [], boundaries = [], pieces = [];
  // Whitespace entered by the user is editable content. Only normalize runs
  // inherited from the loaded book, otherwise typing a word separator at the
  // end of a paragraph would immediately hide it.
  const enteredWhitespace = [];
  if (normalizeWhitespace && originalSource !== source) {
    let shift = 0;
    for (const change of diffBook(originalSource, source, { mergeWords: false })) {
      if (/[\t\f\r ]/.test(change.proposed)) {
        enteredWhitespace.push([change.start + shift, change.start + shift + change.proposed.length]);
      }
      shift += change.proposed.length - (change.end - change.start);
    }
  }
  if (hidden || normalizeWhitespace) {
    // Match the reader's HTML whitespace policy without touching the source
    // used by report hashes and section offsets. Keep paragraph newlines.
    let lineStart = true, start = 0, enteredIndex = 0;
    for (let i = 0; i < source.length;) {
      if (normalizeWhitespace && /[\t\f\r ]/.test(source[i])) {
        let end = i + 1;
        while (end < source.length && /[\t\f\r ]/.test(source[end])) end++;
        while (enteredIndex < enteredWhitespace.length && enteredWhitespace[enteredIndex][1] <= i) enteredIndex++;
        if (enteredIndex < enteredWhitespace.length && enteredWhitespace[enteredIndex][0] < end) {
          pieces.push(source.slice(start, i));
          for (let index = i; index < end; index++) {
            while (enteredIndex < enteredWhitespace.length && enteredWhitespace[enteredIndex][1] <= index) enteredIndex++;
            const entered = enteredIndex < enteredWhitespace.length && enteredWhitespace[enteredIndex][0] <= index;
            if (entered) pieces.push(source[index]);
            else { boundaries.push(index - removed.length); removed.push(index); }
          }
          lineStart = false; start = i = end; continue;
        }
        const keep = !lineStart && end < source.length && source[end] !== '\n';
        pieces.push(source.slice(start, i));
        if (keep) pieces.push(' ');
        for (let index = i + (keep ? 1 : 0); index < end; index++) {
          boundaries.push(index - removed.length); removed.push(index);
        }
        start = i = end;
        continue;
      }
      if (hidden && displayNikud.test(source[i])) {
        pieces.push(source.slice(start, i)); start = i + 1;
        boundaries.push(i - removed.length); removed.push(i);
      } else {
        lineStart = source[i] === '\n';
      }
      i++;
    }
    pieces.push(source.slice(start));
  }
  const text = hidden || normalizeWhitespace ? pieces.join('') : source;
  return {
    source, text,
    toDisplay(offset) {
      offset = Math.max(0, Math.min(source.length, offset));
      return offset - displayLowerBound(removed, offset);
    },
    toSource(offset) {
      offset = Math.max(0, Math.min(text.length, offset));
      return offset + displayLowerBound(boundaries, offset, true);
    }
  };
}

export function applyDisplayEdit(projection, start, end, value) {
  const before = projection.text.slice(start, end);
  if (before === value) return projection.source;
  if (projection.text === projection.source) return projection.source.slice(0, start) + value + projection.source.slice(end);
  // Diff against visible text, then splice only real changes into the source.
  // Unchanged letters retain their hidden vowels, including inside a correction.
  let source = projection.source;
  const changes = diffBook(before, value, { mergeWords: false });
  for (const change of changes.reverse()) {
    const from = projection.toSource(start + change.start);
    const to = projection.toSource(start + change.end);
    source = source.slice(0, from) + change.proposed + source.slice(to);
  }
  return source;
}
