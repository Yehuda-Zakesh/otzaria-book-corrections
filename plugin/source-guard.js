import { loadBook } from './book.js';

export function createSourceGuard(call) {
  const pending = new WeakMap();
  let restores = Promise.resolve();
  function changed() {
    throw new Error('מקור הספר השתנה מאז תחילת העריכה. הטיוטה נשמרה, אך אי אפשר לשלוח אותה מול המקור המעודכן.');
  }
  function verifySource(book) {
    const existing = pending.get(book);
    if (existing) return existing;
    const result = loadBook(call, book.identity).then(current => {
      if (current.originalText !== book.originalText || current.sections.length !== book.sections.length ||
          current.sections.some((section, index) => section.start !== book.sections[index].start || section.end !== book.sections[index].end)) {
        changed();
      }
    });
    pending.set(book, result);
    result.finally(() => { if (pending.get(book) === result) pending.delete(book); }).catch(() => {});
    return result;
  }
  async function check(book, sectionIndices = []) {
    await verifySource(book);
    // Full content comparisons do not prove internal DB section boundaries.
    // Recheck authoritative maps for every section that a queued report uses.
    for (const sectionIndex of new Set(sectionIndices)) {
      if (!Number.isInteger(sectionIndex) || !book.sections[sectionIndex]) changed();
      const map = await call('reader.getSectionTextMap', { ...book.identity, sectionIndex, layer: 'source' });
      if (map?.sourceText !== book.sections[sectionIndex].text) changed();
    }
  }
  // Restoration checks stay silent; submit always verifies again (or awaits a
  // check already in flight) before sending even an existing report queue.
  function restore(book) {
    // Avoid holding fresh copies of all restored books in memory at once.
    // Explicit submission checks can start immediately without joining this queue.
    restores = restores.then(() => verifySource(book)).catch(() => {});
    return restores;
  }
  return { check, restore };
}
