import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import { build } from './build.mjs';

// A small ZIP writer keeps packaging independent of npm downloads and shell tools.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
await build();
const names = ['manifest.json', 'index.html', 'style.css', 'app.bundle.js'];
const manifest = JSON.parse(await readFile('plugin/manifest.json', 'utf8'));
const local = [], central = [];
let offset = 0;
for (const name of names) {
  const data = await readFile(`plugin/${name}`), compressed = deflateRawSync(data), filename = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  local.push(header, filename, compressed);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); header.copy(entry, 6, 4, 28);
  entry.writeUInt32LE(offset, 42);
  central.push(entry, filename);
  offset += header.length + filename.length + compressed.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
await mkdir('dist', { recursive: true });
const path = `dist/book-corrections-${manifest.version}.otzplugin`;
await writeFile(path, Buffer.concat([...local, directory, end]));
console.log(path);
