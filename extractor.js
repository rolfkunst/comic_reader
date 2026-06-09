'use strict';

const AdmZip                      = require('adm-zip');
const { createExtractorFromData } = require('node-unrar-js');
const sharp                       = require('sharp');
const path                        = require('path');
const fs                          = require('fs');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff']);

function isImage(name) {
  return IMAGE_EXTS.has(path.extname(name).toLowerCase());
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// ── ZIP (CBZ) ─────────────────────────────────────────────────────────────────

function listZipImages(buffer) {
  const zip = new AdmZip(buffer);
  return zip.getEntries()
    .filter(e => !e.isDirectory && isImage(e.entryName))
    .map(e => e.entryName)
    .sort(naturalSort);
}

function extractZipPage(buffer, name) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry(name);
  return entry ? entry.getData() : null;
}

function extractZipAll(buffer) {
  const zip = new AdmZip(buffer);
  const images = zip.getEntries()
    .filter(e => !e.isDirectory && isImage(e.entryName))
    .sort((a, b) => naturalSort(a.entryName, b.entryName));
  return images.map(e => ({ name: e.entryName, data: e.getData() }));
}

// ── RAR (CBR) ─────────────────────────────────────────────────────────────────

async function listRarImages(buffer) {
  const extractor = await createExtractorFromData({ data: new Uint8Array(buffer) });
  const list      = extractor.getFileList();
  return [...list.fileHeaders]
    .filter(h => !h.flags.directory && isImage(h.name))
    .map(h => h.name)
    .sort(naturalSort);
}

async function extractRarPage(buffer, name) {
  const extractor = await createExtractorFromData({ data: new Uint8Array(buffer) });
  const result    = extractor.extract({ files: [name] });
  const files     = [...result.files];
  return files.length ? Buffer.from(files[0].extraction) : null;
}

async function extractRarAll(buffer) {
  const extractor = await createExtractorFromData({ data: new Uint8Array(buffer) });
  const list      = extractor.getFileList();
  const names     = [...list.fileHeaders]
    .filter(h => !h.flags.directory && isImage(h.name))
    .map(h => h.name)
    .sort(naturalSort);

  const result = extractor.extract({ files: names });
  return [...result.files].map(f => ({ name: f.fileHeader.name, data: Buffer.from(f.extraction) }));
}

// ── Public API ────────────────────────────────────────────────────────────────

function isCBZ(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.cbz' || ext === '.zip';
}

function isCBR(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.cbr' || ext === '.rar';
}

/**
 * Get sorted list of image names inside a comic archive buffer.
 */
async function listPages(filePath, buffer) {
  if (isCBZ(filePath)) return listZipImages(buffer);
  if (isCBR(filePath)) return await listRarImages(buffer);
  throw new Error(`Unsupported format: ${filePath}`);
}

/**
 * Extract all pages to cacheDir/{comicId}/ and return page count.
 */
async function extractAllPages(filePath, buffer, cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });

  let pages;
  if (isCBZ(filePath))      pages = extractZipAll(buffer);
  else if (isCBR(filePath)) pages = await extractRarAll(buffer);
  else throw new Error(`Unsupported: ${filePath}`);

  for (let i = 0; i < pages.length; i++) {
    const outName = `${String(i + 1).padStart(4, '0')}.jpg`;
    const outPath = path.join(cacheDir, outName);
    if (!fs.existsSync(outPath)) {
      await sharp(pages[i].data).jpeg({ quality: 90 }).toFile(outPath);
    }
  }
  return pages.length;
}

/**
 * Extract just the cover (first image) and save as a small JPEG thumbnail.
 */
async function extractCover(filePath, buffer, cachePath) {
  if (fs.existsSync(cachePath)) return; // already cached

  let firstData = null;

  if (isCBZ(filePath)) {
    const names = listZipImages(buffer);
    if (names.length) firstData = extractZipPage(buffer, names[0]);
  } else if (isCBR(filePath)) {
    const names = await listRarImages(buffer);
    if (names.length) firstData = await extractRarPage(buffer, names[0]);
  }

  if (firstData) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    await sharp(firstData)
      .resize(400, 580, { fit: 'cover', position: 'top' })
      .jpeg({ quality: 85 })
      .toFile(cachePath);
  }
}

module.exports = { listPages, extractAllPages, extractCover, isCBR, isCBZ };
