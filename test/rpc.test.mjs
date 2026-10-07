import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpcCall } from '../plugin/rpc.js';


test('parallel section requests are spaced to satisfy the host rate limiter', async () => {
  let clock = 0;
  const starts = [];
  const call = createRpcCall({ async call() { starts.push(clock); return { success: true, data: clock }; } }, { sleep: async ms => { clock += ms; } });
  await Promise.all(Array.from({ length: 100 }, () => call('reader.getSectionTextMap')));
  assert.equal(starts.length, 100);
  assert.ok(starts.slice(1).every((time, i) => time - starts[i] >= 20));
});
test('rate-limited calls retry with backoff including thrown SDK errors', async () => {
  const waits = []; let attempts = 0;
  const call = createRpcCall({ async call() {
    attempts++;
    if (attempts === 1) throw new Error('Rate limit exceeded');
    if (attempts === 2) return { success: false, error: { code: 'error.rate_limited' } };
    return { success: true, data: 'מקור' };
  } }, { sleep: async ms => { waits.push(ms); } });
  assert.equal(await call('reader.getSectionTextMap'), 'מקור');
  assert.equal(attempts, 3);
  assert.deepEqual(waits.slice(0, 2), [100, 200]);
});
test('permanent permission errors are not retried and do not block later calls', async () => {
  let attempts = 0;
  const call = createRpcCall({ async call() { attempts++; return attempts === 1
    ? { success: false, error: { code: 'error.permission_denied' } } : { success: true, data: 1 }; }
  }, { sleep: async () => {} });
  await assert.rejects(call('library.getBookToc'), /הרשאה/);
  assert.equal(await call('app.getTheme'), 1);
  assert.equal(attempts, 2);
});
