import { diffBook } from './changes.js';

function clampOffset(value, length) {
  return Math.min(length, Math.max(0, Number.isFinite(value) ? Math.trunc(value) : 0));
}
function safeBoundary(text, offset) {
  // The reader and textarea both use UTF-16, but a caret must not split emoji.
  return offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? '') && /[\uD800-\uDBFF]/.test(text[offset - 1]) ? offset - 1 : offset;
}

/** Map a source caret into the edited book. Insertions at the caret use right
 * affinity: the caret follows inserted text and remains next to its source.
 * Deleted/replaced positions clamp to the available replacement text. */
export function originalToEditedOffset(original, edited, offset) {
  const sourceOffset = safeBoundary(original, clampOffset(offset, original.length));
  let shift = 0;
  for (const change of diffBook(original, edited)) {
    if (sourceOffset < change.start) break;
    if (sourceOffset < change.end) {
      return safeBoundary(edited, change.start + shift + Math.min(sourceOffset - change.start, change.proposed.length));
    }
    shift += change.proposed.length - (change.end - change.start);
  }
  return safeBoundary(edited, clampOffset(sourceOffset + shift, edited.length));
}

/** Normalize context-menu selections, toolbar events, reader states and tab
 * metadata. Offsets are relative to the original source section. */
export function readerPosition(event = {}) {
  const selection = event?.selection ?? event ?? {};
  const data = selection.sections?.[0] ?? selection;
  const index = data.sectionIndex ?? data.currentIndex ?? data.index ?? event?.currentIndex ?? event?.index;
  const offset = data.sourceRange?.start?.utf16 ?? data.currentRange?.start?.utf16 ?? data.offset ?? 0;
  return {
    sectionIndex: Number.isSafeInteger(index) && index >= 0 ? index : 0,
    offset: Number.isSafeInteger(offset) && offset >= 0 ? offset : 0
  };
}

/** Numeric UTF-16 caret position in the full edited textarea. */
export function positionInBook(book, location, editedText = book.originalText) {
  const normalized = readerPosition(location);
  const sections = book.sections ?? [];
  const section = sections.find(item => item.index === normalized.sectionIndex)
    ?? sections[Math.min(normalized.sectionIndex, Math.max(0, sections.length - 1))];
  const originalOffset = section
    ? section.start + clampOffset(normalized.offset, section.end - section.start)
    : 0;
  return originalToEditedOffset(book.originalText, editedText, originalOffset);
}
