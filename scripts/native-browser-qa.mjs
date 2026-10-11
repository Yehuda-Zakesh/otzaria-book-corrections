// Exercise the workspace assets in an installed Otzaria WebView with its real SDK.
// Storage is isolated. Automated QA blocks reports; manual preview uses host permission checks.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const port = process.env.CDP_PORT ?? 9231;
const preview = process.argv.includes('--preview');
const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const pluginPages = pages.filter(p => p.url.includes('org.otzaria.community.book-corrections'));
if (!preview) assert.ok(pluginPages.length, 'Open the corrections plugin in Otzaria first');
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let sequence = 0;
const pending = new Map(), errors = [], sessions = new Map();
const pluginTargets = new Set(pluginPages.map(page => page.id));
let stopPreview;
const previewStopped = new Promise(resolve => { stopPreview = resolve; });
const onStop = () => stopPreview();
if (preview) { process.on('SIGINT', onStop); process.on('SIGTERM', onStop); }
let activeSession, selectedBefore, originalReaderIndex, readerSession;
const command = (method, params = {}, sessionId = activeSession) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
  pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const assets = Object.fromEntries(await Promise.all(['index.html', 'style.css', 'app.bundle.js'].map(async name => [name, await readFile(`plugin/${name}`, 'utf8')])));
const guard = `
window.__qaPreview=${preview};window.__qaCalls=[];window.__qaBoot=null;window.__qaEvents=[];
const qaOriginalCall=Otzaria.call.bind(Otzaria);
Otzaria.call=async function(method,args={}){
 window.__qaCalls.push(method);
 if((!window.__qaPreview&&method.startsWith('feedback.'))||method.startsWith('network.')) throw new Error('QA forbids real reports');
 if(method.startsWith('storage.')&&args.key) args={...args,key:'qa-reader-integration:'+args.key};
 const result=await qaOriginalCall(method,args);
 if(method==='storage.list'&&result.success) result.data=result.data.filter(k=>k.startsWith('qa-reader-integration:')).map(k=>k.slice('qa-reader-integration:'.length));
 return result;
};
Otzaria.on('plugin.boot',payload=>{window.__qaBoot=payload;});
Otzaria.on('reader.textReaderNavigate',payload=>{window.__qaEvents.push(payload);});
`;
assets['app.bundle.js'] = guard + assets['app.bundle.js'];
socket.addEventListener('message', async event => {
 try {
  const value = JSON.parse(event.data);
  if (value.id) { const task = pending.get(value.id); pending.delete(value.id); if (task) { clearTimeout(task.timeout); value.error ? task.reject(value.error) : task.resolve(value.result); } }
  if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails);
  if (value.method === 'Target.attachedToTarget') {
    const sessionId = value.params.sessionId;
    if (value.params.targetInfo.type !== 'page') {
      await command('Runtime.runIfWaitingForDebugger', {}, sessionId);
      return;
    }
    sessions.set(value.params.targetInfo.targetId, sessionId);
    if (value.params.targetInfo.url.includes('org.otzaria.community.book-corrections')) pluginTargets.add(value.params.targetInfo.targetId);
    await command('Runtime.enable', {}, sessionId); await command('Page.enable', {}, sessionId);
    await command('Fetch.enable', { patterns: ['index.html', 'style.css', 'app.bundle.js'].map(name => ({ urlPattern: `*org.otzaria.community.book-corrections*${name}*` })) }, sessionId);
    await command('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }
  if (value.method === 'Fetch.requestPaused') {
    if (value.params.request.url.includes('org.otzaria.community.book-corrections')) {
      for (const [targetId, sessionId] of sessions) if (sessionId === value.sessionId) pluginTargets.add(targetId);
    }
    const name = value.params.request.url.split('/').at(-1).split('?')[0];
    if (preview && assets[name]) assets[name] = (name === 'app.bundle.js' ? guard : '') + await readFile(`plugin/${name}`, 'utf8');
    if (preview && name === 'app.bundle.js') console.log(JSON.stringify({ previewAssetsServed: true, sessionId: value.sessionId, asset: name }));
    if (assets[name]) await command('Fetch.fulfillRequest', { requestId: value.params.requestId, responseCode: 200,
      responseHeaders: [{ name: 'Content-Type', value: name.endsWith('.js') ? 'application/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html' }], body: Buffer.from(assets[name]).toString('base64') }, value.sessionId);
    else await command('Fetch.continueRequest', { requestId: value.params.requestId }, value.sessionId);
  }
 } catch (error) {
   console.error('CDP event failed:', error);
   errors.push({ text: String(error) });
   if (preview) stopPreview();
 }
});
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails)); return result.result.value;
};
const waitFor = async expression => {
  for (let i = 0; i < 300; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  console.log(await evaluate(`({boot:window.__qaBoot,status:document.getElementById('status')?.textContent,calls:window.__qaCalls})`));
  throw new Error(`Timeout: ${expression}`);
};
try {
  await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: 'page', exclude: false }, { exclude: true }] }, null);
  for (const page of pluginPages) {
    for (let i=0;i<50&&!sessions.has(page.id);i++) await new Promise(resolve=>setTimeout(resolve,100));
    activeSession = sessions.get(page.id);
    assert.ok(activeSession, 'Attached to the plugin WebView');
    await command('Fetch.enable', { patterns: ['index.html', 'style.css', 'app.bundle.js'].map(name => ({ urlPattern: `*org.otzaria.community.book-corrections*${name}*` })) });
    await command('Page.reload', { ignoreCache: true });
    if (preview) continue;
    await waitFor(`window.__qaBoot && document.getElementById('personal-open') && document.getElementById('status').textContent===''`);
    if (await evaluate(`!!__qaBoot.reader?.embedded`)) break;
  }
  if (preview) {
    console.log(JSON.stringify({ preview: true, active: true, existingPages: pluginPages.length, reportsBlocked: false, hostPermissionsEnforced: true, storageIsolated: true, installedFilesChanged: false }));
    await previewStopped;
  } else {
  console.log(JSON.stringify(await evaluate(`({boot:true,embedded:!!__qaBoot.reader?.embedded,calls:__qaCalls.length,libraryRows:document.querySelectorAll('.library-card').length})`)));
  assert.ok(await evaluate(`!!__qaBoot.reader?.embedded`), 'Open and activate a book using the embedded corrections reader before running native QA');
  selectedBefore = await evaluate(`Otzaria.call('reader.getDefaultTextReader').then(r=>r.data)`);
  const books = await evaluate(`Otzaria.call('library.findBooks',{query:'בראשית',limit:10}).then(r=>r.data)`);
  assert.ok(Array.isArray(books) && books.length, 'Real host library lookup succeeded');
  console.log(JSON.stringify({libraryLookup: true, bookCount: books.length}));
  if (await evaluate(`!!__qaBoot.reader?.embedded`)) {
    const before = await evaluate(`__qaBoot.reader.currentIndex`);
    originalReaderIndex = before;
    readerSession = activeSession;
    const response = await evaluate(`Otzaria.call('reader.scrollToSection',{sectionIndex:100})`);
    console.log(JSON.stringify({navigationResponse:response}));
    await waitFor(`document.getElementById('section-number').value==='101'`);
    const position = await evaluate(`({section:document.getElementById('section-number').value,events:__qaEvents.length,scrollTop:document.getElementById('book-scroll').scrollTop})`);
    console.log(JSON.stringify({nativeNavigation:position}));
    assert.ok(position.events > 0, 'Real host emitted reader.textReaderNavigate');
    assert.ok(position.scrollTop > 0, 'Host navigation moved the actual reader viewport');
    await waitFor(`__qaCalls.includes('reader.reportTextReaderLocation')`);
    assert.equal(await evaluate(`document.querySelector('.book-navigation').getBoundingClientRect().width`), 0, 'Host supplies embedded navigation');
    assert.equal(await evaluate(`document.getElementById('book-tabs').getBoundingClientRect().height`), 0, 'Embedded reader has no duplicate book tabs');
    await evaluate(`Otzaria.call('reader.scrollToSection',{sectionIndex:${before}})`);
    await waitFor(`document.getElementById('section-number').value===String(${before}+1)`);
  }
  assert.deepEqual(await evaluate(`Otzaria.call('reader.getDefaultTextReader').then(r=>r.data)`), selectedBefore, 'QA preserved reader preference');
  const screenshot = await command('Page.captureScreenshot', { format: 'png' });
  await writeFile('test/browser/otzaria-native-plugin.png', Buffer.from(screenshot.data, 'base64'));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  }
} finally {
  if (readerSession && Number.isInteger(originalReaderIndex)) {
    activeSession = readerSession;
    await evaluate(`Otzaria.call('reader.scrollToSection',{sectionIndex:${originalReaderIndex}})`).catch(error=>console.error('Reader position restore failed:',error));
  }
  for (const targetId of preview ? [] : pluginTargets) {
    activeSession = sessions.get(targetId);
    if (!activeSession) continue;
    await evaluate(`(async()=>{if(!window.__qaCalls)return;const result=await Otzaria.call('storage.list');if(result.success)for(const key of result.data)await Otzaria.call('storage.remove',{key});})()`).catch(error=>console.error('QA storage cleanup failed:',error));
  }
  for (const sessionId of sessions.values()) await command('Fetch.disable', {}, sessionId).catch(()=>{});
  await command('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }, null);
  // Fetch.disable alone does not remove the injected SDK wrapper from a live
  // document. Reload original installed assets so QA cannot affect later use.
  for (const targetId of pluginTargets) {
    const sessionId = sessions.get(targetId);
    if (sessionId) await command('Page.reload', { ignoreCache: true }, sessionId).catch(error=>console.error('Original plugin reload failed:',error));
  }
  socket.close();
  if (preview) { process.off('SIGINT', onStop); process.off('SIGTERM', onStop); }
}
