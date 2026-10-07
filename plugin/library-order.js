const topCategories = [
  'תנ"ך', 'מדרש', 'משנה', 'תלמוד בבלי', 'תלמוד ירושלמי', 'תוספתא',
  'הלכה', 'שו"ת', 'קבלה', 'סדר התפילה', 'מחשבת ישראל', 'חסידות',
  'ספרי מוסר', 'מילונים וספרי יעץ', 'לימוד יומי', 'ספרות עזר', 'בית שני'
];
const libraryOrder = item => Number.isInteger(item.order) ? item.order : 999;
function topCategoryOrder(category) {
  const title = category.title.replace(/\u05f4/g, '"').replace(/\u05f3/g, "'");
  const index = topCategories.indexOf(title);
  return index >= 0 ? index : topCategories.length + libraryOrder(category);
}
/** Match LibraryBrowser: canonical root order, normalized category order, raw book order. */
export function sortLibraryTree(node, root = true) {
  if (!node) return node;
  const categoryOrder = root ? topCategoryOrder : category => {
    const order = libraryOrder(category); return order >= 0 ? order : 1000 + Math.abs(order);
  };
  return { ...node,
    categories: (node.categories ?? []).map(category => sortLibraryTree(category, false))
      .sort((a, b) => categoryOrder(a) - categoryOrder(b)),
    books: [...(node.books ?? [])].sort((a, b) => libraryOrder(a) - libraryOrder(b))
  };
}
