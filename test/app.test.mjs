import { test } from 'node:test';
import assert from 'node:assert/strict';

test('full book: partial delivery, persistent queue, reload retry, click guard and failed discard', async () => {
  class Element {
    value = ''; textContent = ''; hidden = false; disabled = false; readOnly = false;
    handlers = new Map(); classList = { toggle() {} }; style = { setProperty() {} };
    replaceChildren() {}
    append() {}
    setAttribute() {}
    addEventListener(event, handler) { this.handlers.set(event, handler); }
    focus() {}
    fire(event) { return this.handlers.get(event)?.({ preventDefault() {} }); }
  }
  const storage = new Map(), requests = [];
  let elements, events, failRemove = false, emailReads = 0, savedEmail = 'user@example.com';
  const raw = 'אב\nגד';
  function setup() {
    elements = new Map(); events = new Map();
    globalThis.document = {
      getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); },
      createElement() { return new Element(); },
      querySelector() { return new Element(); },
      documentElement: { style: { setProperty() {} } }
    };
    globalThis.window = { Otzaria: {
      _booted: true,
      on(event, handler) { events.set(event, handler); },
      call(method, args = {}) {
        if (method === 'feedback.submitBookCorrection') return (async function () {
          let release;
          const response = new Promise(resolve => { release = resolve; });
          requests.push({ args: structuredClone(args), release });
          const status = await response;
          return { success: true, data: status === 200
            ? { status: 'sent', reportId: args.reportId }
            : { status: 'failed', message: 'השליחה נכשלה (503). התיקון נשמר.' } };
        })();
        let data = null;
        if (method === 'storage.get') data = storage.get(args.key) ?? null;
        else if (method === 'storage.set') storage.set(args.key, structuredClone(args.value));
        else if (method === 'storage.remove') {
          if (failRemove) return Promise.resolve({ success: false, error: { message: 'storage failed' } });
          storage.delete(args.key);
        }
        else if (method === 'app.getUserEmail') { emailReads++; data = { email: savedEmail }; }
        else if (method === 'app.getTheme') data = { colorScheme: { primary: '#123456' } };
        else if (method === 'library.getBookDetails') data = { title: 'ספר', source: 'library', type: 'text', lineCount: 2 };
        else if (method === 'library.getBookContent') data = raw.slice(args.offset, args.offset + args.limit);
        else if (method === 'library.getBookToc') data = [{ text: 'פרק א', index: 0, level: 1 }];
        else if (method === 'reader.getSectionTextMap') data = { sourceText: raw.split('\n')[args.sectionIndex], currentRef: `פסקה ${args.sectionIndex + 1}` };
        else if (method !== 'ui.setUnsavedChanges') throw new Error(`Unexpected method: ${method}`);
        return Promise.resolve({ success: true, data });
      }
    } };
  }
  const el = id => document.getElementById(id);
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 300)); };
  async function waitForRequests(count) {
    for (let i = 0; i < 2000 && requests.length < count; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(requests.length, count);
  }
  setup();
  try {
    await import('../plugin/app.js?fullbook-first'); await settle();
    assert.equal(emailReads, 0, 'email is read from settings only when submitting');
    events.get('contextMenu.itemClicked')({ itemId: 'correct-book', selection: { bookId: 'ספר', id: 1 } });
    await settle();
    assert.equal(el('proposed').value, raw);
    assert.equal(el('send').disabled, true);
    el('proposed').value = 'אם\nגה'; el('proposed').fire('input');
    savedEmail = '';
    await el('editor').fire('submit');
    assert.equal(requests.length, 0);
    assert.equal(el('status').textContent, 'יש לעדכן מייל לפני השליחה בהגדרות התוכנה.');
    savedEmail = 'user@example.com';
    const submission = el('editor').fire('submit');
    await waitForRequests(1);
    assert.equal(el('proposed').readOnly, true);
    assert.equal(elements.has('email'), false, 'the editor does not ask for another email');
    assert.equal(emailReads, 2);
    await el('editor').fire('submit');
    assert.equal(requests.length, 1);
    assert.equal(storage.get('book-session').queue.length, 2);
    requests[0].release(200); await waitForRequests(2);
    assert.equal(storage.get('book-session').queue[0].sent, true);
    assert.equal(requests[0].args.sectionIndex, 0);
    assert.equal(requests[1].args.sectionIndex, 1);
    assert.equal(requests[0].args.allowQueue, false);
    assert.equal(requests[1].args.allowQueue, false);
    assert.deepEqual(requests[0].args.snapshots, [{ index: 0, text: 'אב' }]);
    assert.deepEqual(requests[1].args.snapshots, [{ index: 1, text: 'גד' }]);
    requests[1].release(503); await submission;
    const partial = storage.get('book-session');
    assert.deepEqual(partial.queue.map(item => item.sent), [true, false]);
    assert.equal(partial.editedText, 'אם\nגה');
    assert.match(el('status').textContent, /כבר נשלחו 1/);
    assert.equal(el('proposed').readOnly, true, 'prepared reports keep the editor immutable');
    assert.equal(el('send').disabled, false);
    failRemove = true; await el('discard').fire('click');
    assert.equal(el('editor').hidden, false);
    assert.equal(el('proposed').value, 'אם\nגה');
    assert.equal(el('send').disabled, false);
    assert.deepEqual(storage.get('book-session'), partial);
    setup();
    await import('../plugin/app.js?fullbook-reload'); await settle();
    assert.equal(el('proposed').value, 'אם\nגה');
    assert.equal(el('proposed').readOnly, true);
    assert.equal(el('send').textContent, 'המשך שליחה');
    const retry = el('editor').fire('submit'); await waitForRequests(3);
    assert.deepEqual(requests[1].args, requests[2].args, 'native retry keeps report ID and complete request');
    await el('editor').fire('submit'); assert.equal(requests.length, 3);
    requests[2].release(200); await retry;
    assert.equal(storage.get('book-session').completed, true);
    assert.deepEqual(storage.get('book-session').queue.map(item => item.sent), [true, true]);
    assert.match(el('status').textContent, /כל 2 הדיווחים נשלחו/);
    assert.equal(el('send').disabled, true);
    await el('discard').fire('click');
    assert.equal(el('editor').hidden, false, 'failed deletion preserves completed session');
    failRemove = false; await el('discard').fire('click');
    assert.equal(storage.has('book-session'), false);
    assert.equal(el('editor').hidden, true);
  } finally { delete globalThis.window; delete globalThis.document; }
});
