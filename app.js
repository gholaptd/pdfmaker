import { buildPdf } from './pdf.js';

const MAX_SOURCE = 4000; // longest side kept in memory (stays under iOS canvas limits)
const THUMB = 400;
const JPEG_QUALITY = 0.85;

const $ = (id) => document.getElementById(id);
const els = {
  count: $('count'), empty: $('empty'), pages: $('pages'),
  cameraBtn: $('cameraBtn'), libraryBtn: $('libraryBtn'),
  nativeCamera: $('nativeCamera'), library: $('library'),
  fileName: $('fileName'), pageSize: $('pageSize'), margin: $('margin'), quality: $('quality'),
  clearBtn: $('clearBtn'), makePdfBtn: $('makePdfBtn'),
  camera: $('camera'), video: $('video'), shutter: $('shutter'), camClose: $('camClose'),
  camCount: $('camCount'), flash: $('flash'),
  busy: $('busy'), busyText: $('busyText'),
};

/** @type {Array<{id: number, source: Blob, rotation: number, thumbUrl: string}>} */
let pages = [];
let nextId = 1;
let stream = null;

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
  const page = { id: nextId++, source, rotation: 0, thumbUrl: '' };
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

async function refreshThumb(page) {
  const { blob } = await renderBlob(page.source, page.rotation, THUMB, 0.7);
  if (page.thumbUrl) URL.revokeObjectURL(page.thumbUrl);
  page.thumbUrl = URL.createObjectURL(blob);
}

function removePage(id) {
  const i = pages.findIndex((p) => p.id === id);
  if (i < 0) return;
  URL.revokeObjectURL(pages[i].thumbUrl);
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
  await refreshThumb(page);
  render();
}

function render() {
  els.pages.innerHTML = '';
  pages.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = 'page';
    li.innerHTML = `
      <div class="thumb"><img alt="Page ${i + 1}"><span class="num">${i + 1}</span></div>
      <div class="tools">
        <button data-act="up" aria-label="Move earlier" ${i === 0 ? 'disabled' : ''}>◀︎</button>
        <button data-act="rotate" aria-label="Rotate">⟳</button>
        <button data-act="down" aria-label="Move later" ${i === pages.length - 1 ? 'disabled' : ''}>▶︎</button>
        <button data-act="delete" aria-label="Delete">🗑</button>
      </div>`;
    li.querySelector('img').src = p.thumbUrl;
    li.querySelector('.tools').addEventListener('click', (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'up') movePage(p.id, -1);
      else if (act === 'down') movePage(p.id, 1);
      else if (act === 'rotate') rotatePage(p.id);
      else if (act === 'delete') removePage(p.id);
    });
    els.pages.appendChild(li);
  });

  const n = pages.length;
  els.count.textContent = `${n} page${n === 1 ? '' : 's'}`;
  els.empty.hidden = n > 0;
  els.makePdfBtn.disabled = n === 0;
  els.clearBtn.disabled = n === 0;
  els.camCount.textContent = n;
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
  const maxSide = Number(els.quality.value);
  const images = [];
  try {
    for (let i = 0; i < pages.length; i++) {
      showBusy(`Preparing page ${i + 1} of ${pages.length}…`);
      const p = pages[i];
      const { blob, width, height } = await renderBlob(p.source, p.rotation, maxSide, JPEG_QUALITY);
      images.push({ bytes: new Uint8Array(await blob.arrayBuffer()), width, height });
    }
    showBusy('Building PDF…');
    const pdf = buildPdf(images, { pageSize: els.pageSize.value, margin: Number(els.margin.value) });
    const name = (els.fileName.value.trim() || 'scan').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.pdf$/i, '') + '.pdf';
    hideBusy();
    await deliver(pdf, name);
  } catch (err) {
    hideBusy();
    if (err.name !== 'AbortError') alert('Could not create PDF: ' + err.message);
  }
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
  pages.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
  pages = [];
  render();
});
els.makePdfBtn.addEventListener('click', makePdf);
document.addEventListener('visibilitychange', () => { if (document.hidden && stream) closeCamera(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

render();
