import { reportSha256 } from './report-digest.js';
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (loneSurrogate.test(value)) throw new Error('הטקסט מכיל תו פגום.');
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => canonical(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  throw new Error('נתוני הדיווח אינם תקינים.');
}

// SDK libraryPath omits the "אוצריא/" prefix and the extension. The site derives the
// repository path from the full relative path, so rebuild it (the site verifies it).
export function libraryRelativePath(libraryPath) {
  if (typeof libraryPath !== 'string' || !libraryPath.trim()) return '';
  const path = libraryPath.trim().replaceAll('\\', '/');
  return (path.startsWith('אוצריא/') ? path : `אוצריא/${path}`) + (/\.txt$/i.test(path) ? '' : '.txt');
}

export function validateSelection(selection, map) {
  if (selection.sections?.length > 1) throw new Error('לתיקון מדויק, סמנו קטע מתוך פסקה אחת.');
  if (selection.type && selection.type !== 'text') throw new Error('תיקוני טקסט זמינים לספרי טקסט בלבד.');
  if (selection.source && selection.source !== 'library') throw new Error('אפשר לדווח כאן על ספרים מספריית אוצריא בלבד.');
  const range = selection.sourceRange;
  const line = map.sourceText;
  const start = range?.start?.utf16;
  const end = range?.end?.utf16;
  if (range?.layer !== 'source' || typeof line !== 'string' ||
      !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > line.length ||
      line.slice(start, end) !== range.exactText ||
      (range.sourceTextHash && range.sourceTextHash !== map.sourceTextHash)) {
    throw new Error('לא ניתן לזהות את הקטע במקור במדויק. סמנו אותו שוב בספר.');
  }
  if (line.length > 20000 || range.exactText.length > 10000) throw new Error('הקטע ארוך מדי לדיווח. בחרו קטע קצר יותר.');
  return { line, start, end, original: range.exactText };
}

function reportDisplay(value, limit) {
  if (value.length <= limit) return value;
  let end = limit - 1;
  if (/[\uD800-\uDBFF]/u.test(value[end - 1])) end--;
  return value.slice(0, end) + '…';
}

export function reportContentDigest(payload) {
  const correction = payload.correction;
  return reportSha256(canonical({
    v: 1, report_kind: payload.report_kind, book_title: payload.book_title,
    current_ref: payload.current_ref, line_index: payload.location.line_index,
    selected_text: payload.selected_text, error_details: payload.error_details,
    context_text: payload.context_text, source_folder: payload.source_folder,
    file_path: payload.file_path, library_version: payload.library_version,
    correction: correction ? {
      original_line: correction.original_line, original_selection: correction.original_selection,
      proposed_text: correction.proposed_text, selection_offset: correction.selection_offset
    } : null
  }));
}

export async function buildReport(draft, email) {
  const { line, original } = draft.target;
  if (draft.proposed === original) throw new Error('לא בוצע שינוי בנוסח.');
  if (draft.proposed.length > 20000) throw new Error('הנוסח המתוקן ארוך מדי.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('הזינו כתובת מייל תקינה למענה.');
  const selection = draft.selection;
  const index = selection.sectionIndex ?? selection.currentIndex;
  if (!Number.isInteger(index) || index < 0) throw new Error('מיקום הקטע חסר. סמנו אותו מחדש.');
  const title = selection.bookTitle ?? selection.currentBook ?? selection.bookId;
  const ref = selection.currentRef?.trim() || `פסקה ${index + 1}`;
  const location = `ספר: ${title}\nמיקום: ${ref}\nמספר שורה במקור: ${index + 1}\nנשלח באמצעות תוסף תיקוני ספרים`;
  const correction = draft.correction ?? null;
  if (correction) {
    const range = correction.selection_offset;
    const raw = correction.original_line;
    if (typeof raw !== 'string' || raw.length > 20000 || typeof correction.proposed_text !== 'string' ||
        correction.proposed_text.length > 20000 ||
        (range ? range.unit !== 'utf16_code_units' || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
          range.start < 0 || range.end <= range.start || range.end > raw.length ||
          raw.slice(range.start, range.end) !== correction.original_selection ||
          raw.slice(0, range.start) !== correction.context_before || raw.slice(range.end) !== correction.context_after :
          correction.original_selection !== null || correction.context_before !== '' || correction.context_after !== '')) {
      throw new Error('טווח התיקון אינו תואם למקור הגולמי.');
    }
  }
  const filePath = libraryRelativePath(draft.details.libraryPath);
  const target = correction ? correction.original_selection ?? correction.original_line : original;
  const proposed = correction ? correction.proposed_text : draft.proposed;
  const proposedDisplay = proposed === '' ? '(מחיקה)' : proposed;
  const fallback = `--- הצעת תיקון ---\nמקור: ${target}\nמוצע: ${proposedDisplay}`;
  const payload = {
    report_id: draft.id, sender_email: email, subject: reportDisplay(`הצעת תיקון: ${title}`, 500),
    book_title: reportDisplay(title, 300), current_ref: reportDisplay(ref, 300), line_number: index + 1,
    selected_text: reportDisplay(original, 10000), error_details: `${location}\n\n${draft.note ? `${draft.note}\n\n` : ''}${fallback}`,
    context_text: reportDisplay(correction ? correction.original_line : line, 20000), file_path: filePath,
    source_folder: draft.details.textSource?.key ?? '', library_version: 'unknown',
    created_at: draft.createdAt,
    schema_version: 2, report_kind: correction ? 'text_correction' : 'free_text',
    location: { line_index: index, book_id: draft.sourceBookId ?? null, library_build_id: null, he_ref: null },
    source_hint: { source_folder: draft.details.textSource?.key ?? '',
      library_relative_path: filePath, repo_path: null },
    client: draft.client ?? null,
    ...(correction ? { correction } : {})
  };
  // Digest and correction have the same contract as DirectErrorReport in 0.9.98.
  // A missing library build/heRef remains null: the existing SDK does not expose it.
  payload.content_digest = '0'.repeat(64);
  canonical(payload);
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 256 * 1024) throw new Error('הדיווח גדול מדי לשליחה.');
  payload.content_digest = reportContentDigest(payload);
  return payload;
}

// Otzaria sends the report itself (feedback.submitBookCorrection), so the plugin needs no network access.
export async function deliverReport(call, item) {
  let result;
  try { result = await call('feedback.submitBookCorrection', item.submission); }
  catch (error) {
    if (error.code === 'error.report_id_conflict') error.status = 409;
    throw error;
  }
  if (result?.status !== 'sent') throw new Error('אוצריא לא אישרה את קבלת הדיווח. התיקון נשמר.');
  return item.payload.report_kind === 'text_correction' && result.correctionSupported === true;
}

export function reportDeliveryMessage(queue) {
  const sent = queue.filter(item => item.sent);
  const structured = sent.filter(item => item.payload.report_kind === 'text_correction' && item.correctionSupported === true).length;
  const unconfirmed = sent.filter(item => item.payload.report_kind === 'text_correction' && item.correctionSupported !== true).length;
  const free = sent.length - structured - unconfirmed;
  const parts = [];
  if (structured) parts.push(`${structured} הצעות תיקון מובנות אושרו באתר`);
  if (free) parts.push(`${free} הצעות נשלחו כדיווח חופשי עם מקור ונוסח מוצע`);
  if (unconfirmed) parts.push(`${unconfirmed} הצעות נשלחו, אך האתר לא אישר קליטה כתיקון מובנה`);
  return `כל ${sent.length} הדיווחים נשלחו בהצלחה. ${parts.join('; ')}. התיקונים ממתינים לבדיקה ידנית.`;
}
