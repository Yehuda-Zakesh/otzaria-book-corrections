export const EDITOR_CHUNK = 16000;

// Bound native textarea layout, including books with a single huge paragraph.
export function editorRange(text, offset = 0, exactStart = false) {
  offset = Math.max(0, Math.min(text.length, offset));
  let start = exactStart ? offset : Math.floor(Math.min(offset, Math.max(0, text.length - 1)) / EDITOR_CHUNK) * EDITOR_CHUNK;
  if (start && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  let end = Math.min(text.length, start + EDITOR_CHUNK);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end++;
  return { start, end };
}

export function replaceEditorRange(text, range, value) {
  return text.slice(0, range.start) + value + text.slice(range.end);
}

export function editorSegments(text) {
  const segments = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + EDITOR_CHUNK);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start + EDITOR_CHUNK / 2) end = newline + 1;
      else if (/[\uDC00-\uDFFF]/.test(text[end])) end++;
    }
    segments.push({ start, end }); start = end;
  }
  return segments.length ? segments : [{ start: 0, end: 0 }];
}

// One scrollbar belongs to the whole book. Only nearby text is laid out in
// the native editor; replacing that window never restarts the scroll position.
export function createContinuousEditor(viewport, canvas, editor, onPosition) {
  let text = '', segments = [], heights = [], tops = [], range = { start: 0, end: 0 };
  let first = 0, last = 0, markers = [], frame = null, programmaticTop = null;
  let width = 0, lineHeight = 38, padding = 24;
  const mirror = document.createElement('div');
  Object.assign(mirror.style, { position: 'fixed', left: '-100000px', top: '0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', visibility: 'hidden' });
  function configure() {
    const style = getComputedStyle(editor);
    for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'wordSpacing', 'direction', 'tabSize']) mirror.style[key] = style[key];
    width = editor.clientWidth;
    mirror.style.width = `${width}px`;
    lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    padding = parseFloat(getComputedStyle(canvas).getPropertyValue('--book-padding')) || 24;
  }
  function rebuildTops() {
    tops = [0];
    for (const height of heights) tops.push(tops.at(-1) + height);
    canvas.style.height = `${Math.max(viewport.clientHeight, tops.at(-1) + padding * 2)}px`;
  }
  function indexAtHeight(y) {
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function indexAtOffset(offset) {
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (segments[mid].start <= offset) lo = mid; else hi = mid - 1; }
    return lo;
  }
  function mount(index, force = false) {
    const nextFirst = Math.max(0, index - 1), nextLast = Math.min(segments.length - 1, index + 1);
    if (!force && first === nextFirst && last === nextLast && editor.value === text.slice(range.start, range.end)) return;
    const anchorY = viewport.scrollTop - tops[index];
    first = nextFirst; last = nextLast;
    range = { start: segments[first].start, end: segments[last].end };
    document.body.append(mirror);
    for (let i = first; i <= last; i++) {
      let value = text.slice(segments[i].start, segments[i].end);
      if (i < segments.length - 1 && value.endsWith('\n')) value = value.slice(0, -1);
      mirror.textContent = value + '\u200b';
      heights[i] = Math.max(lineHeight, mirror.getBoundingClientRect().height);
    }
    rebuildTops();
    const value = text.slice(range.start, range.end);
    editor.value = value;
    // Mark source boundaries once per mounted window, not on every wheel tick.
    mirror.replaceChildren(); markers = [];
    let cursor = 0;
    while (cursor < value.length) {
      const span = document.createElement('span');
      const newline = value.indexOf('\n', cursor);
      let end = newline >= 0 && newline - cursor < 256 ? newline + 1 : Math.min(value.length, cursor + 256);
      if (end < value.length && /[\uDC00-\uDFFF]/.test(value[end])) end++;
      span.textContent = value.slice(cursor, end);
      mirror.append(span); markers.push({ offset: range.start + cursor, span }); cursor = end;
    }
    const tail = document.createElement('span'); tail.textContent = '\u200b'; mirror.append(tail);
    const height = Math.max(lineHeight, mirror.getBoundingClientRect().height);
    markers = markers.map(marker => ({ offset: marker.offset, y: marker.span.offsetTop }));
    editor.style.top = `${padding + tops[first]}px`;
    editor.style.height = `${height}px`;
    editor.scrollTop = 0;
    mirror.remove();
    viewport.scrollTop = Math.max(0, tops[index] + anchorY);
  }
  function setText(value, offset = 0, savedGeometry = null) {
    const previousText = text, previousWidth = width, previousLineHeight = lineHeight;
    const previous = new Map(segments.map((segment, i) => [segment.start, { ...segment, height: heights[i] }]));
    text = value; segments = editorSegments(text); configure();
    const charsPerLine = Math.max(1, Math.floor(width / (parseFloat(getComputedStyle(editor).fontSize) * 0.55)));
    heights = segments.map(segment => {
      const before = previous.get(segment.start);
      if (before && before.end === segment.end && previousWidth === width && previousLineHeight === lineHeight
        && previousText.slice(before.start, before.end) === text.slice(segment.start, segment.end)) return before.height;
      const lines = text.slice(segment.start, segment.end).replace(/\n$/, '').split('\n');
      return lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0) * lineHeight;
    });
    if (savedGeometry?.width === width && savedGeometry.lineHeight === lineHeight
      && savedGeometry.length === text.length && savedGeometry.heights?.length === segments.length
      && savedGeometry.heights.every(height => Number.isFinite(height) && height > 0)) heights = [...savedGeometry.heights];
    rebuildTops(); mount(indexAtOffset(offset), true);
  }
  function visibleOffset() {
    const y = Math.max(0, viewport.scrollTop - padding - tops[first]);
    let lo = 0, hi = Math.max(0, markers.length - 1);
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (markers[mid].y <= y) lo = mid; else hi = mid - 1; }
    return markers[lo]?.offset ?? range.start;
  }
  function scrollTo(offset, end = offset) {
    mount(indexAtOffset(offset));
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(offset - range.start, Math.min(end, range.end) - range.start);
    document.body.append(mirror);
    mirror.textContent = text.slice(range.start, offset);
    const caret = document.createElement('span'); caret.textContent = '\u200b'; mirror.append(caret);
    viewport.scrollTop = Math.max(0, padding + tops[first] + caret.offsetTop - viewport.clientHeight / 4);
    mirror.remove(); programmaticTop = viewport.scrollTop;
  }
  viewport.addEventListener('scroll', () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (programmaticTop !== null && Math.abs(viewport.scrollTop - programmaticTop) < 1) { programmaticTop = null; return; }
      programmaticTop = null;
      const y = viewport.scrollTop - padding;
      const index = indexAtHeight(Math.max(0, y));
      mount(index);
      onPosition(visibleOffset());
    });
  }, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => {
    if (!editor.clientWidth || editor.clientWidth === width || !segments.length) return;
    const start = range.start + editor.selectionStart, end = range.start + editor.selectionEnd;
    const focused = document.activeElement;
    const offset = visibleOffset(); setText(text, offset); scrollTo(offset);
    editor.setSelectionRange(Math.max(0, Math.min(start - range.start, editor.value.length)), Math.max(0, Math.min(end - range.start, editor.value.length)));
    if (focused !== editor) focused?.focus({ preventScroll: true });
  }).observe(viewport);
  viewport.addEventListener('click', event => {
    if (event.target === viewport || event.target === canvas) editor.focus({ preventScroll: true });
  });
  return {
    setText, scrollTo, visibleOffset,
    get geometry() { return { width, lineHeight, length: text.length, heights: [...heights] }; },
    get range() { return range; },
    edited(value) {
      const offset = range.start + editor.selectionStart;
      const nextText = replaceEditorRange(text, range, value);
      const start = range.start + editor.selectionStart, end = range.start + editor.selectionEnd;
      setText(nextText, offset);
      editor.setSelectionRange(Math.max(0, Math.min(start - range.start, editor.value.length)), Math.max(0, Math.min(end - range.start, editor.value.length)));
      return text;
    }
  };
}
