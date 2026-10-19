// Chrome smoke test of the review page with a contract-model SDK (not the
// host). No screenshots: real captures are taken only with Otzaria itself.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createCorrectionStore } from '../../plugin/correction-store.js';
import { createFakeOtzaria, createStorage } from '../fake-otzaria.mjs';
// Every colorScheme field Otzaria sends (buildThemePayloadFromScheme in
// plugin_bridge_adapter.dart), as #rrggbb. A partial palette would leave the
// previous mode's colours in place and hide real contrast problems.
const palettes = {
  dark: { primary: '#d0bcff', onPrimary: '#381e72', primaryContainer: '#4f378b', onPrimaryContainer: '#eaddff',
    secondary: '#ccc2dc', onSecondary: '#332d41', secondaryContainer: '#4a4458', onSecondaryContainer: '#e8def8',
    tertiary: '#efb8c8', onTertiary: '#492532', tertiaryContainer: '#633b48', onTertiaryContainer: '#ffd8e4',
    surface: '#141218', onSurface: '#e6e0e9', onSurfaceVariant: '#cac4d0', surfaceContainerLowest: '#0f0d13',
    surfaceContainerLow: '#1d1b20', surfaceContainer: '#211f26', surfaceContainerHigh: '#2b2930', surfaceContainerHighest: '#36343b',
    error: '#f2b8b5', onError: '#601410', errorContainer: '#8c1d18', onErrorContainer: '#f9dedc', outline: '#938f99', outlineVariant: '#49454f',
    inverseSurface: '#e6e0e9', onInverseSurface: '#322f35', inversePrimary: '#6750a4', shadow: '#000000', scrim: '#000000', surfaceTint: '#d0bcff' },
  light: { primary: '#6750a4', onPrimary: '#ffffff', primaryContainer: '#eaddff', onPrimaryContainer: '#21005d',
    secondary: '#625b71', onSecondary: '#ffffff', secondaryContainer: '#e8def8', onSecondaryContainer: '#1d192b',
    tertiary: '#7d5260', onTertiary: '#ffffff', tertiaryContainer: '#ffd8e4', onTertiaryContainer: '#31111d',
    surface: '#fffbfe', onSurface: '#1c1b1f', onSurfaceVariant: '#49454f', surfaceContainerLowest: '#ffffff',
    surfaceContainerLow: '#f7f2fa', surfaceContainer: '#f3edf7', surfaceContainerHigh: '#ece6f0', surfaceContainerHighest: '#e6e0e9',
    error: '#b3261e', onError: '#ffffff', errorContainer: '#f9dedc', onErrorContainer: '#410e0b', outline: '#79747e', outlineVariant: '#cac4d0',
    inverseSurface: '#313033', onInverseSurface: '#f4eff4', inversePrimary: '#d0bcff', shadow: '#000000', scrim: '#000000', surfaceTint: '#6750a4' }
};
// Colours the stylesheet reads; each must come from the current palette.
const cssColors = [...new Set([...(await readFile('plugin/style.css', 'utf8')).matchAll(/var\(--([A-Za-z]+)[,)]/g)].map(match => match[1]))];
assert.ok(cssColors.length > 10 && cssColors.every(name => palettes.dark[name] && palettes.light[name]), `palette covers ${cssColors}`);
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
// Switches theme as the host does and checks no stylesheet colour is left over.
async function theme(mode) {
  await evaluate(`mockHandlers['theme.changed']({ mode: '${mode}', colorScheme: palettes.${mode} })`);
  await themed(mode);
}
async function themed(mode) {
  const applied = await evaluate(`Object.fromEntries(${JSON.stringify(cssColors)}.map(name => [name, document.documentElement.style.getPropertyValue('--' + name)]))`);
  for (const name of cssColors) assert.equal(applied[name], palettes[mode][name], `${mode}: --${name}`);
}
// WCAG contrast of each matching element's text against its painted background.
const contrasts = selector => evaluate(`(() => {
  const rgb = value => value.match(/[\\d.]+/g).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map(c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  return [...document.querySelectorAll(${JSON.stringify(selector)})].map(item => {
    let back = item; while (back && rgb(getComputedStyle(back).backgroundColor)[3] === 0) back = back.parentElement;
    const [a, b] = [lum(rgb(getComputedStyle(item).color)), lum(rgb(getComputedStyle(back ?? document.body).backgroundColor))];
    return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
  });
})()`);
const contractModel =(await readFile('test/fake-otzaria.mjs', 'utf8')).replace(/^export /gm, '');
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
  editedText: original.replace('פסקה 5 בספר', 'פסקה חמש בספר'), queue: null, completed: false },
  // A 0.2.2 session whose report was already sent (prepareReports/deliverReport shape).
  { id: 'old-sent', book: { identity: { bookId: 'ספר ישן', bookUid: 'id:9' }, details: { title: 'ספר ישן' }, originalText: 'אלף בית\\nגימל', sections: [{ index: 0, start: 0, end: 7, text: 'אלף בית' }, { index: 1, start: 8, end: 12, text: 'גימל' }] },
    editedText: 'אלף ביית\\nגימל', completed: true,
    queue: [{ payload: { report_id: 'legacy-sent-1', report_kind: 'text_correction', selected_text: 'בית', correction: { proposed_text: 'ביית' }, location: { line_index: 0 } },
      submission: { reportId: 'legacy-sent-1', bookId: 'ספר ישן', bookUid: 'id:9', sectionIndex: 0, snapshots: [{ index: 0, text: 'אלף בית' }], original: 'בית', proposed: 'ביית',
        details: 'הצעת תיקון', allowQueue: false, forceFreeText: false, sourceStart: 4, sourceEnd: 7 },
      sent: true, sentAt: 1760000000000, correctionSupported: true, sourceSections: [0] }] }] });
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
window.palettes = ${JSON.stringify(palettes)};
window.theme = { mode: 'dark', colorScheme: palettes.dark };
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
await themed('dark');
// The already-sent 0.2.2 report is shown, honestly, without a send action.
const legacySent = await evaluate(`(() => { const card = [...document.querySelectorAll('#legacy-list .card')].find(item => item.querySelector('h3').textContent === 'ספר ישן');
  return { text: card?.textContent ?? '', send: !!card?.querySelector('[data-focus-key^="legacy-send:"]') }; })()`);
assert.match(legacySent.text, /legacy-sent-1/);
assert.match(legacySent.text, /נשלח בגרסה הקודמת — סטטוס הטיפול באתר אינו ידוע/);
assert.doesNotMatch(legacySent.text, /אושר באתר|התקבל באתר/);
assert.equal(legacySent.send, false, 'no send action for a sent 0.2.2 report');

// Light theme from the host event.
await theme('light');
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
await waitFor("/השליחה דרך אוצריא הושלמה — סטטוס הטיפול באתר אינו ידוע/.test(document.getElementById('history-list').textContent)", 'history updated');
const sent = await evaluate("({ count: host.submissions.size, structured: [...host.submissions.values()].every(s => s.params.requireTextCorrection === true), history: document.getElementById('history-list').textContent })");
assert.equal(sent.structured, true);
assert.ok(sent.count >= 12);
assert.match(sent.history, /השליחה דרך אוצריא הושלמה — סטטוס הטיפול באתר אינו ידוע/);
assert.doesNotMatch(sent.history, /התקבל באתר|אושר באתר/);
assert.equal(await evaluate("JSON.stringify([...storage.data].filter(([k]) => !k.startsWith('nc:'))) === legacyBefore"), true, '0.2.2 keys still untouched');
assert.equal(await evaluate("[...host.submissions.values()].some(s => s.params.reportId === 'legacy-sent-1')"), false, 'sent 0.2.2 report not resubmitted');
await waitFor("/נשלחו דרך אוצריא/.test(document.getElementById('status').textContent)", 'send summary');

// The delivery wording in both modes, switching back and forth.
const wording = /השליחה דרך אוצריא הושלמה — סטטוס הטיפול באתר אינו ידוע/, legacyWording = /נשלח בגרסה הקודמת — סטטוס הטיפול באתר אינו ידוע/;
const modes = {};
for (const mode of ['dark', 'light', 'dark', 'light']) {
  await theme(mode);
  const view = await evaluate("({ history: document.getElementById('history-list').textContent, legacy: document.getElementById('legacy-list').textContent })");
  assert.match(view.history, wording); assert.match(view.legacy, legacyWording);
  const hint = Math.min(...await contrasts('#history-list .hint, #legacy-list .hint')), header = Math.min(...await contrasts('.panel-header h1'));
  modes[mode] = { hint, header };
  assert.ok(hint >= 4.5 && header >= 4.5, `${mode} contrast ${JSON.stringify(modes[mode])}`);
}

// A history record saved by an earlier run: shown with the new wording after
// boot and after a reload that keeps storage; the record is not rewritten and
// history never submits anything.
const seed = createStorage();
await createCorrectionStore(createFakeOtzaria().instance(seed)).resolve('id:1', 'saved-history', 'sent', {
  result: { reportId: 'bc-saved-history', nativeReportId: 'native-saved', reportKind: 'text_correction', correctionSupported: true, duplicate: false, status: 'sent' },
  sectionIndex: 4, originalText: 'פסקה 5 בספר הבדיקה', proposedText: 'פסקה 5 בספר הבדיקה — מתוקן', title: 'ספר ההיסטוריה' });
const [[savedKey, savedRecord]] = [...seed.data];
let seedScript = null;
async function openWith(entries, reload) {
  if (seedScript) await call('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedScript });
  // Runs after the main fixture: storage holds exactly the given entries.
  seedScript = (await call('Page.addScriptToEvaluateOnNewDocument', { source: `storage.data.clear(); host.drafts.clear(); for (const [k, v] of ${JSON.stringify(entries)}) storage.data.set(k, v);` })).identifier;
  await evaluate('window.stale = true');
  await (reload ? call('Page.reload') : call('Page.navigate', { url: `${pathToFileURL(resolve('plugin/index.html')).href}?history` }));
  await waitFor("!window.stale && typeof mockHandlers['plugin.boot'] === 'function'", 'reloaded');
  await evaluate("booted = true; mockHandlers['plugin.boot']({ theme })");
  await waitFor("/bc-saved-history/.test(document.getElementById('history-list').textContent)", 'saved history rendered');
  const view = await evaluate(`({ history: document.getElementById('history-list').textContent, record: JSON.stringify(storage.data.get(${JSON.stringify(savedKey)})),
    submitted: rpc.some(entry => entry.method === 'feedback.submitBookCorrection') || host.submissions.size > 0, read: rpc.some(entry => entry.method === 'storage.list'), storage: [...storage.data] })`);
  assert.equal(view.read, true, 'RPC log records this page');
  assert.match(view.history, wording);
  assert.doesNotMatch(view.history, /התקבל באתר|אושר באתר/);
  assert.equal(view.record, JSON.stringify(savedRecord), 'stored record not rewritten');
  assert.equal(view.submitted, false, 'history never submits');
  return view.storage;
}
const kept = await openWith([...seed.data], false);
await openWith(kept, true);
assert.equal(errors.length, 0, JSON.stringify(errors));
console.log(JSON.stringify({ boot, scroll, focus: { focused, next }, sent: { count: sent.count, structured: sent.structured }, contrast: modes, savedHistory: 'shown after boot and reload, no submit', exceptions: errors.length }, null, 2));
ws.close();
