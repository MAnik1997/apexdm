const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const mid = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const dx = x - mid;
      const dy = y - mid;
      const inside = Math.hypot(dx, dy) <= size * 0.46;
      const shaft = Math.abs(dx) <= size * 0.055 && dy >= -size * 0.24 && dy <= size * 0.08;
      const head = dy >= size * 0.02 && dy <= size * 0.2 && Math.abs(dx) <= (size * 0.2 - dy);
      const base = Math.abs(dy - size * 0.28) <= size * 0.035 && Math.abs(dx) <= size * 0.2;
      const mark = shaft || head || base;
      const pixel = row + 1 + x * 4;
      const color = !inside ? [16, 17, 20] : mark ? [26, 18, 3] : [255, 176, 32];
      raw[pixel] = color[0];
      raw[pixel + 1] = color[1];
      raw[pixel + 2] = color[2];
      raw[pixel + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = path.join(__dirname, '..');
for (const size of [16, 32, 48, 128]) {
  const file = path.join(root, 'extension', 'icons', `${size}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png(size));
}
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.copyFileSync(path.join(root, 'extension', 'icons', '128.png'), path.join(root, 'assets', 'icon.png'));
fs.copyFileSync(path.join(root, 'extension', 'icons', '32.png'), path.join(root, 'assets', 'icon-32.png'));
console.log('icons written');
