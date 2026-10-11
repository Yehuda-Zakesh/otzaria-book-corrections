import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storedWorkspace } from './stored-workspace.mjs';

test('a restored failed submission remains editable and changed text replaces only unsent reports', async () => {
  class Element {
    value = ''; textContent = ''; hidden = true; readOnly = false; disabled = false;
    handlers = new Map(); children = []; classList = { toggle() {} }; style = { setProperty() {} };
    append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children = children; } setAttribute() {} focus() {}
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    fire(name) { return this.handlers.get(name)?.({ preventDefault() {} }); }
  }
  let elements;
  const storage = new Map(), requests = [];
  const original = 'אב\nגד', edited = 'אם\nגד';
  const book = { identity: { bookId: 'ספר' }, details: { title: 'ספר', source: 'library' }, originalText: original,
    sections: [{index:0,start:0,end:2,text:'אב'},{index:1,start:3,end:5,text:'גד'}], toc:[{text:'פרק א',index:0,level:1}] };
  storage.set('book-session', {id:'restored',book,editedText:edited,queue:null,completed:false,location:{sectionIndex:0,offset:0}});
  function setup() {
    elements = new Map();
    const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
    globalThis.document = {getElementById:el,createElement:()=>new Element(),querySelector:()=>el('main'),documentElement:{style:{setProperty(){}}}};
    globalThis.window = { Otzaria: { _booted:true, on(){}, call(method,args={}) {
      if (method === 'feedback.submitBookCorrection') {
        requests.push(structuredClone(args)); return Promise.resolve({success:false,error:{message:'Network unavailable'}});
      }
      let data = null;
      if (method === 'storage.get') data = structuredClone(storage.get(args.key));
      else if (method === 'storage.set') storage.set(args.key,structuredClone(args.value));
      else if (method === 'storage.remove') storage.delete(args.key);
      else if (method === 'library.getBookDetails') data = { source:'library',type:'text',lineCount:2 };
      else if (method === 'library.getBookContent') data = original.slice(args.offset,args.offset+args.limit);
      else if (method === 'settings.get') data = 'grid';
      else if (method === 'library.getTree') data = { title: 'ספריית אוצריא', path: '/', categories: [], books: [] };
      else if (method === 'app.getUserEmail') data = {email:'user@example.com'};
      else if (method === 'reader.getSectionTextMap') data = {sourceText:book.sections[args.sectionIndex].text};
      else if (!['app.getTheme','ui.setUnsavedChanges'].includes(method)) throw new Error(`Unexpected method: ${method}`);
      return Promise.resolve({success:true,data});
    } } };
    return el;
  }
  const settle = () => new Promise(resolve=>setTimeout(resolve,150));
  const saved = () => { const w=storedWorkspace(storage);return w.sessions.find(s=>s.id===w.activeId); };
  let el = setup();
  try {
    await import('../plugin/app.js?failed-edit-first'); await settle();
    await el('editor').fire('submit');
    assert.equal(requests.length,1); assert.equal(saved().queue[0].sent,false);
    assert.equal(el('proposed').readOnly,false,'a failure before any acknowledgment must not lock editing');
    el = setup();
    await import('../plugin/app.js?failed-edit-restart'); await settle();
    assert.equal(el('proposed').value,edited); assert.equal(el('proposed').readOnly,false);
    assert.equal(el('send').textContent,'המשך שליחה');
    await el('editor').fire('submit');
    assert.deepEqual(requests[1],requests[0],'retry without editing preserves the original payload and ID');
    el('proposed').value = edited; el('proposed').fire('input');
    await el('editor').fire('submit');
    assert.deepEqual(requests[2],requests[0],'input without a text change must also preserve the retry ID');
    el('proposed').value = 'אה\nגד'; el('proposed').fire('input'); await new Promise(resolve=>setTimeout(resolve,550));
    assert.equal(saved().editedText,'אה\nגד'); assert.equal(saved().queue,null);
    await el('editor').fire('submit');
    assert.notEqual(requests[3].reportId,requests[0].reportId);
    assert.equal(requests[3].proposed,'ה');
    // A crash after the last acknowledgment but before completed=true cannot lock the restored book.
    const workspace=storage.get('book-session');
    const draft = storage.get(workspace.sessions[0].draftKey);
    draft.queue.forEach(item=>{item.sent=true;}); draft.completed=false;
    el = setup(); await import('../plugin/app.js?acknowledged-edit-restart'); await settle();
    assert.equal(el('proposed').readOnly,false); assert.equal(el('send').disabled,true);
    el('proposed').value='את\nגד'; el('proposed').fire('input'); await new Promise(resolve=>setTimeout(resolve,550));
    assert.equal(saved().reportedText,'אה\nגד','acknowledged wording remains the baseline for later edits');
  } finally { delete globalThis.document;delete globalThis.window; }
});
