import { watch } from 'node:fs';
import { build } from './build.mjs';

let timer;
let building = false;
let pending = false;
async function rebuild() {
  if (building) { pending = true; return; }
  building = true;
  try {
    await build();
    console.log('הסקריפט נבנה מחדש — אוצריא יכולה לטעון את העדכון.');
  } catch (error) {
    console.error(`הבנייה נכשלה: ${error.message}`);
  } finally {
    building = false;
    if (pending) { pending = false; await rebuild(); }
  }
}

const watcher = watch(new URL('../plugin/', import.meta.url), (_event, filename) => {
  if (!['app.js', 'report.js', 'book.js', 'changes.js', 'book-reports.js', 'rpc.js', 'navigation.js', 'toc-tree.js', 'book-search.js'].includes(String(filename))) return;
  clearTimeout(timer);
  timer = setTimeout(rebuild, 100);
});
await rebuild();
console.log('עוקב אחרי קובצי המקור. טען את תיקיית plugin כתוסף פיתוח באוצריא.');
process.on('SIGINT', () => { clearTimeout(timer); watcher.close(); });
