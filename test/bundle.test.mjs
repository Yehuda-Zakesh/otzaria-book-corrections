import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from '../scripts/build.mjs';

async function exerciseEarlyContextClick(bundle, { newLibraryTab = false, toolbar = false, blockedLibrary = false, restoredUnrelated = false, restoredTarget = false } = {}) {
  const elements = new Map(), listeners = new Map(), calls = [], storage = new Map(), timers = new Set();
  const lines = ['תחילת הספר', 'הפסקה שאליה הגיע הקורא', 'סוף הספר'];
  const identity = { bookId: 'early-click-book', bookUid: 'id:2311' };
  if (newLibraryTab || restoredUnrelated || restoredTarget) {
    const savedLines = restoredUnrelated ? ['unrelated \u05d0\u05b7', 'old draft'] : lines;
    let start = 0;
    const sections = savedLines.map((text, index) => { const section = { index, text, start, end: start + text.length }; start += text.length + 1; return section; });
    storage.set('book-session', { schemaVersion: 2, activeId: 'previous-book', sessions: [{
      id: 'previous-book', book: { identity: restoredUnrelated ? { bookId: 'unrelated-book', bookUid: 'id:99' } : identity, details: { title: 'הספר שנשמר', source: 'library', type: 'text' },
        originalText: savedLines.join('\n'), sections, toc: [] },
      editedText: savedLines.join('\n'), queue: null, location: restoredTarget ? { sectionIndex: 0, offset: 0 } : { sectionIndex: 1, offset: 3 }
    }] });
  }
  function el(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', hidden: true, clientWidth: 0, clientHeight: 300,
      style: { setProperty() {} }, children: [], dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener() {}, focus() {}, setAttribute() {}, remove() {},
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    });
    return elements.get(id);
  }
  let booted = false;
  const host = {
    on(event, handler) { listeners.set(event, handler); },
    async call(method, args = {}) {
      calls.push({ method, args, booted });
      if (!booted) return { success: false, error: 'SDK has not booted' };
      if (blockedLibrary && method === 'library.getTree') return new Promise(() => {});
      if (restoredUnrelated && args.bookUid === 'id:99' && ['library.getBookToc', 'reader.getSectionTextMap'].includes(method)) return new Promise(() => {});
      let data = null;
      if (method === 'library.getTree') data = { title: 'ספריית אוצריא', path: '/', categories: [], books: [] };
      else if (method === 'app.getInfo') data = { version: '0.9.98', buildNumber: '801', platform: 'windows' };
      else if (method === 'library.getBookDetails') data = { source: 'library', type: 'text', title: 'ספר הלחיצה המוקדמת', lineCount: lines.length };
      else if (method === 'library.getBookContent') data = lines.join('\n').slice(args.offset, args.offset + args.limit);
      else if (method === 'reader.getSectionTextMap') data = { sourceText: lines[args.sectionIndex] };
      else if (method === 'library.getBookToc') data = [];
      else if (method === 'storage.get') data = storage.get(args.key) ?? null;
      else if (method === 'storage.set') storage.set(args.key, args.value);
      else if (method === 'storage.remove') storage.delete(args.key);
      return { success: true, data };
    }
  };
  try {
    runInNewContext(bundle, {
      window: { Otzaria: host }, crypto: webcrypto, TextEncoder, console,
      document: { getElementById: el, createElement: () => el(`created-${elements.size}`),
        querySelector: () => el('main'), body: el('body'), documentElement: { style: { setProperty() {} } } },
      getComputedStyle: () => ({ getPropertyValue() { return ''; } }),
      setTimeout(fn, delay) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay); timers.add(timer); return timer; },
      clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); }
    }, { filename: 'app.bundle.js' });
    if (newLibraryTab) listeners.get('plugin.page_opened')({ source: 'newTabButton' });
    else listeners.get(toolbar ? 'reader.toolbar_item_clicked' : 'contextMenu.itemClicked')({ itemId: 'correct-book', selection: { ...identity,
      sections: [{ sectionIndex: 1, sourceRange: { start: { utf16: 3 } } }] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 0, 'early host event must make no RPC before plugin.boot');
    booted = true;
    listeners.get('plugin.boot')({});
    if (newLibraryTab) {
      for (let turn = 0; turn < 150 && !storage.get('book-session')?.libraryTabs?.length; turn++) await new Promise(resolve => setTimeout(resolve, 10));
      const snapshot = storage.get('book-session');
      assert.equal(snapshot.libraryTabs?.length, 1, 'early new-tab event must survive initialization restoring the old draft');
      assert.equal(snapshot.activeLibraryId, snapshot.libraryTabs[0].id);
      assert.equal(snapshot.sessions.length, 1, 'opening the chooser retains the previously saved book');
      assert.equal(snapshot.sessions[0].id, 'previous-book');
      assert.equal(el('empty').hidden, false, 'library chooser is the active tab after boot');
      assert.equal(el('editor').hidden, true, 'restoring the old book must not replace the new chooser');
      assert.equal(el('book-tabs').children.length, 2, 'previous book and new library tab both remain available');
      const savedBook = storage.get(snapshot.sessions[0].bookKey);
      assert.deepEqual(JSON.parse(JSON.stringify(savedBook.identity)), identity);
      assert.equal(savedBook.originalText, lines.join('\n'));
      return;
    }
    for (let turn = 0; turn < 150 && (el('editor').hidden || el('proposed').value !== lines.join('\n') ||
      el('proposed').selectionStart !== lines[0].length + 1 + 3); turn++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(el('editor').hidden, false, `book must open after boot: ${el('status').textContent}`);
    assert.equal(el('proposed').value, lines.join('\n'));
    assert.equal(el('section-number').value, '2');
    assert.equal(el('proposed').selectionStart, lines[0].length + 1 + 3);
    const details = calls.find(call => call.method === 'library.getBookDetails');
    if (!restoredTarget) assert.deepEqual(JSON.parse(JSON.stringify(details.args)), identity);
    else assert.equal(details, undefined, 'reopening a restored target must retain its draft without loading its source again');
    assert.ok(storage.has('book-session'), 'the book loaded from the queued click is persisted');
    if (restoredUnrelated || restoredTarget) {
      const snapshot = storage.get('book-session');
      assert.equal(snapshot.sessions.length, restoredUnrelated ? 2 : 1, 'opening must preserve saved drafts without duplicate tabs');
      const previous = snapshot.sessions.find(item => item.id === 'previous-book');
      assert.ok(previous, 'previous draft remains in the workspace');
      assert.equal(storage.get(previous.bookKey).originalText, restoredUnrelated ? 'unrelated \u05d0\u05b7\nold draft' : lines.join('\n'));
    }
    assert.equal(el('use-reader').hidden, true, 'released 0.9.98 must not offer the unsupported reader selection');
  } finally { for (const timer of timers) clearTimeout(timer); }
}

test('cold context click before boot opens its book while the full library tree is stalled', async () => {
  await exerciseEarlyContextClick(await build(), { blockedLibrary: true });
});

test('cold toolbar click before boot opens its book while the full library tree is stalled', async () => {
  await exerciseEarlyContextClick(await build(), { blockedLibrary: true, toolbar: true });
});

test('an unrelated restored draft with stalled TOC and display maps cannot block a requested book', async () => {
  await exerciseEarlyContextClick(await build(), { restoredUnrelated: true });
});

test('context click on a restored target navigates to the new source position without replacing its draft', async () => {
  await exerciseEarlyContextClick(await build(), { restoredTarget: true });
});

test('a correct-book context click before plugin.boot opens the right source position after boot', async () => {
  const bundle = await build();
  await exerciseEarlyContextClick(bundle);
  // Run the identical scenario against a bundle with just the request gate removed.
  // This proves the regression detects an early RPC rather than merely delayed SDK boot.
  const withoutGate = bundle.replace(/(function requestBook\(event\)[\s\S]*?)await initializationStarted;/, '$1');
  assert.notEqual(withoutGate, bundle, 'mutation must remove the context-click initialization gate');
  await assert.rejects(exerciseEarlyContextClick(withoutGate), /early host event must make no RPC before plugin.boot/);
});

test('a native new-tab event before plugin.boot opens the library while retaining the restored book', async () => {
  const bundle = await build();
  await exerciseEarlyContextClick(bundle, { newLibraryTab: true });
  const withoutGate = bundle.replace(/(function requestLibrary\(\)[\s\S]*?)await initializationStarted;/, '$1');
  assert.notEqual(withoutGate, bundle, 'mutation must remove the new-tab initialization gate');
  await assert.rejects(exerciseEarlyContextClick(withoutGate, { newLibraryTab: true }),
    /early host event must make no RPC before plugin.boot|early new-tab event must survive initialization/);
});

test('declared reader button survives a toolbar click before plugin.boot', async () => {
  const manifest = JSON.parse(await readFile('plugin/manifest.json', 'utf8'));
  assert.ok(manifest.permissions.includes('reader.toolbar'));
  const button = manifest.contributes.startup.toolbarItems.find(item => item.id === 'correct-book');
  assert.deepEqual(button.contexts, ['reader-text']);
  assert.equal(button.openPlugin, true);
  const bundle = await build();
  await exerciseEarlyContextClick(bundle, { toolbar: true });
  const withoutListener = bundle.replace("host.on('reader.toolbar_item_clicked', requestBook);", '');
  await assert.rejects(exerciseEarlyContextClick(withoutListener, { toolbar: true }), /is not a function/);
});

test('released 0.9.98 hides the unsupported reader selection', async () => {
  const bundle = await build();
  await exerciseEarlyContextClick(bundle);
  const withoutGuard = bundle.replace("el('use-reader').hidden = !!embeddedReader || !textReaderAvailable;", "el('use-reader').hidden = !!embeddedReader;");
  assert.notEqual(withoutGuard, bundle);
  await assert.rejects(exerciseEarlyContextClick(withoutGuard), /released 0.9.98 must not offer/);
});

test('installed entrypoint runs a classic bundle and initializes after delayed SDK boot', async () => {
  const html = await readFile(new URL('../plugin/index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="app\.bundle\.js"><\/script>/);
  assert.doesNotMatch(html, /type=["']module["']/);
  const bundle = await build();
  const elements = new Map(), listeners = new Map();
  function el(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: id === 'status' ? 'טוען…' : '', hidden: true,
      style: { setProperty() {} }, children: [], append(...children) { this.children.push(...children); },
      classList: { toggle() {} }, addEventListener() {}, focus() {}, replaceChildren() {}, setAttribute() {}
    });
    return elements.get(id);
  }
  let booted = false, calls = 0;
  const host = {
    on(event, handler) { listeners.set(event, handler); },
    async call(method) {
      assert.equal(booted, true, 'RPC must wait for SDK boot');
      calls++;
      const data = method === 'library.getTree' ? { title: 'ספריית אוצריא', path: '/', categories: [], books: [] } : null;
      return { success: true, data };
    }
  };
  runInNewContext(bundle, {
    window: { Otzaria: host }, document: { getElementById: el, createElement: () => el(`created-${elements.size}`), querySelector: () => el('main'), documentElement: { style: { setProperty() {} } } },
    crypto: webcrypto, TextEncoder, setTimeout, clearTimeout, console
  }, { filename: 'app.bundle.js' });
  assert.equal(calls, 0);
  assert.equal(el('status').textContent, 'טוען…');
  booted = true;
  listeners.get('plugin.boot')({});
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(el('status').textContent, '');
  assert.equal(el('empty').hidden, false);
  assert.ok(calls >= 2);
});
