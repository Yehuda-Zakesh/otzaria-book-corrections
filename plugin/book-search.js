const hebrewMarks = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
const markCode = code => (code >= 0x0591 && code <= 0x05bd) || code === 0x05bf || code === 0x05c1 || code === 0x05c2 || code === 0x05c4 || code === 0x05c5 || code === 0x05c7;
const normalize = text => text.normalize('NFD').toLowerCase().replace(hebrewMarks, '');

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

/** Literal search in edited text; public offsets refer to the original UTF-16
 * string passed here. Nikud/cantillation are ignored, whitespace stays exact. */
export function createBookSearch() {
  let cachedText, normalizedText;
  const search = (text, query, options = {}) => {
    if (typeof text !== 'string' || typeof query !== 'string') throw new TypeError('Search text and query must be strings');
    if (text !== cachedText) { cachedText = text; normalizedText = normalize(text); }
    return findInBook(text, query, { ...options, normalizedText });
  };
  search.clear = () => { cachedText = undefined; normalizedText = undefined; };
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

export function findInBook(text, query, { limit = 200, normalizedText } = {}) {
  if (typeof text !== 'string' || typeof query !== 'string') throw new TypeError('Search text and query must be strings');
  if (!Number.isFinite(limit) || limit <= 0 || !query.trim()) return [];
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
