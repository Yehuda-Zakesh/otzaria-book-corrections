import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from './build.mjs';
const manifest = JSON.parse(await readFile('plugin/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(pkg.version, manifest.version, 'package and manifest versions must match');
const committed = await readFile('plugin/app.bundle.js', 'utf8');
assert.equal(await build(), committed, 'Run npm run build and commit the generated bundle');
assert.ok(!committed.includes('feedback.submitBookCorrection'), 'main must use only the existing reporting API');
for (const directory of ['plugin', 'scripts', 'test', 'test/browser']) {
  for (const file of await readdir(directory)) {
    if (!/\.(?:js|mjs)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
}
console.log(`Syntax, bundle and version checks passed for ${manifest.version}.`);
