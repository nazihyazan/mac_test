const { once } = require('node:events');
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const HALF_RED_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg==',
  'base64'
);
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value >>> 0;
});

function detectBitmapLayout(nativeImage) {
  const sample = nativeImage.createFromBuffer(HALF_RED_PNG).toBitmap();
  if (sample.length !== 4 || sample[3] < 120 || sample[3] > 136) {
    throw new Error('Unsupported native bitmap alpha layout.');
  }
  const redAt = sample[0] > 100 && sample[2] < 10 ? 0
    : sample[2] > 100 && sample[0] < 10 ? 2 : -1;
  if (redAt < 0) throw new Error('Unsupported native bitmap color layout.');
  return { redAt, premultiplied: sample[redAt] <= sample[3] + 2 };
}

function chunk(type, data) {
  const result = Buffer.allocUnsafe(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < result.length - 4; index++) {
    crc = crcTable[(crc ^ result[index]) & 0xff] ^ (crc >>> 8);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

async function encodeBitmapPng(bitmap, width, height, layout) {
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || width < 1 || height < 1 ||
      bitmap.length !== pixels * 4 || pixels > 64 * 1024 * 1024) {
    throw new Error('Clipboard image dimensions are invalid or too large.');
  }
  const compressor = zlib.createDeflate({ level: zlib.constants.Z_BEST_SPEED });
  const dataChunks = [];
  const collect = (async () => {
    for await (const data of compressor) dataChunks.push(chunk('IDAT', data));
  })();
  try {
    // Feed one row at a time so a 4K clipboard image does not allocate a second
    // full-resolution bitmap or block the Electron main loop during compression.
    for (let y = 0; y < height; y++) {
      const row = Buffer.allocUnsafe(width * 4 + 1);
      row[0] = 0;
      for (let x = 0; x < width; x++) {
        const source = (y * width + x) * 4;
        const target = 1 + x * 4;
        const alpha = bitmap[source + 3];
        let red = bitmap[source + layout.redAt];
        let green = bitmap[source + 1];
        let blue = bitmap[source + (layout.redAt === 0 ? 2 : 0)];
        if (layout.premultiplied && alpha > 0 && alpha < 255) {
          red = Math.min(255, Math.round(red * 255 / alpha));
          green = Math.min(255, Math.round(green * 255 / alpha));
          blue = Math.min(255, Math.round(blue * 255 / alpha));
        }
        row[target] = red;
        row[target + 1] = green;
        row[target + 2] = blue;
        row[target + 3] = alpha;
      }
      if (!compressor.write(row)) await once(compressor, 'drain');
    }
    compressor.end();
    await collect;
  } catch (error) {
    compressor.destroy(error);
    await collect.catch(() => {});
    throw error;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // RGBA, eight bits per channel.
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    ...dataChunks,
    chunk('IEND', Buffer.alloc(0))
  ]);
}

module.exports = { detectBitmapLayout, encodeBitmapPng };
