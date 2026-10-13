const hebrewMarks = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
const markCode = code => (code >= 0x0591 && code <= 0x05bd) || code === 0x05bf || code === 0x05c1 || code === 0x05c2 || code === 0x05c4 || code === 0x05c5 || code === 0x05c7;
const normalize = text => text.normalize('NFD').toLowerCase().replace(hebrewMarks, '');

// Port of Otzaria lib/data/repository/data_repository.dart normalization,
// _wordPairMatches and _editDistanceAtMost (UTF-16, identical typo budgets).
function searchWords(value) {
  const words = []; let chunks = [], chunk = '', offset = -1, end = 0;
  const flush = () => { if (offset >= 0) words.push({ word: chunks.join('') + chunk, offset, end }); chunks = []; chunk = ''; offset = -1; };
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0x0591 && c <= 0x05c7) { if (c === 0x05be || c === 0x05c0) flush(); else if (offset >= 0) end = i + 1; continue; }
    if (c === 0x22 || c === 0x27 || c === 0x05f3 || c === 0x05f4) { if (offset >= 0) end = i + 1; continue; }
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || (c >= 0x0590 && c <= 0x05ff)) {
      if (offset < 0) offset = i;
      chunk += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 0x20 : c);
      if (chunk.length === 256) { chunks.push(chunk); chunk = ''; }
      end = i + 1;
    } else flush();
  }
  flush(); return words;
}
function searchWordMatches(query, word) {
  if (word.includes(query)) return true;
  if (query.length < 3) return false;
  if (/(\u05d5\u05d5|\u05d9\u05d9)/.test(query + word) && word.replace(/\u05d5\u05d5/g, '\u05d5').replace(/\u05d9\u05d9/g, '\u05d9').includes(query.replace(/\u05d5\u05d5/g, '\u05d5').replace(/\u05d9\u05d9/g, '\u05d9'))) return true;
  const length = Math.max(query.length, word.length);
  const allowed = length <= 4 ? 0 : Math.min(4, Math.ceil(length / 4) - 1);
  if (!allowed || Math.abs(query.length - word.length) > allowed) return false;
  let previous2 = new Uint32Array(word.length + 1), previous = Uint32Array.from({ length: word.length + 1 }, (_, i) => i), row = new Uint32Array(word.length + 1), previousMin = 0;
  for (let i = 1; i <= query.length; i++) {
    row[0] = i; let rowMin = i;
    for (let j = 1; j <= word.length; j++) {
      const cost = query[i - 1] === word[j - 1] ? 0 : 1;
      let best = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && query[i - 1] === word[j - 2] && query[i - 2] === word[j - 1]) best = Math.min(best, previous2[j - 2] + cost);
      row[j] = best; rowMin = Math.min(rowMin, best);
    }
    if (rowMin > allowed && previousMin > allowed) return false;
    const recycled = previous2; previous2 = previous; previous = row; row = recycled; previousMin = rowMin;
  }
  return previous[word.length] <= allowed;
}
export function createSearchTextMatcher(query) {
  const terms = searchWords(query).map(item => item.word);
  if (!terms.length) return () => true;
  const matches = new Map();
  return text => {
    const words = searchWords(text);
    return terms.every(term => words.some(({ word }) => {
      const key = term + '\0' + word;
      if (!matches.has(key)) matches.set(key, searchWordMatches(term, word));
      return matches.get(key);
    }));
  };
}
export function matchesSearchText(text, query) { return createSearchTextMatcher(query)(text); }
function tolerantQuery(query) { return /[א-ת]/.test(query) && /^[\u0591-\u05c7א-ת"'׳״‘’“”\s־-]+$/.test(query); }
function findHebrewWords(text, query, limit, words) {
  const terms = searchWords(query);
  if (!terms.length) return [];
  const results = [], matches = new Map();
  const accepts = (term, word) => {
    const key = term + '\0' + word;
    if (!matches.has(key)) matches.set(key, searchWordMatches(term, word));
    return matches.get(key);
  };
  for (let i = 0; i <= words.length - terms.length && results.length < limit; i++) {
    if (!terms.every((term, j) => accepts(term.word, words[i + j].word))) continue;
    // Exact containment highlights only the matching letters. Fuzzy spelling
    // matches retain the complete original word (including nikud/quotes).
    const boundary = (item, term, last) => {
      const at = item.word.indexOf(term);
      if (at < 0) return last ? item.end : item.offset;
      const target = last ? at + term.length : at;
      let normalizedOffset = 0;
      for (let position = item.offset; position < item.end; position++) {
        const c = text.charCodeAt(position);
        if ((c >= 0x0591 && c <= 0x05c7) || c === 0x22 || c === 0x27 || c === 0x05f3 || c === 0x05f4) continue;
        if (normalizedOffset === target) return position;
        normalizedOffset++;
      }
      return item.end;
    };
    const offset = boundary(words[i], terms[0].word, false), end = boundary(words[i + terms.length - 1], terms.at(-1).word, true);
    results.push({ offset, end, snippet: snippetFor(text, offset, end) });
    i += terms.length - 1;
  }
  return results;
}

function snippetFor(text, start, end) {
  let leftStart = Math.max(0, start - 120), rightEnd = Math.min(text.length, end + 120);
  if (leftStart > 0 && /[\uDC00-\uDFFF]/.test(text[leftStart])) leftStart--;
  if (rightEnd < text.length && /[\uDC00-\uDFFF]/.test(text[rightEnd])) rightEnd++;
  const left = Array.from(text.slice(leftStart, start)).slice(-60).join('');
  const right = Array.from(text.slice(end, rightEnd)).slice(0, 60).join('');
  const middle = Array.from(text.slice(start, Math.min(end, start + 122))).slice(0, 60).join('');
  const middleDisplay = middle + (middle.length < end - start ? '…' : '');
  return (start > left.length ? '…' : '') + left + middleDisplay + right + (end + right.length < text.length ? '…' : '');
}

/** Search edited text using host word normalization and typo matching for Hebrew
 * queries; other queries remain literal. Results refer to original UTF-16 ranges. */
export function createBookSearch() {
  let cachedText, normalizedText, words;
  const search = (text, query, options = {}) => {
    if (typeof text !== 'string' || typeof query !== 'string') throw new TypeError('Search text and query must be strings');
    if (text !== cachedText) { cachedText = text; normalizedText = undefined; words = undefined; }
    if (tolerantQuery(query)) words ??= searchWords(text);
    else normalizedText ??= normalize(text);
    return findInBook(text, query, { ...options, normalizedText, words });
  };
  search.clear = () => { cachedText = undefined; normalizedText = undefined; words = undefined; };
  return search;
}

/** Large books normalize and search off the UI thread. The worker retains only
 * the current book; subsequent queries transmit just the query. */
export function createAsyncBookSearch({ threshold = 250000, workerFactory } = {}) {
  const fallback = createBookSearch(), pending = new Map();
  let worker, sentText, sequence = 0, disabled = false;
  function reset(useFallback = false) {
    worker?.terminate(); worker = undefined; sentText = undefined;
    for (const item of pending.values()) {
      try { item.resolve(useFallback ? fallback(item.text, item.query, item.options) : []); }
      catch (error) { item.reject(error); }
    }
    pending.clear();
    fallback.clear();
  }
  function makeWorker() {
    const source = `const hebrewMarks = ${hebrewMarks}; const markCode = ${markCode}; const normalize = ${normalize};
      ${searchWords} ${searchWordMatches} ${tolerantQuery} ${findHebrewWords}
      ${snippetFor} ${findInBook} ${createBookSearch}
      const search = createBookSearch(); let text;
      self.onmessage = ({data}) => {
        try { if (typeof data.text === 'string') text = data.text;
          self.postMessage({id: data.id, results: search(text, data.query, data.options)});
        } catch (error) { self.postMessage({id: data.id, error: error.message}); }
      };`;
    if (workerFactory) return workerFactory(source);
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try { return new Worker(url); } finally { URL.revokeObjectURL(url); }
  }
  const search = async (text, query, options = {}) => {
    if (typeof text !== 'string' || typeof query !== 'string') throw new TypeError('Search text and query must be strings');
    if (text.length < threshold || disabled || (!workerFactory && typeof Worker === 'undefined')) {
      if (worker) reset();
      return fallback(text, query, options);
    }
    try {
      if (!worker) {
        worker = makeWorker();
        worker.onmessage = ({ data }) => {
          const item = pending.get(data.id);
          if (!item) return;
          pending.delete(data.id);
          if (data.error) item.reject(new Error(data.error)); else item.resolve(data.results);
        };
        worker.onerror = event => { event?.preventDefault?.(); disabled = true; reset(true); };
        worker.onmessageerror = worker.onerror;
      }
      return await new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject, text, query, options });
        const message = { id, query, options: { limit: options.limit } };
        if (text !== sentText) message.text = text;
        try { worker.postMessage(message); sentText = text; }
        catch { disabled = true; reset(true); }
      });
    } catch { disabled = true; reset(true); return fallback(text, query, options); }
  };
  search.clear = () => reset();
  search.dispose = () => { disabled = true; reset(); };
  return search;
}

export function findInBook(text, query, { limit = 200, normalizedText, words } = {}) {
  if (typeof text !== 'string' || typeof query !== 'string') throw new TypeError('Search text and query must be strings');
  if (!Number.isFinite(limit) || limit <= 0 || !query.trim()) return [];
  if (tolerantQuery(query)) return findHebrewWords(text, query, Math.floor(limit), words ?? searchWords(text));
  const needle = normalize(query);
  if (!needle.trim()) return [];
  const haystack = normalizedText ?? normalize(text), matches = [];
  const max = Math.floor(limit);
  for (let from = 0; matches.length < max;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    matches.push({ normalizedStart: at, normalizedEnd: at + needle.length });
    from = at + needle.length;
  }
  if (!matches.length) return [];

  // Map only found boundaries in one pass, avoiding two 10 MB offset arrays.
  let normalizedOffset = 0, firstStart = 0, firstEnd = 0;
  for (let offset = 0; offset < text.length && firstEnd < matches.length;) {
    const code = text.codePointAt(offset), width = code > 0xffff ? 2 : 1;
    let length;
    if (markCode(code)) length = 0;
    else if (code < 0x80 || (code >= 0x05d0 && code <= 0x05ea)) length = 1;
    else length = normalize(text.slice(offset, offset + width)).length;
    const next = normalizedOffset + length;
    if (length) {
      while (firstStart < matches.length && matches[firstStart].normalizedStart < next) matches[firstStart++].offset = offset;
      while (firstEnd < matches.length && matches[firstEnd].normalizedEnd <= next) matches[firstEnd++].end = offset + width;
    }
    normalizedOffset = next; offset += width;
  }
  return matches.map(match => {
    while (match.end < text.length && markCode(text.charCodeAt(match.end))) match.end++;
    return { offset: match.offset, end: match.end, snippet: snippetFor(text, match.offset, match.end) };
  });
}
