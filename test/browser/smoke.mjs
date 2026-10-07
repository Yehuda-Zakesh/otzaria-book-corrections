import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
const pages = await (await fetch(`http://127.0.0.1:${process.env.CDP_PORT ?? 9227}/json`)).json();
const ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
let id = 0;
const pending = new Map(), errors = [];
ws.addEventListener('message', event => {
  const value = JSON.parse(event.data);
  if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails);
  if (value.id) { const task = pending.get(value.id); pending.delete(value.id); value.error ? task.reject(value.error) : task.resolve(value.result); }
});
const call = (method, params = {}) => new Promise((resolve, reject) => { const key = ++id; pending.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params })); });
const evaluate = async expression => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
await call('Runtime.enable');
await call('Page.enable');
await call('Page.addScriptToEvaluateOnNewDocument', { source: `
window.mockHandlers = {};
window.mockLibraryMode = 'grid';
window.mockTheme = { mode:'light', colorScheme:{primary:'#6750a4',onPrimary:'#ffffff',surface:'#fffbfe',onSurface:'#1c1b1f',onSurfaceVariant:'#49454f',surfaceContainerHigh:'#ece6f0',outline:'#79747e',outlineVariant:'#cac4d0',secondaryContainer:'#e8def8',onSecondaryContainer:'#1d192b'}, typography:{uiFontFamily:'Arial',fontFamily:'Arial',fontSize:25,lineHeight:1.5} };
window.mockReports = [];
window.mockEmail = 'mock@example.com';
window.mockLines = ['טקסט מקורי', 'פסקה שנייה'];
window.mockStorage = new Map();
window.mockWorkersCreated=0;
const NativeWorker=window.Worker;
window.Worker=class extends NativeWorker {constructor(...args){super(...args);window.mockWorkersCreated++;}};
window.mockHydrate = index => ({...index,schemaVersion:2,sessions:index.sessions.map(ref=>{
const book=window.mockStorage.get(ref.bookKey),draft=window.mockStorage.get(ref.draftKey);
const {editedPatch,reportedPatch,...state}=draft;
const restore=p=>{if(!Array.isArray(p))return book.originalText.slice(0,p.start)+p.text+book.originalText.slice(p.end);const parts=[];let cursor=0;for(const c of p){parts.push(book.originalText.slice(cursor,c.start),c.text);cursor=c.end;}parts.push(book.originalText.slice(cursor));return parts.join('');};
return {...state,book:{...book,sections:book.sections.map(s=>({...s,text:book.originalText.slice(s.start,s.end)}))},editedText:restore(editedPatch),...(reportedPatch?{reportedText:restore(reportedPatch)}:{})};
})});
window.Otzaria = { _booted:true, on(name, fn) { window.mockHandlers[name] = fn; }, call(method,args) {
if(method==='network.fetchStream') return (async function*(){ window.mockReports.push(JSON.parse(args.body)); if(window.mockNetworkFails) throw new Error('Network unavailable'); yield {type:'response',status:200}; yield {type:'data',body:JSON.stringify(window.mockEmailFails ? {success:true,accepted:true,savedToDatabase:true,email_sent:false,duplicate:false} : {success:true,correction_supported:window.mockCorrectionSupported!==false})}; })();
return (async()=>{ let data = null;
if(method==='app.getTheme') data=mockTheme;
else if(method==='settings.get') data=window.mockLibraryMode;
else if(method==='app.getUserEmail') data={email:window.mockEmail};
else if(method==='app.getInfo') data={version:'0.9.98',buildNumber:'801',platform:'windows'};
else if(method==='ui.showConfirm') data={confirmed:window.mockConfirmClose===true};
else if(method==='reader.getCurrentState') data={currentId:1,openTabs:[{id:1,bookId:'mock-book',book:'ספר בדיקה',source:'library',type:'text'},{id:2,bookId:'second-book',book:'ספר שני',source:'library',type:'text'}]};
else if(method==='library.getTree') data={title:'ספריית אוצריא',path:'/',categories:[{title:'חסידות',path:'/חסידות',order:0,categories:[],books:[{bookId:'extra',title:'נוסף',source:'library',type:'pdf'}]},{title:'תנ״ך',path:'/תנך',order:999,categories:[],books:[{id:99,bookUid:'id:99',bookId:'library-only',title:'ספר שאינו פתוח',source:'library',author:'מחבר לדוגמה',type:'text'},...Array.from({length:80},(_,i)=>({bookId:'other-'+i,title:'ספר נוסף '+i,source:'library',type:'pdf'}))]},{title:'Personal books',path:'/user',categories:[],books:[{bookId:'private',title:'Private book',source:'user',type:'text'}]}],books:[{bookId:'attached',title:'Attached book',source:'attached',type:'text'}]};
else if(method==='reader.openBook') window.mockOpenedBook=args;
else if(method==='storage.get') data=args.key==='book-session' ? window.mockIndex ?? window.mockStoredSession ?? null : window.mockStorage.get(args.key) ?? null;
else if(method==='storage.set') { if(window.mockStorageDelay) await new Promise(resolve=>setTimeout(resolve,window.mockStorageDelay)); window.mockStorage.set(args.key,structuredClone(args.value)); if(args.key==='book-session') {window.mockIndex=args.value;window.mockWorkspace=window.mockHydrate(args.value);window.mockStoredSession=window.mockWorkspace.sessions.find(item=>item.id===args.value.activeId);} }
else if(method==='storage.remove') {window.mockStorage.delete(args.key);if(args.key==='book-session'){window.mockIndex=null;window.mockStoredSession=null;window.mockWorkspace=null;}}
else if(method==='reader.getSectionTextMap') {
const sourceText=(args.bookId==='second-book'?window.secondLines:mockLines)[args.sectionIndex];
data={sourceText}; // SDK may return no currentRef; resolve it from the book TOC.
if(args.includeChars) {
const tokens=[...new Intl.Segmenter('he',{granularity:'grapheme'}).segment(sourceText)].map(item=>({text:item.segment,normalizedText:window.mockHideNikud?item.segment.replace(/[\\u05b0-\\u05bc\\u05bf\\u05c1\\u05c2\\u05c4\\u05c5\\u05c7]/g,''):item.segment}));
const start=Number(args.cursor??0);data.chars=tokens.slice(start,start+args.limit);data.hasMore=start+args.limit<tokens.length;data.nextCursor=data.hasMore?String(start+args.limit):null;
}
}
else if(method==='library.getBookContent') data=(args.bookId==='second-book'?window.secondLines:mockLines).join(String.fromCharCode(10)).slice(args.offset,args.offset+args.limit);
else if(method==='library.getBookDetails') data={id:args.bookId==='second-book'?2:99,bookUid:args.bookId==='second-book'?'id:2':'id:99',source:'library',type:'text',lineCount:args.bookId==='second-book'?window.secondLines.length:mockLines.length,title:args.bookId==='second-book'?'ספר שני':'ספר בדיקה',libraryPath:args.bookId==='second-book'?'second.txt':'mock.txt'};
else if(method==='library.getBookToc') data=args.bookId==='pointed-book'?[{text:'התחלה',index:0,level:1},{text:'אמצע',index:300,level:1},{text:'סוף',index:599,level:1}]:args.bookId==='second-book'?[{text:'תחילת השני',index:0,level:1},{text:'אמצע השני',index:50,level:1}]:[{text:'ראשית',index:0,level:1},{text:'המשך',index:1,level:1}];
else if(method.startsWith('network.')) throw new Error('Real reports forbidden in browser smoke');
return {success:true,data}; })(); } };
` });
await call('Page.navigate', { url: pathToFileURL(resolve('plugin/index.html')).href });
for (let attempt = 0; attempt < 50; attempt++) {
  if (await evaluate(`document.getElementById('status')?.textContent === ''`)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
const boot = await evaluate(`({ status:document.getElementById('status').textContent, empty:!document.getElementById('empty').hidden, primary:getComputedStyle(document.documentElement).getPropertyValue('--primary') })`);
assert.equal(boot.status, '');
assert.equal(boot.empty, true);
assert.equal(boot.primary, '#6750a4');
assert.equal(await evaluate("document.getElementById('library-grid') === null && document.getElementById('library-tree') === null"), true, 'view mode controls are removed');
const listPreferenceBoot = await call('Page.addScriptToEvaluateOnNewDocument', {source:"window.mockLibraryMode='list';"});
await call('Page.reload');
for(let attempt=0;attempt<50;attempt++) { if(await evaluate("document.querySelectorAll('#library-list .toc-label').length===2"))break; await new Promise(resolve=>setTimeout(resolve,100)); }
assert.equal(await evaluate("document.querySelectorAll('#library-list .library-card').length"), 0, 'startup follows the saved list preference');
assert.equal(await evaluate("document.querySelectorAll('#library-list .toc-label').length"), 2);
await call('Page.removeScriptToEvaluateOnNewDocument', {identifier:listPreferenceBoot.identifier});
await evaluate("window.mockLibraryMode='grid';mockHandlers['plugin.resumed']()");
for(let attempt=0;attempt<50;attempt++) { if(await evaluate("document.querySelectorAll('#library-list .library-card').length===2"))break; await new Promise(resolve=>setTimeout(resolve,100)); }
assert.equal(await evaluate("document.querySelectorAll('#library-list .library-card').length"), 2, 'resuming reads the latest preference even if its change event was missed');
assert.equal(await evaluate("document.getElementById('load-current') === null && document.getElementById('open-books') === null"), true);
assert.equal(await evaluate("document.querySelector('#library-list .library-card .library-name').textContent"), 'תנ״ך');
assert.equal(await evaluate("document.activeElement.id"), 'library-search');
assert.deepEqual(await evaluate("[...document.querySelectorAll('#library-list .library-name')].map(item=>item.textContent)"), ['תנ״ך','חסידות'], 'root categories use Otzaria priorities instead of API insertion order');
const homeGeometry = await evaluate("({main:document.querySelector('main').getBoundingClientRect().toJSON(),library:document.getElementById('library-list').getBoundingClientRect().toJSON(),card:document.querySelector('.library-card').getBoundingClientRect().toJSON()})");
assert.ok(homeGeometry.library.width > 1200 && homeGeometry.library.height > 400, 'library fills the home screen');
const homeScreenshot = await call('Page.captureScreenshot', {format:'png'});
await writeFile(resolve('test/browser/plugin-library-home.png'),Buffer.from(homeScreenshot.data,'base64'));
await evaluate("document.querySelector('#library-list .library-card').click()");
assert.equal(await evaluate("document.querySelectorAll('#library-list .library-card').length"), 81);
assert.equal(await evaluate("document.querySelector('#library-breadcrumbs [aria-current]').textContent"), 'תנ״ך');
assert.equal(await evaluate("getComputedStyle(document.querySelector('.library-card .library-icon')).width"), '32px');
await evaluate("document.querySelectorAll('#library-list .library-card')[1].click()");
for(let attempt=0;attempt<50;attempt++) { if(await evaluate("window.mockOpenedBook?.bookId==='other-0'"))break; await new Promise(resolve=>setTimeout(resolve,100)); }
assert.equal(await evaluate("window.mockOpenedBook.type"), 'pdf');
assert.equal(await evaluate("document.getElementById('editor').hidden"), true, 'PDF opens in the reader, not the text editor');
assert.equal(await evaluate("(()=>{const list=document.getElementById('library-list');list.scrollTop=200;return list.scrollTop>0 && list.scrollHeight>list.clientHeight})()"), true);
await call('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:false});
assert.equal(await evaluate("document.documentElement.scrollWidth <= 390"), true, 'library fits a narrow viewport');
await evaluate("document.getElementById('library-search').focus()");
await call('Page.bringToFront');
await call('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
await call('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
assert.equal(await evaluate("document.activeElement.className"), 'library-card');
assert.notEqual(await evaluate("getComputedStyle(document.activeElement).outlineStyle"), 'none');
await call('Emulation.clearDeviceMetricsOverride');
await evaluate("document.querySelector('#library-breadcrumbs button').click();window.mockLibraryMode='list';mockHandlers['settings.changed']({key:'key-library-view-mode',newValue:'list'})");
await evaluate("document.querySelector('#library-list .toc-label').click()");
assert.equal(await evaluate("document.querySelector('#library-list .toc-label').getAttribute('aria-expanded')"), 'true');
assert.equal(await evaluate("document.activeElement.className"), 'toc-label', 'expansion preserves keyboard focus');
await evaluate("document.getElementById('library-search').value='מחבר לדוגמה';document.getElementById('library-search').dispatchEvent(new Event('input'))");
for(let attempt=0;attempt<50;attempt++) { if(await evaluate("document.querySelectorAll('#library-list .toc-label').length===1"))break; await new Promise(resolve=>setTimeout(resolve,100)); }
assert.equal(await evaluate("document.querySelector('#library-list .toc-label').textContent"), 'ספר שאינו פתוח');
await evaluate("document.getElementById('library-search').value='שאינו פתוח';document.getElementById('library-search').dispatchEvent(new Event('input'))");
for(let attempt=0;attempt<50;attempt++) { if(await evaluate("document.querySelectorAll('#library-list .toc-label').length===1"))break; await new Promise(resolve=>setTimeout(resolve,100)); }
assert.equal(await evaluate("document.querySelectorAll('#library-list .toc-label').length"),1);
await evaluate("document.querySelector('#library-list .toc-label').focus()");
await call('Page.bringToFront');
await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
for(let attempt=0;attempt<50;attempt++) { if(await evaluate("!document.getElementById('editor').hidden"))break; await new Promise(resolve=>setTimeout(resolve,100)); }
assert.deepEqual(await evaluate("({visible:!document.getElementById('editor').hidden,status:document.getElementById('status').textContent})"),{visible:true,status:''});
assert.equal(await evaluate("window.mockWorkspace.sessions[0].book.identity.bookUid"),'id:99');
assert.equal(await evaluate("window.mockWorkspace.sessions[0].book.identity.bookId"),'library-only');
await evaluate("document.getElementById('discard').click()");
for(let attempt=0;attempt<50;attempt++) { if(await evaluate("document.getElementById('editor').hidden"))break; await new Promise(resolve=>setTimeout(resolve,100)); }
await evaluate(`mockHandlers['contextMenu.itemClicked']({itemId:'correct-book',selection:{bookId:'mock-book',currentIndex:1}})`);
for (let attempt = 0; attempt < 50; attempt++) {
  if (await evaluate(`!document.getElementById('editor').hidden && document.getElementById('proposed').value === window.mockLines.join(String.fromCharCode(10))`)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
const editor = await evaluate(`({ status:document.getElementById('status').textContent, visible:!document.getElementById('editor').hidden, value:document.getElementById('proposed').value, focus:document.activeElement.id, title:document.getElementById('screen-title').textContent, caret:document.getElementById('proposed').selectionStart, section:document.getElementById('section-number').value, toc:[...document.querySelectorAll('#toc-list .toc-label')].map(b=>b.textContent), sidebar:document.querySelector('.book-navigation').getBoundingClientRect().toJSON(), paper:document.getElementById('proposed').getBoundingClientRect().toJSON() })`);
assert.equal(editor.status, '');
assert.equal(await evaluate(`document.getElementById('email') === null`), true);
assert.equal(await evaluate(`getComputedStyle(document.querySelector('.section-jump')).display`), 'none');
assert.equal(await evaluate(`document.getElementById('nav-title').textContent`), 'ספר בדיקה');
assert.equal(editor.visible, true);
assert.equal(editor.value, 'טקסט מקורי\nפסקה שנייה');
assert.equal(editor.focus, 'proposed');
assert.equal(editor.caret, 'טקסט מקורי\n'.length);
assert.equal(editor.section, '2');
assert.deepEqual(editor.toc, ['ראשית', 'המשך']);
assert.ok(editor.sidebar.x > editor.paper.x);
const screenshot = await call('Page.captureScreenshot', { format: 'png' });
await writeFile(resolve('test/browser/plugin-native-look.png'), Buffer.from(screenshot.data, 'base64'));
await evaluate(`document.getElementById('proposed').value = 'טקסט מתוקן ארוך'+String.fromCharCode(10)+'פסקה מתוקנת'; document.getElementById('proposed').dispatchEvent(new Event('input',{bubbles:true})); document.querySelectorAll('#toc-list .toc-label')[0].click(); document.querySelectorAll('#toc-list .toc-label')[1].click();`);
const navigation = await evaluate(`({caret:document.getElementById('proposed').selectionStart,section:document.getElementById('section-number').value,value:document.getElementById('proposed').value})`);
assert.equal(navigation.caret, 'טקסט מתוקן ארוך\n'.length);
assert.equal(navigation.section, '2');
await evaluate(`document.getElementById('nav-search-tab').click(); document.getElementById('book-search').value='מתוקנת'; document.getElementById('book-search').dispatchEvent(new Event('input',{bubbles:true}));`);
for (let attempt = 0; attempt < 30; attempt++) {
  if (await evaluate(`document.querySelectorAll('#book-search-results button').length > 0`)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.equal(await evaluate(`document.getElementById('search-view').hidden`), false);
await evaluate(`document.querySelector('#book-search-results button').click()`);
const search = await evaluate(`({start:document.getElementById('proposed').selectionStart,end:document.getElementById('proposed').selectionEnd,text:document.getElementById('proposed').value.slice(document.getElementById('proposed').selectionStart,document.getElementById('proposed').selectionEnd)})`);
assert.equal(search.text, 'מתוקנת');
assert.equal(search.start, 'טקסט מתוקן ארוך\nפסקה '.length);
await evaluate(`document.getElementById('nav-toc-tab').click(); window.mockEmail=''; document.getElementById('editor').requestSubmit()`);
for (let attempt = 0; attempt < 30; attempt++) {
  if (await evaluate(`document.getElementById('status').textContent.includes('יש לעדכן מייל')`)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.equal(await evaluate(`document.getElementById('status').textContent`), 'יש לעדכן מייל לפני השליחה בהגדרות התוכנה.');
assert.equal(await evaluate(`window.mockReports.length`), 0);
await evaluate(`window.mockEmail='mock@example.com'`);
await evaluate(`document.getElementById('editor').requestSubmit()`);
for (let attempt = 0; attempt < 70; attempt++) {
  if (await evaluate(`document.getElementById('status').textContent.includes('נשלחו בהצלחה')`)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
const submission = await evaluate(`({ status:document.getElementById('status').textContent, sendDisabled:document.getElementById('send').disabled, mockReports:window.mockReports })`);
assert.match(submission.status, /נשלחו בהצלחה/);
await new Promise(resolve => setTimeout(resolve, 3200));
assert.equal(await evaluate(`document.getElementById('status').textContent`), '', 'successful submission notice dismisses automatically');
assert.equal(await evaluate(`getComputedStyle(document.getElementById('status')).display`), 'none', 'dismissed notice leaves no visible badge');
assert.equal(submission.sendDisabled, true);
assert.ok(submission.mockReports.length >= 2);
assert.ok(submission.mockReports.some(report => report.line_number === 1));
assert.ok(submission.mockReports.some(report => report.line_number === 2));
assert.ok(submission.mockReports.every(report => report.report_id && report.error_details.includes('מוצע:')));
assert.ok(submission.mockReports.every(report => report.current_ref && report.error_details.includes(`מיקום: ${report.current_ref}\nמספר שורה במקור: ${report.line_number}`)));
assert.ok(submission.mockReports.some(report => report.line_number === 1 && report.current_ref === 'ראשית'));
assert.ok(submission.mockReports.some(report => report.line_number === 2 && report.current_ref === 'המשך'));
assert.ok(submission.mockReports.every(report => report.schema_version === 2 && report.report_kind === 'text_correction' && report.correction));
assert.match(submission.status, /2 הצעות תיקון מובנות אושרו באתר/);
const savedSession = await evaluate('window.mockStoredSession');
await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.mockStoredSession = ${JSON.stringify(savedSession)};` });
await call('Page.reload');
for (let attempt = 0; attempt < 50; attempt++) {
  if (await evaluate(`!document.getElementById('editor')?.hidden && document.getElementById('proposed')?.value === 'טקסט מתוקן ארוך'+String.fromCharCode(10)+'פסקה מתוקנת'`)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
const restored = await evaluate(`({status:document.getElementById('status').textContent,visible:!document.getElementById('editor').hidden,text:document.getElementById('proposed').value})`);
assert.equal(restored.status, '');
assert.equal(restored.visible, true);
assert.equal(restored.text, 'טקסט מתוקן ארוך\nפסקה מתוקנת');
const waitFor = async (expression, label) => {
  for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
};
// Restore the exact failure reported by the user, then type using browser input.
await evaluate(`window.mockEmailFails=true;document.getElementById('proposed').value='טיוטה לפני כשל במייל';document.getElementById('proposed').dispatchEvent(new Event('input'));document.getElementById('editor').requestSubmit()`);
await waitFor(`document.getElementById('status').textContent.includes('המייל לנמען') && !document.getElementById('send').disabled`, 'HTTP success with failed email exposes the failure');
assert.equal(await evaluate(`window.mockStoredSession.completed`), false);
assert.equal(await evaluate(`window.mockStoredSession.queue.some(item=>item.sent)`), false);
await evaluate(`window.mockEmailFails=false`);
await evaluate(`window.mockNetworkFails=true;document.getElementById('proposed').value='טיוטה לפני כשל';document.getElementById('proposed').dispatchEvent(new Event('input'));document.getElementById('editor').requestSubmit()`);
await waitFor(`document.getElementById('status').textContent.includes('Network unavailable') && !document.getElementById('proposed').readOnly`, 'failed delivery unlocks editing');
const failedWorkspace = await evaluate('window.mockWorkspace');
const failedBoot = await call('Page.addScriptToEvaluateOnNewDocument', {source:`window.mockStoredSession=${JSON.stringify(failedWorkspace)};`});
await call('Page.reload');
await waitFor(`document.getElementById('proposed').value==='טיוטה לפני כשל' && document.getElementById('send').textContent==='המשך שליחה'`, 'failed draft restores its retry queue');
assert.equal(await evaluate(`document.getElementById('proposed').readOnly`), false);
await evaluate(`document.getElementById('proposed').focus();document.getElementById('proposed').select()`);
await call('Input.insertText', {text:'טיוטת ספר ראשון'});
await waitFor(`window.mockStoredSession.editedText==='טיוטת ספר ראשון' && window.mockStoredSession.queue===null`, 'new wording discards stale unsent reports and saves after restart');
await call('Page.removeScriptToEvaluateOnNewDocument', {identifier:failedBoot.identifier});
// A restored partial delivery must explain why typing is blocked and how to recover.
const partialWorkspace = {schemaVersion:2,activeId:savedSession.id,sessions:[{...savedSession,completed:false,queue:savedSession.queue.map((item,index)=>({...item,sent:index===0}))}]};
const partialBoot = await call('Page.addScriptToEvaluateOnNewDocument', {source:`window.mockStoredSession=${JSON.stringify(partialWorkspace)};`});
await call('Page.reload');
await waitFor(`document.getElementById('status').textContent.includes('העריכה נעולה זמנית')`, 'restored lock explanation');
assert.equal(await evaluate(`document.getElementById('proposed').readOnly`), true);
const lockText = await evaluate(`document.getElementById('status').textContent`);
assert.match(lockText,/1 מתוך 2 דיווחים כבר נשלחו/);
assert.match(lockText,/חיבור לרשת.*המשך שליחה.*העריכה תיפתח/);
assert.equal(await evaluate(`document.getElementById('proposed').getAttribute('aria-describedby')`),'status');
const lockScreenshot = await call('Page.captureScreenshot',{format:'png'});
await writeFile(resolve('test/browser/plugin-locked-explanation.png'),Buffer.from(lockScreenshot.data,'base64'));
await evaluate(`document.getElementById('change-book').click()`);
await waitFor(`!document.getElementById('empty').hidden`, 'open book picker while delivery is partial');
await evaluate(`document.querySelector('#book-tabs .active .book-tab-close').click()`);
assert.match(await evaluate(`document.getElementById('status').textContent`),/העריכה נעולה זמנית/,'navigation cannot clear a still-relevant explanation');
await evaluate(`document.getElementById('editor').requestSubmit()`);
await waitFor(`!document.getElementById('proposed').readOnly && document.getElementById('status').textContent.includes('נשלחו בהצלחה')`,'finishing pending reports unlocks editor');
assert.equal(await evaluate(`document.getElementById('status').textContent.includes('העריכה נעולה')`),false);
assert.equal(await evaluate(`window.mockReports.length`),1,'recovery sends only the remaining report');
await call('Page.removeScriptToEvaluateOnNewDocument', {identifier:partialBoot.identifier});
// Each tab must retain its draft, search state, selection and scroll position.
await evaluate(`document.getElementById('proposed').value='טיוטת ספר ראשון'; document.getElementById('proposed').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('proposed').setSelectionRange(3,7); document.getElementById('nav-search-tab').click(); document.getElementById('book-search').value='טיוטת'; document.getElementById('book-search').dispatchEvent(new Event('input')); window.secondLines=Array.from({length:180},(_,i)=>'פסקה '+i+' '+('תוכן הספר השני '.repeat(20))); window.mockHandlers['contextMenu.itemClicked']({itemId:'correct-book',selection:{bookId:'second-book',id:2}});`);
await waitFor(`document.getElementById('screen-title').textContent==='ספר שני' && !document.getElementById('proposed').readOnly`, 'second tab opens');
assert.equal(await evaluate(`document.querySelectorAll('#book-tabs [role=tab]').length`), 2);
await evaluate(`document.getElementById('proposed').value='תיקון שני '+document.getElementById('proposed').value; document.getElementById('proposed').dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('toc-search').value='השני'; document.getElementById('toc-search').dispatchEvent(new Event('input')); document.getElementById('book-scroll').scrollTop=12000;`);
await new Promise(resolve => setTimeout(resolve, 300));
const secondPosition = await evaluate(`document.getElementById('book-scroll').scrollTop`);
await evaluate(`window.mockStorageDelay=1200`);
assert.equal(await evaluate(`(()=>{document.querySelector('#book-tabs .book-tab-title').click();return document.getElementById('screen-title').textContent==='ספר בדיקה' && !document.getElementById('proposed').readOnly;})()`), true, 'switch updates immediately with slow storage');
const firstTabPoint = await evaluate(`(()=>{const r=document.querySelector('#book-tabs .book-tab-title').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...firstTabPoint, button: 'left', clickCount: 1 });
await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...firstTabPoint, button: 'left', clickCount: 1 });
await waitFor(`document.getElementById('screen-title').textContent==='ספר בדיקה' && !document.getElementById('proposed').readOnly`, 'first tab restored');
assert.equal(await evaluate(`document.getElementById('proposed').value`), 'טיוטת ספר ראשון');
assert.equal(await evaluate(`document.getElementById('book-search').value`), 'טיוטת');
assert.equal(await evaluate(`document.getElementById('search-view').hidden`), false);
assert.deepEqual(await evaluate(`({start:document.getElementById('proposed').selectionStart,end:document.getElementById('proposed').selectionEnd})`), {start:3,end:7});
// RTL: ArrowLeft selects the next tab, and keeps keyboard focus on the tab strip.
await evaluate(`document.querySelector('#book-tabs [aria-selected=true]').focus();`);
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
await waitFor(`document.getElementById('screen-title').textContent==='ספר שני' && !document.getElementById('proposed').readOnly`, 'keyboard tab navigation');
assert.equal(await evaluate(`document.activeElement.getAttribute('role')`), 'tab');
assert.ok(Math.abs(await evaluate(`document.getElementById('book-scroll').scrollTop`) - secondPosition) <= 1);
assert.equal(await evaluate(`document.getElementById('toc-search').value`), 'השני');
await waitFor(`document.getElementById('draft-status').textContent==='הטיוטה נשמרה' && window.mockWorkspace.activeId===document.querySelector('#book-tabs [aria-selected=true]').id.slice('book-tab-'.length)`, 'background tab save completes');
await evaluate(`window.mockStorageDelay=0`);
assert.equal(await evaluate(`window.mockWorkspace.sessions.find(s=>s.book.identity.bookId==='second-book').editedText.startsWith('תיקון שני ')`), true);
const tabWorkspace = await evaluate('window.mockWorkspace');
await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.secondLines=${JSON.stringify(await evaluate('window.secondLines'))};window.mockStoredSession=${JSON.stringify(tabWorkspace)};` });
await call('Page.reload');
await waitFor(`document.querySelectorAll('#book-tabs [role=tab]').length===2 && document.getElementById('screen-title').textContent==='ספר שני'`, 'all tabs survive reload');
assert.ok(Math.abs(await evaluate(`document.getElementById('book-scroll').scrollTop`) - secondPosition) <= 1);
const multiBookScreenshot = await call('Page.captureScreenshot', { format: 'png' });
await writeFile(resolve('test/browser/plugin-tabs.png'), Buffer.from(multiBookScreenshot.data, 'base64'));
await evaluate(`window.mockHandlers['theme.changed']({...mockTheme,mode:'dark',colorScheme:{...mockTheme.colorScheme,surface:'#141218',onSurface:'#e6e0e9',onSurfaceVariant:'#cac4d0',surfaceContainerHigh:'#2b2930',primary:'#d0bcff',onPrimary:'#381e72'}})`);
assert.equal(await evaluate(`getComputedStyle(document.querySelector('#book-tabs .active')).backgroundColor`), 'rgb(43, 41, 48)');
const darkScreenshot = await call('Page.captureScreenshot', {format:'png'});
await writeFile(resolve('test/browser/plugin-tabs-dark.png'), Buffer.from(darkScreenshot.data, 'base64'));
await call('Emulation.setDeviceMetricsOverride', {width:390,height:800,deviceScaleFactor:1,mobile:false});
await new Promise(resolve=>setTimeout(resolve, 300));
assert.equal(await evaluate(`document.documentElement.scrollWidth <= 390`), true, 'tabs and toolbar must fit a narrow viewport');
assert.equal(await evaluate(`document.querySelectorAll('#book-tabs [role=tab]').length`), 2);
assert.equal(await evaluate(`(window.mockWorkspace??window.mockStoredSession).sessions[1].editedText.startsWith('תיקון שני ')`), true);
await call('Emulation.clearDeviceMetricsOverride');
await evaluate(`window.mockHandlers['theme.changed'](mockTheme)`);
await new Promise(resolve=>setTimeout(resolve, 300));
// Cancellation must preserve the dirty tab. Confirming removes only that tab.
const beforeLibraryScroll = await evaluate(`document.getElementById('book-scroll').scrollTop`);
await evaluate(`document.getElementById('change-book').click()`);
await waitFor(`document.querySelectorAll('#book-tabs [role=tab]').length===3 && !document.getElementById('empty').hidden`, 'plus opens a library tab beside books');
assert.equal(await evaluate(`document.getElementById('book-tabs').hidden`), false);
assert.equal(await evaluate(`document.querySelector('#book-tabs [aria-selected=true]').textContent`), 'ספריית אוצריא');
assert.equal(await evaluate(`document.getElementById('change-book').hidden`), false, 'plus remains available in library');
await evaluate(`document.getElementById('library-search').value='נוסף';document.getElementById('library-search').dispatchEvent(new Event('input'));`);
await new Promise(resolve=>setTimeout(resolve,300));
await evaluate(`window.mockHandlers['plugin.page_opened']({source:'newTabButton'})`);
await waitFor(`document.querySelectorAll('#book-tabs [role=tab]').length===4`, 'host plus opens another library tab');
assert.equal(await evaluate(`document.getElementById('library-search').value`), '', 'new library has independent search');
await evaluate(`document.querySelectorAll('#book-tabs [role=tab]')[2].click()`);
assert.equal(await evaluate(`document.getElementById('library-search').value`), 'נוסף', 'library search restores');
await evaluate(`document.querySelectorAll('#book-tabs [role=tab]')[1].click()`);
assert.equal(await evaluate(`document.getElementById('screen-title').textContent`), 'ספר שני');
assert.ok(Math.abs(await evaluate(`document.getElementById('book-scroll').scrollTop`) - beforeLibraryScroll) <= 1, 'return from library restores book scroll');
await evaluate(`document.querySelectorAll('#book-tabs [aria-selected=true]')[0].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));`);
assert.equal(await evaluate(`document.activeElement.getAttribute('role')`), 'tab');
assert.equal(await evaluate(`document.getElementById('library-search').value`), 'נוסף');
await waitFor(`window.mockWorkspace?.libraryTabs.length===2 && window.mockWorkspace.activeLibraryId`, 'library tabs save');
const libraryWorkspace = await evaluate(`window.mockWorkspace`);
const libraryBoot = await call('Page.addScriptToEvaluateOnNewDocument', {source:`window.mockStoredSession=${JSON.stringify(libraryWorkspace)};`});
await call('Page.reload');
await waitFor(`document.querySelectorAll('#book-tabs [role=tab]').length===4 && !document.getElementById('empty').hidden`, 'library tabs survive reload');
assert.equal(await evaluate(`document.getElementById('library-search').value`), 'נוסף');
await call('Page.removeScriptToEvaluateOnNewDocument', {identifier:libraryBoot.identifier});
await evaluate(`document.querySelector('#book-tabs .active .book-tab-close').click()`);
await evaluate(`document.querySelectorAll('#book-tabs .book-tab-close')[2].click()`);
await waitFor(`document.querySelectorAll('#book-tabs [role=tab]').length===2 && !document.getElementById('editor').hidden`, 'closing library tabs returns to a book');
await waitFor(`window.mockWorkspace?.libraryTabs.length===0 && document.getElementById('draft-status').textContent==='הטיוטה נשמרה'`, 'library closures save');
await evaluate(`document.querySelectorAll('#book-tabs .book-tab-close')[1].click()`);
await new Promise(resolve => setTimeout(resolve, 200));
assert.equal(await evaluate(`document.querySelectorAll('#book-tabs [role=tab]').length`), 2);
await evaluate(`window.mockStorageDelay=1200;window.mockConfirmClose=true;document.querySelectorAll('#book-tabs .book-tab-close')[1].click()`);
await waitFor(`document.querySelectorAll('#book-tabs [role=tab]').length===1 && !document.getElementById('proposed').readOnly`, 'close confirmed tab');
assert.equal(await evaluate(`document.getElementById('proposed').value`), 'טיוטת ספר ראשון');
assert.equal(await evaluate(`(window.mockWorkspace??window.mockStoredSession).sessions.length`), 2, 'close updates before slow storage finishes');
await waitFor(`window.mockWorkspace?.sessions.length===1 && document.getElementById('draft-status').textContent==='הטיוטה נשמרה'`, 'closed tab persisted');
await evaluate(`window.mockStorageDelay=0`);
// Exercise the real DOM with a megabyte Hebrew book, not a fake textarea.
await evaluate(`(()=>{
  const text=('פסקה ארוכה עם טקסט עברי לבדיקה '.repeat(20)+String.fromCharCode(10)).repeat(1800);
  const lines=text.split(String.fromCharCode(10)); let start=0;
  const sections=lines.map((line,index)=>{ const section={index,start,end:start+line.length,text:line}; start+=line.length+1; return section; });
  const toc=sections.filter(s=>s.index%50===0).map(s=>({text:'פרק '+s.index,index:s.index,level:1}));
  window.largeSession={id:'large',book:{...mockStoredSession.book,originalText:text,sections,toc},editedText:text,queue:null,completed:false,location:{sectionIndex:0,offset:0}};
})()`);
const largeSession = await evaluate('window.largeSession');
const hiddenBoot = await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.mockStoredSession = ${JSON.stringify(largeSession)};document.addEventListener('DOMContentLoaded',()=>{document.body.style.display='none';});` });
await call('Page.reload');
for (let attempt = 0; attempt < 80; attempt++) {
  if (await evaluate(`document.getElementById('proposed')?.value.length >= 16000 && document.getElementById('status')?.textContent === ''`)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.equal(await evaluate(`document.getElementById('page-position') === null && document.getElementById('editor-pages') === null`), true);
assert.equal(await evaluate(`document.getElementById('proposed').clientWidth`), 0, 'restored plugin starts hidden like an inactive Otzaria tab');
await evaluate(`document.body.style.display=''`);
await evaluate(`window.mockHandlers['plugin.resumed']()`);
await waitFor(`parseFloat(document.getElementById('proposed').style.height)>100`, 'restored editor initializes when its tab becomes visible');
assert.equal(await evaluate(`document.getElementById('proposed').readOnly`), false);
await evaluate(`document.getElementById('proposed').focus();document.getElementById('proposed').setSelectionRange(0,0)`);
await call('Input.insertText', {text:'תיקון לאחר פתיחה מחדש '});
await waitFor(`window.mockStoredSession.editedText?.startsWith('תיקון לאחר פתיחה מחדש ')`, 'typing in a restored tab is saved');
assert.equal(await evaluate(`window.mockStoredSession.editedText.slice('תיקון לאחר פתיחה מחדש '.length)`), largeSession.editedText, 'editing after restart preserves the full hidden remainder of the book');
await call('Page.removeScriptToEvaluateOnNewDocument', {identifier:hiddenBoot.identifier});
assert.ok(await evaluate(`document.getElementById('proposed').value.length <= 48003`));
await evaluate(`const e=document.getElementById('proposed'); e.value='תיקון'+e.value; e.dispatchEvent(new Event('input'));`);
await new Promise(resolve => setTimeout(resolve, 600));
assert.equal(await evaluate(`mockStoredSession.editedText`), 'תיקוןתיקון לאחר פתיחה מחדש ' + largeSession.editedText);
await evaluate(`document.querySelector('#toc-list .toc-label').click(); document.getElementById('book-scroll').scrollTop=30000;`);
await new Promise(resolve => setTimeout(resolve, 200));
const scrollNavigation = await evaluate(`({position:document.getElementById('book-scroll').scrollTop,section:Number(document.getElementById('section-number').value),selected:document.querySelector('#toc-list .selected')?.dataset.key})`);
assert.ok(scrollNavigation.position > 0);
assert.ok(scrollNavigation.section > 50);
assert.notEqual(scrollNavigation.selected, 'i:0');
// A mouse click must not draw the browser's focus rectangle inside a row.
await evaluate(`document.querySelector('#toc-list .selected .toc-label').click()`);
const focusStyle = await evaluate(`(()=>{const e=document.querySelector('#toc-list .selected .toc-label');e.focus();return {outline:getComputedStyle(e).outlineStyle,border:getComputedStyle(e).borderWidth};})()`);
assert.equal(focusStyle.outline, 'none');
assert.equal(focusStyle.border, '0px');
const labelPoint = await evaluate(`(()=>{const r=document.querySelector('#toc-list .selected .toc-label').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
await call('Input.dispatchMouseEvent', {type:'mouseMoved',...labelPoint});
assert.equal(await evaluate(`getComputedStyle(document.querySelector('#toc-list .selected .toc-label')).backgroundColor`), 'rgba(0, 0, 0, 0)', 'hover cannot draw a separate rectangle inside the selected row');
await evaluate(`document.querySelector('[data-key="i:500"] .toc-label').click()`);
const middleBefore = await evaluate(`document.getElementById('book-scroll').scrollTop`);
await evaluate(`(()=>{const e=document.getElementById('proposed');e.setRangeText('תוספת',e.selectionStart,e.selectionEnd,'end');e.dispatchEvent(new Event('input'));})()`);
await new Promise(resolve => setTimeout(resolve, 600));
const insertionOffset = largeSession.book.sections[500].start + 'תיקוןתיקון לאחר פתיחה מחדש '.length;
const priorText = 'תיקוןתיקון לאחר פתיחה מחדש ' + largeSession.editedText;
const middleText = priorText.slice(0, insertionOffset) + 'תוספת' + priorText.slice(insertionOffset);
assert.equal(await evaluate('mockStoredSession.editedText'), middleText, 'middle edits preserve all hidden text');
const middleAfter = await evaluate(`document.getElementById('book-scroll').scrollTop`);
assert.ok(Math.abs(middleAfter-middleBefore) < 500, 'editing does not restart book scrolling');
await call('Emulation.setDeviceMetricsOverride', {width:700,height:900,deviceScaleFactor:1,mobile:false});
await new Promise(resolve => setTimeout(resolve, 250));
assert.equal(await evaluate('mockStoredSession.editedText'), middleText);
assert.ok(await evaluate(`document.getElementById('book-scroll').scrollTop > 0`));
assert.equal(await evaluate(`getComputedStyle(document.getElementById('proposed')).paddingTop`), '0px');
await call('Emulation.clearDeviceMetricsOverride');
await new Promise(resolve => setTimeout(resolve, 250));
await evaluate(`const s=document.getElementById('book-scroll');s.scrollTop=s.scrollHeight;`);
await new Promise(resolve => setTimeout(resolve, 300));
// Send genuine browser wheel input at the last page, including repeated ticks.
const wheelPoint = await evaluate(`(()=>{const r=document.getElementById('book-scroll').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
const endBefore = await evaluate(`({top:document.getElementById('book-scroll').scrollTop,height:document.getElementById('book-scroll').scrollHeight,section:Number(document.getElementById('section-number').value)})`);
for (let i=0;i<5;i++) {
  await call('Input.dispatchMouseEvent', {type:'mouseWheel',...wheelPoint,deltaY:800,deltaX:0});
  await new Promise(resolve => setTimeout(resolve, 50));
}
const endAfter = await evaluate(`({top:document.getElementById('book-scroll').scrollTop,height:document.getElementById('book-scroll').scrollHeight,section:Number(document.getElementById('section-number').value),rendered:document.getElementById('proposed').value.length})`);
assert.ok(endAfter.top >= endBefore.top - 1, 'scrolling beyond book end cannot return to the beginning');
assert.ok(endAfter.section > 1700);
assert.ok(endAfter.rendered <= 48003);
const layoutComparison = await evaluate(`(()=>{
  const e=document.getElementById('proposed'),chunk=e.value, text=mockStoredSession.editedText;
  const measure=value=>{const t=performance.now();e.value=value; const height=e.scrollHeight; e.scrollTop=height/2; return performance.now()-t;};
  const fullMs=measure(text),chunkMs=measure(chunk); return {characters:text.length,fullMs,chunkMs,renderedCharacters:chunk.length};
})()`);
// Large-book search uses an actual browser worker; query changes cannot leave
// old results behind, and the UI gets an animation frame while work runs.
await evaluate(`window.mockSearchFrames=0;document.getElementById('book-search').value='תוספת';document.getElementById('nav-search-tab').click();requestAnimationFrame(()=>window.mockSearchFrames++);`);
await waitFor(`document.querySelectorAll('#book-search-results button').length>0`,'large search worker returns results');
assert.ok(await evaluate(`window.mockWorkersCreated>0`),'large-book search starts a real Worker');
assert.ok(await evaluate(`window.mockSearchFrames>0`),'UI frames continue while searching');
await evaluate(`const q=document.getElementById('book-search');q.value='תיקון';q.dispatchEvent(new Event('input'));q.value='מחרוזתשאינהקיימת';q.dispatchEvent(new Event('input'));`);
await waitFor(`document.getElementById('book-search-results').textContent==='לא נמצאו תוצאות'`,'latest query replaces earlier worker results');
await evaluate(`document.getElementById('nav-toc-tab').click()`);
// A pointed book follows the host's per-book policy while the draft remains
// canonical. Use real textarea selection and native browser scrolling.
await evaluate(`window.mockHideNikud=true;window.mockLines=Array.from({length:600},(_,i)=>'שָׁלוֹם בַּיִת '+i+' '+ 'מִלָּה '.repeat(20));mockHandlers['contextMenu.itemClicked']({itemId:'correct-book',selection:{bookId:'pointed-book',bookUid:'id:600',currentIndex:300}});`);
for(let attempt=0;attempt<100;attempt++) {
  if(await evaluate(`mockStoredSession?.book.identity.bookId==='pointed-book' && document.getElementById('section-number').max==='600' && document.activeElement.id==='proposed' && !document.getElementById('proposed').value.includes('ָ')`)) break;
  await new Promise(resolve=>setTimeout(resolve,100));
}
assert.equal(await evaluate(`mockStoredSession.hideNikud`),true);
assert.equal(await evaluate(`mockStoredSession.editedText===mockLines.join(String.fromCharCode(10))`),true);
assert.equal(await evaluate(`document.getElementById('send').disabled`),true,'hiding nikud is not a correction');
assert.equal(await evaluate(`document.getElementById('section-number').value`),'301');
assert.equal(await evaluate(`document.activeElement.id`),'proposed');
await evaluate(`document.querySelector('[data-key="i:0"] .toc-label').click()`);
assert.equal(await evaluate(`document.getElementById('proposed').value.slice(0,4)`),'שלום');
assert.equal(await evaluate(`document.getElementById('proposed').readOnly`),false);
await evaluate(`(()=>{const e=document.getElementById('proposed');e.setSelectionRange(3,4);e.setRangeText('מ',3,4,'end');e.dispatchEvent(new Event('input'));})()`);
await new Promise(resolve=>setTimeout(resolve,600));
assert.equal(await evaluate(`mockStoredSession.editedText==='שָׁלוֹמ'+mockLines.join(String.fromCharCode(10)).slice('שָׁלוֹם'.length)`),true,'only the edited letter changes; hidden nikud elsewhere survives');
await evaluate(`document.querySelector('[data-key="i:300"] .toc-label').click()`);
assert.equal(await evaluate(`document.getElementById('proposed').value.slice(document.getElementById('proposed').selectionStart,document.getElementById('proposed').selectionStart+4)`),'שלום');
await evaluate(`(()=>{const s=document.getElementById('book-scroll');s.scrollTop=s.scrollHeight})()`);
await new Promise(resolve=>setTimeout(resolve,300));
assert.ok(await evaluate(`Number(document.getElementById('section-number').value)>550`),'sidebar tracks visible pointed-book source section');
const pointedEnd = await evaluate(`document.getElementById('book-scroll').scrollTop`);
const pointedWheel = await evaluate(`(()=>{const r=document.getElementById('book-scroll').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
await call('Input.dispatchMouseEvent',{type:'mouseWheel',...pointedWheel,deltaY:1600,deltaX:0});
await new Promise(resolve=>setTimeout(resolve,200));
assert.ok(await evaluate(`document.getElementById('book-scroll').scrollTop`)>=pointedEnd-1);
await evaluate(`window.mockHideNikud=false;mockHandlers['plugin.resumed']()`);
for(let attempt=0;attempt<50;attempt++){if(await evaluate(`document.getElementById('proposed').value.includes('ָ')`))break;await new Promise(resolve=>setTimeout(resolve,100));}
assert.equal(await evaluate(`document.getElementById('proposed').value.includes('ָ')`),true,'resuming rereads the current host policy');
await evaluate(`window.mockHideNikud=true;mockHandlers['plugin.resumed']()`);
for(let attempt=0;attempt<50;attempt++){if(await evaluate(`!document.getElementById('proposed').value.includes('ָ')`))break;await new Promise(resolve=>setTimeout(resolve,100));}
assert.equal(await evaluate(`document.getElementById('proposed').value.includes('ָ')`),false);
const pointedScreenshot=await call('Page.captureScreenshot',{format:'png'});
await writeFile(resolve('test/browser/plugin-hidden-nikud.png'),Buffer.from(pointedScreenshot.data,'base64'));
// Reopen the actual schema-3 records rather than a hydrated legacy fixture.
await new Promise(resolve=>setTimeout(resolve,600));
const persistedState=await evaluate(`({index:mockIndex,entries:[...mockStorage],lines:mockLines,text:mockStoredSession.editedText,id:mockStoredSession.id})`);
assert.equal(persistedState.index.schemaVersion,3);
const schema3Boot=await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.mockIndex=${JSON.stringify(persistedState.index)};window.mockStorage=new Map(${JSON.stringify(persistedState.entries)});window.mockLines=${JSON.stringify(persistedState.lines)};window.mockHideNikud=true;`});
await call('Page.reload');
await waitFor(`document.getElementById('section-number')?.max==='600' && document.getElementById('proposed')?.value.length>0`,'schema-3 source and patch records restore');
await evaluate(`mockHandlers['plugin.suspended']()`);
await waitFor(`window.mockStoredSession?.id===${JSON.stringify(persistedState.id)}`,'restored snapshot remains writable');
assert.equal(await evaluate(`mockStoredSession.editedText`),persistedState.text);
assert.equal(await evaluate(`document.getElementById('status').textContent`),'','source restoration check is silent');
// Changing a middle source section blocks sending before the network is used.
await evaluate(`window.mockLines[300]+=' שינוי במקור';document.getElementById('editor').requestSubmit()`);
await waitFor(`document.getElementById('status').textContent.includes('מקור הספר השתנה')`,'changed source blocks queued or new submission');
assert.equal(await evaluate(`mockReports.length`),0);
assert.equal(await evaluate(`mockStoredSession.editedText`),persistedState.text,'blocked submission preserves the draft');
await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:schema3Boot.identifier});
assert.equal(errors.length, 0, JSON.stringify(errors));
console.log(JSON.stringify({ protocol:'file:', boot, homeGeometry, editor, navigation, search, emptyEmailBlocked:true, submission, restored, tabs:{count:2,independentDrafts:true,scrollRestored:true,selectionRestored:true,keyboardFocus:true,reloadRestored:true,closeCancellation:true}, scrollNavigation, focusStyle, middleBefore, middleAfter, resizedWithoutTextLoss:true, endBefore, endAfter, layoutComparison, exceptions:errors.length }, null, 2));
ws.close();
