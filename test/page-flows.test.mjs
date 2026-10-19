// Decisions that depend on dialogs or on sequences of page actions, run
// through the built bundle with the contract model (not the host).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from '../scripts/build.mjs';
import { createCorrectionStore } from '../plugin/correction-store.js';
import { createFakeOtzaria, createStorage } from './fake-otzaria.mjs';

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.handlers = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.classes = new Set(); }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() { const c = this.classes; return { add: v => c.add(v), remove: v => c.delete(v), toggle: (v, on) => (on ?? !c.has(v)) ? c.add(v) : c.delete(v) }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  insertBefore(item, before) { const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, item); }
  setAttribute() {}
  addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
  focus() {}
  click() { for (const handler of this.handlers.click ?? []) handler({ preventDefault() {} }); }
  *walk() { yield this; for (const child of this.children) if (child instanceof Element) yield* child.walk(); }
  get allText() { return [...this.walk()].map(item => item.textContent).join(' '); }
}
const strip = line => line.replace(/<[^>]*>/g, '');
async function plugin({ host, storage, confirm = true, boot = {}, permissions = ['reader.local_edit'] }) {
  const bundle = await build();
  const elements = new Map(), listeners = new Map();
  let booted = false;
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const contract = host.instance(storage);
  const extra = {
    'reader.getCurrentState': () => ({ currentTabId: null, openTabs: [...host.tabs].map(([tabId, bookUid]) => ({
      tabId, bookUid, id: Number(bookUid.slice(3)), bookId: host.books[bookUid].bookId, book: host.books[bookUid].bookId, type: 'text',
      correctionSessionId: [...host.sessions.values()].find(session => !session.ended && session.tabId === tabId)?.sessionId ?? null })) }),
    'reader.activateTab': () => { host.activations = (host.activations ?? 0) + 1; return true; },
    'ui.showError': args => { (host.shownErrors ??= []).push(args.message); return true; },
    'ui.showMessage': args => { (host.shownMessages ??= []).push(args.message); return true; },
    'ui.showConfirm': args => { (host.confirms ??= []).push(args.title); return { confirmed: typeof confirm === 'function' ? confirm(args) : confirm }; },
    'app.getGrantedPermissions': () => permissions,
    // Highlights: the source layer is the stripped paragraph (as in Otzaria).
    'reader.findTextOccurrences': ({ bookUid, sectionIndex, query, layer }) => {
      assert.equal(layer, 'source');
      const text = strip(host.books[bookUid].lines[sectionIndex]), results = [];
      for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + 1)) results.push({ text: query, range: { layer: 'source', exactText: query, start: { utf16: at }, end: { utf16: at + query.length } } });
      return { results, hasMore: false, totalCount: results.length };
    },
    'reader.setHighlight': args => { (host.highlights ??= new Map()).set(args.highlightId, args); return { highlightId: args.highlightId, version: 1 }; },
    'reader.clearHighlight': ({ highlightId }) => host.highlights?.delete(highlightId) ?? false,
    'reader.clearAllHighlights': () => { host.highlights?.clear(); return true; },
    'app.getTheme': () => null,
    'library.getBookDetails': ({ bookUid }) => ({ source: 'library', type: 'text', id: Number(bookUid.slice(3)), title: host.books[bookUid].bookId, lineCount: host.books[bookUid].lines.length }),
    'library.getBookContent': ({ bookUid, offset, limit }) => host.books[bookUid].lines.join('\n').slice(offset, offset + limit),
    'reader.getSectionTextMap': ({ bookUid, sectionIndex }) => ({ sourceText: strip(host.books[bookUid].lines[sectionIndex]) })
  };
  const sdk = {
    on(event, handler) { listeners.set(event, handler); },
    async call(method, args = {}) {
      if (!booted) return { success: false, error: { code: 'error.not_ready', message: 'SDK has not booted' } };
      try { return { success: true, data: extra[method] ? extra[method](args) : await contract(method, args) }; }
      catch (error) { return { success: false, error: { code: error.code ?? 'error.internal', message: error.message } }; }
    }
  };
  const DOMParser = class { parseFromString() { return { body: { textContent: '' } }; } };
  runInNewContext(bundle, {
    window: { Otzaria: sdk }, crypto: webcrypto, TextEncoder, console, queueMicrotask, setTimeout, clearTimeout, DOMParser,
    CSS: { escape: value => value },
    document: { getElementById: el, createElement: tag => new Element(tag), querySelector: () => null, activeElement: null,
      documentElement: { style: { setProperty() {} } } }
  }, { filename: 'app.bundle.js' });
  booted = true; listeners.get('plugin.boot')(boot);
  return { el, listeners, emit: (name, payload) => listeners.get(name)(payload) };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await sleep(20); }
  assert.fail(`timed out: ${label}`);
}
const find = (page, list, text) => [...page.el(list).walk()].find(item => item.textContent === text);
async function clickWhenReady(page, list, text) {
  await waitFor(() => find(page, list, text) && !find(page, list, text).disabled, `button ${text}`);
  find(page, list, text).click();
}
async function editInReader(page, host, edits) {
  const tabId = host.openTab('id:1');
  page.emit('contextMenu.itemClicked', { itemId: 'correct-book', selection: { tabId } });
  await waitFor(() => [...host.sessions.values()].some(session => !session.ended && session.tabId === tabId), 'session begun');
  const session = [...host.sessions.values()].find(item => item.tabId === tabId);
  for (const [index, text] of edits) host.edit(session.sessionId, index, text);
  page.emit('reader.correctionSessionChanged', { sessionId: session.sessionId });
  return session;
}

test('page: an ID conflict asks for consent; refusal and reload keep asking; consent sends a new ID', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  let answer = false;
  const page = await plugin({ host, storage, confirm: () => answer });
  const session = await editInReader(page, host, [[0, 'אלף מתוקן']]);
  page.emit('reader.correctionSessionEnded', host.endByUser(session.sessionId));
  await waitFor(() => /שלח הכל/.test(page.el('book-list').allText), 'pending');
  const [item] = (await createCorrectionStore(host.instance(storage)).load()).books.get('id:1').pending;
  host.submissions.set(`bc-${item.key}`, { content: 'other', params: {}, count: 1 });
  await clickWhenReady(page, 'book-list', 'שלח הכל');
  await waitFor(() => /כבר שייך לתוכן אחר/.test(page.el('book-list').allText), 'conflict shown after refusal');
  assert.deepEqual(host.confirms, ['מזהה הדיווח כבר בשימוש']);
  const reloaded = await plugin({ host, storage, confirm: () => answer });
  await waitFor(() => /כבר שייך לתוכן אחר/.test(reloaded.el('book-list').allText), 'still awaiting consent after reload');
  await clickWhenReady(reloaded, 'book-list', 'שלח הכל');
  await waitFor(() => host.confirms.length === 2, 'asked again after reload');
  assert.equal(host.submissions.has(`bc-${item.key}-1`), false, 'no new ID without consent');
  answer = true;
  await clickWhenReady(reloaded, 'book-list', 'שלח הכל');
  await waitFor(() => host.submissions.has(`bc-${item.key}-1`), 'new ID sent after consent');
});

test('page: a proposal whose session end was never seen asks before sending', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const page = await plugin({ host, storage, confirm: false });
  const session = await editInReader(page, host, [[0, 'אולי בוטל']]);
  host.submitFails = 'report_failed';
  await clickWhenReady(page, 'live-list', 'שמירה ושליחה'); // takes over, then sending fails
  await waitFor(() => host.acks.length >= 1 && /שמירה ושליחה/.test(page.el('live-list').allText) && !find(page, 'live-list', 'שמירה ושליחה').disabled, 'taken over');
  host.submitFails = null;
  host.edit(session.sessionId, 0, 'אלף'); // reset in the reader, then the page closes
  host.endByUser(session.sessionId, 'app_exit'); // end event lost, empty draft not listed
  const reloaded = await plugin({ host, storage, confirm: false });
  await waitFor(() => /ייתכן שהתיקון בוטל בקורא/.test(reloaded.el('book-list').allText), 'flagged');
  await clickWhenReady(reloaded, 'book-list', 'שלח הכל');
  await waitFor(() => host.confirms?.includes('תיקון שמצבו בקורא אינו ידוע'), 'asked');
  await sleep(300);
  assert.equal(host.submissions.size, 0, 'declined: nothing sent');
  assert.match(reloaded.el('book-list').allText, /אולי בוטל/, 'kept, not deleted');
});

test('page: restoring a conflict keeps it listed until the restored proposal is saved', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const store = createCorrectionStore(host.instance(storage));
  const conflict = { sectionIndex: 0, originalSourceText: 'אלף', originalText: 'אלף', proposedText: 'מוצל', reason: 'displaced' };
  await store.saveVersion({ bookUid: 'id:1', bookId: 'ספר', changes: [], draft: { draftId: 'old', version: 1, conflicts: [conflict] } }, { sessionId: 'lost' });
  host.nextVersion = 2;
  const page = await plugin({ host, storage });
  await editInReader(page, host, []);
  host.persist = false; // the host has not saved the restored state
  await clickWhenReady(page, 'book-list', 'החזר לקורא');
  await waitFor(() => /רק אחרי שהשמירה תושלם/.test(page.el('status').textContent), 'not yet saved');
  assert.match(page.el('book-list').allText, /התנגשויות/, 'conflict still listed');
  host.persist = true;
  const [session] = host.sessions.values();
  host.edit(session.sessionId, 3, 'הא!');
  await clickWhenReady(page, 'live-list', 'סיום עריכה');
  await waitFor(() => !/התנגשויות/.test(page.el('book-list').allText) && /מוצל/.test(page.el('book-list').allText), 'settled after the save');
});

test('page: 0.2.2 migration under a write failure keeps the legacy item and never touches legacy keys', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const lines = host.books['id:1'].lines.map(strip);
  let start = 0;
  const sections = lines.map((text, index) => { const section = { index, start, end: start + text.length, text }; start += text.length + 1; return section; });
  storage.data.set('book-session', { schemaVersion: 2, sessions: [{ id: 'old', book: { identity: { bookId: 'ספר', bookUid: 'id:1' }, details: { title: 'ספר' },
    originalText: lines.join('\n'), sections }, editedText: lines.join('\n').replace('דלת', 'דלתות'), queue: null }] });
  const legacy = JSON.stringify(storage.data.get('book-session'));
  const page = await plugin({ host, storage });
  await editInReader(page, host, []);
  host.persist = false; // the host write fails: nothing becomes durable
  await clickWhenReady(page, 'legacy-list', 'העבר לקורא');
  await waitFor(() => /יסומנו כמועברים רק אחרי/.test(page.el('status').textContent), 'not marked');
  assert.match(page.el('legacy-list').allText, /דלתות/, 'legacy item still listed');
  storage.failSet = true; // and now the plugin cannot write either
  host.persist = true;
  const [session] = host.sessions.values();
  host.edit(session.sessionId, 3, 'הא!'); // Otzaria's retried write commits the full state
  page.emit('reader.correctionSessionEnded', host.endByUser(session.sessionId));
  await waitFor(() => /שמירת הטיוטה בתוסף נכשלה/.test(page.el('status').textContent), 'save failure shown');
  assert.match(page.el('legacy-list').allText, /דלתות/, 'still listed after the failed save');
  assert.equal(host.drafts.get('d-id:1').content, true, 'Otzaria keeps its draft');
  storage.failSet = false;
  const reloaded = await plugin({ host, storage }); // restart: discovery takes it over
  await waitFor(() => !/דלתות/.test(reloaded.el('legacy-list').allText), 'covered after the durable save');
  assert.equal(JSON.stringify(storage.data.get('book-session')), legacy, 'legacy keys untouched');
});

test('page: history survives compaction and a reload', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const page = await plugin({ host, storage });
  const session = await editInReader(page, host, [[2, 'דלת!']]);
  page.emit('reader.correctionSessionEnded', host.endByUser(session.sessionId));
  await clickWhenReady(page, 'book-list', 'שלח הכל');
  await waitFor(() => /דלת!/.test(page.el('history-list').allText), 'history');
  await waitFor(() => ![...storage.data.keys()].some(key => key.startsWith('nc:e:')), 'compacted');
  const reloaded = await plugin({ host, storage });
  await waitFor(() => /דלת!/.test(reloaded.el('history-list').allText), 'history after reload');
});

test('page: two independent proposals for one paragraph merge into one report', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  host.books['id:1'].lines[2] = 'דלת הא וו זין';
  const page = await plugin({ host, storage });
  for (const wording of ['דלתות הא וו זין', 'דלת הא וו זינן']) {
    const session = await editInReader(page, host, [[2, wording]]);
    page.emit('reader.correctionSessionEnded', host.endByUser(session.sessionId));
    await waitFor(() => !find(page, 'live-list', 'סיום עריכה'), 'session ended');
  }
  await waitFor(() => /2 הצעות נפרדות/.test(page.el('book-list').allText), 'two proposals listed');
  await editInReader(page, host, []);
  await clickWhenReady(page, 'book-list', 'איחוד לדיווח אחד');
  await waitFor(() => /אוחדו לנוסח אחד/.test(page.el('status').textContent), 'merged');
  await waitFor(() => !/הצעות נפרדות/.test(page.el('book-list').allText), 'one proposal left');
  const [live] = [...host.sessions.values()].filter(session => !session.ended);
  assert.deepEqual(live.changes.map(change => change.proposedText), ['דלתות הא וו זינן']);
  await clickWhenReady(page, 'book-list', 'שלח הכל');
  await waitFor(() => host.submissions.size === 1, 'one report sent');
  await sleep(300);
  const [sent] = host.submissions.values();
  assert.equal(host.submissions.size, 1);
  assert.equal(sent.params.snapshots[0].text, 'דלת הא וו זין');
  assert.equal(host.confirms ?? undefined, undefined, 'no separate-send warning after merging');
});

test('page: a reader click in a background instance opens editing without switching tabs', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const page = await plugin({ host, storage, boot: { app: { runMode: 'background' } } });
  const tabId = host.openTab('id:1'), other = host.openTab('id:1');
  page.emit('contextMenu.itemClicked', { itemId: 'correct-book', selection: { tabId } });
  await waitFor(() => [...host.sessions.values()].some(session => session.tabId === tabId), 'session begun');
  await sleep(200);
  assert.equal(host.activations ?? 0, 0, 'no tab switch');
  page.emit('contextMenu.itemClicked', { itemId: 'correct-book', selection: { tabId: other } });
  await waitFor(() => host.shownErrors?.length === 1, 'busy error shown by Otzaria');
  assert.match(host.shownErrors[0], /כבר בעריכה/);
});

const marked = host => [...(host.highlights?.values() ?? [])].map(mark => `${mark.sectionIndex}:${mark.range.exactText}`).sort();
const withMarks = ['reader.local_edit', 'reader.highlight'];

test('page: a saved proposal is marked green on the words it replaces; sending removes the mark', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  host.books['id:1'].lines[2] = 'דלת הא וו זין';
  const page = await plugin({ host, storage, permissions: withMarks });
  const session = await editInReader(page, host, [[2, 'דלת הא וו זינן'], [3, 'הא הא']]);
  await sleep(200);
  assert.deepEqual(marked(host), [], 'nothing is marked before the proposal is saved in the plugin');
  page.emit('reader.correctionSessionEnded', host.endByUser(session.sessionId));
  await waitFor(() => marked(host).length === 2, 'marks drawn');
  assert.deepEqual(marked(host), ['2:זין', '3:הא'], 'a replaced word, and the word next to an insertion');
  const [mark] = host.highlights.values();
  assert.equal(mark.style.backgroundColor, '#4CAF50');
  await waitFor(() => storage.data.get('readerMarksPending') === true, 'the background engine may wake to redraw');
  await clickWhenReady(page, 'book-list', 'שלח הכל');
  await waitFor(() => host.submissions.size === 2, 'sent');
  await waitFor(() => marked(host).length === 0, 'marks removed after sending');
  await waitFor(() => storage.data.get('readerMarksPending') === false, 'nothing left to wake for');
});

test('page: the marks setting is on by default; turning it off clears the marks and stops waking', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const page = await plugin({ host, storage, permissions: withMarks });
  const session = await editInReader(page, host, [[3, 'הי']]);
  page.emit('reader.correctionSessionEnded', host.endByUser(session.sessionId));
  await waitFor(() => marked(host).length === 1, 'marked by default');
  assert.equal(page.el('marks-toggle').checked, true);
  const toggle = page.el('marks-toggle'); toggle.checked = false;
  for (const handler of toggle.handlers.change) handler({ target: toggle });
  await waitFor(() => marked(host).length === 0, 'marks cleared');
  assert.equal(storage.data.get('markPendingInReader'), false);
  await waitFor(() => storage.data.get('readerMarksPending') === false, 'engine no longer woken');
  assert.match(page.el('book-list').allText, /1 תיקונים ממתינים/, 'the proposal itself is kept');
  toggle.checked = true;
  for (const handler of toggle.handlers.change) handler({ target: toggle });
  await waitFor(() => marked(host).length === 1, 'marks drawn again');
});

test('page: a mark whose words moved in the source is not guessed', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  host.books['id:1'].lines[2] = 'דלת הא';
  const page = await plugin({ host, storage, permissions: withMarks });
  const session = await editInReader(page, host, [[2, 'דלת הי']]);
  host.books['id:1'].lines[2] = 'וו דלת הא'; // the source changed after the proposal
  page.emit('reader.correctionSessionEnded', host.endByUser(session.sessionId));
  await waitFor(() => /1 תיקונים ממתינים/.test(page.el('book-list').allText), 'pending listed');
  await sleep(300);
  assert.deepEqual(marked(host), []);
});

test('page: without reader.highlight nothing is marked and the setting explains why', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const page = await plugin({ host, storage });
  const session = await editInReader(page, host, [[3, 'הי']]);
  page.emit('reader.correctionSessionEnded', host.endByUser(session.sessionId));
  await waitFor(() => /1 תיקונים ממתינים/.test(page.el('book-list').allText), 'pending listed');
  await sleep(200);
  assert.equal(host.highlights, undefined);
  assert.equal(page.el('marks-permission').hidden, false);
  assert.equal(page.el('marks-toggle').disabled, true);
});

test('page: while reading, a change made by another instance is redrawn', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  const page = await plugin({ host, storage, permissions: withMarks });
  const session = await editInReader(page, host, [[3, 'הי']]);
  page.emit('reader.correctionSessionEnded', host.endByUser(session.sessionId));
  await waitFor(() => marked(host).length === 1, 'marked');
  // Another instance turned the setting off.
  storage.data.set('markPendingInReader', false); storage.data.set('readerMarksRevision', 'off');
  page.emit('reader.current_ref_changed', { currentRef: 'x' });
  await waitFor(() => marked(host).length === 0, 'cleared after the reading position changed');
});
