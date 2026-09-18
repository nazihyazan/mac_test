const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createReadStream, constants } = require('node:fs');

function createMediaStore({ directory, nativeImage }) {
  let imageWrites = Promise.resolve();
  const preparedFiles = new Map();
  const mediaUrl = name => `app-media://media/${encodeURIComponent(name)}`;
  async function writeOnce(name, buffer) {
    await fs.mkdir(directory(), { recursive: true });
    try { await fs.writeFile(path.join(directory(), name), buffer, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }

  function saveImage(input, name = 'Clipboard image.png') {
    const result = imageWrites.then(() => writeImage(input, name));
    imageWrites = result.catch(() => {});
    return result;
  }

  async function writeImage(input, name) {
    const image = Buffer.isBuffer(input) ? nativeImage.createFromBuffer(input) : input;
    if (image.isEmpty()) throw new Error('Image could not be decoded.');
    const { width, height } = image.getSize();
    const contentHash = crypto.createHash('sha256').update(`${width}x${height}:`).update(image.toBitmap()).digest('hex');
    const fileName = `${contentHash}.png`;
    const thumbnail = `${contentHash}-thumb.png`;
    const exists = await fs.access(path.join(directory(), fileName)).then(() => true, () => false);
    if (!exists) await writeOnce(fileName, image.toPNG());
    const thumbnailExists = await fs.access(path.join(directory(), thumbnail)).then(() => true, () => false);
    if (!thumbnailExists) {
      const scale = Math.min(1, 512 / Math.max(width, height));
      const small = image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
      await writeOnce(thumbnail, small.toPNG());
    }
    const stat = await fs.stat(path.join(directory(), fileName));
    return { id: crypto.randomUUID(), kind: 'image', name, mime: 'image/png', size: stat.size,
      storage: 'file', fileName, contentHash, thumbnail, src: mediaUrl(fileName), previewSrc: mediaUrl(thumbnail), createdAt: new Date().toISOString() };
  }

  async function saveBuffer(buffer, { kind = 'video', name = 'Video', mime = '' } = {}) {
    const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
    const extension = /^\.[a-z0-9]{1,8}$/i.test(path.extname(name)) ? path.extname(name).toLowerCase() : '.bin';
    const fileName = `${contentHash}${extension}`;
    await writeOnce(fileName, buffer);
    return { id: crypto.randomUUID(), kind, name, mime, size: buffer.length, storage: 'file', fileName,
      contentHash, src: mediaUrl(fileName), createdAt: new Date().toISOString() };
  }

  async function saveFile(source, { kind, name, mime = '' }) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    const contentHash = hash.digest('hex');
    const fileName = `${contentHash}${path.extname(source).toLowerCase()}`;
    await fs.mkdir(directory(), { recursive: true });
    try { await fs.copyFile(source, path.join(directory(), fileName), constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.stat(source);
    return { id: crypto.randomUUID(), kind, name, mime, size: stat.size, storage: 'file', fileName,
      contentHash, src: mediaUrl(fileName), createdAt: new Date().toISOString() };
  }

  async function prepareFile(fileName, name) {
    const source = path.join(directory(), fileName);
    const stat = await fs.stat(source);
    const key = `${fileName}:${stat.size}:${stat.mtimeMs}`;
    if (!preparedFiles.has(key)) {
      if (preparedFiles.size >= 512) preparedFiles.delete(preparedFiles.keys().next().value);
      preparedFiles.set(key, fs.readFile(source).then(buffer => saveImage(buffer, name)));
    }
    try { return await preparedFiles.get(key); }
    catch (error) { preparedFiles.delete(key); throw error; }
  }

  return { saveImage, saveBuffer, saveFile, prepareFile, mediaUrl };
}

module.exports = { createMediaStore };
