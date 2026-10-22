// Chrome smoke test of the review page with a contract-model SDK (not the
// host). Fixture screenshots show the plugin UI, not the native Otzaria app.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
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
const key = async (name, code = name) => { for (const type of ['keyDown', 'keyUp']) await call('Input.dispatchKeyEvent', { type, key: name, code, windowsVirtualKeyCode: ({ Tab: 9, Enter: 13, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35 })[name],
  ...(type === 'keyDown' && name === 'Enter' ? { text: '\r' } : {}) }); };
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
lines[10] = '<b>פסקה 11</b> <i>בספר הבדיקה</i>';
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
window.legacyKeys = [...storage.data.keys()];
window.legacyBefore = JSON.stringify([...storage.data]);
const draft = { draftId: 'd-id:1', bookUid: 'id:1', bookId: 'ספר הבדיקה', version: 7, acked: null, content: true, libraryVersion: '1', updatedAt: 1,
  changes: Array.from({ length: 12 }, (_, i) => ({ sectionIndex: 10 + i, originalSourceText: lines[10 + i], originalText: lines[10 + i].replace(/<[^>]*>/g, ''), proposedText: lines[10 + i].replace(/<[^>]*>/g, '') + ' — מתוקן' })),
  conflicts: [{ sectionIndex: 2, originalSourceText: lines[2], originalText: lines[2], proposedText: 'פסקה 3 מוצעת', reason: 'displaced' },
    { sectionIndex: 3, originalSourceText: 'נוסח ישן', originalText: 'נוסח ישן', proposedText: 'נוסח חדש', reason: 'source_changed' }] };
host.drafts.set(draft.draftId, draft); host.nextVersion = 8;
window.tab = host.openTab('id:1');
const contract = host.instance(storage);
window.logFiles = new Map();
const extra = {
  'fs.writeFile': ({ path, content }) => { logFiles.set(path, content); return { path, size: content.length }; },
  'fs.readFile': ({ path }) => ({ content: logFiles.get(path) }),
  'fs.listDir': () => ({ entries: [...logFiles].map(([path, content]) => ({ path, type: 'file', size: content.length, modified: new Date().toISOString() })) }),
  'fs.deleteEntry': ({ path }) => logFiles.delete(path),
  'reader.getCurrentState': () => ({ currentTabId: window.readerFieldActive ? tab : null, bookUid: 'id:1', currentType: 'text', currentBookId: 'ספר הבדיקה',
    currentCorrectionSessionId: [...host.sessions.values()].find(s => !s.ended && s.tabId === tab)?.sessionId ?? null,
    openTabs: [...host.tabs].map(([tabId, bookUid]) => ({ tabId, bookUid, id: 1, bookId: 'ספר הבדיקה', book: 'ספר הבדיקה', type: 'text',
    correctionSessionId: [...host.sessions.values()].find(s => !s.ended && s.tabId === tabId)?.sessionId ?? null })) }),
  'reader.activateTab': ({ index }) => { window.activated = index; return true; },
  'library.getBookDetails': ({ bookUid }) => ({ source: 'library', type: 'text', bookUid, lineCount: host.books[bookUid].lines.length }),
  'library.getBookContent': ({ bookUid, offset, limit }) => host.books[bookUid].lines.join(String.fromCharCode(10)).slice(offset, offset + limit),
  // Native reader maps can see empty placeholders outside the loaded range.
  'reader.getSectionTextMap': () => ({ sourceText: '' }),
  'ui.showConfirm': () => ({ confirmed: true }),
  'ui.showMessage': () => true,
  'ui.showError': () => true,
  'search.setFieldActionState': args => { (window.fieldStates ??= []).push(args); return true; },
  'search.endFieldSession': ({ sessionId }) => { queueMicrotask(() => mockHandlers['search.fieldAction.ended']({ sessionId, reason: 'plugin' })); return true; },
  'app.getGrantedPermissions': () => ['reader.local_edit', 'reader.highlight'],
  'reader.findTextOccurrences': ({ bookUid, sectionIndex, query }) => {
    const text = host.books[bookUid].lines[sectionIndex].replace(/<[^>]*>/g, ''), results = [];
    for (let at = text.indexOf(query); at >= 0; at = text.indexOf(query, at + 1)) results.push({ range: { layer: 'source', exactText: query, start: { utf16: at }, end: { utf16: at + query.length } } });
    return { results };
  },
  'reader.setHighlight': args => ({ highlightId: args.highlightId }),
  'reader.clearHighlight': () => true,
  'reader.clearAllHighlights': () => true,
  'feedback.hasReporterEmail': () => window.hasReporterEmail ?? true,
  'feedback.report': args => { (window.developerReports ??= []).push(args); return window.reportMode ?? 'cancelled'; },
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
  legacy: !document.getElementById('legacy-area').hidden, legacyUnchanged: JSON.stringify([...storage.data].filter(([k]) => legacyKeys.includes(k))) === legacyBefore,
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
assert.equal(await evaluate("document.getElementById('screen-history').hidden && document.getElementById('screen-settings').hidden && document.getElementById('screen-report').hidden"), true, 'home shows only work');
assert.equal(await evaluate("document.querySelectorAll('[data-icon] svg path').length >= 4 && document.querySelectorAll('[data-icon] image').length === 0"), true, 'navigation uses theme-aware vector icons');
assert.equal(await evaluate("document.getElementById('pending-count').textContent"), '12 ממתינים · 2 דורשים החלטה');
const formatting = await evaluate(`(() => { const box = document.querySelector('#book-list .diff');
  return { bold: getComputedStyle(box.querySelector('.book-b')).fontWeight, italic: getComputedStyle(box.querySelector('.book-i')).fontStyle, images: box.querySelectorAll('img,script,iframe').length, text: box.textContent }; })()`);
assert.equal(formatting.bold, '700'); assert.equal(formatting.italic, 'italic'); assert.equal(formatting.images, 0);
assert.match(formatting.text, /פסקה 11/);
async function capture(name) {
  const shot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(`test/browser/${name}.png`, Buffer.from(shot.data, 'base64'));
}
async function selectPreview() {
  const rects = await evaluate(`(() => {
    const box = document.querySelector('#book-list .diff'); box.scrollIntoView({ block: 'center' });
    const text = document.createTreeWalker(box.querySelector('.book-b'), NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 4);
    const r = range.getBoundingClientRect(); return { right: r.right - 1, left: r.left + 1, y: r.y + r.height / 2 };
  })()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rects.right, y: rects.y, button: 'left', buttons: 1, clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rects.left, y: rects.y, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rects.left, y: rects.y, button: 'left', buttons: 0, clickCount: 1 });
  assert.ok((await evaluate('getSelection().toString()')).length > 0, 'formatted preview supports mouse text selection');
  await evaluate('getSelection().removeAllRanges()');
}
await waitFor("!document.getElementById('refresh').disabled", 'initial operation completed before capture');
await selectPreview();
await evaluate("document.getElementById('panel').scrollTop = 0");
await capture('plugin-home-light');
await theme('dark'); await selectPreview();
await evaluate("document.getElementById('panel').scrollTop = 0");
await capture('plugin-home-dark'); await theme('light');

// Continuous scroll with a bounded end.
const scroll = await evaluate(`(() => { const main = document.getElementById('panel'); const max = main.scrollHeight - main.clientHeight;
  main.scrollTop = 400; const middle = main.scrollTop; main.scrollTop = 1e9; return { max, middle, end: main.scrollTop }; })()`);
assert.ok(scroll.max > 400, 'content scrolls'); assert.equal(scroll.middle, 400); assert.equal(scroll.end, scroll.max, 'stops at the end');
await evaluate("document.getElementById('panel').scrollTop = 400");
await click('#nav-settings'); await click('#nav-work');
assert.equal(await evaluate("document.getElementById('panel').scrollTop"), 400, 'work scroll position survives screen navigation');
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
assert.equal(await evaluate("JSON.stringify([...storage.data].filter(([k]) => legacyKeys.includes(k))) === legacyBefore"), true, '0.2.2 keys still untouched');
assert.equal(await evaluate("[...host.submissions.values()].some(s => s.params.reportId === 'legacy-sent-1')"), false, 'sent 0.2.2 report not resubmitted');
await waitFor("/נשלחו דרך אוצריא/.test(document.getElementById('status').textContent)", 'send summary');

// The delivery wording in both modes, switching back and forth.
const wording = /השליחה דרך אוצריא הושלמה — סטטוס הטיפול באתר אינו ידוע/, legacyWording = /נשלח בגרסה הקודמת — סטטוס הטיפול באתר אינו ידוע/;
const modes = {};
await click('#nav-history');
assert.equal(await evaluate("!document.getElementById('screen-history').hidden && document.querySelector('#history-list .card').getBoundingClientRect().height > 0"), true, 'history screen opens with mouse');
await evaluate("document.getElementById('nav-history').focus()");
await key('ArrowLeft');
assert.equal(await evaluate("document.getElementById('screen-history').hidden && !document.getElementById('screen-settings').hidden && document.activeElement.id === 'nav-settings'"), true, 'RTL arrow switches to settings with focus');
await key('ArrowRight');
assert.equal(await evaluate("!document.getElementById('screen-history').hidden && document.activeElement.id === 'nav-history'"), true, 'RTL arrow returns to history');
for (const mode of ['dark', 'light', 'dark', 'light']) {
  await theme(mode);
  const view = await evaluate("({ history: document.getElementById('history-list').textContent, legacy: document.getElementById('legacy-list').textContent })");
  assert.match(view.history, wording); assert.match(view.legacy, legacyWording);
  const hint = Math.min(...await contrasts('#history-list .hint, #legacy-list .hint')), header = Math.min(...await contrasts('.panel-header h1'));
  modes[mode] = { hint, header };
  assert.ok(hint >= 4.5 && header >= 4.5, `${mode} contrast ${JSON.stringify(modes[mode])}`);
  await click('#nav-settings');
  await click('#marks-toggle');
  await waitFor("!document.getElementById('marks-toggle').disabled", 'setting saved');
  await click('#marks-toggle');
  await waitFor("!document.getElementById('marks-toggle').disabled", 'setting restored');
  await capture(`plugin-settings-${mode}`);
  await click('#nav-history');
}

// The developer report uses the host's plugin-report API, never book feedback.
await click('#nav-report');
await waitFor("document.getElementById('report-email-area').hidden", 'saved email used without exposing it');
assert.equal(await evaluate("!document.getElementById('screen-report').hidden && document.getElementById('screen-history').hidden"), true);
await waitFor("!document.getElementById('report-details').disabled && document.activeElement.id === 'report-details'", 'report field ready and focused');
await call('Input.insertText', { text: 'תקלה בתוסף: בדיקת הממשק בלבד' });
await waitFor("!document.getElementById('report-send').disabled", 'report text entered');
await capture('plugin-report-light');
await click('#report-send');
await waitFor("/בוטלה/.test(document.getElementById('status').textContent)", 'host cancellation');
await waitFor("!document.getElementById('report-send').disabled", 'report action released after cancellation');
assert.equal(await evaluate("document.getElementById('report-details').value"), 'תקלה בתוסף: בדיקת הממשק בלבד', 'cancel preserves the draft');
assert.equal(await evaluate("developerReports[0].details.includes('Plugin diagnostics') && developerReports[0].details.length <= 5000"), true, 'diagnostics attached within host limit');
await click('#report-logs');
await waitFor("!document.getElementById('screen-logs').hidden && !document.getElementById('log-file').disabled", 'log folder opened');
assert.equal(await evaluate("document.getElementById('log-content').readOnly"), true, 'log files cannot be edited accidentally');
assert.equal(await evaluate("document.getElementById('log-file').options.length > 1"), true, 'private log files listed');
assert.equal(await evaluate("document.getElementById('log-content').value.includes('rpc.ok')"), true, 'detailed RPC log visible');
assert.equal(await evaluate("document.getElementById('report-details').value"), 'תקלה בתוסף: בדיקת הממשק בלבד');
await click('#log-content');
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
assert.equal(await evaluate("document.getElementById('log-content').selectionEnd === document.getElementById('log-content').value.length"), true, 'keyboard selection for copying logs');
await capture('plugin-logs-light');
await theme('dark'); await capture('plugin-logs-dark'); await theme('light');
await evaluate("document.getElementById('log-file').selectedIndex = 1; document.getElementById('log-file').dispatchEvent(new Event('change', { bubbles: true }))");
await waitFor("!document.getElementById('log-file').disabled && !JSON.parse(document.getElementById('log-content').value).instances", 'individual file opened');
await click('#logs-back');
assert.equal(await evaluate("!document.getElementById('screen-report').hidden"), true, 'back to report');
await evaluate("window.reportMode = 'queued'");
await click('#report-send');
await waitFor("/הדיווח למפתח נשמר בתור/.test(document.getElementById('status').textContent)", 'developer report queued');
await waitFor("!document.getElementById('report-details').disabled", 'queued report operation completed');
assert.equal(await evaluate("document.getElementById('report-details').value"), '', 'queued draft accepted by host');
assert.equal(await evaluate("developerReports.length === 2 && developerReports.every(r => r.details.includes('תקלה בתוסף') && r.reportType === 'bug' && !('reporterEmail' in r))"), true);
assert.equal(await evaluate('host.submissions.size'), sent.count, 'reporting the plugin never submits book corrections');
await click('#report-back');
assert.equal(await evaluate("!document.getElementById('screen-history').hidden"), true, 'returns to the originating screen');
await evaluate("window.hasReporterEmail = false; window.reportMode = 'sent'");
await theme('dark'); await click('#nav-report');
await waitFor("!document.getElementById('report-email-area').hidden", 'optional email when none saved');
await call('Input.insertText', { text: 'בדיקת דיווח במצב כהה' });
await evaluate("document.getElementById('report-email').focus()");
await call('Input.insertText', { text: 'qa@example.invalid' });
await capture('plugin-report-dark');
await click('#report-send');
await waitFor("/הדיווח למפתח נשלח דרך/.test(document.getElementById('status').textContent) && !document.getElementById('report-details').disabled", 'developer report sent');
assert.equal(await evaluate("developerReports.at(-1).reporterEmail"), 'qa@example.invalid');
assert.equal(await evaluate('host.submissions.size'), sent.count);
await click('#report-back'); await theme('light');

// A history record saved by an earlier run: shown with the new wording after
// boot and after a reload that keeps storage; the record is not rewritten and
// history never submits anything.
const seed = createStorage();
await createCorrectionStore(createFakeOtzaria().instance(seed)).resolve('id:1', 'saved-history', 'sent', {
  result: { reportId: 'bc-saved-history', nativeReportId: 'native-saved', reportKind: 'text_correction', correctionSupported: true, duplicate: false, status: 'sent' },
  sectionIndex: 4, originalText: 'פסקה 5 בספר הבדיקה', proposedText: 'פסקה 5 בספר הבדיקה — מתוקן', title: 'ספר ההיסטוריה' });
const [[savedKey, savedRecord]] = [...seed.data];
// Independent proposals can be merged without opening a reader session.
const offlineStore = createCorrectionStore(createFakeOtzaria().instance(seed));
for (const [version, proposedText] of [[1, 'אלף ביתא גימל דלת'], [2, 'אלף בית גימל דלת!']]) {
  await offlineStore.saveVersion({ bookUid: 'id:offline', bookId: 'ספר לאיחוד ללא קורא', libraryVersion: 'qa',
    draftId: `offline-${version}`, version, conflicts: [], changes: [0, 1].map(sectionIndex => ({
      sectionIndex, originalSourceText: 'אלף בית גימל דלת', originalText: 'אלף בית גימל דלת', proposedText })) });
}
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
await waitFor("!document.getElementById('refresh').disabled", 'home idle');
await evaluate("window.homeCard = document.querySelector('#book-list .card'); window.historyCard = document.querySelector('#history-list .card')");
await click('#refresh');
assert.equal(await evaluate("window.homeCard === document.querySelector('#book-list .card') && window.historyCard === document.querySelector('#history-list .card')"), true, 'busy state preserves unchanged home and history DOM');
await waitFor("!document.getElementById('refresh').disabled", 'home refresh released');
await waitFor("document.querySelector('[data-focus-key^=\"merge:\"]') && !document.querySelector('[data-focus-key^=\"merge:\"]').disabled", 'offline merge enabled');
await theme('light');
await click('[data-focus-key^="merge:"]');
await waitFor("/ההצעות אוחדו ונשמרו בתוסף/.test(document.getElementById('status').textContent) && !document.getElementById('refresh').disabled", 'offline merge saved');
assert.equal(await evaluate("host.sessions.size"), 0, 'offline merge opens no reader session');
assert.equal(await evaluate("host.submissions.size"), 0, 'offline merge sends nothing');
await theme('dark');
await evaluate("document.querySelector('[data-focus-key^=\"merge:\"]').focus()");
assert.equal(await evaluate("document.activeElement.dataset.focusKey.startsWith('merge:')"), true, 'offline merge keyboard focus');
await key('Enter');
await waitFor("!document.querySelector('[data-focus-key^=\"merge:\"]') && !document.getElementById('refresh').disabled", 'second offline merge from keyboard');
assert.equal(await evaluate("[...storage.data.keys()].filter(k => k.startsWith('nc:merged:')).length"), 2);
assert.equal(await evaluate("[...storage.data.values()].filter(v => v?.replacedKeys).every(v => v.changes[0].proposedText === 'אלף ביתא גימל דלת!')"), true, 'combined wording stored');
assert.equal(await evaluate("document.getElementById('book-list').textContent.includes('ביתא') && document.getElementById('book-list').textContent.includes('!')"), true, 'both edits displayed in diff');
await capture('plugin-offline-merge-dark');
await waitFor("document.querySelector('[data-focus-key^=\"begin:\"]') && !document.querySelector('[data-focus-key^=\"begin:\"]').disabled", 'reader edit available');
await click('[data-focus-key^="begin:"]');
await waitFor("document.querySelector('[data-focus-key^=\"replace:\"]') && !document.querySelector('[data-focus-key^=\"replace:\"]').disabled", 'active-session replacement button');
await evaluate("host.edit([...host.sessions.values()].find(s => !s.ended).sessionId, 0, 'פסקה 1 בספר הבדיקה — תיקון קודם'); mockHandlers['reader.correctionSessionChanged']({ sessionId: [...host.sessions.values()].find(s => !s.ended).sessionId })");
await click('[data-focus-key^="replace:"]');
await waitFor("document.activeElement.id === 'replace-query' && !document.getElementById('replace-query').disabled", 'replacement input focused');
await call('Input.insertText', { text: 'בספר הבדיקה' });
await click('#replace-with'); await call('Input.insertText', { text: 'בספר המתוקן' });
await click('#replace-preview');
await waitFor("/39 התאמות/.test(document.getElementById('replace-summary').textContent) && !document.getElementById('replace-apply').disabled", 'replacement preview despite unloaded reader maps');
assert.equal(await evaluate("rpc.filter(r => r.method === 'reader.getSectionTextMap').length"), 0);
const replacementReads = await evaluate("rpc.filter(r => r.method === 'library.getBookContent').length");
await theme('light'); await capture('plugin-replace-light'); await theme('dark'); await capture('plugin-replace-dark');
await click('#replace-preview');
await waitFor("!document.getElementById('replace-apply').disabled", 'second preview ready');
assert.equal(await evaluate("rpc.filter(r => r.method === 'library.getBookContent').length"), replacementReads, 'repeated preview reuses source');
await click('#replace-apply');
await waitFor("/39 החלפות הוחלו/.test(document.getElementById('status').textContent) && !document.getElementById('replace-query').disabled", 'bulk replacement applied');
assert.equal(await evaluate("[...host.sessions.values()].find(s => !s.ended).changes.length"), 39);
assert.equal(await evaluate("[...host.sessions.values()].find(s => !s.ended).changes.find(c => c.sectionIndex === 0).proposedText.endsWith('תיקון קודם')"), true, 'existing wording retained');
assert.equal(await evaluate('host.submissions.size'), 0, 'replacement sends no reports');
await click('#replace-back');
// The host field itself is Flutter. This exercises its real event contract
// through the browser SDK fixture; native registration/taps are tested in Dart.
await waitFor("!document.getElementById('refresh').disabled", 'ready for native field actions');
await evaluate("window.readerFieldActive = true; mockHandlers['search.fieldAction.invoked']({ actionId: 'replace-in-book', field: 'inBook', sessionId: 'field-first', text: 'פסקה 3', selectionStart: 6, selectionEnd: 6 })");
await waitFor("/נשמר החיפוש המדויק/.test(document.getElementById('status').textContent) && !document.getElementById('refresh').disabled", 'first search-field click remembers exact query');
await evaluate("mockHandlers['search.fieldAction.ended']({ sessionId: 'field-first', reason: 'edited' }); mockHandlers['search.fieldAction.invoked']({ actionId: 'replace-in-book', field: 'inBook', sessionId: 'field-second', text: 'פסקה שלישית', selectionStart: 12, selectionEnd: 12 })");
await waitFor("/1 החלפות הוחלו בקורא/.test(document.getElementById('status').textContent) && !document.getElementById('refresh').disabled", 'second search-field click applies confirmed alternative');
assert.equal(await evaluate("[...host.sessions.values()].find(s => !s.ended).changes.find(c => c.sectionIndex === 2).proposedText.startsWith('פסקה שלישית')"), true);
assert.equal(await evaluate('host.submissions.size'), 0, 'native field workflow sends no reports');
await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
await evaluate("document.getElementById('panel').scrollTop = 0");
assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'no horizontal overflow on a narrow page');
await capture('plugin-home-mobile');
assert.equal(errors.length, 0, JSON.stringify(errors));
console.log(JSON.stringify({ boot, scroll, focus: { focused, next }, sent: { count: sent.count, structured: sent.structured }, contrast: modes, savedHistory: 'shown after boot and reload, no submit', exceptions: errors.length }, null, 2));
ws.close();
