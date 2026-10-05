const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');
const { encodeBitmapPng } = require('../png-encode');

function decodeScanlines(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const compressed = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return zlib.inflateSync(Buffer.concat(compressed));
}

test('encodes BGRA premultiplied transparency as valid RGBA PNG', async () => {
  const png = await encodeBitmapPng(Buffer.from([0, 0, 128, 128]), 1, 1,
    { redAt: 2, premultiplied: true });
  assert.deepEqual([...decodeScanlines(png)], [0, 255, 0, 0, 128]);
});

test('preserves distinct opaque pixels across rows', async () => {
  const bitmap = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]);
  const png = await encodeBitmapPng(bitmap, 1, 2,
    { redAt: 0, premultiplied: false });
  assert.deepEqual([...decodeScanlines(png)], [0, 255, 0, 0, 255, 0, 0, 255, 0, 255]);
});

test('rejects dimensions that do not match the bitmap', async () => {
  await assert.rejects(encodeBitmapPng(Buffer.alloc(4), 2, 2,
    { redAt: 0, premultiplied: false }), /dimensions/);
});
