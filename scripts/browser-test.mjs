import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const candidates = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : process.platform === 'win32'
  ? [join(process.env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe')]
  : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Chrome was not found. Set CHROME_PATH to the browser executable.');
const profile = await mkdtemp(join(tmpdir(), 'book-corrections-qa-'));
const browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
  '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,900', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let child, launchError;
browser.on('error', error => { launchError = error; });
try {
  let port;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw new Error(`Chrome exited before startup (${browser.exitCode}).`);
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break; } catch {}
    await delay(100);
  }
  if (!port) throw new Error('Chrome did not start within 15 seconds.');
  child = spawn(process.execPath, ['test/browser/smoke.mjs'], { env: { ...process.env, CDP_PORT: String(port) }, stdio: 'inherit', windowsHide: true });
  const timeout = setTimeout(() => child.kill(), 120000);
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
  clearTimeout(timeout);
  if (result !== 0) throw new Error(`Browser QA failed (${result ?? 'timeout'}).`);
} finally {
  child?.kill(); browser.kill();
  // Chromium may still be releasing its profile locks on Windows.
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
