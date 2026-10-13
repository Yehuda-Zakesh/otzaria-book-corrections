import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from './build.mjs';
const manifest = JSON.parse(await readFile('plugin/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(pkg.version, manifest.version, 'package and manifest versions must match');
const committed = await readFile('plugin/app.bundle.js', 'utf8');
assert.equal(await build(), committed, 'Run npm run build and commit the generated bundle');
assert.ok(committed.includes("'network.fetchStream'"), 'reports use the 0.9.98 streaming network API');
assert.ok(!committed.includes('feedback.submitBookCorrection'), 'the 0.9.99 submission API must not be used by the compatibility build');
assert.ok(!/reader.(?:begin|get|restore|reset|end)CorrectionSession|reader.restoreCorrectionDraft|reader.resetCorrection/.test(committed), 'main must not use the unapproved reader session API');
assert.ok(manifest.permissions.includes('network.access') && manifest.network?.enabled, 'direct reports require declared network access');
assert.deepEqual(manifest.network.allowlist, ['https://otzaria.org/api/reportingerrors'], 'network access is restricted to report intake');
assert.ok(!manifest.permissions.includes('feedback.send_email'), 'direct reports do not use the mailto permission');
assert.equal(manifest.minAppVersion, '0.9.98', 'the compatibility build supports the released 0.9.98');
for (const directory of ['plugin', 'scripts', 'test', 'test/browser']) {
  for (const file of await readdir(directory)) {
    if (!/\.(?:js|mjs)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
}
console.log(`Syntax, bundle and version checks passed for ${manifest.version}.`);
