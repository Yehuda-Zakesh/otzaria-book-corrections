import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('requested custom host manifest keeps minimum 0.9.98 and the reader search button', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../plugin/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.minAppVersion, '0.9.98');
  assert(manifest.contributes?.startup?.searchFieldActions.some(action => action.id === 'replace-in-book'));
  assert(manifest.permissions.includes('search.field_actions'));
  // This checks the requested declaration, not installation acceptance. The
  // native validator's 0.9.99 gate must be aligned in the user's custom host.
});
