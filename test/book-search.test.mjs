import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findInBook, createBookSearch, createAsyncBookSearch } from '../plugin/book-search.js';
import vm from 'node:vm';

test('Hebrew nikud and cantillation are ignored while original ranges retain them', () => {
  const text = 'פתיח שָׁל֣וֹםָ סוף';
  const [match] = findInBook(text, 'שלום');
  assert.equal(match.offset, 5);
  assert.equal(text.slice(match.offset, match.end), 'שָׁל֣וֹםָ');
  assert.equal(findInBook(text, 'שָׁלוֹם').length, 1);
});
test('emoji and accented characters retain UTF-16 offsets', () => {
  const text = '😀 Café שָׁלוֹם 😃';
  const [hebrew] = findInBook(text, 'שלום');
  assert.equal(hebrew.offset, 8);
  assert.equal(text.slice(hebrew.offset, hebrew.end), 'שָׁלוֹם');
  const [emoji] = findInBook(text, '😃');
  assert.equal(emoji.end - emoji.offset, 2);
  assert.equal(findInBook(text, 'CAFÉ')[0].offset, 3);
});
test('repeated matches are non-overlapping and limited', () => {
  assert.deepEqual(findInBook('אב אב אב', 'אב', { limit: 2 }).map(hit => hit.offset), [0, 3]);
  assert.equal(findInBook('aaaa', 'aa').length, 2);
  assert.deepEqual(findInBook('אב', 'אב', { limit: 0 }), []);
  assert.deepEqual(findInBook('אב', 'אב', { limit: 0.5 }), []);
});
test('punctuation is literal and never a regular expression', () => {
  const [match] = findInBook('start [a.*]+? end', '[a.*]+?');
  assert.equal(match.offset, 6);
  assert.equal(findInBook('aaa', 'a.*').length, 0);
});
test('blank and mark-only queries have no matches', () => {
  for (const query of ['', ' ', '\n', '\u05b8\u0591']) assert.deepEqual(findInBook('אב', query), []);
});
test('spaces and newlines match exactly', () => {
  assert.equal(findInBook('אב\nגד אב גד', 'אב גד')[0].offset, 6);
  assert.equal(findInBook('אב\nגד אב גד', 'אב\nגד')[0].offset, 0);
  assert.equal(findInBook('אב  גד', 'אב גד').length, 0);
});
test('snippets cap Unicode context and preserve literal HTML as text', () => {
  const text = '😀'.repeat(100) + '<script>אב</script>' + '😃'.repeat(100);
  const [match] = findInBook(text, '<script>אב</script>');
  assert.equal(match.offset, 200);
  assert.equal(match.snippet, '…' + '😀'.repeat(60) + '<script>אב</script>' + '😃'.repeat(60) + '…');
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(match.snippet));
});
test('large book search does not require a character offset array', () => {
  const text = 'x'.repeat(10 * 1024 * 1024) + ' שָׁלוֹם';
  const [match] = findInBook(text, 'שלום');
  assert.equal(match.offset, 10 * 1024 * 1024 + 1);
  assert.equal(match.end, text.length);
});

test('cached search invalidates edited text and preserves Unicode search ranges', () => {
  const search = createBookSearch();
  for (const text of ['\u05e9\u05b8\u05c1\u05dc\u05d5\u05b9\u05dd 😀 Café', '😀 CAFÉ \u05e9\u05dc\u05d5\u05dd', 'edited']) {
    for (const query of ['\u05e9\u05dc\u05d5\u05dd', 'café', '😀', 'edited', 'missing']) assert.deepEqual(search(text, query), findInBook(text, query));
  }
});

test('async worker caches text, invalidates changes, and releases its worker', async () => {
  const messages = [], workers = [];
  const search = createAsyncBookSearch({ threshold: 1, workerFactory(source) {
    const fake = { terminated: false, terminate() { this.terminated = true; }, postMessage(message) {
      messages.push(message);
      queueMicrotask(() => scope.onmessage({ data: message }));
    } };
    const scope = { postMessage(data) { queueMicrotask(() => fake.onmessage({ data })); } };
    vm.runInNewContext(source, { self: scope });
    workers.push(fake); return fake;
  } });
  const text = '😀 \u05e9\u05b8\u05c1\u05dc\u05d5\u05b9\u05dd Café';
  const results = await Promise.all([search(text, '\u05e9\u05dc\u05d5\u05dd'), search(text, 'CAFÉ'), search('edited', 'edited')]);
  assert.deepEqual(JSON.parse(JSON.stringify(results)), [findInBook(text, '\u05e9\u05dc\u05d5\u05dd'), findInBook(text, 'CAFÉ'), findInBook('edited', 'edited')]);
  assert.equal(messages[0].text, text);
  assert.equal('text' in messages[1], false);
  assert.equal(messages[2].text, 'edited');
  search.clear(); assert.equal(workers[0].terminated, true);
  await search(text, 'missing'); assert.equal(workers.length, 2);
  search.dispose(); assert.equal(workers[1].terminated, true);
  await search(text, 'missing'); assert.equal(workers.length, 2);
});

test('worker creation and execution failures silently fall back to cached search', async () => {
  const text = 'hello edited';
  const broken = createAsyncBookSearch({ threshold: 1, workerFactory() { throw new Error('blocked'); } });
  assert.deepEqual(await broken(text, 'edited'), findInBook(text, 'edited'));
  const crashing = createAsyncBookSearch({ threshold: 1, workerFactory() { return {
    terminate() {}, postMessage() { queueMicrotask(() => this.onerror()); }
  }; } });
  assert.deepEqual(await crashing(text, 'edited'), findInBook(text, 'edited'));
});

test('clear and dispose cancel pending searches without normalizing their large text', async () => {
  for (const action of ['clear', 'dispose']) {
    let normalized = 0, terminated = 0;
    const search = createAsyncBookSearch({ threshold: 1, workerFactory() { return {
      terminate() { terminated++; }, postMessage() {}
    }; } });
    const normalize = String.prototype.normalize;
    String.prototype.normalize = function (...args) { normalized++; return normalize.apply(this, args); };
    try {
      const pending = search('x'.repeat(300000), 'x');
      search[action]();
      assert.deepEqual(await pending, []);
      assert.equal(normalized, 0);
      assert.equal(terminated, 1);
    } finally { String.prototype.normalize = normalize; }
  }
});

test('switching to small text terminates the large-book worker and cancels its outstanding result', async () => {
  let terminated = 0;
  const search = createAsyncBookSearch({ threshold: 10, workerFactory() { return {
    terminate() { terminated++; }, postMessage() {}
  }; } });
  const pending = search('x'.repeat(300000), 'x');
  assert.deepEqual(await search('small', 'small'), findInBook('small', 'small'));
  assert.deepEqual(await pending, []);
  assert.equal(terminated, 1);
});

test('worker errors suppress the browser error event and preserve a fallback result', async () => {
  let prevented = false;
  const search = createAsyncBookSearch({ threshold: 1, workerFactory() { return {
    terminate() {}, postMessage() { queueMicrotask(() => this.onerror({ preventDefault() { prevented = true; } })); }
  }; } });
  assert.deepEqual(await search('hello', 'hello'), findInBook('hello', 'hello'));
  assert.equal(prevented, true);
});
