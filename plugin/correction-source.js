import { sourceText } from './book.js';

export function officialReportBookId(book) {
  const id = book?.details?.id;
  const uid = book?.identity?.bookUid;
  return book?.details?.source === 'library' && book.details.type === 'text' &&
    Number.isSafeInteger(id) && id > 0 && uid === `id:${id}` ? id : null;
}

// Build offsets from the raw tokens, never search for a possibly repeated word.
// A boundary inside a decoded entity or a synthetic block-tag space is unsafe.
export function correctionForSource(raw, plain, start, end, proposed) {
  if (typeof raw !== 'string' || raw.length > 20000 || sourceText(raw) !== plain ||
      !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > plain.length) return null;
  const expected = plain.slice(0, start) + proposed + plain.slice(end);
  const tokens = [...raw.matchAll(/<[^>]*>|&(?:#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);|[^<&]+|[<&]/g)];
  const spans = []; let position = 0;
  for (const token of tokens) {
    const text = sourceText(token[0]);
    spans.push({ rawStart: token.index, rawEnd: token.index + token[0].length,
      start: position, end: position + text.length, text,
      tag: /^<[^>]*>$/.test(token[0]), entity: token[0].startsWith('&') && token[0].endsWith(';') });
    position += text.length;
  }
  if (spans.map(span => span.text).join('') !== plain) return null;
  function boundary(offset, isStart) {
    const candidates = spans.filter(span => !span.tag && span.text.length &&
      span.start <= offset && span.end >= offset);
    if (isStart) candidates.reverse();
    for (const span of candidates) {
      if (span.entity && offset !== span.start && offset !== span.end) continue;
      return offset === span.end ? span.rawEnd : span.entity ? span.rawStart : span.rawStart + offset - span.start;
    }
    return raw === '' && offset === 0 ? 0 : null;
  }
  const rawStart = boundary(start, true), rawEnd = start === end ? rawStart : boundary(end, false);
  if (rawStart == null || rawEnd == null || rawEnd < rawStart || /<[^>]*>/.test(raw.slice(rawStart, rawEnd))) return null;
  if (sourceText(raw.slice(0, rawStart)) !== plain.slice(0, start) ||
      sourceText(raw.slice(rawEnd)) !== plain.slice(end)) return null;
  // proposed_text replaces raw source text. Preserve literal &, < and > rather
  // than allow the replacement to create HTML or an unintended entity.
  const replacement = proposed.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const nextRaw = raw.slice(0, rawStart) + replacement + raw.slice(rawEnd);
  if (sourceText(nextRaw) !== expected) return null;
  const whole = start === end || (rawStart === 0 && rawEnd === raw.length);
  if ((whole ? nextRaw.length : replacement.length) > 20000) return null;
  return {
    original_line: raw,
    original_selection: whole ? null : raw.slice(rawStart, rawEnd),
    selection_offset: whole ? null : { unit: 'utf16_code_units', start: rawStart, end: rawEnd },
    proposed_text: whole ? nextRaw : replacement,
    context_before: whole ? '' : raw.slice(0, rawStart),
    context_after: whole ? '' : raw.slice(rawEnd)
  };
}

export function verifyQueuedCorrectionSources(queue, sourceBook) {
  for (const item of queue ?? []) {
    if (item.sent || !item.payload.correction) continue;
    const index = item.payload.location?.line_index;
    if (officialReportBookId(sourceBook) !== item.payload.location?.book_id ||
        sourceBook.rawLines?.[index] !== item.payload.correction.original_line) {
      throw new Error('מקור התיקון המובנה השתנה. הטיוטה נשמרה, אך אי אפשר לשלוח מול המקור המעודכן.');
    }
  }
}
