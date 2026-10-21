import { createRpcCall } from './rpc.js';
import { createCorrectionStore } from './correction-store.js';
import { createSessionController, codeOf } from './correction-sessions.js';
import { submitItem, deliveryLabel, legacyDeliveryLabel } from './correction-submit.js';
import { readLegacyDrafts, readLegacyHistory } from './legacy-drafts.js';
import { loadBook, sourceText } from './book.js';
import { mergeProposals } from './text-diff.js';
import { createReaderMarks, marksEnabled, MARK_SETTING_KEY } from './reader-marks.js';
import { appendFormattedDiff } from './book-format.js';
const el = id => document.getElementById(id), host = window.Otzaria;
const call = host ? createRpcCall(host) : async () => { throw new Error('יש לפתוח את התוסף מתוך אוצריא.'); };
const store = createCorrectionStore(call);
let state = { books: new Map() }, legacy = { drafts: [], failures: [] }, legacyHistory = [], openTabs = [];
let busy = false, renderQueued = false, statusTimer, startInitialization, initialized, embedded = null;
// A reader click wakes a background instance (app.run_on_startup) without
// leaving the book; it has no visible page, so its messages go to Otzaria.
let background = false;
const mainScreens = ['work', 'history', 'settings'];
let currentScreen = 'work', lastMainScreen = 'work', reporterHasEmail = null;
const screenScroll = new Map();
// Pending proposals are marked green in the reader (a setting, on by default).
const marks = createReaderMarks(call);
let marksOn = true, highlightGranted = true, refCheck = 0;
const reasons = {
  source_changed: 'המקור השתנה מאז התיקון', not_found: 'הפסקה אינה קיימת עוד בספר',
  invalid: 'הנתונים פגומים או שההצעה אינה נתמכת', displaced: 'עריכה שלא נשמרה בחלון שאיבד את הבעלות על הספר',
  paragraph_boundaries: 'השינוי מוסיף או מוחק מעבר פסקה', unsupported_text: 'ההצעה כוללת תגיות או ישויות HTML',
  too_long: 'הפסקה המתוקנת ארוכה מהמותר'
};
const endReasons = { user: 'העריכה הסתיימה בקורא', explicit: 'העריכה הסתיימה מהתוסף', tab_closed: 'הלשונית נסגרה',
  plugin_unavailable: 'התוסף הושבת או שהרשאת העריכה בוטלה', window_closed: 'החלון נסגר', app_exit: 'אוצריא נסגרה',
  ownership_lost: 'הספר נפתח לעריכה בחלון אחר; השינויים שלא נשמרו נשמרו כהתנגשויות' };
const errorText = error => ({
  correction_busy: 'הספר כבר בעריכה בלשונית או בחלון אחר.',
  unsupported_context: 'אפשר לתקן רק ספר טקסט מספריית אוצריא, בתצוגת מפרשים בצד או מתחת (לא בצורת הדף).',
  storage_failed: 'אוצריא לא הצליחה לקרוא או לשמור את הטיוטה כעת. הטיוטה לא השתנתה; נסו שוב.',
  revision_conflict: 'הנוסח בקורא השתנה בזמן הפעולה. בדקו את המצב העדכני ונסו שוב.',
  source_changed: 'המקור הנוכחי שונה מהנוסח שעליו נעשה התיקון. לא הוחל דבר.',
  not_found: 'הלשונית או הסשן אינם קיימים עוד.'
}[codeOf(error)] ?? error.message);

function notify(text, error = false) {
  if (background || document.visibilityState === 'hidden') call(error ? 'ui.showError' : 'ui.showMessage', { message: text }).catch(() => {});
  message(text, error, error ? 0 : 6000);
}
function message(text = '', error = false, duration = 0) {
  clearTimeout(statusTimer);
  el('status').textContent = text; el('status').classList.toggle('error', error);
  if (duration) statusTimer = setTimeout(() => message(), duration);
}
function applyTheme(theme) {
  if (!theme?.colorScheme) return;
  for (const [key, color] of Object.entries(theme.colorScheme)) {
    if (typeof color === 'string' && /^#[\da-f]{6,8}$/i.test(color)) document.documentElement.style.setProperty(`--${key}`, color);
  }
  const t = theme.typography;
  if (t) {
    document.documentElement.style.setProperty('--font-ui', `${JSON.stringify(t.uiFontFamily ?? 'Rubik')}, system-ui, sans-serif`);
    document.documentElement.style.setProperty('--font-main', `${JSON.stringify(t.fontFamily ?? 'FrankRuhlCLM')}, serif`);
  }
  document.documentElement.style.colorScheme = theme.mode;
}
function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}
function button(label, action, { ghost = true, key, disabled = false, describe } = {}) {
  const item = node('button', ghost ? 'ghost' : '', label); item.type = 'button';
  if (key) item.dataset.focusKey = key;
  if (describe) item.setAttribute('aria-label', describe);
  item.disabled = disabled || busy;
  item.addEventListener('click', () => run(action));
  return item;
}
async function confirm(title, content) {
  try { return (await call('ui.showConfirm', { title, content }))?.confirmed === true; }
  catch (error) {
    if (codeOf(error) === 'timeout') throw new Error('לא התקבל אישור בזמן. לחצו שוב על הפעולה ואשרו בחלון של אוצריא.');
    throw error;
  }
}
function showScreen(name, focus = false) {
  if (![...mainScreens, 'report'].includes(name)) return;
  screenScroll.set(currentScreen, el('panel').scrollTop ?? 0);
  if (name !== currentScreen) message();
  currentScreen = name;
  if (mainScreens.includes(name)) lastMainScreen = name;
  for (const screen of [...mainScreens, 'report']) el(`screen-${screen}`).hidden = screen !== name;
  for (const screen of mainScreens) {
    const tab = el(`nav-${screen}`);
    tab.setAttribute('aria-selected', String(screen === name));
    tab.tabIndex = screen === name || (name === 'report' && screen === lastMainScreen) ? 0 : -1;
  }
  el('panel').scrollTop = screenScroll.get(name) ?? 0;
  if (focus && mainScreens.includes(name)) el(`nav-${name}`).focus();
  if (name === 'report') afterBoot(async () => {
    const result = await call('feedback.hasReporterEmail');
    reporterHasEmail = typeof result === 'boolean' ? result : result?.hasEmail === true;
    el('report-email-area').hidden = reporterHasEmail;
    el('report-email-note').textContent = reporterHasEmail ? 'אוצריא תצרף את כתובת המייל השמורה בהגדרות הדיווח שלה.' : 'אפשר להוסיף כתובת לחזרה, או לשלוח בלי כתובת מייל.';
  }).catch(() => { reporterHasEmail = null; el('report-email-area').hidden = false; });
}
function renderReport() {
  for (const id of ['report-details', 'report-type', 'report-email']) el(id).disabled = busy;
  el('report-send').disabled = busy || !String(el('report-details').value ?? '').trim();
}
async function reportToDeveloper() {
  const details = String(el('report-details').value ?? '').trim();
  if (!details) { el('report-details').focus(); throw new Error('כתבו את תוכן הדיווח לפני השליחה.'); }
  if (details.length > 5000) throw new Error('הדיווח יכול להכיל עד 5,000 תווים.');
  const email = reporterHasEmail === true ? '' : String(el('report-email').value ?? '').trim();
  if (email && el('report-email').checkValidity && !el('report-email').checkValidity()) throw new Error('כתובת המייל אינה תקינה.');
  const result = await call('feedback.report', { details, reportType: el('report-type').value || 'bug', ...(email ? { reporterEmail: email } : {}) });
  if (result === 'sent' || result === 'queued') {
    el('report-details').value = '';
    message(result === 'sent' ? 'הדיווח למפתח נשלח דרך מערכת הדיווחים של אוצריא.' : 'הדיווח למפתח נשמר בתור של אוצריא ויישלח כשיתאפשר.', false);
  } else if (result === 'cancelled') message('שליחת הדיווח בוטלה. הנוסח נשמר כאן לעריכה.');
  else throw new Error('לא התקבל אישור לשליחת הדיווח. הנוסח נשמר; בדקו באוצריא לפני ניסיון נוסף.');
}
// One user operation at a time in this page; session operations are also
// serialized inside the controller.
let operations = Promise.resolve();
function run(action) {
  operations = operations.then(async () => {
    busy = true; render();
    try { await action(); } catch (error) { notify(errorText(error), true); }
    finally { busy = false; await reload().catch(error => message(error.message, true)); }
  });
  return operations;
}
function scheduleRender() {
  if (renderQueued) return; renderQueued = true;
  queueMicrotask(() => { renderQueued = false; render(); });
}
const controller = createSessionController({ call, store, onChange: () => { reload().catch(error => message(error.message, true)); },
  onNotice: (kind, snapshot, error) => {
    if (kind === 'save-failed') message(`שמירת הטיוטה בתוסף נכשלה (${error.message}). הטיוטה נשארה באוצריא ותישמר שוב בהמשך.`, true);
    if (kind === 'pending-save') message('אוצריא עדיין שומרת את הטיוטה. היא תיקלט בתוסף בפתיחה הבאה או ברענון.');
  } });
// Coalesced, but a request during a read always causes a fresh read after it.
let reloading = null, reloadAgain = false;
async function reload() {
  if (reloading) { reloadAgain = true; return reloading; }
  reloading = (async () => {
    try {
      do {
        reloadAgain = false;
        state = await store.load();
        legacy = await readLegacyDrafts(call);
        legacyHistory = await readLegacyHistory(call).catch(() => []);
      } while (reloadAgain);
    } finally { reloading = null; }
    scheduleRender();
    syncMarks();
  })();
  return reloading;
}
function syncMarks() {
  if (highlightGranted) marks.sync(state, marksOn).catch(() => {});
}
async function setMarks(enabled) {
  await call('storage.set', { key: MARK_SETTING_KEY, value: enabled });
  marksOn = enabled;
  if (!enabled) await marks.clearAll();
  syncMarks();
  message(enabled ? 'התיקונים הממתינים יסומנו בירוק בספר.' : 'סימון התיקונים בספר כובה.', false, 5000);
}
// While the user reads, another instance may have changed the marks (sent,
// dismissed, setting): redraw then. One cheap check every few seconds.
async function checkMarks() {
  const now = Date.now();
  if (!highlightGranted || now - refCheck < 3000) return;
  refCheck = now;
  if (!await marks.outdated()) return;
  marksOn = await marksEnabled(call);
  if (!marksOn) await marks.clearAll();
  await reload();
}
async function refreshTabs() {
  const current = await call('reader.getCurrentState').catch(() => null);
  openTabs = (current?.openTabs ?? []).map((tab, index) => ({ ...tab, index })).filter(tab => typeof tab.tabId === 'string');
  // Adopt sessions this plugin owns that started before the page loaded.
  for (const tab of openTabs) {
    if (tab.correctionSessionId && !controller.sessions.has(tab.correctionSessionId)) await controller.changed({ sessionId: tab.correctionSessionId });
  }
  scheduleRender();
}
async function activateTab(tabId) {
  const current = await call('reader.getCurrentState');
  const index = current?.openTabs?.findIndex(tab => tab.tabId === tabId) ?? -1;
  if (index >= 0) await call('reader.activateTab', { index });
}
async function beginFor(tabId) {
  const snapshot = await controller.begin(tabId);
  const restored = snapshot.recovery?.restoredSectionIndices?.length ?? 0;
  const conflicts = snapshot.recovery?.conflicts?.length ?? 0;
  if (snapshot.recovery) notify(`שוחזרה טיוטה: ${restored} פסקאות מוצגות בקורא${conflicts ? `, ${conflicts} התנגשויות ממתינות להחלטה בדף התוסף` : ''}.`);
  else message('העריכה פעילה בקורא.', false, 6000);
  // From the page's own list the reader tab is brought forward; a click in
  // the reader is already there.
  if (!background && document.visibilityState !== 'hidden') await activateTab(tabId).catch(() => {});
  await refreshTabs();
}
const sameBook = (tab, event) => {
  const uid = event.bookUid ?? event.selection?.bookUid ?? (event.currentId != null ? `id:${event.currentId}` : null);
  return uid ? tab.bookUid === uid || (tab.id != null && `id:${tab.id}` === uid) : tab.bookId === (event.currentBookId ?? event.currentBook);
};
// Toolbar clicks carry no tabId (host gap); only an unambiguous tab is used.
async function tabForToolbar(event) {
  const current = await call('reader.getCurrentState');
  if (current?.currentTabId && sameBook({ bookUid: current.bookUid, id: current.currentId, bookId: current.currentBookId }, event)) return current.currentTabId;
  const candidates = (current?.openTabs ?? []).filter(tab => tab.tabId && sameBook(tab, event));
  if (candidates.length === 1) return candidates[0].tabId;
  await refreshTabs();
  throw new Error(candidates.length ? 'הספר פתוח בכמה לשוניות. בחרו את הלשונית ברשימה, או לחצו לחיצה ימנית בתוך הלשונית ובחרו „תיקון הספר בקורא”.' : 'לא נמצאה לשונית טקסט של הספר. פתחו את הספר בקורא ונסו שוב.');
}
// A click on a closed plugin can arrive before plugin.boot: wait for it.
const initializationStarted = new Promise(resolve => { startInitialization = resolve; });
const afterBoot = task => initializationStarted.then(() => initialized).then(task);
function requestEdit(event, fromToolbar) {
  if (!['correct-book', 'correct-selection', 'send-book-corrections'].includes(event?.itemId)) return;
  afterBoot(() => run(async () => {
    if (event.itemId === 'send-book-corrections') {
      await refreshTabs();
      const candidates = openTabs.filter(tab => sameBook(tab, event));
      const bookUid = event.bookUid ?? event.selection?.bookUid ?? (event.currentId != null ? `id:${event.currentId}` : null) ?? (candidates.length === 1 ? candidates[0].bookUid : null);
      if (!bookUid) throw new Error('לא זוהה הספר לשליחה. לחצו לחיצה ימנית בתוך הספר ונסו שוב.');
      const live = liveFor(bookUid);
      if (live && !(await controller.save(live.snapshot.sessionId)).saved) throw new Error('שמירת התיקונים עדיין לא הושלמה. נסו שוב לאחר שמירת הטיוטה.');
      await reload();
      const pending = state.books.get(bookUid)?.pending ?? [];
      if (!pending.length) { notify('אין תיקונים ממתינים לשליחה בספר הזה.'); return; }
      if (!await confirm('שליחת תיקוני הספר', `לשלוח ${pending.length} הצעות תיקון מהספר? הדיווחים יישלחו עם כתובת המייל המוגדרת בדיווח השגיאות של אוצריא. הספר המקומי אינו משתנה.`)) return;
      await sendItems(bookUid, pending.map(item => item.sectionIndex));
      return;
    }
    const tabId = event.selection?.tabId ?? event.tabId ?? (fromToolbar || !event.selection ? await tabForToolbar(event) : null);
    if (!tabId) throw new Error('לא זוהתה לשונית הספר. לחצו לחיצה ימנית בתוך הספר ובחרו „תיקון הספר בקורא”.');
    await beginFor(tabId);
  })).catch(error => notify(errorText(error), true));
}
async function ensureEmail() {
  const result = await call('feedback.hasReporterEmail');
  if (result?.hasEmail === false || result === false) throw new Error('לפני השליחה יש לשמור כתובת מייל בהגדרות דיווח השגיאות של אוצריא.');
}
// A proposal of a session that began but was never seen ending (its end event
// was lost and no draft identifies it) may have been reset in the reader. The
// contract has no record of that; the user decides before it is sent.
function uncertain(item, bookUid) {
  if (!item.openSession) return false;
  const live = controller.sessions.get(item.openSession);
  if (live && !live.ended) return false;
  return ![...controller.activeElsewhere.values()].some(meta => meta.bookUid === bookUid);
}
function liveFor(bookUid) {
  return [...controller.sessions.values()].find(item => !item.ended && item.snapshot.bookUid === bookUid) ?? null;
}
async function sendItems(bookUid, keys) {
  await ensureEmail();
  const live = liveFor(bookUid);
  if (live) {
    const saved = await controller.save(live.snapshot.sessionId);
    if (!saved.saved) throw new Error('שמירת התיקונים עדיין לא הושלמה. נסו שוב לאחר שמירת הטיוטה.');
  }
  let sent = 0, queued = 0, kept = 0, book = null, queue = [];
  // One storage read per batch; re-read only after an ID conflict changed an item.
  const load = async () => {
    state = await store.load(); book = state.books.get(bookUid);
    queue = (book?.pending ?? []).filter(candidate => keys.includes(candidate.sectionIndex));
  };
  await load();
  for (;;) {
    const item = queue.shift();
    if (!item) break;
    const attempt = async freeText => submitItem({ call, store, book, item, freeText });
    const peers = samePeers(book, item);
    if (peers.length > 1 && peers[0] === item && !await confirm('כמה הצעות לאותה פסקה', `לפסקה ${item.sectionIndex + 1} יש ${peers.length} הצעות נפרדות. אם יישלחו בנפרד, אחרי שהאתר יחיל את הראשונה ייתכן שהאחרות יידחו כי נוסח הפסקה השתנה. מומלץ לאחד אותן קודם („איחוד לדיווח אחד”). לשלוח בנפרד בכל זאת?`)) {
      kept += peers.length; keys = keys.filter(index => index !== item.sectionIndex);
      queue = queue.filter(other => other.sectionIndex !== item.sectionIndex); continue;
    }
    if (uncertain(item, bookUid) && !await confirm('תיקון שמצבו בקורא אינו ידוע', `העריכה שבה נוצר התיקון לפסקה ${item.sectionIndex + 1} הסתיימה בלי שהתוסף קיבל את מצבה הסופי. ייתכן שהתיקון בוטל בקורא. לשלוח אותו בכל זאת?`)) {
      kept++; keys = keys.filter(index => index !== item.sectionIndex); continue;
    }
    let result = await attempt(false);
    if (result.status === 'needs_decision') {
      const free = await confirm('התיקון דורש בדיקה ידנית', `אוצריא לא הצליחה להכין תיקון מובנה לפסקה ${item.sectionIndex + 1}. זה עשוי לקרות בשינוי שחוצה תגיות עיצוב או בפסקה ארוכה מדי. אפשר לשלוח את המקור וההצעה כדיווח חופשי לבדיקה ידנית; אופן הטיפול תלוי במקור הספר ובשרת. לשלוח לבדיקה ידנית? ביטול ישאיר את ההצעה שמורה.`);
      result = free ? await attempt(true) : { status: 'kept' };
    }
    if (result.status === 'id_conflict') {
      const again = await confirm('מזהה הדיווח כבר בשימוש', 'דיווח עם אותו מזהה ותוכן שונה כבר קיים בתור של אוצריא או באתר. ייתכן שהוא כבר נשלח. ליצור דיווח חדש עם מזהה חדש?');
      // Consent is recorded durably; refusing leaves the question open.
      if (again) { await store.consentNewReportId(bookUid, item); await load(); continue; }
      result = { status: 'kept' };
    }
    if (result.status === 'email_required') throw new Error('לפני השליחה יש לשמור כתובת מייל בהגדרות דיווח השגיאות של אוצריא.');
    if (result.status === 'source_changed') notify(`המקור של פסקה ${item.sectionIndex + 1} השתנה; התיקון לא נשלח ונשמר.`, true);
    if (result.status === 'sent') sent++; else if (result.status === 'queued') queued++; else kept++;
    if (!['sent', 'queued'].includes(result.status)) keys = keys.filter(index => index !== item.sectionIndex);
  }
  const parts = [];
  if (sent) parts.push(`${sent} נשלחו דרך אוצריא`); if (queued) parts.push(`${queued} נשמרו בתור של אוצריא וטרם נשלחו לאתר`);
  if (kept) parts.push(`${kept} נשארו לטיפול`);
  if (parts.length) notify(parts.join('; ') + '.', kept > 0 && !sent && !queued);
  // Remove fully handled versions only when no live session can still add to them.
  if (!liveFor(bookUid)) await store.compact(await store.load(), bookUid).catch(() => 0);
}
// Several independent proposals for one paragraph (from different editing
// sessions) are merged into one wording and shown in the reader; once that is
// saved it replaces them, so the site receives one report for the paragraph.
function samePeers(book, item) {
  return book.pending.filter(other => other.sectionIndex === item.sectionIndex && other.originalSourceText === item.originalSourceText);
}
async function mergeParagraph(bookUid, items) {
  const live = liveFor(bookUid);
  if (!live) throw new Error('כדי לאחד, התחילו קודם עריכה של הספר בקורא (לחיצה ימנית ← „תיקון הספר בקורא”).');
  const merged = mergeProposals(items[0].originalText, items.map(item => item.proposedText));
  if (merged === null) throw new Error(`ההצעות לפסקה ${items[0].sectionIndex + 1} משנות את אותן מילים, ולכן אי אפשר לאחד אותן אוטומטית. ערכו את הפסקה בקורא ובחרו נוסח אחד.`);
  const { sectionIndex, originalSourceText, originalText } = items[0];
  await controller.restore(live.snapshot.sessionId, [{ sectionIndex, originalSourceText, originalText, proposedText: merged }]);
  // The originals stay listed until the merged wording is saved.
  const saved = await controller.save(live.snapshot.sessionId);
  message(saved.saved ? `ההצעות לפסקה ${sectionIndex + 1} אוחדו לנוסח אחד, מוצג בקורא ונשמר בתוסף.`
    : `ההצעות לפסקה ${sectionIndex + 1} אוחדו ומוצגות בקורא. ההצעות הנפרדות יוחלפו אחרי שהשמירה תושלם.`, !saved.saved, 6000);
}
async function restoreConflict(bookUid, conflict) {
  const live = liveFor(bookUid);
  if (!live) throw new Error('כדי להחזיר את התיקון, התחילו קודם עריכה של הספר בקורא.');
  await controller.restore(live.snapshot.sessionId, [conflict]);
  // The conflict stays visible until a saved version contains the restored
  // proposal; a host write failure or crash leaves it actionable.
  const saved = await controller.save(live.snapshot.sessionId);
  message(saved.saved ? `התיקון לפסקה ${conflict.sectionIndex + 1} הוחזר לקורא ונשמר בתוסף.`
    : `התיקון לפסקה ${conflict.sectionIndex + 1} הוחזר לקורא. ההתנגשות תוסר מהרשימה רק אחרי שהשמירה תושלם.`, !saved.saved, 6000);
}
async function migrateLegacy(draft) {
  const bookUid = draft.bookUid, live = bookUid ? liveFor(bookUid) : null;
  if (!live) throw new Error('כדי להעביר את הטיוטה, התחילו קודם עריכה של הספר בקורא.');
  const resolved = state.books.get(bookUid)?.resolutions ?? new Map();
  const items = draft.mapped.filter(change => !resolved.has(change.key));
  if (!items.length) return;
  message('בודק את המקור הנוכחי של הספר…');
  const book = await loadBook(call, { bookId: draft.bookId, bookUid }, undefined, { includeRaw: true });
  if (!book.rawLines) throw new Error('לא ניתן למפות את המקור הגולמי של הספר במדויק. הטיוטה נשמרה כפי שהיא.');
  const ready = [], changed = [];
  for (const change of items) {
    const raw = book.rawLines[change.sectionIndex];
    if (typeof raw === 'string' && sourceText(raw) === change.originalText) ready.push({ ...change, originalSourceText: raw });
    else changed.push(change.sectionIndex + 1);
  }
  let durable = 0;
  if (ready.length) {
    await controller.restore(live.snapshot.sessionId, ready);
    // Marked migrated only once a saved version contains the change; until
    // then the 0.2.2 item stays listed (and its legacy keys are never touched).
    await controller.save(live.snapshot.sessionId);
    const changes = (await store.load()).books.get(bookUid)?.durableChanges ?? [];
    for (const change of ready) {
      if (!changes.some(saved => legacyCovered(change, saved))) continue;
      await store.resolve(bookUid, change.key, 'migrated'); durable++;
    }
  }
  if (durable < ready.length) message(`${ready.length} תיקונים הועברו לקורא; ${ready.length - durable} יסומנו כמועברים רק אחרי שהשמירה תושלם.`, true, 8000);
  else message(`${ready.length} תיקונים הועברו לקורא.${changed.length ? ` בפסקאות ${changed.join(', ')} המקור השתנה; הן נשארות בטיוטה הקודמת להחלטתכם.` : ''}`, changed.length > 0, 8000);
}
const legacyCovered = (change, saved) => saved.sectionIndex === change.sectionIndex && saved.originalText === change.originalText && saved.proposedText === change.proposedText;
async function sendLegacyReport(draft, report) {
  await ensureEmail();
  const bookUid = draft.bookUid ?? `legacy:${draft.bookId}`;
  if (report.submission.forceFreeText && !await confirm('שליחה לבדיקה ידנית', 'הדיווח הזה הוכן בגרסה הקודמת כדיווח חופשי עם המקור וההצעה. אופן הטיפול בו תלוי במקור הספר ובשרת. לשלוח לבדיקה ידנית?')) return;
  const { allowQueue, forceFreeText, ...submission } = report.submission;
  const params = { ...submission, allowQueue: true, ...(forceFreeText ? { forceFreeText: true } : { requireTextCorrection: true }) };
  await store.recordSubmission(bookUid, report.key, report.reportId, 'attempt');
  let result;
  try { result = await call('feedback.submitBookCorrection', params); }
  catch (error) {
    if (codeOf(error) === 'report_id_conflict') throw new Error('דיווח עם אותו מזהה ותוכן שונה כבר קיים — ייתכן שהגרסה הקודמת כבר שלחה אותו לאתר. בדקו וסמנו כטופל במקום לשלוח שוב.');
    if (codeOf(error) === 'text_correction_unavailable') throw new Error('אי אפשר לשלוח את הדיווח הזה כתיקון מובנה. העבירו את התיקון לקורא ותקנו אותו שם, או סמנו אותו כטופל.');
    throw error;
  }
  const record = { reportId: result.reportId ?? report.reportId, reportKind: result.reportKind, correctionSupported: result.correctionSupported ?? null, status: result.status, duplicate: result.duplicate === true };
  await store.recordSubmission(bookUid, report.key, record.reportId, result.status, { result: record });
  await store.resolve(bookUid, report.key, result.status, { result: record, title: draft.title,
    ...(Number.isInteger(report.sectionIndex) ? { sectionIndex: report.sectionIndex } : {}), originalText: report.original, proposedText: report.proposed });
  message(deliveryLabel(record), false, 6000);
}

function renderLive() {
  const cards = [];
  for (const item of controller.sessions.values()) {
    if (item.ended && item.saved) continue;
    const snapshot = item.snapshot, card = node('article', 'card');
    card.append(node('h3', '', snapshot.bookId));
    const draft = snapshot.draft ?? {};
    const saved = item.ended ? (item.saved ? 'נקלט בתוסף' : item.error ? `לא נקלט בתוסף: ${item.error}` : 'ממתין לשמירה באוצריא') :
      draft.error ? `שמירת הטיוטה באוצריא נכשלה: ${draft.error}` : draft.persisted ? 'הטיוטה נשמרה באוצריא' : 'שומר טיוטה…';
    card.append(node('p', '', `${item.ended ? endReasons[item.reason] ?? 'העריכה הסתיימה' : 'בעריכה בקורא'} · ${snapshot.changes.length} פסקאות מתוקנות · ${saved}`));
    if (!item.ended) {
      const actions = node('div', 'actions');
      actions.append(button('חזרה לקורא', () => activateTab(snapshot.tabId), { key: `go:${snapshot.sessionId}`, ghost: false }),
        button('שמירה ושליחה', () => sendItems(snapshot.bookUid, snapshot.changes.map(change => change.sectionIndex)),
          { key: `send-live:${snapshot.sessionId}`, disabled: !snapshot.changes.length }),
        button('סיום עריכה', async () => { await controller.end(snapshot.sessionId); message('העריכה הסתיימה והתיקונים נקלטו בתוסף.', false, 5000); }, { key: `end:${snapshot.sessionId}` }));
      card.append(actions);
    }
    cards.push(card);
  }
  for (const meta of controller.activeElsewhere.values()) {
    const card = node('article', 'card'); card.append(node('h3', '', meta.bookId), node('p', '', 'בעריכה בלשונית או בחלון אחר. התיקונים ייקלטו בסיום העריכה שם.'));
    cards.push(card);
  }
  el('live-list').replaceChildren(...cards);
  const editing = new Set([...controller.sessions.values()].filter(item => !item.ended).map(item => item.snapshot.tabId));
  const rows = openTabs.filter(tab => tab.type === 'text' && !editing.has(tab.tabId)).map(tab => {
    const row = node('div', 'row'); row.append(node('span', 'grow', `${tab.book ?? tab.bookId}${tab.currentRef ? ` — ${tab.currentRef}` : ''}`),
      button('עריכה בקורא', () => beginFor(tab.tabId), { key: `begin:${tab.tabId}`, describe: `עריכת ${tab.book ?? tab.bookId} בקורא` }));
    return row;
  });
  el('tab-list').replaceChildren(...rows);
  el('tab-list').hidden = !rows.length && cards.length > 0;
  if (!rows.length && !cards.length) el('tab-list').append(node('p', '', 'פתחו ספר טקסט באוצריא כדי להתחיל לתקן.'),
    node('p', 'hint', 'אפשר להתחיל גם מתוך הספר: לחיצה ימנית ← תיקון הספר בקורא. לשליחה בלי לפתוח את התוסף: שליחת תיקוני הספר בסרגל הקורא.'));
}
// Like Otzaria's TextCorrectionDiffView: one bordered box, removed words
// struck through on errorContainer, added words bold on primaryContainer.
function diffView(before, after, raw) {
  const box = node('div', 'diff');
  appendFormattedDiff(box, before ?? '', after ?? '', raw);
  // A long paragraph scrolls inside the box; start at the first change.
  queueMicrotask(() => {
    const first = box.querySelector?.('del, ins');
    if (first && box.scrollHeight > box.clientHeight) box.scrollTop = Math.max(0, first.offsetTop - box.offsetTop - 24);
  });
  return box;
}
function changeView(item) {
  const view = node('div', 'change');
  view.append(node('strong', '', `פסקה ${item.sectionIndex + 1}`), diffView(item.originalText, item.proposedText, item.originalSourceText));
  if (item.proposedText === '') view.append(node('p', 'hint', '(מחיקת הפסקה)'));
  return view;
}
function renderBooks() {
  const cards = [];
  let pendingCount = 0, conflictCount = 0;
  for (const book of state.books.values()) {
    pendingCount += book.pending.length;
    conflictCount += book.conflicts.length;
    if (!book.pending.length && !book.conflicts.length) continue;
    const card = node('article', 'card'), live = liveFor(book.bookUid);
    card.append(node('h3', '', book.bookId ?? book.bookUid));
    if (book.pending.length) {
      const header = node('div', 'row');
      header.append(node('span', 'grow', `${book.pending.length} תיקונים ממתינים לשליחה`),
        button('שלח הכל', () => sendItems(book.bookUid, book.pending.map(item => item.sectionIndex)), { ghost: false, key: `send:${book.bookUid}`, describe: `שליחת ${book.pending.length} התיקונים של ${book.bookId ?? book.bookUid}` }));
      if (live) {
        // One proposal per paragraph can be shown in the reader at a time.
        const hidden = book.pending.filter((item, index, all) => !live.snapshot.changes.some(change => change.sectionIndex === item.sectionIndex) &&
          all.findIndex(other => other.sectionIndex === item.sectionIndex) === index);
        if (hidden.length) header.append(button('הצג בקורא', () => controller.restore(live.snapshot.sessionId, hidden), { key: `show:${book.bookUid}` }));
      }
      card.append(header);
      for (const item of book.pending) {
        const view = changeView(item), actions = node('div', 'actions');
        const peers = samePeers(book, item);
        if (peers.length > 1 && peers[0] === item) {
          const note = node('div', 'row');
          note.append(node('span', 'grow reason', `לפסקה זו יש ${peers.length} הצעות נפרדות. מומלץ לאחד אותן לדיווח אחד.`),
            button('איחוד לדיווח אחד', () => mergeParagraph(book.bookUid, peers), { key: `merge:${item.key}`, disabled: !live,
              describe: `איחוד ${peers.length} ההצעות לפסקה ${item.sectionIndex + 1} לנוסח אחד בקורא` }));
          view.append(note);
          if (!live) view.append(node('p', 'hint', 'כדי לאחד, התחילו קודם עריכה של הספר בקורא.'));
        }
        if (uncertain(item, book.bookUid)) view.append(node('p', 'reason', 'העריכה הסתיימה בלי שהתוסף קיבל את מצבה הסופי; ייתכן שהתיקון בוטל בקורא. לפני שליחה תתבקשו לאשר.'));
        if (item.idConflict) view.append(node('p', 'reason', 'מזהה הדיווח כבר שייך לתוכן אחר. שליחה תבקש את אישורכם ליצירת מזהה חדש.'));
        if (item.submission?.status === 'attempt') view.append(node('p', 'hint', 'שליחה קודמת לא הסתיימה בוודאות; שליחה חוזרת תשתמש באותו מזהה ולא תיצור כפילות.'));
        actions.append(button('שלח', () => sendItems(book.bookUid, [item.sectionIndex]), { key: `send:${item.key}` }),
          button('מחק הצעה', async () => { if (await confirm('מחיקת הצעה', `למחוק את ההצעה לפסקה ${item.sectionIndex + 1}? היא לא תישלח.`)) await store.resolve(book.bookUid, item.key, 'dismissed'); }, { key: `dismiss:${item.key}` }));
        view.append(actions); card.append(view);
      }
    }
    if (book.conflicts.length) {
      card.append(node('h4', '', 'התנגשויות — דורשות החלטה'));
      for (const conflict of book.conflicts) {
        const view = changeView(conflict), actions = node('div', 'actions');
        view.classList.add('conflict');
        view.insertBefore(node('p', 'reason', reasons[conflict.reason] ?? conflict.reason), view.children[1]);
        if (live && conflict.reason !== 'not_found' && conflict.reason !== 'invalid') {
          actions.append(button('החזר לקורא', () => restoreConflict(book.bookUid, conflict), { key: `restore:${conflict.key}`, describe: `החזרת התיקון לפסקה ${conflict.sectionIndex + 1} לקורא, אם המקור תואם` }));
        }
        actions.append(button('סמן כטופל', async () => { if (await confirm('סימון התנגשות כטופלה', 'התיקון לא יוחזר ולא יישלח. להמשיך?')) await store.resolve(book.bookUid, conflict.key, 'dismissed'); }, { key: `drop:${conflict.key}` }));
        view.append(actions); card.append(view);
      }
    }
    cards.push(card);
  }
  if (!cards.length) cards.push(node('p', 'hint', 'אין תיקונים שממתינים לשליחה.'));
  el('pending-count').textContent = [pendingCount ? `${pendingCount} ממתינים` : '', conflictCount ? `${conflictCount} דורשים החלטה` : ''].filter(Boolean).join(' · ');
  el('book-list').replaceChildren(...cards);
}
function renderLegacy() {
  const cards = [];
  for (const draft of legacy.drafts) {
    const bookUid = draft.bookUid ?? `legacy:${draft.bookId}`, resolved = state.books.get(bookUid)?.resolutions ?? new Map();
    const card = node('article', 'card'); card.append(node('h3', '', draft.title));
    const durable = state.books.get(bookUid)?.durableChanges ?? [];
    const mapped = draft.mapped.filter(change => !resolved.has(change.key) && !durable.some(saved => legacyCovered(change, saved)));
    if (mapped.length) {
      const row = node('div', 'row'); row.append(node('span', 'grow', `${mapped.length} תיקונים שאפשר להעביר לקורא`),
        button('העבר לקורא', () => migrateLegacy(draft), { key: `migrate:${draft.id}`, disabled: !draft.bookUid || !liveFor(draft.bookUid), describe: 'העברה לעריכה הפעילה של הספר בקורא' }));
      card.append(row);
      if (!draft.bookUid || !liveFor(draft.bookUid)) card.append(node('p', 'hint', 'כדי להעביר, התחילו קודם עריכה של הספר בקורא.'));
      for (const change of mapped) card.append(changeView(change));
    }
    for (const change of draft.unmappable.filter(change => !resolved.has(change.key))) {
      const view = node('div', 'change conflict');
      view.append(node('strong', '', change.sectionIndex != null ? `פסקה ${change.sectionIndex + 1}` : 'שינוי'), node('p', 'reason', `לא ניתן להעביר: ${reasons[change.reason] ?? change.reason}`),
        diffView(change.original ?? change.originalText, change.proposed ?? change.proposedText));
      const actions = node('div', 'actions');
      actions.append(button('סמן כטופל', async () => { if (await confirm('סימון כטופל', 'השינוי יוסתר מהרשימה. הטיוטה הקודמת עצמה אינה נמחקת. להמשיך?')) await store.resolve(bookUid, change.key, 'dismissed'); }, { key: `legacy-drop:${change.key}` }));
      view.append(actions); card.append(view);
    }
    for (const report of draft.queue) {
      const record = resolved.get(report.key)?.[0];
      const view = node('div', 'change');
      view.append(node('strong', '', `דיווח ${report.reportId ?? ''}${report.sectionIndex != null ? ` · פסקה ${report.sectionIndex + 1}` : ''}`),
        diffView(report.original, report.proposed));
      if (report.sent) view.append(node('p', 'hint', legacyDeliveryLabel(report)));
      else if (record) view.append(node('p', 'hint', record.status === 'dismissed' ? 'סומן כטופל' : deliveryLabel(record.result) ?? record.status));
      else {
        const actions = node('div', 'actions');
        if (report.submission) actions.append(button('שלח', () => sendLegacyReport(draft, report), { key: `legacy-send:${report.key}` }));
        else view.append(node('p', 'hint', 'דיווח מגרסה ישנה מאוד שאינו כולל את פרטי המקור הנדרשים לשליחה דרך אוצריא.'));
        actions.append(button('סמן כטופל', async () => { if (await confirm('סימון כטופל', 'הדיווח לא יישלח. הטיוטה הקודמת אינה נמחקת. להמשיך?')) await store.resolve(bookUid, report.key, 'dismissed'); }, { key: `legacy-report-drop:${report.key}` }));
        view.append(actions);
      }
      card.append(view);
    }
    if (card.children.length > 1) cards.push(card);
  }
  for (const failure of legacy.failures) cards.push(node('p', 'hint error', `לא ניתן לקרוא טיוטה קודמת (${failure.key}). הנתונים לא שונו.`));
  el('legacy-area').hidden = !cards.length;
  el('legacy-list').replaceChildren(...cards);
}
function renderHistory() {
  const rows = [];
  // Built from resolution records, which compaction never removes.
  for (const book of state.books.values()) for (const item of book.history) {
    const record = item.record;
    const row = node('article', 'card');
    row.append(node('h3', '', `${item.title ?? book.bookId ?? book.bookUid}${Number.isInteger(item.sectionIndex) ? ` — פסקה ${item.sectionIndex + 1}` : ''}`), typeof item.originalText === 'string' ? diffView(item.originalText, item.proposedText, item.originalSourceText) : node('p', 'after', item.proposedText || '(מחיקה)'),
      node('p', 'hint', `${deliveryLabel(record.result) ?? record.status} · ${new Date(record.at).toLocaleDateString('he-IL')} · ${record.result?.reportId ?? ''}`));
    rows.push(row);
  }
  for (const item of legacyHistory) {
    const row = node('article', 'card');
    row.append(node('h3', '', `${item.title} — ${item.location ?? ''}`), node('p', 'after', item.submission?.proposed || '(מחיקה)'),
      node('p', 'hint', `נשלח בגרסה הקודמת · ${new Date(item.sentAt).toLocaleDateString('he-IL')} · ${item.id}`));
    rows.push(row);
  }
  el('history-count').textContent = rows.length ? String(rows.length) : '';
  if (!rows.length) rows.push(node('p', 'hint', 'אין עדיין תיקונים שנשלחו.'));
  el('history-list').replaceChildren(...rows);
}
function renderSettings() {
  el('marks-toggle').checked = marksOn;
  el('marks-toggle').disabled = busy || !highlightGranted;
  el('marks-permission').hidden = highlightGranted;
}
function render() {
  const focused = document.activeElement?.dataset?.focusKey;
  renderLive(); renderBooks(); renderLegacy(); renderHistory(); renderSettings(); renderReport();
  el('refresh').disabled = busy;
  if (focused) (document.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`) ?? el('refresh')).focus({ preventScroll: true });
}
async function initialize(boot) {
  background = boot?.app?.runMode === 'background';
  applyTheme(boot?.theme);
  embedded = boot?.reader?.embedded ? boot.reader : null;
  el('embedded-notice').hidden = !embedded;
  call('app.getTheme').then(applyTheme).catch(() => {});
  const granted = await call('app.getGrantedPermissions').catch(() => null);
  const permissions = granted?.permissions ?? granted;
  highlightGranted = !Array.isArray(permissions) || permissions.includes('reader.highlight');
  marksOn = await marksEnabled(call);
  if (Array.isArray(permissions) && !permissions.includes('reader.local_edit')) {
    message('כדי לערוך בקורא יש לאשר לתוסף את ההרשאה „עריכה מקומית בקורא” בניהול התוספים.', true);
  } else if (Array.isArray(permissions) && !background && !permissions.includes('app.run_on_startup')) {
    message('כדי ש„תיקון הספר בקורא” יפתח את העריכה בלי לעבור לדף התוסף, אשרו לתוסף בניהול התוספים את ההרשאה להפעלה ברקע.');
  }
  await reload();
  await refreshTabs();
  const report = await controller.recoverOrphans().catch(error => { message(errorText(error), true); return null; });
  if (report?.saved) message(`נקלטו ${report.saved} טיוטות שנשמרו באוצריא מעריכה קודמת.`, false, 6000);
  if (report?.failed.length) message(`לא ניתן היה לקלוט ${report.failed.length} טיוטות; הן נשארו באוצריא וייקלטו בפעם הבאה.`, true);
  else if (!report?.saved && el('status').textContent === 'טוען…') message();
}
// Read the choice now: run() renders first, which resets the box to the stored value.
el('marks-toggle').addEventListener('change', event => { const enabled = event.target.checked; run(() => setMarks(enabled)); });
for (const [index, screen] of mainScreens.entries()) {
  el(`nav-${screen}`).addEventListener('click', () => showScreen(screen));
  el(`nav-${screen}`).addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowLeft') next = (index + 1) % mainScreens.length;
    if (event.key === 'ArrowRight') next = (index + mainScreens.length - 1) % mainScreens.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = mainScreens.length - 1;
    if (next !== undefined) { event.preventDefault(); showScreen(mainScreens[next], true); }
  });
}
el('nav-report').addEventListener('click', () => { showScreen('report'); el('report-details').focus(); });
el('report-back').addEventListener('click', () => showScreen(lastMainScreen, true));
el('report-details').addEventListener('input', () => { if (currentScreen === 'report') message(); renderReport(); });
el('report-send').addEventListener('click', () => { afterBoot(() => run(reportToDeveloper)).catch(error => notify(errorText(error), true)); });
el('refresh').addEventListener('click', () => run(async () => { await refreshTabs(); await controller.recoverOrphans(); }));
el('embedded-native').addEventListener('click', () => run(async () => {
  await call('reader.setDefaultTextReader', { enabled: false }).catch(() => {});
  if (embedded) await call('reader.openBook', { bookId: embedded.bookId, ...(embedded.id != null ? { id: embedded.id } : {}), index: embedded.currentIndex ?? 0, reader: 'native' });
}));
if (host) {
  host.on('theme.changed', applyTheme);
  host.on('contextMenu.itemClicked', event => requestEdit(event, false));
  host.on('reader.toolbar_item_clicked', event => requestEdit(event, true));
  // Session events queue behind boot; nothing is acknowledged before saving.
  host.on('reader.correctionSessionChanged', event => { afterBoot(() => controller.changed(event)).catch(error => message(errorText(error), true)); });
  host.on('reader.correctionSessionEnded', event => { afterBoot(() => controller.ended(event)).catch(error => message(errorText(error), true)); });
  host.on('reader.current_ref_changed', () => { afterBoot(checkMarks).catch(() => {}); });
  host.on('plugin.resumed', () => { afterBoot(() => run(refreshTabs)).catch(() => {}); });
  host.on('plugin.boot', boot => { initialized ??= initialize(boot); startInitialization(); initialized.catch(error => message(errorText(error), true)); });
  if (host._booted) { initialized ??= initialize(); startInitialization(); initialized.catch(error => message(errorText(error), true)); }
} else message('יש לפתוח את התוסף מתוך אוצריא.');
