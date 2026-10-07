import { loadBook, MAX_BOOK_BYTES } from './book.js';
import { sortLibraryTree, filterLibraryTree } from './library-order.js';
import { diffBook } from './changes.js';
import { readNikudDisplay, projectNikud, applyDisplayEdit } from './text-display.js';
import { sendReport, reportDeliveryMessage } from './report.js';
import { verifyQueuedCorrectionSources } from './correction-source.js';
import { prepareReports } from './book-reports.js';
import { createRpcCall } from './rpc.js';
import { readerPosition, positionInBook, originalToEditedOffset } from './navigation.js';
import { createAsyncBookSearch } from './book-search.js';
import { createDraftStorage } from './draft-storage.js';
import { createSourceGuard } from './source-guard.js';
import { editorRange, createContinuousEditor } from './editor-window.js';
import { buildTocTree, flattenTocTree, activeTocKey, ensurePathExpanded, setAllExpanded } from './toc-tree.js';
const el = id => document.getElementById(id), host = window.Otzaria;
const newId = () => `${Date.now()}-${Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')}`;
let session = null, initialized, loading = false, sending = false, pause = false;
let sessions = [];
let chooserOpen = false;
let libraryTabs = [], activeLibraryId = null;
const openTabs = () => [...sessions, ...libraryTabs];
const activeTabId = () => chooserOpen ? activeLibraryId : session?.id;
let libraryTree = null, libraryExpanded = new Set();
let libraryPath = '/', libraryMode = 'grid', libraryQueryTimer;
let writes = Promise.resolve(), saveTimer, revision = 0;
let unsaved = false;
let tocBook = null, tocTree = [], tocExpanded = new Set();
let searchTimer, searchGeneration = 0, searchSession = null;
let visibleRange = { start: 0, end: 0 };
let continuousEditor = null, mappedText = null, mappedBook = null, inverseChanges = [];
let displayProjection = projectNikud('');
let selectedRow = null, selectedKey = null;
let statusText = '', statusError = false, statusTimer;
const call = host ? createRpcCall(host) : async () => { throw new Error('יש לפתוח את התוסף מתוך אוצריא.'); };
const draftStorage = createDraftStorage(call, newId), sourceGuard = createSourceGuard(call);
const searchBook = createAsyncBookSearch();
function message(text = '', error = false, duration = 0) {
  clearTimeout(statusTimer);
  statusText = text;
  statusError = error;
  renderStatus();
  if (duration > 0) statusTimer = setTimeout(() => message(), duration);
}
function renderStatus() {
  const partial = !loading && !sending && !chooserOpen && hasPartialDelivery();
  const sent = partial ? session.queue.filter(item => item.sent).length : 0;
  const explanation = partial ? `העריכה נעולה זמנית כי ${sent} מתוך ${session.queue.length} דיווחים כבר נשלחו. כדי לחזור לערוך, ודאו שיש חיבור לרשת ולחצו על „המשך שליחה”. לאחר השלמת הדיווחים שנותרו העריכה תיפתח. הטיוטה נשמרה.` : '';
  el('status').textContent = [statusText, explanation].filter(Boolean).join(' ');
  el('status').classList.toggle('error', statusError);
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
    if (Number.isFinite(t.fontSize)) document.documentElement.style.setProperty('--font-size', `${t.fontSize}px`);
    if (Number.isFinite(t.lineHeight)) document.documentElement.style.setProperty('--line-height', String(t.lineHeight));
  }
  document.documentElement.style.colorScheme = theme.mode;
}
function hasEdits() { return session && session.editedText !== (session.reportedText ?? session.book.originalText); }
function hasPartialDelivery() { return !session?.completed && session?.queue?.some(item => item.sent) && session.queue.some(item => !item.sent); }
function queuedSourceSections(item) {
  if (!item.queue) return [];
  if (item.queue.every(report => Array.isArray(report.sourceSections))) {
    return [...new Set(item.queue.filter(report => !report.sent).flatMap(report => report.sourceSections))];
  }
  // Older queues did not retain their complete multi-section source ranges.
  const changes = diffBook(item.book.originalText, item.editedText), indices = new Set();
  for (const change of changes) {
    let first = 0;
    for (const section of item.book.sections) { if (section.start > change.start) break; first = section.index; }
    indices.add(first);
    for (const section of item.book.sections) {
      if (section.index > first && section.start < change.end) indices.add(section.index);
    }
  }
  return [...indices];
}
function controls() {
  const locked = loading || sending;
  el('proposed').setAttribute('aria-describedby', 'status');
  el('proposed').readOnly = locked || !!hasPartialDelivery();
  el('send').hidden = !session || chooserOpen;
  el('change-book').hidden = false;
  el('change-book').disabled = locked;
  for (const button of el('book-tabs').querySelectorAll?.('button') ?? []) button.disabled = locked;
  el('cancel-book-picker').disabled = locked;
  el('send').disabled = locked || !session || session.completed || (!hasEdits() && !session.queue);
  el('send').textContent = sending ? 'שולח דיווחים…' : session?.queue ? 'המשך שליחה' : 'שלח דיווח';
  for (const id of ['discard', 'library-search']) el(id).disabled = locked;
  for (const button of el('library-list').querySelectorAll?.('button') ?? []) button.disabled = locked;
  el('pause').hidden = !sending;
  el('discard').textContent = session?.completed ? 'סיים' : 'ביטול התיקונים';
  renderStatus();
}
function render() {
  if (searchSession !== session || chooserOpen) { searchBook.clear(); searchGeneration++; searchSession = session; }
  renderBookTabs();
  el('editor').hidden = !session || chooserOpen; el('empty').hidden = !!session && !chooserOpen;
  el('cancel-book-picker').hidden = true;
  document.querySelector('main').classList.toggle('reading', !!session && !chooserOpen);
  if (!session || chooserOpen) renderLibrary();
  el('screen-title').textContent = !session || chooserOpen ? 'ספריית אוצריא' : session.book.details.title ?? session.book.identity.bookId;
  el('nav-title').textContent = session?.book.details.title ?? session?.book.identity.bookId ?? 'תוכן הספר';
  if (session && !chooserOpen) showEditorRange(session.view?.visibleOffset ?? session.view?.selectionStart ?? positionInBook(session.book, session.location ?? { sectionIndex: 0, offset: 0 }, session.editedText));
  renderNavigation();
  controls();
}
function renderBookTabs() {
  const items = openTabs(), activeId = activeTabId();
  const strip = el('book-tabs'); strip.hidden = !items.length;
  const tabs = items.map(bookSession => {
    const isLibrary = libraryTabs.includes(bookSession), active = bookSession.id === activeId;
    const row = document.createElement('div'); row.className = `book-tab${active ? ' active' : ''}`;
    const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'book-tab-title';
    tab.id = `book-tab-${bookSession.id}`; tab.textContent = isLibrary ? 'ספריית אוצריא' : bookSession.book.details.title ?? bookSession.book.identity.bookId;
    tab.title = tab.textContent; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(active));
    tab.setAttribute('aria-controls', isLibrary ? 'empty' : 'editor'); tab.tabIndex = active ? 0 : -1;
    tab.addEventListener('click', () => activateBook(bookSession.id).catch(error => message(error.message, true)));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = openTabs(), index = items.indexOf(bookSession);
      const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowLeft' ? 1 : -1) + items.length) % items.length;
      activateBook(items[nextIndex].id, true).catch(error => message(error.message, true));
    });
    const close = document.createElement('button'); close.type = 'button'; close.className = 'book-tab-close'; close.textContent = '×';
    close.setAttribute('aria-label', `סגור ${tab.textContent}`); close.title = `סגור ${tab.textContent}`;
    close.addEventListener('click', () => closeBook(bookSession.id).catch(error => message(error.message, true)));
    row.append(tab, close); return row;
  });
  strip.replaceChildren(...tabs);
  if (activeId) el(`book-tab-${activeId}`).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  if (activeLibraryId) el('empty').setAttribute('aria-labelledby', `book-tab-${activeLibraryId}`);
  if (session) el('editor').setAttribute('aria-labelledby', `book-tab-${session.id}`);
}
function captureView() {
  if (chooserOpen) {
    const tab = libraryTabs.find(item => item.id === activeLibraryId);
    if (tab) tab.view = { path: libraryPath, expanded: [...libraryExpanded],
      query: el('library-search').value, scrollTop: el('library-list').scrollTop ?? 0 };
    return;
  }
  if (!session || chooserOpen || el('proposed').clientWidth === 0) return;
  session.view = { scrollTop: el('book-scroll').scrollTop ?? 0,
    visibleOffset: displayProjection.toSource(continuousEditor?.visibleOffset() ?? visibleRange.start),
    geometry: continuousEditor?.geometry,
    selectionStart: displayProjection.toSource(visibleRange.start + (el('proposed').selectionStart ?? 0)),
    selectionEnd: displayProjection.toSource(visibleRange.start + (el('proposed').selectionEnd ?? 0)),
    tocExpanded: [...tocExpanded], tocSearch: el('toc-search').value,
    bookSearch: el('book-search').value, searching: !el('search-view').hidden,
    tocScrollTop: el('toc-list').scrollTop ?? 0 };
}
function restoreView() {
  if (chooserOpen) {
    const view = libraryTabs.find(item => item.id === activeLibraryId)?.view;
    libraryPath = view?.path ?? '/';
    libraryExpanded = new Set(view?.expanded ?? []); el('library-search').value = view?.query ?? '';
    renderLibrary(); el('library-list').scrollTop = view?.scrollTop ?? 0;
    return;
  }
  if (!session) return;
  const view = session.view;
  el('toc-search').value = view?.tocSearch ?? ''; el('book-search').value = view?.bookSearch ?? '';
  tocBook = null; renderNavigation();
  if (view?.tocExpanded) { tocExpanded = new Set(view.tocExpanded); renderNavigation(); }
  el('toc-view').hidden = !!view?.searching; el('search-view').hidden = !view?.searching;
  el('nav-toc-tab').setAttribute('aria-selected', String(!view?.searching));
  el('nav-search-tab').setAttribute('aria-selected', String(!!view?.searching));
  if (view?.searching) renderSearchResults();
  if (view) {
    if (Number.isFinite(view.scrollTop)) el('book-scroll').scrollTop = view.scrollTop;
    else scrollEditorToOffset(view.visibleOffset ?? view.selectionStart ?? 0);
    el('toc-list').scrollTop = view.tocScrollTop;
    el('proposed').setSelectionRange?.(Math.max(0, displayProjection.toDisplay(view.selectionStart) - visibleRange.start), Math.max(0, displayProjection.toDisplay(view.selectionEnd) - visibleRange.start));
  } else navigateTo(session.location ?? { sectionIndex: 0, offset: 0 });
}
async function activateBook(id, focusTab = false) {
  if (loading || sending) return;
  if (libraryTabs.some(item => item.id === id)) {
    captureView(); activeLibraryId = id; chooserOpen = true;
    render(); restoreView(); message(); scheduleSave();
    if (focusTab) el(`book-tab-${id}`).focus({ preventScroll: true });
    else el('library-search').focus({ preventScroll: true });
    return;
  }
  const next = sessions.find(item => item.id === id); if (!next) return;
  if (next !== session || chooserOpen) {
    captureView();
    session = next; chooserOpen = false; render(); restoreView(); message();
    scheduleSave();
  }
  if (focusTab) el(`book-tab-${id}`).focus();
  else el('proposed').focus({ preventScroll: true });
}
async function closeBook(id) {
  if (loading || sending) return;
  if (libraryTabs.some(item => item.id === id)) {
    captureView();
    const items = openTabs(), index = items.findIndex(item => item.id === id), active = activeTabId() === id;
    libraryTabs = libraryTabs.filter(item => item.id !== id);
    if (active) {
      const remaining = openTabs(), next = remaining[Math.min(index, remaining.length - 1)];
      activeLibraryId = null; chooserOpen = true;
      if (next) await activateBook(next.id, true);
      else { render(); el('library-search').focus(); }
    } else renderBookTabs();
    scheduleSave(); return;
  }
  const target = sessions.find(item => item.id === id); if (!target) return;
  loading = true; controls();
  try {
    if (target.editedText !== (target.reportedText ?? target.book.originalText) || (target.queue && !target.completed)) {
      const result = await call('ui.showConfirm', { title: 'סגירת ספר', content: 'בספר יש תיקונים שטרם נשלחו. סגירת הלשונית תמחק את הטיוטה שלו. לסגור?' });
      if (!result?.confirmed) return;
    }
    captureView();
    const index = sessions.indexOf(target), remaining = sessions.filter(item => item.id !== id);
    const next = session?.id === id ? remaining[Math.min(index, remaining.length - 1)] ?? null : session;
    sessions = remaining;
    const changed = !chooserOpen && session !== next;
    session = next;
    if (changed) { render(); restoreView(); }
    else renderBookTabs();
    message(); scheduleSave();
    loading = false; controls();
    if (activeTabId()) el(`book-tab-${activeTabId()}`).focus({ preventScroll: true });
    else el('library-search').focus({ preventScroll: true });
  } finally { loading = false; controls(); }
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
  selectedRow = null;
  const group = document.createElement('div'); group.className = 'toc-group';
  const scroll = el('toc-list').scrollTop;
  for (const item of flattenTocTree(tocTree, tocExpanded, query)) {
    const row = document.createElement('div');
    row.className = `toc-row${item.expanded ? ' expanded' : ''}${item.key === active ? ' selected' : ''}`;
    row.dataset && (row.dataset.key = item.key);
    if (item.key === active) selectedRow = row;
    row.style.setProperty('--level', Math.min(100, Math.max(0, (item.entry.level ?? 1) - 1)));
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
  selectedKey = active;
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
  offset = displayProjection.toDisplay(offset); end = displayProjection.toDisplay(end);
  const editor = el('proposed');
  if (typeof editor.setSelectionRange !== 'function') return;
  if (continuousEditor) { continuousEditor.scrollTo(offset, end); visibleRange = continuousEditor.range; return; }
  if (offset < visibleRange.start || end > visibleRange.end) showEditorRange(displayProjection.toSource(offset));
  offset -= visibleRange.start; end = Math.min(end - visibleRange.start, editor.value.length);
  editor.focus(); editor.setSelectionRange(offset, end);
  // Measure wrapped text with the editor's own font and width rather than
  // guessing a line height: a single source paragraph can wrap many times.
  const computed = getComputedStyle(editor), mirror = document.createElement('div');
  for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'padding', 'direction', 'tabSize']) mirror.style[key] = computed[key];
  Object.assign(mirror.style, { position: 'fixed', left: '-100000px', top: '0', width: `${editor.clientWidth}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', boxSizing: 'border-box' });
  mirror.textContent = editor.value.slice(0, offset);
  const marker = document.createElement('span'); marker.textContent = '\u200b'; mirror.append(marker); document.body.append(mirror);
  editor.scrollTop = Math.max(0, marker.offsetTop - editor.clientHeight / 4); mirror.remove();
}
function showEditorRange(offset) {
  displayProjection = projectNikud(session.editedText, session.hideNikud);
  offset = displayProjection.toDisplay(offset);
  if (!continuousEditor && el('proposed').clientWidth > 0) {
    continuousEditor = createContinuousEditor(el('book-scroll'), el('editor-canvas'), el('proposed'), syncScrollNavigation);
  }
  if (continuousEditor) {
    continuousEditor.setText(displayProjection.text, offset, session.view?.geometry); visibleRange = continuousEditor.range;
  } else {
    visibleRange = editorRange(displayProjection.text, offset);
    el('proposed').value = displayProjection.text.slice(visibleRange.start, visibleRange.end);
  }
}
function initializeVisibleEditor() {
  // Otzaria may restore the plugin before its tab has a visible viewport.
  if (!session || chooserOpen || continuousEditor || !(el('proposed').clientWidth > 0)) return;
  showEditorRange(session.view?.visibleOffset ?? positionInBook(session.book, session.location ?? { sectionIndex: 0, offset: 0 }, session.editedText));
  restoreView(); controls();
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(initializeVisibleEditor).observe(el('book-scroll'));
function syncScrollNavigation(offset) {
  if (!session || chooserOpen) return;
  offset = displayProjection.toSource(offset);
  visibleRange = continuousEditor.range;
  if (mappedText !== session.editedText || mappedBook !== session.book) {
    mappedBook = session.book;
    mappedText = session.editedText;
    inverseChanges = diffBook(mappedText, session.book.originalText);
  }
  const originalOffset = originalToEditedOffset(mappedText, session.book.originalText, offset, inverseChanges);
  const sections = session.book.sections;
  let lo = 0, hi = sections.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (sections[mid].start <= originalOffset) lo = mid; else hi = mid - 1; }
  session.location = { sectionIndex: sections[lo].index, offset: Math.max(0, originalOffset - sections[lo].start) };
  el('section-number').value = String(sections[lo].index + 1);
  const key = activeTocKey(tocTree, sections[lo].index);
  if (key === selectedKey) return;
  ensurePathExpanded(tocTree, key, tocExpanded);
  // Change the selected row only; rebuilding the whole tree on each scroll
  // would replace focus and create avoidable layout work.
  const nextRow = el('toc-list').querySelector?.(`[data-key="${key}"]`);
  if (!nextRow) renderNavigation();
  else {
    selectedRow?.classList.remove('selected');
    nextRow.classList.add('selected'); selectedRow = nextRow; selectedKey = key;
  }
  selectedRow?.scrollIntoView?.({ block: 'nearest' });
}
function switchNavigation(search) {
  el('toc-view').hidden = search; el('search-view').hidden = !search;
  el('nav-toc-tab').setAttribute('aria-selected', String(!search)); el('nav-search-tab').setAttribute('aria-selected', String(search));
  if (search) { renderSearchResults(); el('book-search').focus(); }
}
async function renderSearchResults() {
  if (!session) return;
  const generation = ++searchGeneration, searchedSession = session, text = session.editedText;
  const query = el('book-search').value.trim();
  const group = document.createElement('div'); group.className = 'toc-group';
  if (!query) { const hint = document.createElement('p'); hint.textContent = 'כתבו מילים לחיפוש בספר'; group.append(hint); }
  else {
    const results = await searchBook(text, query);
    if (generation !== searchGeneration || session !== searchedSession || session.editedText !== text ||
        el('book-search').value.trim() !== query || chooserOpen || el('search-view').hidden) return;
    if (!results.length) { const hint = document.createElement('p'); hint.textContent = 'לא נמצאו תוצאות'; group.append(hint); }
    for (const result of results) {
      const row = document.createElement('div'); row.className = 'toc-row search-result';
      const label = document.createElement('button'); label.type = 'button'; label.className = 'toc-label'; label.textContent = projectNikud(result.snippet, session.hideNikud).text;
      label.addEventListener('click', () => {
        if (session !== searchedSession || session.editedText !== text || el('book-search').value.trim() !== query) return;
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
el('book-search').addEventListener('input', () => { searchGeneration++; clearTimeout(searchTimer); searchTimer = setTimeout(renderSearchResults, 150); });
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
async function persist(value = session, books = sessions) {
  clearTimeout(saveTimer);
  if (value === session) captureView();
  // Book data and report bodies are immutable; copy only mutable queue state.
  const nextBooks = value ? [...books.filter(item => item.id !== value.id), value] : books.filter(item => item.id !== session?.id);
  // Preserve tab order when replacing the active draft.
  if (value && books.some(item => item.id === value.id)) nextBooks.splice(0, nextBooks.length, ...books.map(item => item.id === value.id ? value : item));
  const snapshot = nextBooks.length || libraryTabs.length ? { schemaVersion: 2, activeId: value?.id ?? nextBooks[0]?.id,
    activeLibraryId: chooserOpen ? activeLibraryId : null,
    libraryTabs: libraryTabs.map(item => ({ ...item, view: item.view ? { ...item.view, expanded: [...item.view.expanded] } : undefined })),
    sessions: nextBooks.map(item => ({ ...item, view: item.view ? { ...item.view, tocExpanded: [...item.view.tocExpanded] } : undefined,
      queue: item.queue?.map(report => ({ ...report, payload: { ...report.payload } })) ?? null })) } : null, savedRevision = revision;
  writes = writes.catch(() => {}).then(() => draftStorage.write(snapshot));
  await writes;
  // A background write must not restore tabs closed or switched since its snapshot.
  if (books === sessions && savedRevision === revision) sessions = nextBooks;
  if (savedRevision === revision) {
    el('draft-status').textContent = snapshot ? 'הטיוטה נשמרה' : '';
    await call('ui.setUnsavedChanges', { hasChanges: false }).catch(() => {});
    if (savedRevision === revision) unsaved = false;
  }
}
function scheduleSave() {
  revision++; el('draft-status').textContent = 'שומר…';
  if (!unsaved) {
    unsaved = true;
    call('ui.setUnsavedChanges', { hasChanges: true, message: 'השינויים האחרונים בספר טרם נשמרו בטיוטה.' }).catch(() => { unsaved = false; });
  }
  clearTimeout(saveTimer); saveTimer = setTimeout(() => persist().catch(error => message(`שמירת הטיוטה נכשלה: ${error.message}`, true)), 400);
}
function identityFrom(event) {
  const data = event.selection ?? event, bookId = data.bookId ?? data.currentBookId ?? data.currentBook, id = data.id ?? data.currentId;
  if (typeof bookId !== 'string' || !bookId) throw new Error('לא נמצא ספר פתוח. פתחו ספר טקסט ובחרו „העבר את הספר לתיקון”.');
  return { bookId, ...(data.bookUid ? { bookUid: data.bookUid } : id != null ? { bookUid: `id:${id}` } : {}), location: readerPosition(event) };
}
async function openBook(identity) {
  if (loading || sending) throw new Error('המתינו לסיום הפעולה הנוכחית.');
  loading = true; controls();
  try {
    captureView();
    if (session) await persist();
    const { location, ...bookIdentity } = identity;
    const existing = sessions.find(item => item.book.identity.bookId === bookIdentity.bookId && item.book.identity.bookUid === bookIdentity.bookUid);
    if (existing) {
      await updateNikudDisplay(existing);
      await persist(existing); finishLibraryTab(); session = existing; chooserOpen = false; render(); restoreView(); message(); scheduleSave(); return;
    }
    const book = await loadBook(call, bookIdentity, progress => message(progress.phase === 'content'
      ? `טוען את הספר… ${Math.round(progress.loaded / 1000)} אלפי תווים` : `ממפה פסקאות… ${progress.loaded} מתוך ${progress.total}`));
    book.toc = await call('library.getBookToc', book.identity).catch(() => []);
    const hideNikud = await readNikudDisplay(call, book);
    const next = { id: newId(), book, hideNikud, editedText: book.originalText, queue: null, completed: false, location: location ?? { sectionIndex: 0, offset: 0 } };
    await persist(next); finishLibraryTab(); session = next; chooserOpen = false; render(); restoreView(); message(); scheduleSave();
    loading = false; controls();
  } finally { loading = false; controls(); }
}
function finishLibraryTab() {
  if (chooserOpen && activeLibraryId) libraryTabs = libraryTabs.filter(item => item.id !== activeLibraryId);
  activeLibraryId = null;
}
let openings = Promise.resolve();
function requestBook(event) {
  if (!['correct-book', 'correct-selection'].includes(event.itemId)) return;
  openings = openings.catch(() => {}).then(async () => {
    await initialized;
    const identity = identityFrom(event);
    await openBook(identity);
  }).catch(error => message(error.message, true));
}
el('proposed').addEventListener('input', () => {
  if (!session || loading || sending || hasPartialDelivery()) return;
  const value = el('proposed').value;
  const editedText = applyDisplayEdit(displayProjection, visibleRange.start, visibleRange.end, value);
  const visibleValue = projectNikud(value, session.hideNikud).text;
  if (continuousEditor) {
    continuousEditor.edited(visibleValue); visibleRange = continuousEditor.range;
  } else {
    el('proposed').value = visibleValue;
    visibleRange.end = visibleRange.start + visibleValue.length;
  }
  displayProjection = projectNikud(editedText, session.hideNikud);
  if (editedText === session.editedText) return;
  searchGeneration++;
  if (session.completed) session.reportedText = session.editedText;
  // Unsent reports belong to the previous wording; rebuild them on next submit.
  // Until the user changes the text, retain their IDs for an idempotent retry.
  session.queue = null; session.completed = false; session.editedText = editedText;
  controls(); scheduleSave();
  if (!el('search-view').hidden) { clearTimeout(searchTimer); searchTimer = setTimeout(renderSearchResults, 150); }
});
function normalizeLibraryQuery(value) {
  return value.normalize('NFD').replace(/[\u0591-\u05c7]/g, '').toLocaleLowerCase('he').trim();
}
function libraryIcon(folder, type = 'text') {
  const icon = document.createElement('span'); icon.className = 'library-icon';
  icon.innerHTML = folder
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11a2 2 0 0 1 2 2v16H6a3 3 0 0 1-3-3V6a3 3 0 0 1 2-3ZM3 18h15M7 3v12"/>' + (type === 'pdf' ? '<path d="M10 7h5M10 10h5"/>' : '') + '</svg>';
  return icon;
}
function libraryChain(node, path, chain = []) {
  if (!node) return null;
  const next = [...chain, node];
  if (node.path === path || (node === libraryTree && path === '/')) return next;
  for (const child of node.categories ?? []) {
    const found = libraryChain(child, path, next); if (found) return found;
  }
  return null;
}
function navigateLibrary(path) {
  if (loading || sending) return;
  libraryPath = path; el('library-search').value = ''; renderLibrary();
  el('library-list').scrollTop = 0; el('library-search').focus();
}
async function selectLibraryBook(book) {
  if (loading || sending) return;
  try {
    if (book.type === 'text') await openBook(identityFrom(book));
    else {
      loading = true; controls();
      await call('reader.openBook', { bookId: book.bookId, ...(book.bookUid ? { bookUid: book.bookUid } : book.id != null ? { id: book.id } : {}), type: book.type });
      message();
    }
  } catch (error) { message(error.message, true); }
  finally { loading = false; controls(); }
}
function updateLibraryGeometry() {
  const width = el('library-list').clientWidth;
  const columns = Math.max(1, Math.min(5, Math.floor(width / 250)));
  el('library-list').style.setProperty('--columns', columns);
  el('library-list').style.setProperty('--card-ratio', width < 800 ? 3.3 : width >= 1400 ? 2.1 : width >= 1100 ? 1.95 : 1.8);
}
function renderLibrary() {
  const query = normalizeLibraryQuery(el('library-search').value);
  const chain = libraryChain(libraryTree, libraryPath) ?? (libraryTree ? [libraryTree] : []);
  const current = chain.at(-1);
  const breadcrumbs = chain.map((category, index) => {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = index === 0 ? 'ספריית אוצריא' : category.title;
    if (index === chain.length - 1) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => navigateLibrary(category.path ?? '/')); return button;
  });
  el('library-breadcrumbs').replaceChildren(...breadcrumbs);
  el('library-search').placeholder = 'איתור ספר או מחבר ב' + (current?.title ?? 'ספריית אוצריא');
  const groups = [];
  const bookMatches = book => normalizeLibraryQuery((book.title ?? book.bookId) + ' ' + (book.author ?? '')).includes(query);
  function card(entry, folder, action) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'library-card';
    button.title = entry.title ?? entry.bookId;
    const text = document.createElement('span'); text.className = 'library-text';
    const title = document.createElement('span'); title.className = 'library-name'; title.textContent = button.title; text.append(title);
    if (entry.author) { const author = document.createElement('span'); author.className = 'library-author'; author.textContent = entry.author; text.append(author); }
    button.append(text, libraryIcon(folder, entry.type)); button.addEventListener('click', action); return button;
  }
  function listRow(entry, level, action, expanded) {
    const item = document.createElement('div'); item.className = 'toc-row' + (expanded ? ' expanded' : '');
    item.style.setProperty('--level', level); item.append(libraryIcon(expanded !== undefined, entry.type));
    const label = document.createElement('button'); label.type = 'button'; label.className = 'toc-label';
    label.textContent = entry.title ?? entry.bookId; label.title = label.textContent; label.addEventListener('click', action); item.append(label);
    if (expanded !== undefined) {
      label.setAttribute('aria-expanded', String(expanded));
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'toc-chevron';
      toggle.setAttribute('aria-label', (expanded ? 'כווץ ' : 'הרחב ') + entry.title); toggle.setAttribute('aria-expanded', String(expanded));
      toggle.addEventListener('click', action); item.append(toggle);
    }
    return item;
  }
  function visitTree(node, level, group) {
    for (const category of node.categories ?? []) {
      const expanded = libraryExpanded.has(category.path);
      const container = level === 0 ? document.createElement('div') : group;
      if (level === 0) { container.className = 'toc-group library-group'; groups.push(container); }
      container.append(listRow(category, level, () => {
        if (loading || sending) return;
        expanded ? libraryExpanded.delete(category.path) : libraryExpanded.add(category.path);
        renderLibrary();
        for (const button of el('library-list').querySelectorAll?.('.toc-label') ?? []) {
          if (button.title === category.title) { button.focus({ preventScroll: true }); break; }
        }
      }, expanded));
      if (expanded) visitTree(category, level + 1, container);
    }
    for (const book of node.books ?? []) {
      const container = level === 0 ? document.createElement('div') : group;
      if (level === 0) { container.className = 'toc-group library-group'; groups.push(container); }
      container.append(listRow(book, level, () => selectLibraryBook(book)));
    }
  }
  if (current && !query && libraryMode === 'tree') visitTree(current, 0);
  else if (current) {
    const container = document.createElement('div'); container.className = libraryMode === 'grid' ? 'library-grid' : 'toc-group library-group';
    function add(entry, folder) {
      const action = folder ? () => navigateLibrary(entry.path) : () => selectLibraryBook(entry);
      container.append(libraryMode === 'grid' ? card(entry, folder, action) : listRow(entry, 0, action));
    }
    function collect(node) {
      for (const category of node.categories ?? []) {
        if (!query || normalizeLibraryQuery(category.title).includes(query)) add(category, true);
        if (query) collect(category);
      }
      for (const book of node.books ?? []) if (!query || bookMatches(book)) add(book, false);
    }
    collect(current);
    if (container.children.length) groups.push(container);
  }
  if (!groups.length && libraryTree) { const hint = document.createElement('p'); hint.className = 'library-no-results'; hint.textContent = query ? 'לא נמצאו תוצאות' : 'אין ספרים בתיקייה זו'; groups.push(hint); }
  const scroll = el('library-list').scrollTop;
  el('library-list').replaceChildren(...groups); el('library-list').scrollTop = scroll;
  updateLibraryGeometry(); controls();
}
el('library-search').addEventListener('input', () => {
  clearTimeout(libraryQueryTimer); libraryQueryTimer = setTimeout(() => { renderLibrary(); el('library-list').scrollTop = 0; }, 250);
});
el('library-search').addEventListener('keydown', event => {
  if (event.key === 'ArrowDown' || event.key === 'Tab' && !event.shiftKey) {
    const first = el('library-list').querySelector?.('button');
    if (first) { event.preventDefault(); first.focus(); }
  }
});
el('library-list').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const items = [...el('library-list').querySelectorAll('.library-card, .toc-label')];
  const index = items.indexOf(document.activeElement); if (index < 0) return;
  const columns = libraryMode === 'grid' ? Math.max(1, Math.min(5, Math.floor(el('library-list').clientWidth / 250))) : 1;
  const step = event.key === 'ArrowLeft' ? 1 : event.key === 'ArrowRight' ? -1 : event.key === 'ArrowDown' ? columns : -columns;
  event.preventDefault();
  if (event.key === 'ArrowUp' && index < columns) { el('library-search').focus(); return; }
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, index + step));
  items[next].focus(); items[next].scrollIntoView?.({ block: 'nearest' });
});
const librarySettingsPermissionMessage = 'כדי להתאים את תצוגת הספרייה לאוצריא, יש לאפשר קריאת הגדרות בהרשאות התוסף.';
function applyLibraryMode(value) {
  const mode = value === 'list' ? 'tree' : 'grid';
  if (libraryMode === mode) return;
  libraryMode = mode;
  if (chooserOpen || !session) renderLibrary();
}
async function refreshLibraryMode() {
  applyLibraryMode(await call('settings.get', { key: 'key-library-view-mode' }));
  if (statusText === librarySettingsPermissionMessage) message();
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateLibraryGeometry).observe(el('library-list'));
async function showLibrary() {
  if (loading || sending) return;
  try {
    await initialized;
    captureView();
    const tab = { id: newId() }; libraryTabs.push(tab);
    activeLibraryId = tab.id; chooserOpen = true;
    render(); restoreView(); message(); scheduleSave(); el('library-search').focus();
  } catch (error) { message(error.message, true); }
}
el('change-book').addEventListener('click', showLibrary);
el('cancel-book-picker').addEventListener('click', () => {
  if (loading || sending) return;
  finishLibraryTab();
  chooserOpen = false; render(); restoreView(); message();
  scheduleSave();
});
el('discard').addEventListener('click', async () => {
  if (loading || sending) return;
  loading = true; controls();
  try {
    await persist(null); session = sessions[0] ?? null; render(); restoreView(); message();
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
    const sourceBook = await sourceGuard.check(session.book, queuedSourceSections(session));
    verifyQueuedCorrectionSources(session.queue, sourceBook);
    if (!session.queue) {
      message('מכין את דיווחי התיקונים…'); await new Promise(resolve => setTimeout(resolve, 0));
      const reported = new Set(diffBook(session.book.originalText, session.reportedText ?? session.book.originalText).map(change => JSON.stringify(change)));
      const changes = diffBook(session.book.originalText, session.editedText).filter(change => !reported.has(JSON.stringify(change)));
      if (!changes.length) { message('לא נמצאו שינויים בספר.'); return; }
      const info = await call('app.getInfo').catch(() => null);
      const client = info && typeof info.version === 'string' && typeof info.platform === 'string' ?
        { app_version: info.version + (info.buildNumber ? `+${info.buildNumber}` : ''), platform: info.platform } : null;
      const queue = await prepareReports(session, changes, email, call, newId, (done, total) => message(`מכין דיווחים… ${done} מתוך ${total}`), { sourceBook, client });
      session.queue = queue; await persist();
    }
    let sent = session.queue.filter(item => item.sent).length;
    for (const item of session.queue) {
      if (item.sent) continue; if (pause) break;
      message(`שולח דיווח ${sent + 1} מתוך ${session.queue.length}…`);
      try {
        const response = await sendReport(host, item.payload);
        item.correctionSupported = item.payload.report_kind === 'text_correction' ? response.correction_supported === true : false;
      } catch (error) {
        if (error.status === 409) { item.payload.report_id = newId(); await persist(); }
        throw error;
      }
      item.sent = true; sent++; await persist();
      if (sent < session.queue.length) await new Promise(resolve => setTimeout(resolve, 350));
    }
    session.completed = session.queue.every(item => item.sent); await persist();
    message(session.completed ? `כל ${sent} הדיווחים נשלחו בהצלחה.` : `נשלחו ${sent} מתוך ${session.queue.length}. אפשר להמשיך את השליחה בהמשך.`);
    if (session.completed) {
      message(reportDeliveryMessage(session.queue), false, 3000);
    }
  } catch (error) {
    const sent = session?.queue?.filter(item => item.sent).length ?? 0;
    message(`${error.message}${sent ? ` כבר נשלחו ${sent} דיווחים; ההמשך נשמר.` : ''}`, true);
  } finally { sending = false; controls(); }
});
async function initialize(boot) {
  applyTheme(boot?.theme);
  const results = await Promise.allSettled([call('app.getTheme'), draftStorage.read(),
    call('settings.get', { key: 'key-library-view-mode' })]);
  if (results[0].status === 'fulfilled') applyTheme(results[0].value);
  if (results[1].status === 'rejected') throw new Error('לא ניתן לקרוא את טיוטת הספר. בדקו את הרשאות האחסון.');
  if (results[2].status === 'fulfilled') libraryMode = results[2].value === 'list' ? 'tree' : 'grid';
  const stored = results[1].value;
  sessions = stored?.schemaVersion === 2 ? stored.sessions : stored ? [stored] : [];
  libraryTabs = stored?.libraryTabs ?? [];
  activeLibraryId = libraryTabs.some(item => item.id === stored?.activeLibraryId) ? stored.activeLibraryId : null;
  chooserOpen = !!activeLibraryId;
  for (const item of sessions) if (item.queue?.length && item.queue.every(report => report.sent)) item.completed = true;
  session = sessions.find(item => item.id === stored?.activeId) ?? sessions[0] ?? null;
  for (const item of sessions) if (!item.book.toc?.length) item.book.toc = await call('library.getBookToc', item.book.identity).catch(() => []);
  for (const item of sessions) await updateNikudDisplay(item);
  render(); restoreView();
  for (const item of sessions) sourceGuard.restore(item.book);
  if (!session) {
    message('טוען את הספרייה…');
    libraryTree = sortLibraryTree(filterLibraryTree(await call('library.getTree', { includeBooks: true })));
    if (chooserOpen) restoreView(); else renderLibrary();
    el('library-search').focus();
  } else {
    call('library.getTree', { includeBooks: true }).then(tree => { libraryTree = sortLibraryTree(filterLibraryTree(tree)); if (chooserOpen) restoreView(); else if (!session) renderLibrary(); }).catch(error => message(error.message, true));
  }
  message(results[2].status === 'rejected' ? librarySettingsPermissionMessage : '', results[2].status === 'rejected');
}
async function updateNikudDisplay(item) {
  const hidden = await readNikudDisplay(call, item.book).catch(() => item.hideNikud ?? false);
  if (hidden === !!item.hideNikud) return false;
  item.hideNikud = hidden;
  if (item.view) { delete item.view.geometry; delete item.view.scrollTop; }
  return true;
}
async function refreshActiveDisplay() {
  await initialized;
  if (!session || chooserOpen || loading || sending) return;
  const item = session;
  captureView();
  if (await updateNikudDisplay(item) && item === session && !chooserOpen && !loading && !sending) {
    // Capture again after the RPC: editing may have continued while it ran.
    captureView();
    if (item.view) { delete item.view.geometry; delete item.view.scrollTop; }
    render(); restoreView(); scheduleSave();
  }
  initializeVisibleEditor();
}
if (host) {
  host.on('theme.changed', applyTheme); host.on('contextMenu.itemClicked', requestBook);
  host.on('settings.changed', event => { if (event.key === 'key-library-view-mode') applyLibraryMode(event.newValue); });
  host.on('plugin.permissions_changed', event => {
    if (event.permissions?.includes('settings.read')) initialized?.then(refreshLibraryMode).catch(error => message(error.message, true));
  });
  host.on('plugin.page_opened', event => { if (event.source === 'newTabButton') showLibrary(); });
  host.on('plugin.suspended', () => { if (session || libraryTabs.length) { captureView(); persist().catch(error => message(error.message, true)); } });
  host.on('plugin.resumed', () => {
    initialized?.then(refreshLibraryMode).catch(error => message(error.message, true));
    refreshActiveDisplay().catch(error => message(error.message, true));
  });
  host.on('plugin.boot', boot => { initialized ??= initialize(boot); initialized.catch(error => message(error.message, true)); });
  if (host._booted) { initialized ??= initialize(); initialized.catch(error => message(error.message, true)); }
} else { el('empty').hidden = false; message('יש לפתוח את התוסף מתוך אוצריא.'); }
