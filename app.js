import { buildPdf } from './pdf.js';

const MAX_SOURCE = 4000; // longest side kept in memory (stays under iOS canvas limits)
const THUMB = 400;
const JPEG_QUALITY = 0.85;
const CROP_PREVIEW = 1600;
const MIN_CROP = 0.05; // smallest crop side, as a fraction of the image
const FULL = { x: 0, y: 0, w: 1, h: 1 };
const PDF_LIB_URL = './vendor/pdf-lib.esm.min.js';

const $ = (id) => document.getElementById(id);
const els = {
  count: $('count'), empty: $('empty'), pages: $('pages'),
  cameraBtn: $('cameraBtn'), libraryBtn: $('libraryBtn'),
  pdfBtn: $('pdfBtn'),
  nativeCamera: $('nativeCamera'), library: $('library'), pdfInput: $('pdfInput'),
  fileName: $('fileName'), pageSize: $('pageSize'), margin: $('margin'), quality: $('quality'),
  clearBtn: $('clearBtn'), makePdfBtn: $('makePdfBtn'),
  camera: $('camera'), video: $('video'), shutter: $('shutter'), camClose: $('camClose'),
  camCount: $('camCount'), flash: $('flash'),
  busy: $('busy'), busyText: $('busyText'),
  cropper: $('cropper'), cropStage: $('cropStage'), cropFrame: $('cropFrame'), cropImg: $('cropImg'),
  cropBox: $('cropBox'), cropCancel: $('cropCancel'), cropReset: $('cropReset'), cropDone: $('cropDone'),
};

/**
 * Photos are one page each. PDFs are a single item covering all of their pages.
 * A photo's crop is a fraction of the rotated image (null = uncropped).
 * @type {Array<
 *   {id: number, kind: 'photo', source: Blob, rotation: number, crop: ?{x: number, y: number, w: number, h: number}, thumbUrl: string} |
 *   {id: number, kind: 'pdf', bytes: Uint8Array, name: string, pageCount: number, rotation: number}
 * >}
 */
let pages = [];
let nextId = 1;
let stream = null;
let pdfLib = null;

/** Loads pdf-lib on first use so photo-only sessions never pay for it. */
async function loadPdfLib() {
  pdfLib ??= import(PDF_LIB_URL).catch((err) => { pdfLib = null; throw err; });
  return pdfLib;
}

// ---------- image helpers ----------

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

function canvasToBlob(canvas, quality = JPEG_QUALITY) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), 'image/jpeg', quality)
  );
}

/**
 * Draws `src` (image/video/canvas) rotated, then cropped to `crop` (fractions of the
 * rotated image), and scaled so the longest side of the result <= maxSide.
 */
function renderToCanvas(src, srcW, srcH, rotation, maxSide, crop = FULL) {
  const swap = rotation % 180 !== 0;
  const rw = swap ? srcH : srcW; // rotated size
  const rh = swap ? srcW : srcH;
  const cw = crop.w * rw;
  const ch = crop.h * rh;
  const scale = Math.min(1, maxSide / Math.max(cw, ch));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cw * scale));
  canvas.height = Math.max(1, Math.round(ch * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no alpha; avoid black backgrounds for transparent PNGs
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.translate(rw / 2 - crop.x * rw, rh / 2 - crop.y * rh);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(src, -srcW / 2, -srcH / 2, srcW, srcH);
  return canvas;
}

async function renderBlob(blob, rotation, maxSide, quality, crop) {
  const img = await loadImage(blob);
  const canvas = renderToCanvas(img, img.naturalWidth, img.naturalHeight, rotation, maxSide, crop || FULL);
  const out = await canvasToBlob(canvas, quality);
  const result = { blob: out, width: canvas.width, height: canvas.height };
  canvas.width = canvas.height = 0; // release memory early on iOS
  return result;
}

// ---------- page management ----------

async function addSource(source) {
  const page = { id: nextId++, kind: 'photo', source, rotation: 0, crop: null, thumbUrl: '' };
  await refreshThumb(page);
  pages.push(page);
  render();
}

async function addFiles(files) {
  if (!files.length) return;
  showBusy(`Adding ${files.length} photo${files.length > 1 ? 's' : ''}…`);
  try {
    for (const file of files) {
      // Normalize (HEIC/PNG/huge JPEG) to a bounded JPEG with orientation baked in.
      const { blob } = await renderBlob(file, 0, MAX_SOURCE, 0.92);
      await addSource(blob);
    }
  } catch (err) {
    alert(err.message);
  } finally {
    hideBusy();
  }
}

async function addPdfs(files) {
  if (!files.length) return;
  showBusy(`Adding ${files.length} PDF${files.length > 1 ? 's' : ''}…`);
  const failed = [];
  try {
    const { PDFDocument } = await loadPdfLib();
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const doc = await PDFDocument.load(bytes);
        pages.push({ id: nextId++, kind: 'pdf', bytes, name: file.name, pageCount: doc.getPageCount(), rotation: 0 });
        render();
      } catch (err) {
        const reason = /encrypted/i.test(err.message) ? 'password protected' : 'not a readable PDF';
        failed.push(`${file.name} (${reason})`);
      }
    }
  } catch (err) {
    alert('Could not load the PDF tools: ' + err.message);
  } finally {
    hideBusy();
  }
  if (failed.length) alert('Skipped:\n' + failed.join('\n'));
}

async function refreshThumb(page) {
  const { blob } = await renderBlob(page.source, page.rotation, THUMB, 0.7, page.crop);
  if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
  page.thumbUrl = URL.createObjectURL(blob);
}

function removePage(id) {
  const i = pages.findIndex((p) => p.id === id);
  if (i < 0) return;
  if (pages[i].thumbUrl) URL.revokeObjectURL(pages[i].thumbUrl);
  pages.splice(i, 1);
  render();
}

function movePage(id, delta) {
  const i = pages.findIndex((p) => p.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= pages.length) return;
  [pages[i], pages[j]] = [pages[j], pages[i]];
  render();
}

async function rotatePage(id) {
  const page = pages.find((p) => p.id === id);
  if (!page) return;
  page.rotation = (page.rotation + 90) % 360;
  if (page.crop) {
    // Keep the same region selected: rotating 90° clockwise maps (x, y) to (1 - y, x).
    const { x, y, w, h } = page.crop;
    page.crop = { x: 1 - (y + h), y: x, w: h, h: w };
  }
  if (page.kind === 'photo') await refreshThumb(page);
  render();
}

function render() {
  els.pages.innerHTML = '';
  let first = 1; // page number of this item in the final PDF
  pages.forEach((p, i) => {
    const count = p.kind === 'pdf' ? p.pageCount : 1;
    const label = count > 1 ? `${first}–${first + count - 1}` : `${first}`;
    first += count;
    const li = document.createElement('li');
    li.className = 'page';
    const thumb = p.kind === 'pdf'
      ? `<div class="thumb doc"><div class="doc-icon">📄</div><div class="doc-name"></div>
           <div class="doc-pages">${count} page${count === 1 ? '' : 's'}</div><span class="num">${label}</span></div>`
      : `<div class="thumb"><img alt="Page ${label}"><span class="num">${label}</span></div>`;
    li.innerHTML = `
      ${thumb}
      <div class="tools">
        <button data-act="up" aria-label="Move earlier" ${i === 0 ? 'disabled' : ''}>◀︎</button>
        <button data-act="rotate" aria-label="Rotate">⟳</button>
        ${p.kind === 'photo' ? '<button data-act="crop" aria-label="Crop">✂︎</button>' : ''}
        <button data-act="down" aria-label="Move later" ${i === pages.length - 1 ? 'disabled' : ''}>▶︎</button>
        <button data-act="delete" aria-label="Delete">🗑</button>
      </div>`;
    if (p.kind === 'pdf') {
      li.querySelector('.doc-name').textContent = p.name;
      li.querySelector('.doc-icon').style.transform = `rotate(${p.rotation}deg)`;
    } else {
      li.querySelector('img').src = p.thumbUrl;
    }
    li.querySelector('.tools').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'up') movePage(p.id, -1);
      else if (act === 'down') movePage(p.id, 1);
      else if (act === 'rotate') rotatePage(p.id);
      else if (act === 'crop') openCropper(p.id);
      else if (act === 'delete') removePage(p.id);
    });
    els.pages.appendChild(li);
  });

  const n = first - 1;
  els.count.textContent = `${n} page${n === 1 ? '' : 's'}`;
  els.empty.hidden = n > 0;
  els.makePdfBtn.disabled = n === 0;
  els.clearBtn.disabled = n === 0;
  els.camCount.textContent = pages.filter((p) => p.kind === 'photo').length;
}

// ---------- crop editor ----------

/** @type {?{page: object, rect: {x: number, y: number, w: number, h: number}, url: string, aspect: number}} */
let cropping = null;
let cropDrag = null;

async function openCropper(id) {
  const page = pages.find((p) => p.id === id);
  if (!page || page.kind !== 'photo') return;
  showBusy('Opening…');
  try {
    const { blob, width, height } = await renderBlob(page.source, page.rotation, CROP_PREVIEW, 0.85);
    cropping = { page, rect: { ...(page.crop || FULL) }, url: URL.createObjectURL(blob), aspect: width / height };
  } catch (err) {
    alert(err.message);
    return;
  } finally {
    hideBusy();
  }
  els.cropImg.src = cropping.url;
  els.cropper.hidden = false;
  layoutCropper();
}

function closeCropper() {
  if (cropping) URL.revokeObjectURL(cropping.url);
  cropping = null;
  cropDrag = null;
  els.cropImg.removeAttribute('src');
  els.cropper.hidden = true;
}

/** Sizes the frame to the largest box with the image's aspect ratio that fits the stage. */
function layoutCropper() {
  if (!cropping) return;
  const style = getComputedStyle(els.cropStage);
  const sw = els.cropStage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const sh = els.cropStage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  const w = Math.min(sw, sh * cropping.aspect);
  els.cropFrame.style.width = `${w}px`;
  els.cropFrame.style.height = `${w / cropping.aspect}px`;
  drawCropBox();
}

function drawCropBox() {
  const { x, y, w, h } = cropping.rect;
  Object.assign(els.cropBox.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });
}

function framePoint(e) {
  const r = els.cropFrame.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

els.cropFrame.addEventListener('pointerdown', (e) => {
  if (!cropping || !e.target.closest('.crop-box')) return;
  e.preventDefault();
  cropDrag = { handle: e.target.dataset.handle || 'move', start: framePoint(e), rect: { ...cropping.rect } };
  els.cropFrame.setPointerCapture(e.pointerId);
});

els.cropFrame.addEventListener('pointermove', (e) => {
  if (!cropDrag) return;
  const p = framePoint(e);
  const dx = p.x - cropDrag.start.x;
  const dy = p.y - cropDrag.start.y;
  const r = cropDrag.rect;
  if (cropDrag.handle === 'move') {
    cropping.rect = { ...r, x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h) };
  } else {
    // Handles are named by compass direction: n/s move the top/bottom edge, w/e the left/right.
    let left = r.x, top = r.y, right = r.x + r.w, bottom = r.y + r.h;
    const h = cropDrag.handle;
    if (h.includes('w')) left = clamp(left + dx, 0, right - MIN_CROP);
    if (h.includes('e')) right = clamp(right + dx, left + MIN_CROP, 1);
    if (h.includes('n')) top = clamp(top + dy, 0, bottom - MIN_CROP);
    if (h.includes('s')) bottom = clamp(bottom + dy, top + MIN_CROP, 1);
    cropping.rect = { x: left, y: top, w: right - left, h: bottom - top };
  }
  drawCropBox();
});

for (const type of ['pointerup', 'pointercancel']) els.cropFrame.addEventListener(type, () => { cropDrag = null; });

els.cropCancel.addEventListener('click', closeCropper);
els.cropReset.addEventListener('click', () => { cropping.rect = { ...FULL }; drawCropBox(); });
els.cropDone.addEventListener('click', async () => {
  const { page, rect } = cropping;
  closeCropper();
  const full = rect.x < 0.001 && rect.y < 0.001 && rect.w > 0.999 && rect.h > 0.999;
  page.crop = full ? null : rect;
  await refreshThumb(page);
  render();
});
window.addEventListener('resize', layoutCropper);

// ---------- in-app camera ----------

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    els.nativeCamera.click();
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (err) {
    // Permission denied or unavailable: fall back to the native iOS camera sheet.
    els.nativeCamera.click();
    return;
  }
  els.video.srcObject = stream;
  els.camera.hidden = false;
  await els.video.play().catch(() => {});
}

function closeCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
  els.camera.hidden = true;
}

async function takePicture() {
  const v = els.video;
  if (!v.videoWidth) return;
  els.flash.classList.add('on');
  requestAnimationFrame(() => requestAnimationFrame(() => els.flash.classList.remove('on')));
  const canvas = renderToCanvas(v, v.videoWidth, v.videoHeight, 0, MAX_SOURCE);
  const blob = await canvasToBlob(canvas, 0.92);
  canvas.width = canvas.height = 0;
  await addSource(blob);
}

// ---------- PDF ----------

async function makePdf() {
  if (!pages.length) return;
  try {
    const pdf = pages.some((p) => p.kind === 'pdf') ? await joinPdf() : await photosToPdf(pages);
    const name = (els.fileName.value.trim() || 'scan').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.pdf$/i, '') + '.pdf';
    hideBusy();
    await deliver(pdf, name);
  } catch (err) {
    hideBusy();
    if (err.name !== 'AbortError') alert('Could not create PDF: ' + err.message);
  }
}

/** Builds a PDF from photo items using the page size, margin, and quality options. */
async function photosToPdf(photos, progress = { done: 0, total: photos.length }) {
  const maxSide = Number(els.quality.value);
  const images = [];
  for (const p of photos) {
    showBusy(`Preparing page ${++progress.done} of ${progress.total}…`);
    const { blob, width, height } = await renderBlob(p.source, p.rotation, maxSide, JPEG_QUALITY, p.crop);
    images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width, height });
  }
  showBusy('Building PDF…');
  return buildPdf(images, { pageSize: els.pageSize.value, margin: Number(els.margin.value) });
}

/** Joins PDFs and runs of photos, in list order, into one PDF. */
async function joinPdf() {
  showBusy('Joining PDFs…');
  const { PDFDocument, degrees } = await loadPdfLib();
  const out = await PDFDocument.create();
  const progress = { done: 0, total: pages.filter((p) => p.kind === 'photo').length };

  const append = async (bytes, rotation) => {
    const src = await PDFDocument.load(bytes);
    for (const page of await out.copyPages(src, src.getPageIndices())) {
      if (rotation) page.setRotation(degrees((page.getRotation().angle + rotation) % 360));
      out.addPage(page);
    }
  };

  for (let i = 0; i < pages.length; ) {
    if (pages[i].kind === 'pdf') {
      showBusy(`Joining ${pages[i].name}…`);
      await append(pages[i].bytes, pages[i].rotation);
      i++;
    } else {
      // Consecutive photos go through the regular photo layout as one chunk.
      let j = i;
      while (j < pages.length && pages[j].kind === 'photo') j++;
      const chunk = await photosToPdf(pages.slice(i, j), progress);
      showBusy('Joining PDFs…');
      await append(new Uint8Array(await chunk.arrayBuffer()), 0);
      i = j;
    }
  }
  showBusy('Saving PDF…');
  return new Blob([await out.save()], { type: 'application/pdf' });
}

async function deliver(blob, name) {
  const file = new File([blob], name, { type: 'application/pdf' });
  // iOS share sheet lets the user "Save to Files", AirDrop, Mail, etc.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- misc ----------

function showBusy(text) { els.busyText.textContent = text; els.busy.hidden = false; }
function hideBusy() { els.busy.hidden = true; }

els.cameraBtn.addEventListener('click', openCamera);
els.libraryBtn.addEventListener('click', () => els.library.click());
els.pdfBtn.addEventListener('click', () => els.pdfInput.click());
els.pdfInput.addEventListener('change', async () => {
  await addPdfs([...els.pdfInput.files]);
  els.pdfInput.value = '';
});
els.shutter.addEventListener('click', takePicture);
els.camClose.addEventListener('click', closeCamera);
for (const input of [els.nativeCamera, els.library]) {
  input.addEventListener('change', async () => {
    await addFiles([...input.files]);
    input.value = '';
  });
}
els.clearBtn.addEventListener('click', () => {
  if (!confirm('Remove all pages?')) return;
  pages.forEach((p) => p.thumbUrl && URL.revokeObjectURL(p.thumbUrl));
  pages = [];
  render();
});
els.makePdfBtn.addEventListener('click', makePdf);
document.addEventListener('visibilitychange', () => { if (document.hidden && stream) closeCamera(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

render();
