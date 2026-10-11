import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from './build.mjs';
const manifest = JSON.parse(await readFile('plugin/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(pkg.version, manifest.version, 'package and manifest versions must match');
const committed = await readFile('plugin/app.bundle.js', 'utf8');
assert.equal(await build(), committed, 'Run npm run build and commit the generated bundle');
assert.ok(committed.includes('feedback.submitBookCorrection'), 'reports are sent through the approved Otzaria API');
assert.ok(!/reader.(?:begin|get|restore|reset|end)CorrectionSession|reader.restoreCorrectionDraft|reader.resetCorrection/.test(committed), 'main must not use the unapproved reader session API');
assert.ok(!manifest.permissions.includes('network.access') && !manifest.network?.enabled, 'Otzaria sends the reports, so no network access is declared');
assert.equal(manifest.minAppVersion, '0.9.99', 'feedback.submitBookCorrection requires Otzaria 0.9.99');
for (const directory of ['plugin', 'scripts', 'test', 'test/browser']) {
  for (const file of await readdir(directory)) {
    if (!/\.(?:js|mjs)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
}
console.log(`Syntax, bundle and version checks passed for ${manifest.version}.`);
