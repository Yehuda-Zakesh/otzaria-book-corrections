import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { build } from './build.mjs';
const manifest = JSON.parse(await readFile('plugin/manifest.json', 'utf8'));
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
assert.equal(pkg.version, manifest.version, 'package and manifest versions must match');
const committed = await readFile('plugin/app.bundle.js', 'utf8');
assert.equal(await build(), committed, 'Run npm run build and commit the generated bundle');
// Compatibility policy of the 0.3 line (Otzaria 0.9.99, PR #2311 contract).
// The 0.2.x line for the released 0.9.98 stays on main and is not changed here.
assert.equal(manifest.minAppVersion, '0.9.99', 'the correction session and draft API requires Otzaria 0.9.99');
for (const method of ['reader.beginCorrectionSession', 'reader.getCorrectionSession', 'reader.endCorrectionSession',
  'reader.acknowledgeCorrectionDraft', 'reader.listCorrectionDrafts', 'reader.getCorrectionDraft', 'feedback.submitBookCorrection']) {
  assert.ok(committed.includes(`'${method}'`), `the native correction flow uses ${method}`);
}
assert.ok(committed.includes('requireTextCorrection: true'), 'structured corrections never fall back to free text silently');
assert.ok(!committed.includes('network.fetchStream'), 'reports go through Otzaria, not a direct network request');
assert.ok(!manifest.permissions.includes('network.access') && !manifest.network, 'no direct network access is requested');
for (const permission of ['reader.local_edit', 'reader.open', 'feedback.send_email', 'reader.context_menu']) {
  assert.ok(manifest.permissions.includes(permission), `manifest requests ${permission}`);
}
// A reader click must not switch to the plugin page; a background instance
// (app.run_on_startup) receives it while the user stays in the book.
assert.ok(manifest.permissions.includes('app.run_on_startup'), 'reader clicks wake a background instance');
for (const item of [...manifest.contributes.startup.toolbarItems, ...manifest.contributes.startup.contextMenuItems]) {
  assert.notEqual(item.openPlugin, true, `${item.id} must not open the plugin page`);
}
assert.ok(manifest.contributes.startup.contextMenuItems.some(item => item.contexts.includes('reader-book')),
  'the reader menu without a selection carries the exact tabId (0.9.99)');
// Pending proposals are marked in the reader; the host keeps highlights only
// while an instance lives, so a background engine redraws them, and it wakes
// only while the setting is on and something is pending.
assert.ok(manifest.permissions.includes('reader.highlight'), 'reader marks need reader.highlight');
const activation = manifest.contributes.startup.activationEvents ?? [];
for (const topic of ['app.startup', 'reader.current_ref_changed']) {
  const event = activation.find(entry => entry.topic === topic);
  assert.ok(event?.when, `${topic} wakes the engine only under a condition`);
  assert.ok(JSON.stringify(event.when).includes('"markPendingInReader"') && JSON.stringify(event.when).includes('"readerMarksPending"'), `${topic} respects the marks setting`);
}
assert.ok(manifest.permissions.includes('events.subscribe:reader.current_ref_changed'), 'reading wakes the engine to redraw marks');
assert.ok(!manifest.contributes.startup.keepAlive || manifest.permissions.includes('app.background_keep_alive'), 'keepAlive is declared with its permission');
// Acknowledge only after the plugin copy was saved (contract: "save before acknowledge").
const keep = committed.slice(committed.indexOf('async function keep('), committed.indexOf('async function latest('));
assert.ok(keep.indexOf('store.saveVersion') > 0 && keep.indexOf('store.saveVersion') < keep.indexOf('acknowledge('), 'save precedes acknowledge');
for (const directory of ['plugin', 'scripts', 'test', 'test/browser', 'test/review']) {
  for (const file of await readdir(directory)) {
    if (!/\.(?:js|mjs)$/.test(file)) continue;
    const result = spawnSync(process.execPath, ['--check', `${directory}/${file}`], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
}
console.log(`Syntax, bundle and compatibility checks passed for ${manifest.version} (Otzaria ${manifest.minAppVersion}).`);
