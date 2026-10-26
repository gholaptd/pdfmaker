import { buildPdf } from './pdf.js';

const MAX_SOURCE = 4000; // longest side kept in memory (stays under iOS canvas limits)
const THUMB = 400;
const JPEG_QUALITY = 0.85;
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
};

/**
 * Photos are one page each. PDFs are a single item covering all of their pages.
 * @type {Array<
 *   {id: number, kind: 'photo', source: Blob, rotation: number, thumbUrl: string} |
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

/** Draws `src` (image/video/canvas) rotated and scaled so the longest side <= maxSide. */
function renderToCanvas(src, srcW, srcH, rotation, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const swap = rotation % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG has no alpha; avoid black backgrounds for transparent PNGs
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  return canvas;
}

async function renderBlob(blob, rotation, maxSide, quality) {
  const img = await loadImage(blob);
  const canvas = renderToCanvas(img, img.naturalWidth, img.naturalHeight, rotation, maxSide);
  const out = await canvasToBlob(canvas, quality);
  const result = { blob: out, width: canvas.width, height: canvas.height };
  canvas.width = canvas.height = 0; // release memory early on iOS
  return result;
}

// ---------- page management ----------

async function addSource(source) {
  const page = { id: nextId++, kind: 'photo', source, rotation: 0, thumbUrl: '' };
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
  const { blob } = await renderBlob(page.source, page.rotation, THUMB, 0.7);
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
    const { blob, width, height } = await renderBlob(p.source, p.rotation, maxSide, JPEG_QUALITY);
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
