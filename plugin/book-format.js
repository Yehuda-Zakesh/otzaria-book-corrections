import { sourceText } from './book.js';
import { computeTextDiff } from './text-diff.js';

// Book HTML is never inserted into the page. Only formatting tags and vetted
// style values are recreated; text and diffs always use textContent.
const bookTags = new Set(['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'small', 'big', 'sup', 'sub', 'span', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'center', 'blockquote', 'a']);
const bookStyleRules = {
  'font-weight': /^(normal|bold|[1-9]00)$/i,
  'font-style': /^(normal|italic|oblique)$/i,
  'text-decoration': /^(none|underline|line-through|overline)( (underline|line-through|overline))*$/i,
  'font-size': /^(small|smaller|large|larger|medium|(?:[1-9]|[1-5]\d|60)(?:\.\d+)?px|[0-2](?:\.\d+)?em|(?:[5-9]\d|1\d\d|200)%)$/i,
  'color': /^(#[\da-f]{3,8}|[a-z]{3,20}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i,
  'background-color': /^(#[\da-f]{3,8}|[a-z]{3,20})$/i
};
function bookAttributes(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/\b(style|color|size)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4];
  const styles = [];
  for (const rule of (attrs.style ?? '').split(';')) {
    const colon = rule.indexOf(':');
    if (colon < 0) continue;
    const name = rule.slice(0, colon).trim().toLowerCase(), value = rule.slice(colon + 1).trim();
    if (bookStyleRules[name]?.test(value)) styles.push(`${name}:${value}`);
  }
  if (attrs.color && bookStyleRules.color.test(attrs.color)) styles.push(`color:${attrs.color}`);
  if (attrs.size && /^[+-]?[1-7]$/.test(attrs.size)) {
    const size = Math.max(1, Math.min(7, /^[+-]/.test(attrs.size) ? 3 + Number(attrs.size) : Number(attrs.size)));
    styles.push(`font-size:${[0, .6, .75, 1, 1.2, 1.5, 2, 3][size]}em`);
  }
  return styles.join(';');
}

export function bookFormatRuns(raw, plain) {
  if (typeof raw !== 'string' || !raw.includes('<') || sourceText(raw) !== plain) return null;
  const runs = [], stack = [];
  let offset = 0, copied = 0;
  const add = (text, structural = false) => {
    if (text) runs.push({ start: offset, end: offset + text.length, formats: stack.slice(0, 32).map(item => ({ ...item })), structural });
    offset += text.length;
  };
  for (const match of raw.matchAll(/<[^>]*>/g)) {
    add(sourceText(raw.slice(copied, match.index))); copied = match.index + match[0].length;
    const tag = /^<\s*(\/?)\s*([a-z][\w-]*)/i.exec(match[0]);
    const space = sourceText(match[0]);
    if (space) add(space, true);
    if (!tag) continue;
    const name = tag[2].toLowerCase();
    if (!bookTags.has(name)) continue;
    if (tag[1]) {
      const at = stack.map(item => item.name).lastIndexOf(name);
      if (at >= 0) stack.splice(at);
    } else if (!/\/\s*>$/.test(match[0])) stack.push({ name, css: bookAttributes(match[0]) });
  }
  add(sourceText(raw.slice(copied)));
  return offset === plain.length ? runs : null;
}

export function formattedDiffParts(before, after, raw) {
  const runs = bookFormatRuns(raw, before), parts = [];
  const textRuns = runs?.filter(run => !run.structural) ?? [];
  let offset = 0, runIndex = 0;
  for (const segment of computeTextDiff(before, after)) {
    if (segment.op === 'added') {
      const run = runs?.find(item => !item.structural && item.start <= offset && item.end >= offset);
      parts.push({ ...segment, formats: run?.formats ?? [] });
      continue;
    }
    const end = offset + segment.text.length;
    if (!runs) { parts.push({ ...segment, formats: [] }); offset = end; continue; }
    while (offset < end) {
      while (runs[runIndex]?.end <= offset) runIndex++;
      const run = runs[runIndex], until = Math.min(end, run?.end ?? end);
      parts.push({ op: segment.op, text: before.slice(offset, until), formats: run?.formats ?? [],
        // Spaces introduced by block tags are not literal book indentation.
        hidden: !!run?.structural && (run.end <= (textRuns[0]?.start ?? 0) || run.start >= (textRuns.at(-1)?.end ?? before.length)),
        lineBreak: !!run?.structural && run.start > 0 && run.end < before.length });
      offset = until;
    }
  }
  return parts;
}

export function appendFormattedDiff(box, before, after, raw, doc = document) {
  for (const part of formattedDiffParts(before, after, raw)) {
    if (part.hidden && part.op === 'equal') continue;
    let parent = box;
    for (const format of part.formats) {
      const inline = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'center', 'blockquote', 'a', 'font'].includes(format.name);
      const wrapper = doc.createElement(inline ? 'span' : format.name);
      wrapper.className = `book-format book-${format.name}`;
      if (format.css) wrapper.setAttribute('style', format.css);
      parent.append(wrapper); parent = wrapper;
    }
    const text = doc.createElement(part.op === 'removed' ? 'del' : part.op === 'added' ? 'ins' : 'span');
    text.textContent = part.text;
    if (part.lineBreak && part.op === 'equal') { parent.append(doc.createElement('br')); }
    else parent.append(text);
  }
}
