import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from '../scripts/build.mjs';

test('installed entrypoint runs a classic bundle and initializes after delayed SDK boot', async () => {
  const html = await readFile(new URL('../plugin/index.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="app\.bundle\.js"><\/script>/);
  assert.doesNotMatch(html, /type=["']module["']/);
  const bundle = await build();
  const elements = new Map(), listeners = new Map();
  function el(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: id === 'status' ? 'טוען…' : '', hidden: true,
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
      const data = method === 'app.getUserEmail' ? { email: 'reader@example.com' } : null;
      return { success: true, data };
    }
  };
  runInNewContext(bundle, {
    window: { Otzaria: host }, document: { getElementById: el, querySelector: () => el('main'), documentElement: { style: { setProperty() {} } } },
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
