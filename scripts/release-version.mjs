import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile('plugin/manifest.json', 'utf8'));
assert.match(version, /^\d+\.\d+\.\d+$/, 'Release version must be stable SemVer');
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, `v${version}`, 'Tag and plugin version must match');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
console.log(`Plugin version: ${version}`);
