import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics, LOG_PREFIX } from '../../plugin/diagnostics.js';
import { createStorage, createFakeOtzaria, plugin, waitFor } from './page-harness.mjs';

function fixture(options = {}) {
  const storage = createStorage(), files = new Map(), calls = [];
  let fsFailed = false;
  const raw = async (method, args = {}) => {
    calls.push({ method, args: structuredClone(args) });
    if (!method.startsWith('fs.')) return storage.call(method, args);
    if (fsFailed) throw Object.assign(new Error('PRIVATE file content'), { code: 'error.denied' });
    if (method === 'fs.writeFile') { files.set(args.path, args.content); return true; }
    if (method === 'fs.readFile') return { content: files.get(args.path) };
    // Native deleteFile handles granted external paths; plugin workspace uses deleteEntry.
    if (method === 'fs.deleteFile') throw Object.assign(new Error('outside granted folder'), { code: 'error.forbidden' });
    if (method === 'fs.deleteEntry') return files.delete(args.path);
    if (method === 'fs.listDir') return { entries: [...files].map(([path, content]) => ({ path, type: 'file', size: content.length })) };
    throw new Error(method);
  };
  const create = extra => createDiagnostics(raw, { id: 'qa', now: () => 1000, schedule: () => 1, cancel() {}, ...options, ...extra });
  return { storage, files, calls, raw, create, failFiles: () => { fsFailed = true; } };
}
const secrets = 'PRIVATE book text alice@example.com';

test('QA diagnostics: payload, email, result text and error messages never persist or export', async () => {
  const f = fixture(), d = f.create(); await d.start();
  d.record('ui.action', { text: secrets, email: secrets, args: { details: secrets }, count: 3 });
  const wrapped = d.wrap(async () => ({ text: secrets, changes: [{ proposedText: secrets }], reporterEmail: secrets }));
  await wrapped('reader.getCorrectionSession', { details: secrets, reporterEmail: secrets });
  const error = Object.assign(new Error(secrets), { code: 'error.internal', stack: secrets });
  await assert.rejects(d.wrap(async () => { throw error; })('feedback.report', { details: secrets }), e => e === error);
  d.error('operation.error', error);
  await d.flush();
  for (const output of [await d.exportText(), await d.reportDetails('User description'), ...f.files.values(), JSON.stringify([...f.storage.data])]) {
    assert(!output.includes(secrets)); assert(!output.includes('alice@example.com'));
  }
  assert.match(await d.exportText(), /error.internal/);
});
test('QA diagnostics: unsafe RPC method is sanitized in counters and entries; counters are bounded', async () => {
  const f = fixture(), d = f.create({ maxEntries: 4 }); await d.start();
  const wrapped = d.wrap(async () => true);
  await wrapped(secrets, null);
  for (let i = 0; i < 150; i++) await wrapped(`reader.method${i}`);
  const exported = JSON.parse(await d.exportText()), current = exported.instances[0];
  assert(!JSON.stringify(exported).includes(secrets));
  assert(current.entries.length <= 4);
  assert(Object.keys(current.counters).length <= 101);
});
test('QA diagnostics: previous malformed timestamps and fields cannot break developer report', async () => {
  const f = fixture();
  f.storage.data.set(LOG_PREFIX + 'old', { schema: 1, id: 'old', updatedAt: 1e100,
    entries: [{ at: 1e100, event: 'rpc.error', details: secrets, code: 'error.old' }, null, { at: -Infinity, event: secrets }] });
  const d = f.create(); await d.start();
  const output = await d.reportDetails('User description');
  assert.match(output, /error.old/); assert(!output.includes(secrets));
  assert(output.length <= 5000);
});
test('QA diagnostics: restart retains logs and pruning keeps storage and file mirrors bounded', async () => {
  const f = fixture({ maxInstances: 3 });
  for (let i = 0; i < 7; i++) { const d = f.create({ id: `run${i}`, now: () => i + 1 }); await d.start(); d.record('operation.error', { count: i }); await d.flush(); }
  assert.equal([...f.storage.data.keys()].filter(k => k.startsWith(LOG_PREFIX)).length, 3);
  assert.equal(f.files.size, 3);
  const latest = f.create({ id: 'run6' });
  const data = JSON.parse(await latest.exportText());
  assert(data.instances.some(r => r.id === 'run5'));
  assert(!data.instances.some(r => r.id === 'run0'));
});
test('QA diagnostics: full-length user description survives bounded reports with many errors', async () => {
  const f = fixture(), d = f.create(); await d.start();
  for (let i = 0; i < 350; i++) d.record('rpc.error', { code: 'error.limit', count: i });
  const details = 'א'.repeat(3000), output = await d.reportDetails(details);
  assert(output.startsWith(details)); assert(output.length <= 5000); assert.match(output, /Plugin diagnostics/);
  assert.equal(JSON.parse(await d.exportText()).instances[0].entries.length, 250);
  await assert.rejects(d.reportDetails(details + 'א'), /3,000/);
});
test('QA diagnostics: storage and filesystem failures never replace RPC success or original error', async () => {
  const f = fixture(), d = f.create(); f.storage.failSet = true; f.failFiles();
  await d.start();
  assert.equal(await d.wrap(async () => 42)('reader.getCurrentState'), 42);
  const error = new Error('original');
  await assert.rejects(d.wrap(async () => { throw error; })('reader.getCorrectionSession'), e => e === error);
  const output = await d.reportDetails('User description');
  assert.match(output, /persistenceFailed=true/);
  assert.equal(JSON.parse(await d.exportText()).filesAvailable, false);
});
test('QA diagnostics: files reject traversal and sanitize old on-disk content', async () => {
  const f = fixture(), d = f.create(); await d.start();
  f.files.set('logs/old.json', JSON.stringify({ id: 'old', password: secrets,
    entries: [{ at: 1e100, event: 'rpc.error', details: secrets, code: 'error.old' }] }));
  f.files.set('../profile.json', secrets);
  assert(!(await d.files()).some(f => f.path.includes('..')));
  await assert.rejects(d.readFile('../profile.json'), /Invalid log path/);
  const read = await d.readFile('logs/old.json');
  assert(!read.includes(secrets)); assert.equal(JSON.parse(read).entries[0].at, 0);
});
test('QA diagnostics: orphan file pruning ignores unrelated files and keeps current mirror', async () => {
  const f = fixture({ maxInstances: 3 });
  for (let i = 0; i < 9; i++) f.files.set(`logs/orphan${i}.json`, '{}');
  f.files.set('logs/keep.txt', secrets);
  const d = f.create(); await d.start();
  assert.equal((await d.files()).length, 3);
  assert(f.files.has('logs/qa.json')); assert(f.files.has('logs/keep.txt'));
});
test('QA diagnostics: stack records only bundle frame coordinates', async () => {
  const f = fixture(), d = f.create(); await d.start();
  const e = new Error(secrets); e.stack = `${secrets}\n at fn (app.bundle.js:123:45)\n at ${secrets}`;
  d.error('operation.error', e);
  const text = await d.exportText();
  assert.match(text, /123:45/); assert(!text.includes(secrets));
});
test('QA diagnostics: serialized flush retains events added during an outstanding write', async () => {
  const f = fixture(); let release, began;
  const pendingWrite = new Promise(resolve => { began = resolve; });
  let block = false;
  const d = createDiagnostics(async (method, args) => {
    if (method === 'storage.set' && block) { block = false; began(); await new Promise(resolve => { release = resolve; }); }
    return f.raw(method, args);
  }, { id: 'qa', now: () => 1000, schedule: () => 1, cancel() {} });
  await d.start(); block = true; d.record('before.write');
  const first = d.flush(); await pendingWrite;
  d.record('during.write'); const second = d.flush(); release();
  await Promise.all([first, second]);
  assert(f.storage.data.get(LOG_PREFIX + 'qa').entries.some(e => e.event === 'during.write'));
  assert.match(f.files.get('logs/qa.json'), /during.write/);
});
test('QA diagnostics page: log viewer and developer report include sanitized logs without book submission', async () => {
  const host = createFakeOtzaria(), storage = createStorage(), reports = [];
  const page = await plugin({ host, storage, sdkOverrides: {
    'feedback.hasReporterEmail': () => true,
    'feedback.report': args => { reports.push(structuredClone(args)); return 'cancelled'; },
    'fs.writeFile': () => true, 'fs.listDir': () => ({ entries: [] })
  } });
  await waitFor(() => page.rpcCalls.some(c => c.method === 'reader.getCurrentState') && !page.el('refresh').disabled, 'initialized');
  page.el('nav-report').click();
  await waitFor(() => page.rpcCalls.some(c => c.method === 'feedback.hasReporterEmail') && !page.el('refresh').disabled, 'report');
  page.el('report-details').value = secrets;
  page.el('report-logs').click();
  await waitFor(() => !page.el('screen-logs').hidden && page.el('log-content').value, 'logs visible');
  assert(!page.el('log-content').value.includes(secrets));
  page.el('logs-back').click(); page.el('report-send').click();
  await waitFor(() => reports.length === 1 && !page.el('report-details').disabled, 'cancelled report');
  assert(reports[0].details.startsWith(secrets)); assert.match(reports[0].details, /Plugin diagnostics/);
  assert(reports[0].details.length <= 5000); assert.equal(page.el('report-details').value, secrets);
  assert.equal(host.submissions.size, 0);
  assert(!JSON.stringify([...storage.data]).includes(secrets));
});
test('QA diagnostics page: a stuck log mirror never blocks the next user operation', async () => {
  const host = createFakeOtzaria(), storage = createStorage();
  let blockWrites = false, release, blocked = false;
  const stuck = new Promise(resolve => { release = resolve; });
  const page = await plugin({ host, storage, sdkOverrides: {
    'fs.writeFile': () => {
      if (!blockWrites) return true;
      blocked = true; return stuck;
    },
    'fs.listDir': () => ({ entries: [] })
  } });
  await waitFor(() => page.rpcCalls.some(c => c.method === 'reader.getCurrentState') && !page.el('refresh').disabled, 'initial startup finished');
  const states = () => page.rpcCalls.filter(c => c.method === 'reader.getCurrentState').length;
  try {
    blockWrites = true;
    page.el('refresh').click();
    await waitFor(() => blocked && !page.el('refresh').disabled, 'first refresh reached blocked mirror');
    const before = states();
    page.el('refresh').click();
    await waitFor(() => states() > before, 'second refresh runs while mirror is unresolved');
    assert(blocked);
  } finally { blockWrites = false; release(true); }
});
