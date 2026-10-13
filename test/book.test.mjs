import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBook, sourceText, MAX_BOOK_BYTES } from '../plugin/book.js';

// Only whitelisted entity tokens reach the inert parser; this stub asserts it.
globalThis.DOMParser = class {
  parseFromString(input, kind) {
    assert.equal(kind, 'text/html');
    assert.match(input, /^<body>&[a-z]+;<\/body>$/);
    const values = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', ndash: '–', mdash: '—', laquo: '«', raquo: '»', middot: '·' };
    return { body: { textContent: values[input.slice(7, -8)] } };
  }
};

function fixture(raw, authoritative = raw.split('\n').map(sourceText)) {
  const calls = [];
  return {
    calls,
    async call(method, args) {
      calls.push({ method, args });
      if (method === 'library.getBookDetails') return { type: 'text', source: 'library', lineCount: authoritative.length, bookUid: 'id:7' };
      if (method === 'library.getBookContent') return raw.slice(args.offset, args.offset + args.limit);
      if (method === 'reader.getSectionTextMap') return { sourceText: authoritative[args.sectionIndex], currentRef: 'ignored' };
      throw new Error(method);
    }
  };
}

test('source stripping matches block spaces, inline joins, host entities and inert content', () => {
  assert.equal(sourceText('מי<b>לה</b><br>סוף&nbsp;&lt;b&gt;&AMP;&unknown;&#x1F600;'), 'מילה סוף <b>&😀');
  assert.equal(sourceText('<img src="https://invalid.test/a">טקסט<script>literal</script>'), 'טקסטliteral');
  assert.equal(sourceText('&#10;&#31;&#1114112;&emsp;'), ' ');
  assert.equal(sourceText('&#12abc;'), '');
});

test('chunks use UTF-16 offsets and reconstruct split surrogate pairs before decoding', async () => {
  const raw = 'א'.repeat(4999) + '😀\n<b>סוף</b>\n';
  const f = fixture(raw);
  const book = await loadBook(f.call, { bookId: 'ספר' });
  assert.equal(book.originalText, 'א'.repeat(4999) + '😀\nסוף\n');
  assert.deepEqual(book.identity, { bookId: 'ספר', bookUid: 'id:7' });
  assert.deepEqual(book.sections.map(s => [s.index, s.start, s.end]), [[0, 0, 5001], [1, 5002, 5005], [2, 5006, 5006]]);
  assert.deepEqual(f.calls.filter(c => c.method === 'library.getBookContent').map(c => c.args.offset), [0, 5000, 10000, 15000, 20000]);
  assert.equal(f.calls.some(c => c.method.includes('Ref')), false);
});

test('embedded DB newlines use authoritative maps rather than shifting section indexes', async () => {
  const f = fixture('first\ninside\nlast', ['first\ninside', 'last']);
  const progress = [];
  const book = await loadBook(f.call, { bookId: 'ספר', bookUid: 'id:7' }, value => progress.push(value));
  assert.equal(book.sections.length, 2);
  assert.deepEqual(book.sections[1], { index: 1, start: 13, end: 17, text: 'last' });
  assert.equal(progress.at(-1).phase, 'done');
});

test('raw source is temporary, requested for reporting only and omitted for ambiguous DB boundaries', async () => {
  const f = fixture('<b>אב</b>\nגד');
  const book = await loadBook(f.call, { bookId: 'ספר' });
  assert.equal('rawLines' in book, false);
  const reportSource = await loadBook(f.call, { bookId: 'ספר' }, undefined, { includeRaw: true });
  assert.deepEqual(reportSource.rawLines, ['<b>אב</b>', 'גד']);
  const ambiguous = fixture('first\ninside\nlast', ['first\ninside', 'last']);
  assert.equal((await loadBook(ambiguous.call, { bookId: 'ספר' }, undefined, { includeRaw: true })).rawLines, null);
});

test('a source disagreement triggers authoritative loading even with matching line count', async () => {
  const f = fixture('file first\nfile last', ['DB first', 'DB last']);
  assert.equal((await loadBook(f.call, { bookId: 'ספר' })).originalText, 'DB first\nDB last');
});

test('a terminal file newline does not trigger mapping every DB section', async () => {
  const lines = Array.from({ length: 1000 }, (_, i) => `פסקה ${i}`);
  const f = fixture(lines.join('\n') + '\n', lines);
  const book = await loadBook(f.call, { bookId: 'ספר' }, undefined, { includeRaw: true });
  assert.equal(book.originalText, lines.join('\n'));
  assert.equal(f.calls.filter(c => c.method === 'reader.getSectionTextMap').length, 2);
  assert.deepEqual(book.rawLines, lines);
});

test('content reads overlap with bounded concurrency and retain chunk order', async () => {
  const raw = 'א'.repeat(22000), f = fixture(raw);
  let active = 0, peak = 0;
  const book = await loadBook(async (method, args) => {
    if (method !== 'library.getBookContent') return f.call(method, args);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, args.offset === 0 ? 15 : 1));
    active--;
    return f.call(method, args);
  }, { bookId: 'ספר' });
  assert.equal(book.originalText, raw);
  assert.ok(peak > 1 && peak <= 4, `concurrent reads: ${peak}`);
});

test('missing section count and nonlibrary books are rejected', async () => {
  await assert.rejects(loadBook(async () => ({ source: 'library', type: 'text' }), { bookId: 'ספר' }));
  await assert.rejects(loadBook(async () => ({ source: 'user', type: 'text' }), { bookId: 'ספר' }));
});

test('content progress updates once per completed batch instead of every ready chunk', async () => {
  const raw = 'a'.repeat(42000), f = fixture(raw), progress = [];
  await loadBook(f.call, { bookId: 'book' }, value => progress.push(value));
  assert.deepEqual(progress.filter(value => value.phase === 'content').map(value => value.loaded), [5000, 25000, 42000]);
});

test('a failed speculative read rejects rather than returning partial book content', async () => {
  const f = fixture('a'.repeat(22000));
  await assert.rejects(loadBook(async (method, args) => {
    if (method === 'library.getBookContent' && args.offset === 15000) throw new Error('host read failed');
    return f.call(method, args);
  }, { bookId: 'book' }), /host read failed/);
  assert.equal(f.calls.some(value => value.method === 'reader.getSectionTextMap'), false);
});

test('canceling a speculative batch rejects promptly even when host reads never settle', async () => {
  const controller = new AbortController(), f = fixture('a'.repeat(22000));
  const pending = loadBook(async (method, args) => {
    if (method === 'library.getBookContent' && args.offset > 0) {
      queueMicrotask(() => controller.abort());
      return new Promise(() => {});
    }
    return f.call(method, args);
  }, { bookId: 'book' }, undefined, { signal: controller.signal });
  await assert.rejects(pending, { name: 'AbortError' });
});

test('a canceled in-flight request stops loading promptly', async () => {
  const controller = new AbortController();
  const pending = loadBook(() => new Promise(() => {}), { bookId: 'ספר' }, undefined, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('UTF-8 byte limit rejects large Hebrew books before section parsing', async () => {
  const raw = 'א'.repeat(MAX_BOOK_BYTES / 2 + 1);
  const f = fixture(raw);
  await assert.rejects(loadBook(f.call, { bookId: 'ספר' }), /10 MB/);
  assert.equal(f.calls.some(c => c.method === 'reader.getSectionTextMap'), false);
});
