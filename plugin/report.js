export const ENDPOINT = 'https://otzaria.org/api/reportingerrors';
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
  const location = `ספר: ${title}\nמיקום: ${ref}\nמספר שורה במקור: ${index + 1}`;
  const proposedDisplay = draft.proposed === '' ? '(מחיקה)' : draft.proposed;
  const fallback = `--- הצעת תיקון ---\nמקור: ${original}\nמוצע: ${proposedDisplay}`;
  const payload = {
    report_id: draft.id, sender_email: email, subject: `הצעת תיקון: ${title}`.slice(0, 500),
    book_title: title.slice(0, 300), current_ref: ref.slice(0, 300), line_number: index + 1,
    selected_text: original, error_details: `${location}\n\n${draft.note ? `${draft.note}\n\n` : ''}${fallback}`,
    context_text: line, file_path: draft.details.libraryPath ?? '',
    source_folder: draft.details.textSource?.key ?? '', library_version: 'unknown',
    created_at: draft.createdAt
  };
  // SDK source offsets refer to HTML-stripped text, not the raw DB line.
  // Use the existing free-text reporting contract rather than advertise a false DB correction range.
  canonical(payload);
  if (new TextEncoder().encode(JSON.stringify(payload)).length > 256 * 1024) throw new Error('הדיווח גדול מדי לשליחה.');
  return payload;
}

export async function sendReport(host, payload) {
  let status = 0, body = '';
  for await (const chunk of host.call('network.fetchStream', {
    url: ENDPOINT, method: 'POST', timeoutMs: 30000,
    headers: { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json' },
    body: JSON.stringify(payload)
  })) {
    if (chunk.type === 'response') status = chunk.status;
    if (chunk.type === 'data') body += chunk.body;
    if (body.length > 65536) throw new Error('התקבלה תשובה לא תקינה מהשרת. התיקון נשמר לניסיון חוזר.');
  }
  if (status !== 200) {
    const message = status === 409 ? 'מזהה הדיווח כבר שייך לתוכן אחר.' :
      status === 429 ? 'נשלחו יותר מדי דיווחים. נסו שוב מאוחר יותר.' :
      [400, 413, 422].includes(status) ? 'השרת דחה את הדיווח.' : 'השליחה לא הושלמה. נסו שוב.';
    const error = new Error(`${message} התיקון נשמר.`);
    error.status = status;
    throw error;
  }
  let response;
  try { response = JSON.parse(body); } catch { throw new Error('התקבלה תשובה לא תקינה מהשרת. התיקון נשמר לניסיון חוזר.'); }
  if (response?.success !== true) throw new Error('השרת לא אישר את קבלת הדיווח. התיקון נשמר.');
  // Intake success does not imply email delivery. Retry with the same report ID:
  // the server can retry its notification without creating another report.
  if (response.email_sent === false && response.duplicate !== true) {
    throw new Error('הדיווח נקלט באתר, אך האתר לא הצליח לשלוח את המייל לנמען. התיקון נשמר לניסיון חוזר.');
  }
  return response;
}
