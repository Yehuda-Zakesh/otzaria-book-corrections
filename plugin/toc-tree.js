const normalized = value => String(value ?? '').normalize('NFD').replace(/[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g, '').toLocaleLowerCase().trim();

/** Preserve the reader's heading order and levels, including skipped levels. */
export function buildTocTree(entries = []) {
  const roots = [], stack = [];
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry?.index) || entry.index < 0) continue;
    const level = Number.isFinite(entry.level) ? entry.level : 0;
    const node = { entry, key: `i:${entry.index}`, children: [] };
    while (stack.length && stack.at(-1).level >= level) stack.pop();
    if (stack.length) stack.at(-1).node.children.push(node); else roots.push(node);
    stack.push({ node, level });
  }
  return roots;
}

function expandedState(expanded, key, depth) {
  if (expanded instanceof Set) return expanded.has(key);
  if (expanded instanceof Map) return expanded.has(key) ? !!expanded.get(key) : depth === 0;
  return depth === 0;
}

/** Search shows matching headers, their complete subtrees and ancestor paths.
 * Search expansion is temporary and does not mutate the supplied state. */
export function flattenTocTree(tree, expanded = null, query = '') {
  const needle = normalized(query), visible = new Set();
  if (needle) {
    function mark(nodes, matchedAncestor = false) {
      let any = false;
      for (const node of nodes) {
        const matches = normalized(node.entry.text).includes(needle);
        const childMatches = mark(node.children, matchedAncestor || matches);
        if (matchedAncestor || matches || childMatches) { visible.add(node); any = true; }
      }
      return any;
    }
    mark(tree);
  }
  const rows = [];
  function visit(nodes, depth) {
    for (const node of nodes) {
      if (needle && !visible.has(node)) continue;
      const children = needle ? node.children.filter(child => visible.has(child)) : node.children;
      const open = children.length > 0 && (needle ? true : expandedState(expanded, node.key, depth));
      rows.push({ entry: node.entry, key: node.key, depth, hasChildren: node.children.length > 0, expanded: open });
      if (open) visit(children, depth + 1);
    }
  }
  visit(tree, 0);
  return rows;
}

/** Find the nearest source heading, regardless of its tree traversal order.
 * For a shared section anchor, the deepest heading is the active one. */
export function activeTocKey(tree, sectionIndex) {
  let active = null, activeIndex = -1, activeDepth = -1;
  function visit(nodes, depth) {
    for (const node of nodes) {
      const index = node.entry.index;
      if (index <= sectionIndex && (index > activeIndex || (index === activeIndex && depth >= activeDepth))) {
        active = node.key; activeIndex = index; activeDepth = depth;
      }
      visit(node.children, depth + 1);
    }
  }
  visit(tree, 0);
  return active;
}

export function ensurePathExpanded(tree, key, expanded = new Set()) {
  function visit(nodes, ancestors) {
    for (const node of nodes) {
      if (node.key === key) { for (const ancestor of ancestors) expanded.add(ancestor); return true; }
      if (visit(node.children, [...ancestors, node.key])) return true;
    }
    return false;
  }
  visit(tree, []);
  return expanded;
}

export function setAllExpanded(tree, open, expanded = new Set()) {
  expanded.clear();
  if (open) {
    function visit(nodes) { for (const node of nodes) { if (node.children.length) expanded.add(node.key); visit(node.children); } }
    visit(tree);
  }
  return expanded;
}
