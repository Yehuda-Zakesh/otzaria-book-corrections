import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('manifest requires Otzaria 0.9.98.2, keeps the reader search button and needs no network', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../plugin/manifest.json', import.meta.url), 'utf8'));
  // 0.9.98.2 is the first release whose validator accepts searchFieldActions
  // (0.9.98.1 gate) and whose host has the correction session/draft APIs.
  assert.equal(manifest.minAppVersion, '0.9.98.2');
  assert(manifest.contributes?.startup?.searchFieldActions.some(action => action.id === 'replace-in-book'));
  assert(manifest.permissions.includes('search.field_actions'));
  // Without network.enabled Otzaria keeps the tool available in offline mode.
  assert.equal(manifest.network?.enabled ?? false, false);
  assert(!manifest.permissions.some(permission => permission.startsWith('network.')));
});
