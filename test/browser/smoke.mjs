import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
const pages = await (await fetch('http://127.0.0.1:9227/json')).json();
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
const evaluate = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
await call('Runtime.enable');
await call('Page.enable');
await call('Page.addScriptToEvaluateOnNewDocument', { source: `
window.mockHandlers = {};
window.mockTheme = { mode:'light', colorScheme:{primary:'#6750a4',onPrimary:'#ffffff',surface:'#fffbfe',onSurface:'#1c1b1f',onSurfaceVariant:'#49454f',surfaceContainerHigh:'#ece6f0',outline:'#79747e',outlineVariant:'#cac4d0',secondaryContainer:'#e8def8',onSecondaryContainer:'#1d192b'}, typography:{uiFontFamily:'Arial',fontFamily:'Arial',fontSize:25,lineHeight:1.5} };
window.mockReports = [];
window.mockEmail = 'mock@example.com';
window.mockLines = ['טקסט מקורי', 'פסקה שנייה'];
window.Otzaria = { _booted:true, on(name, fn) { window.mockHandlers[name] = fn; }, call(method,args) {
return (async()=>{ let data = null;
if(method==='app.getTheme') data=mockTheme;
else if(method==='app.getUserEmail') data={email:window.mockEmail};
else if(method==='storage.get' && args.key==='book-session') data=window.mockStoredSession ?? null;
else if(method==='storage.set' && args.key==='book-session') window.mockStoredSession=args.value;
else if(method==='reader.getSectionTextMap') data={sourceText:mockLines[args.sectionIndex],currentRef:'פסקה '+(args.sectionIndex+1)};
else if(method==='library.getBookContent') data=mockLines.join(String.fromCharCode(10)).slice(args.offset,args.offset+args.limit);
else if(method==='library.getBookDetails') data={source:'library',type:'text',lineCount:2,title:'ספר בדיקה',libraryPath:'mock.txt'};
else if(method==='library.getBookToc') data=[{text:'ראשית',index:0,level:1},{text:'המשך',index:1,level:1}];
else if(method==='feedback.submitBookCorrection') { window.mockReports.push(args); data={status:'sent',reportId:args.reportId,correctionSupported:!args.forceFreeText && args.sectionIndex===args.endSectionIndex}; }
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
const emptyGeometry = await evaluate(`(()=>{const m=document.querySelector('main').getBoundingClientRect(),b=document.getElementById('load-current').getBoundingClientRect();return { main:{x:m.x,y:m.y,width:m.width,height:m.height}, button:{x:b.x,y:b.y,width:b.width,height:b.height}, centerError:Math.abs((m.x+m.width/2)-(b.x+b.width/2))};})()`);
assert.ok(emptyGeometry.button.width > 0 && emptyGeometry.button.height > 0);
assert.ok(emptyGeometry.centerError < 1);
assert.ok(emptyGeometry.button.y >= emptyGeometry.main.y && emptyGeometry.button.y + emptyGeometry.button.height <= emptyGeometry.main.y + emptyGeometry.main.height);
await evaluate(`mockHandlers['contextMenu.itemClicked']({itemId:'correct-book',selection:{bookId:'mock-book',currentIndex:1}})`);
for (let attempt = 0; attempt < 50; attempt++) {
  if (await evaluate(`!document.getElementById('editor').hidden && document.getElementById('proposed').value === window.mockLines.join(String.fromCharCode(10))`)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
const editor = await evaluate(`({ status:document.getElementById('status').textContent, visible:!document.getElementById('editor').hidden, value:document.getElementById('proposed').value, focus:document.activeElement.id, location:document.getElementById('location').textContent, caret:document.getElementById('proposed').selectionStart, section:document.getElementById('section-number').value, toc:[...document.querySelectorAll('#toc-list .toc-label')].map(b=>b.textContent), sidebar:document.querySelector('.book-navigation').getBoundingClientRect().toJSON(), paper:document.getElementById('proposed').getBoundingClientRect().toJSON() })`);
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
assert.equal(submission.sendDisabled, true);
assert.ok(submission.mockReports.length >= 2);
assert.ok(submission.mockReports.some(report => report.sectionIndex === 0));
assert.ok(submission.mockReports.some(report => report.sectionIndex === 1));
assert.ok(submission.mockReports.every(report => report.allowQueue === false && report.snapshots.length > 0));
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
// Exercise the real DOM with a megabyte Hebrew book, not a fake textarea.
await evaluate(`(()=>{
  const text=('פסקה ארוכה עם טקסט עברי לבדיקה '.repeat(20)+String.fromCharCode(10)).repeat(1800);
  const lines=text.split(String.fromCharCode(10)); let start=0;
  const sections=lines.map((line,index)=>{ const section={index,start,end:start+line.length,text:line}; start+=line.length+1; return section; });
  const toc=sections.filter(s=>s.index%50===0).map(s=>({text:'פרק '+s.index,index:s.index,level:1}));
  window.largeSession={id:'large',book:{...mockStoredSession.book,originalText:text,sections,toc},editedText:text,queue:null,completed:false,location:{sectionIndex:0,offset:0}};
})()`);
const largeSession = await evaluate('window.largeSession');
await call('Page.addScriptToEvaluateOnNewDocument', { source: `window.mockStoredSession = ${JSON.stringify(largeSession)};` });
await call('Page.reload');
for (let attempt = 0; attempt < 80; attempt++) {
  if (await evaluate(`document.getElementById('proposed')?.value.length > 16000 && document.getElementById('status')?.textContent === ''`)) break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.equal(await evaluate(`document.getElementById('page-position') === null && document.getElementById('editor-pages') === null`), true);
assert.ok(await evaluate(`document.getElementById('proposed').value.length <= 48003`));
await evaluate(`const e=document.getElementById('proposed'); e.value='תיקון'+e.value; e.dispatchEvent(new Event('input'));`);
await new Promise(resolve => setTimeout(resolve, 600));
assert.equal(await evaluate(`mockStoredSession.editedText`), 'תיקון' + largeSession.editedText);
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
const insertionOffset = largeSession.book.sections[500].start + 'תיקון'.length;
const priorText = 'תיקון' + largeSession.editedText;
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
assert.equal(errors.length, 0, JSON.stringify(errors));
console.log(JSON.stringify({ protocol:'file:', boot, emptyGeometry, editor, navigation, search, emptyEmailBlocked:true, submission, restored, scrollNavigation, focusStyle, middleBefore, middleAfter, resizedWithoutTextLoss:true, endBefore, endAfter, layoutComparison, exceptions:errors.length }, null, 2));
ws.close();
