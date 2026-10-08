import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitFor(predicate, description, timeout = 10000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${description}`);
    await delay(10);
  }
}
