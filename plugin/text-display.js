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

export function projectNikud(source, hidden = false) {
  const removed = [], boundaries = [], pieces = [];
  if (hidden) {
    let start = 0;
    for (let i = 0; i < source.length; i++) {
      if (!displayNikud.test(source[i])) continue;
      pieces.push(source.slice(start, i)); start = i + 1;
      boundaries.push(i - removed.length); removed.push(i);
    }
    pieces.push(source.slice(start));
  }
  const text = removed.length ? pieces.join('') : source;
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
