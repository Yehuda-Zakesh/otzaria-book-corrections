// Chrome smoke test of the review page with a contract-model SDK (not the
// host). No screenshots: real captures are taken only with Otzaria itself.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9227}/json`)).json();
const ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
await new Promise(done => ws.addEventListener('open', done, { once: true }));
let id = 0;
const pending = new Map(), errors = [];
ws.addEventListener('message', event => {
  const value = JSON.parse(event.data);
  if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails);
  if (value.id) { const task = pending.get(value.id); pending.delete(value.id); value.error ? task.reject(value.error) : task.resolve(value.result); }
});
const call = (method, params = {}) => new Promise((ok, fail) => { const key = ++id; pending.set(key, { resolve: ok, reject: fail }); ws.send(JSON.stringify({ id: key, method, params })); });
const evaluate = async expression => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
async function waitFor(expression, label) {
  for (let attempt = 0; attempt < 600; attempt++) { if (await evaluate(expression)) return; await new Promise(done => setTimeout(done, 50)); }
  assert.fail(`timed out: ${label} — status: ${await evaluate("document.getElementById('status').textContent")}`);
}
async function click(selector) {
  const box = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await call('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
}
const key = async (name, code = name) => { for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: name === 'Tab' ? 9 : 13 }); };
const contractModel = (await readFile('test/fake-otzaria.mjs', 'utf8')).replace(/^export /gm, '');
await call('Runtime.enable');
await call('Page.enable');
await call('Page.addScriptToEvaluateOnNewDocument', { source: `${contractModel}
window.mockHandlers = {};
const lines = Array.from({ length: 40 }, (_, i) => 'פסקה ' + (i + 1) + ' בספר הבדיקה');
lines[1] = '<b>בית</b> גימל';
window.host = createFakeOtzaria({ books: { 'id:1': { bookId: 'ספר הבדיקה', lines } } });
window.storage = createStorage();
// 0.2.2 workspace (schema 2 inline) and an Otzaria draft whose end event was lost.
const original = lines.map(line => line.replace(/<[^>]*>/g, '')).join('\\n');
let start = 0;
const sections = original.split('\\n').map((text, index) => { const s = { index, start, end: start + text.length, text }; start += text.length + 1; return s; });
storage.data.set('book-session', { schemaVersion: 2, sessions: [{ id: 'old', book: { identity: { bookId: 'ספר הבדיקה', bookUid: 'id:1' }, details: { title: 'ספר הבדיקה' }, originalText: original, sections },
  editedText: original.replace('פסקה 5 בספר', 'פסקה חמש בספר'), queue: null, completed: false }] });
window.legacyBefore = JSON.stringify([...storage.data]);
const draft = { draftId: 'd-id:1', bookUid: 'id:1', bookId: 'ספר הבדיקה', version: 7, acked: null, content: true, libraryVersion: '1', updatedAt: 1,
  changes: Array.from({ length: 12 }, (_, i) => ({ sectionIndex: 10 + i, originalSourceText: lines[10 + i], originalText: lines[10 + i], proposedText: lines[10 + i] + ' — מתוקן' })),
  conflicts: [{ sectionIndex: 2, originalSourceText: lines[2], originalText: lines[2], proposedText: 'פסקה 3 מוצעת', reason: 'displaced' },
    { sectionIndex: 3, originalSourceText: 'נוסח ישן', originalText: 'נוסח ישן', proposedText: 'נוסח חדש', reason: 'source_changed' }] };
host.drafts.set(draft.draftId, draft); host.nextVersion = 8;
window.tab = host.openTab('id:1');
const contract = host.instance(storage);
const extra = {
  'reader.getCurrentState': () => ({ currentTabId: null, openTabs: [...host.tabs].map(([tabId, bookUid]) => ({ tabId, bookUid, id: 1, bookId: 'ספר הבדיקה', book: 'ספר הבדיקה', type: 'text',
    correctionSessionId: [...host.sessions.values()].find(s => !s.ended && s.tabId === tabId)?.sessionId ?? null })) }),
  'reader.activateTab': ({ index }) => { window.activated = index; return true; },
  'ui.showConfirm': () => ({ confirmed: true }),
  'app.getGrantedPermissions': () => ['reader.local_edit'],
  'app.getTheme': () => window.theme
};
window.theme = { mode: 'dark', colorScheme: { surface: '#141218', onSurface: '#e6e0e9', primary: '#d0bcff', onPrimary: '#381e72', surfaceContainer: '#211f26', surfaceContainerHigh: '#2b2930' } };
window.booted = false; window.rpc = [];
window.Otzaria = { _booted: false, on: (name, handler) => { mockHandlers[name] = handler; },
  async call(method, args = {}) {
    rpc.push({ method, booted });
    if (!booted) return { success: false, error: { code: 'error.not_ready', message: 'SDK has not booted' } };
    try { return { success: true, data: extra[method] ? extra[method](args) : await contract(method, args) }; }
    catch (error) { return { success: false, error: { code: error.code ?? 'error.internal', message: error.message } }; }
  } };
` });
await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await call('Page.navigate', { url: pathToFileURL(resolve('plugin/index.html')).href });
await waitFor("typeof mockHandlers['plugin.boot'] === 'function'", 'listeners registered');

// A reader-menu click on a closed plugin arrives before plugin.boot.
await evaluate("mockHandlers['contextMenu.itemClicked']({ itemId: 'correct-book', selection: { tabId: tab, bookUid: 'id:1', sectionIndex: 4 } })");
await new Promise(done => setTimeout(done, 100));
assert.equal(await evaluate('rpc.length'), 0, 'no RPC before boot');
await evaluate("booted = true; mockHandlers['plugin.boot']({ theme })");
await waitFor("[...host.sessions.values()].some(s => s.tabId === tab) && window.activated === 0", 'session on the clicked tab');
await waitFor("document.querySelectorAll('#book-list .change').length === 14", 'discovered draft rendered');
const boot = await evaluate(`({ acked: host.drafts.get('d-id:1').acked, pending: document.querySelectorAll('#book-list .change:not(.conflict)').length,
  conflicts: [...document.querySelectorAll('#book-list .conflict .reason')].map(item => item.textContent),
  legacy: !document.getElementById('legacy-area').hidden, legacyUnchanged: JSON.stringify([...storage.data].filter(([k]) => !k.startsWith('nc:'))) === legacyBefore,
  background: getComputedStyle(document.body).backgroundColor })`);
assert.equal(boot.acked, 7, 'acknowledged after the plugin copy was saved');
assert.equal(boot.pending, 12);
assert.deepEqual(boot.conflicts, ['עריכה שלא נשמרה בחלון שאיבד את הבעלות על הספר', 'המקור השתנה מאז התיקון']);
assert.equal(boot.legacy, true);
assert.equal(boot.legacyUnchanged, true, '0.2.2 keys untouched');
assert.equal(boot.background, 'rgb(20, 18, 24)', 'dark theme');

// Light theme from the host event.
await evaluate("mockHandlers['theme.changed']({ mode: 'light', colorScheme: { surface: '#fffbfe', onSurface: '#1c1b1f', primary: '#6750a4', onPrimary: '#ffffff', surfaceContainer: '#f3edf7' } })");
assert.equal(await evaluate('getComputedStyle(document.body).backgroundColor'), 'rgb(255, 251, 254)');

// Continuous scroll with a bounded end.
const scroll = await evaluate(`(() => { const main = document.getElementById('panel'); const max = main.scrollHeight - main.clientHeight;
  main.scrollTop = 400; const middle = main.scrollTop; main.scrollTop = 1e9; return { max, middle, end: main.scrollTop }; })()`);
assert.ok(scroll.max > 400, 'content scrolls'); assert.equal(scroll.middle, 400); assert.equal(scroll.end, scroll.max, 'stops at the end');
await evaluate("document.getElementById('panel').scrollTop = 0");

// Keyboard focus survives a re-render (data-focus-key).
await waitFor("!document.querySelector('[data-focus-key^=\"send:\"]').disabled", 'buttons enabled');
await evaluate("document.querySelector('[data-focus-key^=\"send:\"]').focus()");
const focused = await evaluate('document.activeElement.dataset.focusKey');
await key('Tab');
const next = await evaluate('document.activeElement.dataset.focusKey');
assert.notEqual(next, focused, 'Tab moves focus');
await evaluate("mockHandlers['reader.correctionSessionChanged']({ sessionId: [...host.sessions.keys()][0], revision: 1, sectionIndices: [] })");
await new Promise(done => setTimeout(done, 400));
assert.equal(await evaluate('document.activeElement.dataset.focusKey'), next, 'focus kept after re-render');

// Restore a displaced conflict whose source still matches; the changed one stays.
await click('[data-focus-key^="restore:"]');
await waitFor("document.querySelectorAll('#book-list .conflict').length === 1", 'restored conflict removed');
assert.equal(await evaluate("[...host.sessions.values()][0].changes.some(c => c.sectionIndex === 2)"), true);

// Send everything with the mouse; history shows the delivery honestly.
await click('[data-focus-key^="send:id"]');
await waitFor("/התקבל באתר כתיקון מובנה/.test(document.getElementById('history-list').textContent)", 'history updated');
const sent = await evaluate("({ count: host.submissions.size, structured: [...host.submissions.values()].every(s => s.params.requireTextCorrection === true), history: document.getElementById('history-list').textContent })");
assert.equal(sent.structured, true);
assert.ok(sent.count >= 12);
assert.match(sent.history, /התקבל באתר כתיקון מובנה/);
assert.equal(await evaluate("JSON.stringify([...storage.data].filter(([k]) => !k.startsWith('nc:'))) === legacyBefore"), true, '0.2.2 keys still untouched');
assert.equal(errors.length, 0, JSON.stringify(errors));
console.log(JSON.stringify({ boot, scroll, focus: { focused, next }, sent: { count: sent.count, structured: sent.structured }, exceptions: errors.length }, null, 2));
ws.close();
