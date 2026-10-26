// Deliberately records metadata only. Never pass RPC arguments, book text,
// report wording or arbitrary exception messages into the persisted log.
import { reportSha256 } from './report-digest.js';
export const LOG_PREFIX = 'logs:v1:';
export function createDiagnostics(rawCall, { now = () => Date.now(),
  id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = handle => clearTimeout(handle),
  maxEntries = 250, maxInstances = 6 } = {}) {
  id = typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id) ? id : 'runtime';
  const key = LOG_PREFIX + id;
  const entries = [], counters = new Map();
  let started = false, timer = null, writing = Promise.resolve(), sequence = 0, persistenceFailed = false, filesAvailable = true;
  const validTime = value => Number.isFinite(value) && Math.abs(value) <= 8640000000000000;
  const token = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
  const fields = new Set(['method', 'request', 'attempt', 'code', 'name', 'status', 'durationMs', 'delayMs',
    'revision', 'version', 'sectionIndex', 'changes', 'conflicts', 'count', 'bytes', 'offset', 'length',
    'background', 'embedded', 'saved', 'persisted', 'confirmed', 'success', 'screen', 'reason', 'frame', 'book', 'session']);
  const reference = value => typeof value === 'string' ? reportSha256(value).slice(0, 12) : undefined;
  const frame = error => typeof error?.stack === 'string' ?
    [...error.stack.matchAll(/app\.bundle\.js:(\d+):(\d+)/g)].slice(0, 4).map(m => `${m[1]}:${m[2]}`).join('_') : undefined;
  function clean(data) {
    const result = {};
    for (const [field, value] of Object.entries(data ?? {})) {
      if (!fields.has(field)) continue;
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) result[field] = value;
      else if (token(value)) result[field] = value;
    }
    return result;
  }
  function add(event, data, persist = true) {
    entries.push({ at: now(), event: token(event) ?? 'unknown', ...clean(data) });
    while (entries.length > maxEntries) {
      const isError = e => /error|failed/.test(e.event);
      const keepErrors = entries.filter(isError).length <= Math.min(20, maxEntries);
      const discard = keepErrors ? entries.findIndex(e => !isError(e)) : 0;
      entries.splice(discard < 0 ? 0 : discard, 1);
    }
    if (persist && started && timer === null) timer = schedule(() => { timer = null; api.flush(); }, 800);
  }
  function summary(value) {
    if (!value || typeof value !== 'object') return typeof value === 'string' ? { status: token(value) } : {};
    return clean({ revision: value.revision, version: value.version ?? value.draft?.version,
      changes: value.changes?.length, conflicts: (value.conflicts ?? value.draft?.conflicts)?.length,
      count: Array.isArray(value) ? value.length : undefined, saved: value.saved,
      book: reference(value.bookUid), session: reference(value.sessionId),
      persisted: value.draft?.persisted, confirmed: value.confirmed, status: value.status,
      length: typeof value.text === 'string' ? value.text.length : undefined });
  }
  async function records() {
    const all = [ { schema: 1, id, entries: [...entries], counters: Object.fromEntries(counters), updatedAt: now() } ];
    try {
      const keys = await rawCall('storage.list');
      for (const other of (Array.isArray(keys) ? keys : []).filter(k => typeof k === 'string' && k.startsWith(LOG_PREFIX) && k !== key).slice(-maxInstances)) {
        const value = await rawCall('storage.get', { key: other });
        if (value?.schema === 1 && Array.isArray(value.entries)) {
          // Re-sanitize persisted values, including logs written by an older build.
          all.push({ id: token(value.id) ?? 'previous', entries: value.entries.slice(-maxEntries).map(e =>
            ({ at: validTime(e?.at) ? e.at : 0, event: token(e?.event) ?? 'unknown', ...clean(e) })) });
        }
      }
    } catch { persistenceFailed = true; }
    return all;
  }
  const api = {
    record: add,
    error(event, error) { add(event, { code: token(error?.code) ?? 'unknown', name: token(error?.name) ?? 'Error', frame: frame(error) }); },
    async start() {
      if (started) return;
      started = true;
      try {
        const listed = await rawCall('storage.list');
        const keys = (Array.isArray(listed) ? listed : []).filter(k => typeof k === 'string' && k.startsWith(LOG_PREFIX) && k !== key);
        const older = [];
        for (const other of keys) {
          const value = await rawCall('storage.get', { key: other });
          if (value?.schema === 1 && Array.isArray(value.entries)) older.push({ key: other, at: validTime(value.updatedAt) ? value.updatedAt : 0 });
        }
        older.sort((a, b) => b.at - a.at);
        for (const item of older.slice(maxInstances - 1)) {
          await rawCall('storage.remove', { key: item.key });
          const oldId = item.key.slice(LOG_PREFIX.length);
          if (/^[a-zA-Z0-9_-]{1,80}$/.test(oldId)) {
            try { await rawCall('fs.deleteEntry', { path: `logs/${oldId}.json` }); } catch { /* Optional mirror. */ }
          }
        }
      } catch { persistenceFailed = true; }
      try {
        const listed = await rawCall('fs.listDir', { path: 'logs' });
        const previous = (listed?.entries ?? []).filter(e => e?.type === 'file' &&
          /^logs\/[a-zA-Z0-9_-]{1,80}\.json$/.test(e.path) && e.path !== `logs/${id}.json`);
        previous.sort((a, b) => (Date.parse(b.modified) || 0) - (Date.parse(a.modified) || 0));
        for (const file of previous.slice(maxInstances - 1)) await rawCall('fs.deleteEntry', { path: file.path });
      } catch { /* Folder may not exist until the first flush. */ }
      add('runtime.start', { success: !persistenceFailed });
      await api.flush();
    },
    wrap(invoke) {
      return async (method, args = {}, options) => {
        const request = ++sequence, at = now();
        const safeMethod = token(method) ?? 'unknown';
        const counterKey = counters.has(safeMethod) || counters.size < 100 ? safeMethod : 'other';
        counters.set(counterKey, (counters.get(counterKey) ?? 0) + 1);
        // Frequent state reloads must not erase the failure being diagnosed.
        // Counts still include successful storage reads; their errors remain detailed.
        const quiet = method === 'storage.get' || method === 'storage.list';
        if (!quiet) add('rpc.start', { method: safeMethod, request, book: reference(args?.bookUid), session: reference(args?.sessionId),
          sectionIndex: args?.sectionIndex, offset: args?.offset, length: args?.length });
        try {
          const result = await invoke(method, args, options);
          if (!quiet) add('rpc.ok', { method: safeMethod, request, durationMs: now() - at, ...summary(result) });
          return result;
        } catch (error) {
          add('rpc.error', { method: safeMethod, request, durationMs: now() - at, code: token(error?.code) ?? 'unknown', name: token(error?.name) ?? 'Error', frame: frame(error) });
          api.flush();
          throw error;
        }
      };
    },
    flush() {
      if (timer !== null) { cancel(timer); timer = null; }
      if (!started) return Promise.resolve();
      // Take the snapshot when the serialized write runs, so an older flush
      // can never overwrite a newer one. Logging failures never break editing.
      writing = writing.then(async () => {
        const value = { schema: 1, id, updatedAt: now(), entries: [...entries], counters: Object.fromEntries(counters) };
        try {
          await rawCall('storage.set', { key, value });
          persistenceFailed = false;
        } catch { persistenceFailed = true; add('log.persist_failed', {}, false); }
        if (filesAvailable) {
          try { await rawCall('fs.writeFile', { path: `logs/${id}.json`, content: JSON.stringify(value, null, 2) }); }
          catch (error) { filesAvailable = false; add('log.file_unavailable', { code: token(error?.code) ?? 'unknown' }, false); }
        }
      });
      return writing;
    },
    async exportText() {
      await api.flush();
      return JSON.stringify({ plugin: 'book-corrections', version: '0.3.1', schema: 1,
        persistenceFailed, filesAvailable, instances: await records() }, null, 2);
    },
    async files() {
      await api.flush();
      try {
        const result = await rawCall('fs.listDir', { path: 'logs' });
        return (result?.entries ?? []).filter(e => e?.type === 'file' && /^logs\/[a-zA-Z0-9_-]{1,80}\.json$/.test(e.path))
          .map(e => ({ path: e.path, size: e.size }));
      } catch { return []; }
    },
    async readFile(path) {
      if (!/^logs\/[a-zA-Z0-9_-]{1,80}\.json$/.test(path)) throw new Error('Invalid log path');
      // The sanitized export is used for display even if older files contained
      // fields that newer builds no longer record.
      const result = await rawCall('fs.readFile', { path });
      const value = JSON.parse(result.content);
      return JSON.stringify({ schema: 1, id: token(value.id), entries: (Array.isArray(value.entries) ? value.entries : [])
        .slice(-maxEntries).map(e => ({ at: validTime(e?.at) ? e.at : 0, event: token(e?.event) ?? 'unknown', ...clean(e) })) }, null, 2);
    },
    async reportDetails(details) {
      if (details.length > 3000) throw new Error('תוכן הדיווח יכול להכיל עד 3,000 תווים, כדי להשאיר מקום ללוגים.');
      await api.flush();
      const all = await records();
      const counts = [...counters].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m, count]) => `${m}=${count}`).join(',');
      const header = `\n\n--- Plugin diagnostics v1 / book-corrections 0.3.1 ---\ninstance=${id}; persistenceFailed=${persistenceFailed}; filesAvailable=${filesAvailable}\nRPC counts: ${counts}\n`;
      const recent = all.flatMap(r => r.entries.map(e => ({ ...e, instance: r.id }))).sort((a, b) => a.at - b.at);
      const errors = recent.filter(e => /error|failed/.test(e.event)).slice(-3);
      let output = details + header;
      const append = entry => `${new Date(entry.at).toISOString()} ${JSON.stringify(entry)}\n`;
      for (const entry of errors) { const line = append(entry); if (output.length + line.length < 4800) output += line; }
      let tail = '';
      for (const entry of recent.slice(-40).reverse()) {
        if (errors.includes(entry)) continue;
        const line = append(entry);
        if (output.length + tail.length + line.length > 4950) break;
        tail = line + tail;
      }
      return output + tail;
    }
  };
  return api;
}
