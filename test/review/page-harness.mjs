// Decisions that depend on dialogs or on sequences of page actions, run
// through the built bundle with the contract model (not the host).

import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from '../../scripts/build.mjs';
import { createCorrectionStore } from '../../plugin/correction-store.js';
import { createFakeOtzaria, createStorage } from '../fake-otzaria.mjs';

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
async function plugin({ host, storage, confirm = true, boot = {}, permissions = ['reader.local_edit'], autoBoot = true, sdkOverrides = {} }) {
  const bundle = await build();
  const elements = new Map(), listeners = new Map(), rpcCalls = [];
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
    'reader.getSectionTextMap': ({ bookUid, sectionIndex }) => ({ sourceText: strip(host.books[bookUid].lines[sectionIndex]) }),
    ...sdkOverrides
  };
  const sdk = {
    on(event, handler) { listeners.set(event, handler); },
    async call(method, args = {}) {
      rpcCalls.push({ method, args });
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
  const start = () => { booted = true; listeners.get('plugin.boot')(boot); }; if (autoBoot) start();
  return { el, listeners, start, rpcCalls, emit: (name, payload) => listeners.get(name)(payload) };
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


export { plugin, waitFor, clickWhenReady, editInReader, find, createFakeOtzaria, createStorage, createCorrectionStore };
