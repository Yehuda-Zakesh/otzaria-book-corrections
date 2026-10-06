import { loadBook, MAX_BOOK_BYTES } from './book.js';
import { sendReport } from './report.js';
import { diffBook } from './changes.js';
import { prepareReports } from './book-reports.js';
import { createRpcCall } from './rpc.js';
import { readerPosition, positionInBook, originalToEditedOffset } from './navigation.js';
import { findInBook } from './book-search.js';
import { buildTocTree, flattenTocTree, activeTocKey, ensurePathExpanded, setAllExpanded } from './toc-tree.js';
const el = id => document.getElementById(id), host = window.Otzaria;
const newId = () => `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')}`;
let session = null, pendingBook = null, initialized, loading = false, sending = false, pause = false;
let chooserOpen = false;
let writes = Promise.resolve(), saveTimer, revision = 0;
let tocBook = null, tocTree = [], tocExpanded = new Set();
let searchTimer;
const call = host ? createRpcCall(host) : async () => { throw new Error('יש לפתוח את התוסף מתוך אוצריא.'); };
function message(text = '', error = false) { el('status').textContent = text; el('status').classList.toggle('error', error); }
function applyTheme(theme) {
  if (!theme?.colorScheme) return;
  for (const [key, color] of Object.entries(theme.colorScheme)) {
    if (typeof color === 'string' && /^#[\da-f]{6,8}$/i.test(color)) document.documentElement.style.setProperty(`--${key}`, color);
  }
  const t = theme.typography;
  if (t) {
    document.documentElement.style.setProperty('--font-ui', `${JSON.stringify(t.uiFontFamily ?? 'Rubik')}, system-ui, sans-serif`);
    document.documentElement.style.setProperty('--font-main', `${JSON.stringify(t.fontFamily ?? 'FrankRuhlCLM')}, serif`);
    if (Number.isFinite(t.fontSize)) document.documentElement.style.setProperty('--font-size', `${t.fontSize}px`);
    if (Number.isFinite(t.lineHeight)) document.documentElement.style.setProperty('--line-height', String(t.lineHeight));
  }
  document.documentElement.style.colorScheme = theme.mode;
}
function hasEdits() { return session && session.editedText !== session.book.originalText; }
function controls() {
  const locked = loading || sending;
  el('proposed').readOnly = locked || !!session?.queue;
  el('send').hidden = !session || chooserOpen;
  el('change-book').hidden = !session || chooserOpen;
  el('change-book').disabled = locked;
  el('cancel-book-picker').disabled = locked;
  el('send').disabled = locked || !session || session.completed || (!hasEdits() && !session.queue);
  el('send').textContent = sending ? 'שולח דיווחים…' : session?.queue ? 'המשך שליחה' : 'שלח דיווח';
  for (const id of ['discard', 'next-book', 'load-current', 'open-books']) el(id).disabled = locked;
  el('pause').hidden = !sending;
  el('discard').textContent = session?.completed ? 'סיים' : 'ביטול התיקונים';
}
function render() {
  el('editor').hidden = !session || chooserOpen; el('empty').hidden = !!session && !chooserOpen;
  el('cancel-book-picker').hidden = !session || !chooserOpen;
  document.querySelector('main').classList.toggle('reading', !!session && !chooserOpen);
  el('book-picker').hidden = true;
  el('load-current').textContent = 'טען את הספר הפתוח';
  el('location').textContent = session?.book.details.title ?? session?.book.identity.bookId ?? '';
  el('screen-title').textContent = session?.book.details.title ?? session?.book.identity.bookId ?? 'תיקוני ספרים';
  el('nav-title').textContent = session?.book.details.title ?? session?.book.identity.bookId ?? 'תוכן הספר';
  if (session) el('proposed').value = session.editedText;
  renderNavigation();
  el('next-book').textContent = session && !session.completed ? 'בטל את התיקונים ועבור לספר החדש' : 'עבור לספר החדש';
  controls();
}
function renderNavigation() {
  if (!session) return;
  const query = el('toc-search').value.trim();
  const toc = session.book.toc?.length ? session.book.toc : session.book.sections.map(section => ({ text: `פסקה ${section.index + 1}`, index: section.index, level: 1 }));
  if (tocBook !== session.book) {
    tocBook = session.book;
    tocTree = buildTocTree(toc.filter(item => Number.isInteger(item.index) && item.index >= 0 && item.index < session.book.sections.length));
    tocExpanded = new Set(flattenTocTree(tocTree).filter(row => row.hasChildren && row.expanded).map(row => row.key));
    ensurePathExpanded(tocTree, activeTocKey(tocTree, session.location?.sectionIndex ?? 0), tocExpanded);
  }
  const active = activeTocKey(tocTree, session.location?.sectionIndex ?? 0);
  const group = document.createElement('div'); group.className = 'toc-group';
  const scroll = el('toc-list').scrollTop;
  for (const item of flattenTocTree(tocTree, tocExpanded, query)) {
    const row = document.createElement('div');
    row.className = `toc-row${item.expanded ? ' expanded' : ''}${item.key === active ? ' selected' : ''}`;
    row.style.setProperty('--level', Math.min(item.depth, 100));
    const label = document.createElement('button'); label.type = 'button'; label.className = 'toc-label'; label.textContent = item.entry.text; label.title = item.entry.text;
    label.addEventListener('click', () => navigateTo({ sectionIndex: item.entry.index, offset: 0 }));
    row.append(label);
    if (item.hasChildren) {
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'toc-chevron';
      toggle.setAttribute('aria-label', `${item.expanded ? 'כווץ' : 'הרחב'} ${item.entry.text}`);
      toggle.setAttribute('aria-expanded', String(item.expanded));
      toggle.addEventListener('click', () => { item.expanded ? tocExpanded.delete(item.key) : tocExpanded.add(item.key); renderNavigation(); });
      row.append(toggle);
    }
    group.append(row);
  }
  el('toc-list').replaceChildren(group); el('toc-list').scrollTop = scroll;
  el('section-number').max = String(session.book.sections.length);
  el('section-number').value = String((session.location?.sectionIndex ?? 0) + 1);
}
function navigateTo(location) {
  if (!session) return;
  session.location = location;
  ensurePathExpanded(tocTree, activeTocKey(tocTree, location.sectionIndex), tocExpanded);
  renderNavigation();
  el('section-number').value = String(location.sectionIndex + 1);
  const editor = el('proposed'), offset = positionInBook(session.book, location, session.editedText);
  scrollEditorToOffset(offset);
}
function scrollEditorToOffset(offset, end = offset) {
  const editor = el('proposed');
  if (typeof editor.setSelectionRange !== 'function') return;
  editor.focus(); editor.setSelectionRange(offset, end);
  // Measure wrapped text with the editor's own font and width rather than
  // guessing a line height: a single source paragraph can wrap many times.
  const computed = getComputedStyle(editor), mirror = document.createElement('div');
  for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'padding', 'direction', 'tabSize']) mirror.style[key] = computed[key];
  Object.assign(mirror.style, { position: 'fixed', left: '-100000px', top: '0', width: `${editor.clientWidth}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', boxSizing: 'border-box' });
  mirror.textContent = session.editedText.slice(0, offset);
  const marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.append(marker); document.body.append(mirror);
  editor.scrollTop = Math.max(0, marker.offsetTop - editor.clientHeight / 4); mirror.remove();
}
function switchNavigation(search) {
  el('toc-view').hidden = search; el('search-view').hidden = !search;
  el('nav-toc-tab').setAttribute('aria-selected', String(!search)); el('nav-search-tab').setAttribute('aria-selected', String(search));
  if (search) { renderSearchResults(); el('book-search').focus(); }
}
function renderSearchResults() {
  if (!session) return;
  const query = el('book-search').value.trim();
  const group = document.createElement('div'); group.className = 'toc-group';
  if (!query) { const hint = document.createElement('p'); hint.textContent = 'כתבו מילים לחיפוש בספר'; group.append(hint); }
  else {
    const results = findInBook(session.editedText, query);
    if (!results.length) { const hint = document.createElement('p'); hint.textContent = 'לא נמצאו תוצאות'; group.append(hint); }
    for (const result of results) {
      const row = document.createElement('div'); row.className = 'toc-row search-result';
      const label = document.createElement('button'); label.type = 'button'; label.className = 'toc-label'; label.textContent = result.snippet;
      label.addEventListener('click', () => {
        const originalOffset = originalToEditedOffset(session.editedText, session.book.originalText, result.offset);
        let section = session.book.sections[0];
        for (const candidate of session.book.sections) { if (candidate.start > originalOffset) break; section = candidate; }
        session.location = { sectionIndex: section.index, offset: Math.max(0, originalOffset - section.start) };
        renderNavigation(); scrollEditorToOffset(result.offset, result.end);
      });
      row.append(label); group.append(row);
    }
  }
  el('book-search-results').replaceChildren(group);
}
el('nav-toc-tab').addEventListener('click', () => switchNavigation(false));
el('nav-search-tab').addEventListener('click', () => switchNavigation(true));
el('book-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearchResults, 150); });
el('toc-search').addEventListener('input', renderNavigation);
el('toc-search-toggle').addEventListener('click', () => {
  el('toc-search-wrap').hidden = !el('toc-search-wrap').hidden;
  if (!el('toc-search-wrap').hidden) el('toc-search').focus();
  else { el('toc-search').value = ''; renderNavigation(); }
});
el('toc-expand').addEventListener('click', () => {
  const hasClosed = flattenTocTree(tocTree, tocExpanded).some(row => row.hasChildren && !row.expanded);
  setAllExpanded(tocTree, hasClosed, tocExpanded); renderNavigation();
});
el('go-section').addEventListener('click', () => {
  const index = Number(el('section-number').value) - 1;
  if (session && Number.isInteger(index) && index >= 0 && index < session.book.sections.length) navigateTo({ sectionIndex: index, offset: 0 });
});
async function persist(value = session) {
  clearTimeout(saveTimer);
  const snapshot = value ? JSON.parse(JSON.stringify(value)) : null, savedRevision = revision;
  writes = writes.catch(() => {}).then(() => snapshot ? call('storage.set', { key: 'book-session', value: snapshot }) : call('storage.remove', { key: 'book-session' }));
  await writes;
  if (savedRevision === revision) {
    el('draft-status').textContent = snapshot ? 'הטיוטה נשמרה' : '';
    await call('ui.setUnsavedChanges', { hasChanges: false }).catch(() => {});
  }
}
function scheduleSave() {
  revision++; el('draft-status').textContent = 'שומר…';
  call('ui.setUnsavedChanges', { hasChanges: true, message: 'השינויים האחרונים בספר טרם נשמרו בטיוטה.' }).catch(() => {});
  clearTimeout(saveTimer); saveTimer = setTimeout(() => persist().catch(error => message(`שמירת הטיוטה נכשלה: ${error.message}`, true)), 400);
}
function identityFrom(event) {
  const data = event.selection ?? event, bookId = data.bookId ?? data.currentBookId ?? data.currentBook, id = data.id ?? data.currentId;
  if (typeof bookId !== 'string' || !bookId) throw new Error('לא נמצא ספר פתוח. פתחו ספר טקסט ובחרו „העבר את הספר לתיקון”.');
  return { bookId, ...(id != null ? { bookUid: `id:${id}` } : {}), location: readerPosition(event) };
}
async function openBook(identity) {
  if (loading || sending) throw new Error('המתינו לסיום הפעולה הנוכחית.');
  loading = true; controls();
  try {
    if (session) await persist();
    const { location, ...bookIdentity } = identity;
    const book = await loadBook(call, bookIdentity, progress => message(progress.phase === 'content'
      ? `טוען את הספר… ${Math.round(progress.loaded / 1000)} אלפי תווים` : `ממפה פסקאות… ${progress.loaded} מתוך ${progress.total}`));
    book.toc = await call('library.getBookToc', book.identity).catch(() => []);
    const next = { id: newId(), book, editedText: book.originalText, queue: null, completed: false, location: location ?? { sectionIndex: 0, offset: 0 } };
    await persist(next); session = next; chooserOpen = false; render(); message();
    loading = false; controls(); navigateTo(session.location);
  } finally { loading = false; controls(); }
}
let openings = Promise.resolve();
function requestBook(event) {
  if (!['correct-book', 'correct-selection'].includes(event.itemId)) return;
  openings = openings.catch(() => {}).then(async () => {
    await initialized;
    const identity = identityFrom(event);
    if (session && !session.completed && (hasEdits() || session.queue || sending)) {
      pendingBook = identity; el('next-book').hidden = false; message('יש ספר עם תיקונים פתוחים. אפשר לשלוח אותם או לבטל ולעבור לספר החדש.'); return;
    }
    await openBook(identity);
  }).catch(error => message(error.message, true));
}
el('proposed').addEventListener('input', () => {
  if (!session || loading || sending || session.queue) return;
  session.editedText = el('proposed').value; controls(); scheduleSave();
  if (!el('search-view').hidden) { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearchResults, 150); }
});
async function chooseOpenBook({ forceChoice = false } = {}) {
  if (loading || sending) return;
  try {
    await initialized;
    const state = await call('reader.getCurrentState');
    const books = [], seen = new Set();
    for (const tab of state?.openTabs ?? []) {
      if (tab.type !== 'text' || tab.source !== 'library' || !tab.bookId) continue;
      const key = tab.id != null ? `id:${tab.id}` : tab.bookId;
      if (!seen.has(key)) { seen.add(key); books.push({ ...tab, key }); }
    }
    if (!books.length) throw new Error('אין ספרי טקסט מהספרייה פתוחים. פתחו ספר ונסו שוב.');
    let chosen = books[0];
    if (books.length > 1 || forceChoice) {
      const previous = el('open-books').value;
      chosen = books.find(book => book.key === previous);
      const confirm = !el('book-picker').hidden && !!chosen;
      const options = books.map(book => {
        const option = document.createElement('option');
        option.value = book.key; option.textContent = book.book ?? book.bookId;
        return option;
      });
      el('open-books').replaceChildren(...options);
      el('open-books').value = chosen?.key ?? books.find(book => book.id === state.currentId)?.key ?? books[0].key;
      el('book-picker').hidden = false;
      el('load-current').textContent = 'יבא את הספר הנבחר';
      if (!confirm) { message(); el('open-books').focus(); return; }
    }
    requestBook({ selection: chosen, itemId: 'correct-book' }); await openings;
  }
  catch (error) { message(error.message, true); }
}
el('load-current').addEventListener('click', chooseOpenBook);
el('change-book').addEventListener('click', async () => {
  if (!session || loading || sending) return;
  try {
    await persist();
    chooserOpen = true; render(); message();
    await chooseOpenBook({ forceChoice: true });
  } catch (error) { message(error.message, true); }
});
el('cancel-book-picker').addEventListener('click', () => {
  if (loading || sending) return;
  chooserOpen = false; pendingBook = null; el('next-book').hidden = true; render(); message();
  navigateTo(session?.location ?? { sectionIndex: 0, offset: 0 });
});
el('next-book').addEventListener('click', async () => {
  if (!pendingBook || loading || sending) return;
  try { await openBook(pendingBook); pendingBook = null; el('next-book').hidden = true; } catch (error) { message(error.message, true); }
});
el('discard').addEventListener('click', async () => {
  if (loading || sending) return;
  loading = true; controls();
  try {
    await persist(null); session = null; render(); message();
    if (pendingBook) { const identity = pendingBook; loading = false; await openBook(identity); pendingBook = null; el('next-book').hidden = true; }
  } catch (error) { message(error.message, true); } finally { loading = false; controls(); }
});
el('pause').addEventListener('click', () => { pause = true; message('השליחה תיעצר לאחר הדיווח הנוכחי.'); });
el('editor').addEventListener('submit', async event => {
  event.preventDefault(); if (!session || loading || sending || session.completed) return;
  sending = true; pause = false; controls();
  try {
    const email = (await call('app.getUserEmail'))?.email?.trim() ?? '';
    if (!email) { message('יש לעדכן מייל לפני השליחה בהגדרות התוכנה.', true); return; }
    if (new TextEncoder().encode(session.editedText).length > MAX_BOOK_BYTES) throw new Error('הטקסט המתוקן גדול מדי (מעל 10 MB).');
    await persist();
    if (!session.queue) {
      message('מכין את דיווחי התיקונים…'); await new Promise(resolve => setTimeout(resolve, 0));
      const changes = diffBook(session.book.originalText, session.editedText);
      if (!changes.length) { message('לא נמצאו שינויים בספר.'); return; }
      const queue = await prepareReports(session, changes, email, call, newId, (done, total) => message(`מכין דיווחים… ${done} מתוך ${total}`));
      session.queue = queue; await persist();
    }
    let sent = session.queue.filter(item => item.sent).length;
    for (const item of session.queue) {
      if (item.sent) continue; if (pause) break;
      message(`שולח דיווח ${sent + 1} מתוך ${session.queue.length}…`);
      try {
        await sendReport(host, item.payload);
      } catch (error) {
        if (error.status === 409) { item.payload.report_id = newId(); if (item.request) item.request.reportId = item.payload.report_id; await persist(); }
        throw error;
      }
      item.sent = true; sent++; await persist();
      if (sent < session.queue.length) await new Promise(resolve => setTimeout(resolve, 350));
    }
    session.completed = session.queue.every(item => item.sent); await persist();
    message(session.completed ? `כל ${sent} הדיווחים נשלחו בהצלחה.` : `נשלחו ${sent} מתוך ${session.queue.length}. אפשר להמשיך את השליחה בהמשך.`);
  } catch (error) {
    const sent = session?.queue?.filter(item => item.sent).length ?? 0;
    message(`${error.message}${sent ? ` כבר נשלחו ${sent} דיווחים; ההמשך נשמר.` : ''}`, true);
  } finally { sending = false; controls(); }
});
async function initialize(boot) {
  applyTheme(boot?.theme);
  const results = await Promise.allSettled([call('app.getTheme'), call('storage.get', { key: 'book-session' })]);
  if (results[0].status === 'fulfilled') applyTheme(results[0].value);
  if (results[1].status === 'rejected') throw new Error('לא ניתן לקרוא את טיוטת הספר. בדקו את הרשאות האחסון.');
  session = results[1].value;
  if (session && !session.book.toc?.length) {
    session.book.toc = await call('library.getBookToc', session.book.identity).catch(() => []);
  }
  render(); if (session) navigateTo(session.location ?? { sectionIndex: 0, offset: 0 });
  message();
}
if (host) {
  host.on('theme.changed', applyTheme); host.on('contextMenu.itemClicked', requestBook); host.on('reader.toolbar_item_clicked', requestBook);
  host.on('plugin.suspended', () => { if (session) persist().catch(error => message(error.message, true)); });
  host.on('plugin.boot', boot => { initialized ??= initialize(boot); initialized.catch(error => message(error.message, true)); });
  if (host._booted) { initialized ??= initialize(); initialized.catch(error => message(error.message, true)); }
} else { el('empty').hidden = false; message('יש לפתוח את התוסף מתוך אוצריא.'); }
