import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from '../scripts/build.mjs';
import { waitFor } from './wait-for.mjs';

test('installed entrypoint runs a classic bundle and initializes after delayed SDK boot', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
  const readerAction = manifest.contributes.startup.contextMenuItems.find(item => item.id === 'correct-in-reader');
  assert.equal(readerAction.openPlugin, false, 'reader editing must keep the invoking book visible');
  assert.ok(manifest.permissions.includes('app.run_on_startup'), 'the reader action must be able to activate without a plugin tab');
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
  await waitFor(() => el('status').textContent === '' && el('empty').hidden === false, 'SDK boot and library initialization');
  assert.equal(el('status').textContent, '');
  assert.equal(el('empty').hidden, false);
  assert.ok(calls >= 2);
});
