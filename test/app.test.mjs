import { test } from 'node:test';
import assert from 'node:assert/strict';

test('full book: partial delivery, persistent queue, reload retry, click guard and failed discard', async () => {
  class Element {
    value = ''; textContent = ''; hidden = false; disabled = false; readOnly = false;
    handlers = new Map(); children = []; classList = { toggle() {} }; style = { setProperty() {} };
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener(event, handler) { this.handlers.set(event, handler); }
    focus() {}
    fire(event) { return this.handlers.get(event)?.({ preventDefault() {} }); }
  }
  const storage = new Map(), requests = [];
  let elements, events, failRemove = false, emailReads = 0, savedEmail = 'user@example.com';
  const savedSession = () => { const workspace = storage.get('book-session'); return workspace?.sessions.find(item => item.id === workspace.activeId); };
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
        if (method === 'network.fetchStream') return (async function* () {
          let release;
          const response = new Promise(resolve => { release = resolve; });
          requests.push({ args: JSON.parse(args.body), release });
          const status = await response;
          yield { type: 'response', status };
          yield { type: 'data', body: JSON.stringify({ success: status === 200 }) };
        })();
        let data = null;
        if (method === 'storage.get') data = storage.get(args.key) ?? null;
        else if (method === 'storage.set') storage.set(args.key, structuredClone(args.value));
        else if (method === 'storage.remove') {
          if (failRemove) return Promise.resolve({ success: false, error: { message: 'storage failed' } });
          storage.delete(args.key);
        }
        else if (method === 'app.getUserEmail') { emailReads++; data = { email: savedEmail }; }
        else if (method === 'settings.get') data = 'grid';
      else if (method === 'library.getTree') data = { title: 'ספריית אוצריא', path: '/', categories: [], books: [] };
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
    assert.equal(savedSession().queue.length, 2);
    requests[0].release(200); await waitForRequests(2);
    assert.equal(savedSession().queue[0].sent, true);
    const firstPayload = requests[0].args, secondPayload = requests[1].args;
    assert.equal(firstPayload.line_number, 1);
    assert.equal(secondPayload.line_number, 2);
    assert.equal(firstPayload.book_title, 'ספר');
    assert.equal(firstPayload.selected_text, 'ב');
    assert.match(firstPayload.error_details, /מוצע: ם/);
    requests[1].release(503); await submission;
    const partialWorkspace = storage.get('book-session'), partial = savedSession();
    assert.deepEqual(partial.queue.map(item => item.sent), [true, false]);
    assert.equal(partial.editedText, 'אם\nגה');
    assert.match(el('status').textContent, /כבר נשלחו 1/);
    assert.equal(el('proposed').readOnly, true, 'prepared reports keep the editor immutable');
    assert.match(el('status').textContent, /העריכה נעולה זמנית כי 1 מתוך 2 דיווחים כבר נשלחו/);
    assert.match(el('status').textContent, /חיבור לרשת.*המשך שליחה.*העריכה תיפתח/);
    assert.equal(el('send').disabled, false);
    failRemove = true; await el('discard').fire('click');
    assert.equal(el('editor').hidden, false);
    assert.equal(el('proposed').value, 'אם\nגה');
    assert.equal(el('send').disabled, false);
    assert.deepEqual(storage.get('book-session'), partialWorkspace);
    savedEmail = 'updated@example.com';
    setup();
    await import('../plugin/app.js?fullbook-reload'); await settle();
    assert.equal(el('proposed').value, 'אם\nגה');
    assert.equal(el('proposed').readOnly, true);
    assert.equal(el('send').textContent, 'המשך שליחה');
    assert.match(el('status').textContent, /העריכה נעולה זמנית/,'restored locked editor explains the reason and recovery');
    const retry = el('editor').fire('submit'); await waitForRequests(3);
    assert.deepEqual(requests[1].args, requests[2].args, 'legacy retry keeps the complete report payload');
    assert.equal(requests[2].args.report_id, secondPayload.report_id);
    assert.equal(emailReads, 3, 'each submit reads current settings without adding an email dialog');
    await el('editor').fire('submit'); assert.equal(requests.length, 3);
    requests[2].release(200); await retry;
    assert.equal(savedSession().completed, true);
    assert.deepEqual(savedSession().queue.map(item => item.sent), [true, true]);
    assert.match(el('status').textContent, /כל 2 הדיווחים נשלחו/);
    assert.match(el('status').textContent, /כהצעות תיקון לבדיקה ידנית/);
    assert.doesNotMatch(el('status').textContent, /העריכה נעולה/,'completion clears the lock explanation');
    assert.equal(el('send').disabled, true);
    assert.equal(el('proposed').readOnly, false, 'successful delivery allows another correction');
    el('proposed').value = 'אם\nגה\nחדש'; el('proposed').fire('input');
    assert.equal(el('send').disabled, false);
    const additional = el('editor').fire('submit'); await waitForRequests(4);
    assert.equal(savedSession().queue.length, 1, 'previously reported corrections are excluded');
    const additionalPayload = requests[3].args;
    assert.notEqual(additionalPayload.report_id, secondPayload.report_id);
    requests[3].release(409); await additional;
    assert.notEqual(savedSession().queue[0].payload.report_id, additionalPayload.report_id);
    const conflictRetry = el('editor').fire('submit'); await waitForRequests(5);
    assert.notEqual(requests[4].args.report_id, additionalPayload.report_id);
    assert.equal(requests[4].args.selected_text, additionalPayload.selected_text);
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
