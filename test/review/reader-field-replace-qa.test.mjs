import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderReplacement } from '../../plugin/reader-replace.js';
import { createSessionController } from '../../plugin/correction-sessions.js';
import { createCorrectionStore } from '../../plugin/correction-store.js';
import { createFakeOtzaria, createStorage } from '../fake-otzaria.mjs';

async function fixture({ confirm = () => true, lifetime = 120000, fieldState = () => true } = {}) {
  const host = createFakeOtzaria({ books: { 'id:1': { bookId: 'QA', lines: ['אב אב', 'שמור'] } } }), storage = createStorage();
  const native = host.instance(storage), calls = [], notices = [];
  const tabId = host.openTab('id:1');
  let clock = 0, activeTab = tabId, bookUid = 'id:1', type = 'text', loadGate = null;
  const call = async (method, args = {}) => {
    calls.push({ method, args: structuredClone(args) });
    if (method === 'reader.getCurrentState') return { currentTabId: activeTab, bookUid, currentType: type,
      currentCorrectionSessionId: [...host.sessions.values()].find(s => !s.ended && s.tabId === activeTab)?.sessionId ?? null };
    if (method === 'search.setFieldActionState') return fieldState(args);
    if (method.startsWith('search.')) return true;
    return native(method, args);
  };
  const controller = createSessionController({ call, store: createCorrectionStore(call) });
  const loader = { clears: 0, clear() { this.clears++; }, async load(snapshot) {
    if (loadGate) await loadGate;
    return { identity: { bookUid: snapshot.bookUid }, rawLines: ['אב אב', 'שמור'], sections: [
      { index: 0, text: 'אב אב' }, { index: 1, text: 'שמור' }
    ] };
  } };
  const flow = createReaderReplacement({ call, controller, loader, confirm, notify: text => notices.push(text), now: () => clock, lifetime });
  const event = (text, sessionId = 'field-first') => ({ actionId: 'replace-in-book', field: 'inBook', sessionId, text });
  const prepare = async () => { await flow.invoked(event('אב')); flow.ended({ sessionId: 'field-first', reason: 'edited' }); };
  return { host, controller, flow, calls, notices, loader, event, prepare, tabId,
    setClock: v => { clock = v; }, setContext: (tab, book = 'id:1', kind = 'text') => { activeTab = tab; bookUid = book; type = kind; },
    gateLoad: p => { loadGate = p; }, latest: () => [...host.sessions.values()].find(s => !s.ended) };
}
test('QA native field: two clicks adopt exact query then apply one confirmed draft without reports', async () => {
  const f = await fixture(); await f.prepare();
  await f.flow.invoked(f.event('אם', 'field-second'));
  assert.deepEqual(f.latest().changes.map(c => c.proposedText), ['אם אם']);
  assert.equal(f.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 1);
  assert.equal(f.host.submissions.size, 0);
});
test('QA native field: deletion is explicit and empty replacement remains supported', async () => {
  const f = await fixture(); await f.prepare(); await f.flow.invoked(f.event('', 'second'));
  assert.deepEqual(f.latest().changes.map(c => c.proposedText), [' ']);
});
test('QA native field: an existing correction session and unrelated manual edits are preserved', async () => {
  const f = await fixture(), current = await f.controller.begin(f.tabId);
  f.host.edit(current.sessionId, 1, 'שמור חדש');
  const begins = f.calls.filter(c => c.method === 'reader.beginCorrectionSession').length;
  await f.prepare(); await f.flow.invoked(f.event('אם', 'second'));
  assert.equal(f.calls.filter(c => c.method === 'reader.beginCorrectionSession').length, begins);
  assert.deepEqual(f.latest().changes.map(c => c.proposedText), ['אם אם', 'שמור חדש']);
});
test('QA native field: an ended event from an older lease cannot cancel the current lease', async () => {
  let f;
  f = await fixture({ confirm: () => { f.flow.ended({ sessionId: 'field-first', reason: 'disposed' }); return true; } });
  await f.prepare(); await f.flow.invoked(f.event('אם', 'second'));
  assert.deepEqual(f.latest().changes.map(c => c.proposedText), ['אם אם']);
});
test('QA native field: stop arriving before a queued invocation prevents correction startup', async () => {
  const f = await fixture();
  await f.flow.stop({ actionId: 'replace-in-book', sessionId: 'queued' });
  await f.flow.invoked(f.event('אב', 'queued'));
  assert.equal(f.host.sessions.size, 0);
  assert.equal(f.calls.filter(c => c.method === 'reader.beginCorrectionSession').length, 0);
  // Cancellation belongs to the old lease; a new click is still actionable.
  await f.flow.invoked(f.event('אב', 'fresh'));
  assert.equal(f.host.sessions.size, 1);
});
test('QA native field: a closed field event before queued invocation prevents correction startup', async () => {
  const f = await fixture();
  f.flow.ended({ actionId: 'replace-in-book', sessionId: 'closed-before-run', reason: 'disposed' });
  await f.flow.invoked(f.event('אב', 'closed-before-run'));
  assert.equal(f.host.sessions.size, 0);
  assert.equal(f.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
});
test('QA native field: stopping a queued second phase clears the previously remembered query', async () => {
  const f = await fixture(); await f.prepare();
  await f.flow.stop({ actionId: 'replace-in-book', sessionId: 'queued-second' });
  await f.flow.invoked(f.event('אם', 'queued-second'));
  await f.flow.invoked(f.event('חיפוש חדש', 'fresh-after-cancel'));
  assert.equal(f.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
  assert.equal(f.latest().changes.length, 0);
});
test('QA native field: editing before phase-one state update keeps the remembered search for a new lease', async () => {
  let f, first = true;
  f = await fixture({ fieldState: () => {
    if (first) {
      first = false;
      f.flow.ended({ actionId: 'replace-in-book', sessionId: 'field-first', reason: 'edited' });
      throw Object.assign(new Error('field already ended'), { code: 'error.not_found' });
    }
    return true;
  } });
  await f.flow.invoked(f.event('אב'));
  await f.flow.invoked(f.event('אם', 'new-lease'));
  assert.deepEqual(f.latest().changes.map(c => c.proposedText), ['אם אם']);
  assert.equal(f.calls.filter(c => c.method === 'reader.beginCorrectionSession').length, 1);
});
test('QA native field: same wording refuses and declining final confirmation never restores', async () => {
  const f = await fixture(); await f.prepare();
  await assert.rejects(f.flow.invoked(f.event('אב', 'second')), /זהה/);
  assert.equal(f.latest().changes.length, 0);
  const g = await fixture({ confirm: () => false }); await g.prepare(); await g.flow.invoked(g.event('אם', 'second'));
  assert.equal(g.latest().changes.length, 0);
  assert.equal(g.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
});
for (const change of ['tab', 'book', 'ttl', 'correction-session']) {
  test(`QA native field: changed ${change} invalidates remembered query before any restore`, async () => {
    const f = await fixture(); await f.prepare();
    if (change === 'tab') f.setContext(f.host.openTab('id:1'));
    if (change === 'book') f.setContext(f.tabId, 'id:2');
    if (change === 'ttl') f.setClock(120001);
    if (change === 'correction-session') f.host.endByUser(f.latest().sessionId);
    await assert.rejects(f.flow.invoked(f.event('אם', 'second')), /השתנו|זמן/);
    assert.equal(f.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
  });
}
test('QA native field: a closed lease during loading cancels the pending application', async () => {
  const f = await fixture(); await f.prepare();
  let release; f.gateLoad(new Promise(resolve => { release = resolve; }));
  const pending = f.flow.invoked(f.event('אם', 'second'));
  await new Promise(resolve => setTimeout(resolve, 0));
  f.flow.ended({ sessionId: 'second', reason: 'disposed' }); release();
  await assert.rejects(pending, /בוטלה/);
  assert.equal(f.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
});
test('QA native field: field edit during confirmation and reader revision races cannot overwrite edits', async () => {
  let f;
  f = await fixture({ confirm: () => { f.flow.ended({ sessionId: 'second', reason: 'edited' }); return true; } });
  await f.prepare(); await assert.rejects(f.flow.invoked(f.event('אם', 'second')), /בוטלה/);
  assert.equal(f.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
  let g;
  g = await fixture({ confirm: () => { g.host.edit(g.latest().sessionId, 0, 'הקלדה חדשה'); return true; } });
  await g.prepare(); await assert.rejects(g.flow.invoked(g.event('אם', 'second')), { code: 'error.revision_conflict' });
  assert.deepEqual(g.latest().changes.map(c => c.proposedText), ['הקלדה חדשה']);
});
test('QA native field: book switches during confirmation and source changes remain atomic', async () => {
  let f;
  f = await fixture({ confirm: () => { f.setContext('different'); return true; } }); await f.prepare();
  await assert.rejects(f.flow.invoked(f.event('אם', 'second')), /השתנו/);
  assert.equal(f.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
  let g;
  g = await fixture({ confirm: () => { g.host.books['id:1'].lines[0] = 'מקור אחר'; return true; } }); await g.prepare();
  await assert.rejects(g.flow.invoked(g.event('אם', 'second')), { code: 'error.source_changed' });
  assert.equal(g.latest().changes.length, 0);
});
test('QA native field: stop cancels and unrelated fields never begin correction sessions', async () => {
  const f = await fixture();
  await f.flow.invoked({ ...f.event('אב'), field: 'fullText' }); assert.equal(f.host.sessions.size, 0);
  await f.flow.invoked(f.event('אב')); await f.flow.stop({ sessionId: 'field-first' });
  await f.flow.invoked(f.event('מילה', 'new'));
  assert.equal(f.calls.filter(c => c.method === 'reader.restoreCorrectionDraft').length, 0);
});
