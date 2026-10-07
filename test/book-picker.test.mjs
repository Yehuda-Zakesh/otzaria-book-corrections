import { test } from 'node:test';
import assert from 'node:assert/strict';

test('book tabs preserve independent drafts, reuse open books, and confirm closing unsent changes', async () => {
  class Element {
    hidden = true; value = ''; textContent = ''; handlers = new Map(); children = [];
    classList = { toggle() {} }; style = { setProperty() {} };
    addEventListener(name, callback) { this.handlers.set(name, callback); }
    replaceChildren(...children) { this.children = children; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    focus() {}
    fire(name) { return this.handlers.get(name)?.({ preventDefault() {} }); }
  }
  const elements = new Map(), loaded = [], storage = new Map();
  let confirmClose = false, failSave = false;
  const content = { ראשון: 'תוכן הספר הראשון', שני: 'תוכן הספר השני' };
  const titles = { ראשון: 'ספר ראשון', שני: 'ספר שני' };
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  let tabs = [
    { id: 1, bookId: 'ראשון', book: 'ספר ראשון', type: 'text', source: 'library' },
    { id: 2, bookId: 'שני', book: 'ספר שני', type: 'text', source: 'library' },
    { id: 2, bookId: 'שני', book: 'ספר שני', type: 'text', source: 'library' },
    { id: 3, bookId: 'סריקה', type: 'pdf', source: 'library' },
    { toolId: 'plugin', isSelf: true }
  ];
  globalThis.document = { getElementById: el, querySelector: () => el('main'), createElement: () => new Element(), documentElement: { style: { setProperty() {} } } };
  globalThis.window = { Otzaria: { _booted: true, on() {}, async call(method, args = {}) {
    let data = null;
    if (method === 'reader.getCurrentState') data = { currentId: 1, openTabs: tabs };
    if (method === 'library.getBookDetails') {
      loaded.push(args);
      data = { title: titles[args.bookId], lineCount: 1, type: 'text', source: 'library' };
    }
    if (method === 'library.getBookContent') data = content[args.bookId];
    if (method === 'reader.getSectionTextMap') data = { sourceText: content[args.bookId] };
    if (method === 'library.getBookToc') data = [{ text: `כותרת ${args.bookId}`, index: 0, level: 1 }];
    if (method === 'storage.get') data = storage.get(args.key) ?? null;
    if (method === 'storage.set') {
      if (failSave) return { success: false, error: { message: 'storage failed' } };
      storage.set(args.key, structuredClone(args.value));
    }
    if (method === 'storage.remove') storage.delete(args.key);
    if (method === 'ui.showConfirm') data = { confirmed: confirmClose };
    return { success: true, data };
  } } };
  try {
    await import('../plugin/app.js?book-picker');
    await new Promise(resolve => setImmediate(resolve));
    await el('load-current').fire('click');
    assert.equal(loaded.length, 0, 'multiple books must not silently choose the active book');
    assert.equal(el('book-picker').hidden, false);
    assert.deepEqual(el('open-books').children.map(option => option.textContent), ['ספר ראשון', 'ספר שני']);
    el('open-books').value = 'id:2';
    await el('load-current').fire('click');
    assert.deepEqual(loaded, [{ bookId: 'שני', bookUid: 'id:2' }]);
    assert.equal(el('location').textContent, titles.שני);
    assert.equal(el('nav-title').textContent, titles.שני);
    assert.equal(el('screen-title').textContent, titles.שני);
    assert.equal(el('proposed').value, content.שני);
    assert.equal(el('toc-list').children[0].children[0].children[0].textContent, 'כותרת שני');
    assert.equal(el('book-picker').hidden, true);

    await el('change-book').fire('click');
    assert.equal(el('book-picker').hidden, false);
    assert.equal(el('empty').hidden, false, 'chooser occupies the centered empty area');
    assert.equal(el('editor').hidden, true);
    assert.deepEqual(el('open-books').children.map(option => option.textContent), ['ספר ראשון', 'ספר שני']);
    await el('cancel-book-picker').fire('click');
    assert.equal(el('book-picker').hidden, true);
    assert.equal(el('editor').hidden, false);
    assert.equal(el('proposed').value, content.שני);
    assert.equal(el('nav-title').textContent, titles.שני);

    await el('change-book').fire('click');
    el('open-books').value = 'id:1';
    await el('load-current').fire('click');
    assert.equal(loaded[1].bookId, 'ראשון');
    assert.equal(el('proposed').value, content.ראשון);
    assert.equal(el('location').textContent, titles.ראשון);
    assert.equal(el('nav-title').textContent, titles.ראשון);
    assert.equal(el('screen-title').textContent, titles.ראשון);
    assert.equal(el('toc-list').children[0].children[0].children[0].textContent, 'כותרת ראשון');

    await el('change-book').fire('click');
    el('open-books').value = 'id:2';
    await el('load-current').fire('click');
    assert.equal(el('proposed').value, content.שני);
    el('proposed').value = 'תיקון שטרם נשלח';
    el('proposed').fire('input');
    await el('change-book').fire('click');
    el('open-books').value = 'id:1';
    await el('load-current').fire('click');
    assert.equal(loaded.length, 2, 'already-open books reuse their own drafts without reloading');
    assert.equal(el('proposed').value, content.ראשון);
    assert.equal(el('screen-title').textContent, titles.ראשון);
    assert.equal(el('book-tabs').children.length, 2);
    const workspace = storage.get('book-session');
    assert.equal(workspace.schemaVersion, 2);
    assert.equal(workspace.sessions.find(item => item.book.identity.bookId === 'שני').editedText, 'תיקון שטרם נשלח');
    const secondTab = () => el('book-tabs').children[0].children[0];
    await secondTab().fire('click');
    assert.equal(el('proposed').value, 'תיקון שטרם נשלח');
    failSave = true;
    await el('book-tabs').children[1].children[0].fire('click');
    assert.equal(el('proposed').value, 'תיקון שטרם נשלח', 'failed save must prevent tab switching');
    failSave = false;
    await el('book-tabs').children[0].children[1].fire('click');
    assert.equal(el('book-tabs').children.length, 2, 'canceling close preserves unsent draft');
    confirmClose = true;
    await el('book-tabs').children[0].children[1].fire('click');
    assert.equal(el('book-tabs').children.length, 1);
    assert.equal(el('proposed').value, content.ראשון);
    await el('discard').fire('click');
    tabs = [tabs[0]];
    await el('load-current').fire('click');
    assert.equal(loaded[2].bookId, 'ראשון');
    await el('discard').fire('click');
    tabs = [{ type: 'pdf', source: 'library', bookId: 'סריקה' }];
    await el('load-current').fire('click');
    assert.equal(loaded.length, 3);
    assert.match(el('status').textContent, /אין ספרי טקסט/);
  } finally { delete globalThis.document; delete globalThis.window; }
});
