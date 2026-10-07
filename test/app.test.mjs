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
        if (method === 'feedback.submitBookCorrection') return (async () => {
          let release;
          const response = new Promise(resolve => { release = resolve; });
          requests.push({ args: structuredClone(args), release });
          const status = await response;
          return status === 200 ? { success: true, data: { status: 'sent', correctionSupported: args.sectionIndex === 0 } }
            : { success: false, error: { code: status === 409 ? 'error.report_id_conflict' : 'error.report_failed', message: 'שליחה נכשלה' } };
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
        else if (method === 'library.getBookDetails') data = { title: 'ספר', source: 'library', type: 'text', lineCount: 2, textSource: { key: 'otzaria-books' }, libraryPath: 'ספרים/ספר.txt' };
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
    for (let i = 0; i < 2000 && el('proposed').value !== raw; i++) await new Promise(resolve => setTimeout(resolve, 1));
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
    const firstPayload = requests[0].args, secondPayload = requests[1].args;
    assert.equal(firstPayload.sectionIndex, 0);
    assert.equal(secondPayload.sectionIndex, 1);
    assert.equal(firstPayload.bookId, 'ספר');
    assert.equal(firstPayload.sourceStart, 1);
    assert.equal(firstPayload.sourceEnd, 2);
    assert.equal(firstPayload.original, 'ב');
    assert.equal(firstPayload.proposed, 'ם');
    assert.equal(firstPayload.forceFreeText, false);
    assert.equal(firstPayload.allowQueue, false);
    assert.deepEqual(firstPayload.snapshots, [{ index: 0, text: 'אב' }]);
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
    savedEmail = 'updated@example.com';
    setup();
    await import('../plugin/app.js?fullbook-reload'); await settle();
    assert.equal(el('proposed').value, 'אם\nגה');
    assert.equal(el('proposed').readOnly, true);
    assert.equal(el('send').textContent, 'המשך שליחה');
    const retry = el('editor').fire('submit'); await waitForRequests(3);
    assert.deepEqual(requests[1].args, requests[2].args, 'native retry keeps report ID and source snapshots');
    assert.equal(requests[2].args.reportId, secondPayload.reportId);
    assert.equal(emailReads, 3, 'each submit reads current settings without adding an email dialog');
    await el('editor').fire('submit'); assert.equal(requests.length, 3);
    requests[2].release(200); await retry;
    assert.equal(storage.get('book-session').completed, true);
    assert.deepEqual(storage.get('book-session').queue.map(item => item.sent), [true, true]);
    assert.match(el('status').textContent, /כל 2 הדיווחים נשלחו/);
    assert.match(el('status').textContent, /1 תיקונים ישירים, 1 הצעות בלבד/);
    assert.equal(el('send').disabled, true);
    assert.equal(el('proposed').readOnly, false, 'successful delivery allows another correction');
    el('proposed').value = 'אם\nגה\nחדש'; el('proposed').fire('input');
    assert.equal(el('send').disabled, false);
    const additional = el('editor').fire('submit'); await waitForRequests(4);
    assert.equal(storage.get('book-session').queue.length, 1, 'previously reported corrections are excluded');
    const additionalPayload = requests[3].args;
    assert.notEqual(additionalPayload.reportId, secondPayload.reportId);
    requests[3].release(409); await additional;
    assert.notEqual(storage.get('book-session').queue[0].request.reportId, additionalPayload.reportId);
    const conflictRetry = el('editor').fire('submit'); await waitForRequests(5);
    assert.notEqual(requests[4].args.reportId, additionalPayload.reportId);
    assert.equal(requests[4].args.original, additionalPayload.original);
    requests[4].release(200); await conflictRetry;
    setup();
    await import('../plugin/app.js?fullbook-completed-reload'); await settle();
    assert.equal(el('proposed').readOnly, false, 'completed drafts remain editable after reload');
    assert.equal(el('proposed').value, 'אם\nגה\nחדש');
    await el('discard').fire('click');
    assert.equal(el('editor').hidden, false, 'failed deletion preserves completed session');
    failRemove = false; await el('discard').fire('click');
    assert.equal(storage.has('book-session'), false);
    assert.equal(el('editor').hidden, true);
  } finally { delete globalThis.window; delete globalThis.document; }
});
