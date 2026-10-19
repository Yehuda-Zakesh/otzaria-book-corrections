import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from '../scripts/build.mjs';
import { createFakeOtzaria, createStorage } from './fake-otzaria.mjs';

class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.dataset = {}; this.handlers = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.attributes = {}; this.classes = new Set(); }
  get className() { return [...this.classes].join(' '); }
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get classList() { const c = this.classes; return { add: v => c.add(v), remove: v => c.delete(v), toggle: (v, on) => (on ?? !c.has(v)) ? c.add(v) : c.delete(v), contains: v => c.has(v) }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  insertBefore(item, before) { const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, item); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
  focus() {}
  click() { for (const handler of this.handlers.click ?? []) handler({ preventDefault() {} }); }
  *walk() { yield this; for (const child of this.children) if (child instanceof Element) yield* child.walk(); }
  get allText() { return [...this.walk()].map(item => item.textContent).join(' '); }
}

async function plugin({ storage = createStorage(), host = createFakeOtzaria(), confirm = true } = {}) {
  const bundle = await build();
  const elements = new Map(), listeners = new Map(), rpc = [];
  let booted = false;
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const contract = host.instance(storage);
  const extra = {
    'reader.getCurrentState': () => ({ currentTabId: host.currentTabId ?? null, openTabs: [...host.tabs].map(([tabId, bookUid]) => ({
      tabId, bookUid, id: Number(bookUid.slice(3)), bookId: host.books[bookUid].bookId, book: host.books[bookUid].bookId, type: 'text',
      correctionSessionId: [...host.sessions.values()].find(session => !session.ended && session.tabId === tabId)?.sessionId ?? null })) }),
    'reader.activateTab': ({ index }) => { host.activated = index; return true; },
    'ui.showConfirm': () => ({ confirmed: confirm }),
    'app.getGrantedPermissions': () => ['reader.local_edit', 'reader.open'],
    'app.getTheme': () => ({ mode: 'dark', colorScheme: { surface: '#101010' } })
  };
  const sdk = {
    on(event, handler) { listeners.set(event, handler); },
    async call(method, args = {}) {
      rpc.push({ method, booted });
      if (!booted) return { success: false, error: { code: 'error.not_ready', message: 'SDK has not booted' } };
      try { return { success: true, data: extra[method] ? extra[method](args) : await contract(method, args) }; }
      catch (error) { return { success: false, error: { code: error.code ?? 'error.internal', message: error.message } }; }
    }
  };
  runInNewContext(bundle, {
    window: { Otzaria: sdk }, crypto: webcrypto, TextEncoder, console, queueMicrotask, setTimeout, clearTimeout,
    CSS: { escape: value => value },
    document: { getElementById: el, createElement: tag => new Element(tag), querySelector: () => null, activeElement: null,
      documentElement: { style: { setProperty() {} } } }
  }, { filename: 'app.bundle.js' });
  const boot = async () => { booted = true; listeners.get('plugin.boot')({}); await settle(); };
  return { host, storage, rpc, listeners, el, boot, emit: async (name, payload) => { listeners.get(name)(payload); await settle(); } };
}
const settle = async (ms = 400) => { await new Promise(resolve => setTimeout(resolve, ms)); };
async function waitFor(predicate, label) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await settle(20); }
  assert.fail('timed out: ' + label);
}

test('bundle policy: Otzaria 0.9.99 contract only, no direct network path', async () => {
  const bundle = await build();
  for (const method of ['reader.beginCorrectionSession', 'reader.acknowledgeCorrectionDraft', 'reader.listCorrectionDrafts',
    'reader.getCorrectionDraft', 'feedback.submitBookCorrection', 'requireTextCorrection']) assert.ok(bundle.includes(method), method);
  assert.ok(!bundle.includes('network.fetchStream'));
  assert.ok(!bundle.includes('forceFreeText: true }') || bundle.includes('confirm('), 'free text only behind a confirmation');
});

test('a context click before plugin.boot begins the session on the clicked tab after boot', async () => {
  const page = await plugin();
  const tab = page.host.openTab('id:1'); page.host.openTab('id:1');
  page.listeners.get('contextMenu.itemClicked')({ itemId: 'correct-book', selection: { tabId: tab, bookUid: 'id:1', sectionIndex: 2 } });
  await settle();
  assert.equal(page.rpc.filter(call => !call.booted).length, 0, 'no RPC before boot');
  await page.boot();
  await waitFor(() => page.host.activated === 0, 'session begun and tab activated');
  const session = [...page.host.sessions.values()][0];
  assert.equal(session.tabId, tab);
  // Repeated opening of the same tab rejoins the same session.
  await page.emit('contextMenu.itemClicked', { itemId: 'correct-book', selection: { tabId: tab } });
  assert.equal(page.host.sessions.size, 1);
});

test('toolbar clicks use only an unambiguous tab', async () => {
  const page = await plugin();
  await page.boot();
  page.host.openTab('id:1'); page.host.openTab('id:1');
  await page.emit('reader.toolbar_item_clicked', { itemId: 'correct-book', bookUid: 'id:1', currentId: 1 });
  await waitFor(() => /בכמה לשוניות/.test(page.el('status').textContent), 'ambiguity message');
  assert.equal(page.host.sessions.size, 0);
  page.host.tabs.clear(); const only = page.host.openTab('id:1');
  await page.emit('reader.toolbar_item_clicked', { itemId: 'correct-book', bookUid: 'id:1', currentId: 1 });
  await waitFor(() => page.host.sessions.size === 1, 'unique tab session');
  assert.equal([...page.host.sessions.values()][0].tabId, only);
});

test('an end event before boot is saved, then acknowledged; a failed save is not acknowledged', async () => {
  for (const failSet of [false, true]) {
    const host = createFakeOtzaria(), storage = createStorage();
    const page = await plugin({ host, storage });
    const begun = await host.instance(createStorage())('reader.beginCorrectionSession', { tabId: host.openTab('id:1') });
    host.edit(begun.sessionId, 0, 'אלף!');
    const event = host.endByUser(begun.sessionId);
    host.drafts.get('d-id:1').content = true;
    storage.failSet = failSet;
    page.listeners.get('reader.correctionSessionEnded')(event);
    await page.boot();
    if (!failSet) await waitFor(() => /אלף!/.test(page.el('book-list').allText), 'saved proposal rendered');
    else await waitFor(() => /נכשלה/.test(page.el('status').textContent), 'save failure shown');
    // End event and boot discovery may both acknowledge; the second is idempotent.
    if (failSet) assert.equal(host.acks.length, 0); else assert.ok(host.acks.length >= 1);
    assert.equal(host.drafts.get('d-id:1').content, failSet);
  }
});

test('sending from the page uses requireTextCorrection and shows queued honestly', async () => {
  const host = createFakeOtzaria(), page = await plugin({ host });
  await page.boot();
  await page.emit('contextMenu.itemClicked', { itemId: 'correct-book', selection: { tabId: host.openTab('id:1') } });
  const [session] = host.sessions.values();
  await page.emit('reader.correctionSessionChanged', host.edit(session.sessionId, 1, 'בית גימל!'));
  host.submitMode = 'queued';
  const send = [...page.el('live-list').walk()].find(item => item.textContent === 'שמירה ושליחה');
  send.click();
  await waitFor(() => /טרם נשלחו לאתר/.test(page.el('status').textContent), 'queued status');
  const [submission] = host.submissions.values();
  assert.equal(submission.params.requireTextCorrection, true);
  assert.match(page.el('status').textContent, /בתור של אוצריא וטרם נשלחו לאתר/);
  await waitFor(() => /טרם נשלח לאתר/.test(page.el('history-list').allText), 'queued history');
});
