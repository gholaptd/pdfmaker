// Minimal dependency-free PDF writer that embeds JPEG images (one per page).

const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

/**
 * @param {Array<{bytes: Uint8Array, width: number, height: number}>} images
 * @param {{pageSize: 'fit'|'a4'|'letter', margin: number}} opts margin in points
 * @returns {Blob}
 */
export function buildPdf(images, opts = { pageSize: 'a4', margin: 0 }) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let offset = 0;

  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    chunks.push(bytes);
    offset += bytes.length;
  };
  const startObj = (num) => {
    offsets[num] = offset;
    push(`${num} 0 obj\n`);
  };
  const f = (n) => Number(n.toFixed(2));

  push('%PDF-1.4\n%âãÏÓ\n');

  const n = images.length;
  startObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const kids = images.map((_, i) => `${3 + 3 * i} 0 R`).join(' ');
  startObj(2);
  push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

  images.forEach((img, i) => {
    const pageNum = 3 + 3 * i;
    const imgNum = pageNum + 1;
    const contentNum = pageNum + 2;
    const margin = opts.margin || 0;

    let pw, ph;
    if (opts.pageSize === 'fit') {
      // Page matches image aspect ratio, normalized to A4 width.
      pw = PAGE_SIZES.a4[0] + 2 * margin;
      ph = (img.height * PAGE_SIZES.a4[0]) / img.width + 2 * margin;
    } else {
      [pw, ph] = PAGE_SIZES[opts.pageSize] || PAGE_SIZES.a4;
      if (img.width > img.height) [pw, ph] = [ph, pw]; // landscape image -> landscape page
    }

    const availW = pw - 2 * margin;
    const availH = ph - 2 * margin;
    const scale = Math.min(availW / img.width, availH / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const x = (pw - dw) / 2;
    const y = (ph - dh) / 2;

    startObj(pageNum);
    push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] ` +
        `/Resources << /XObject << /Im${i} ${imgNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`
    );

    startObj(imgNum);
    push(
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`
    );
    push(img.bytes);
    push('\nendstream\nendobj\n');

    const content = `q ${f(dw)} 0 0 ${f(dh)} ${f(x)} ${f(y)} cm /Im${i} Do Q`;
    startObj(contentNum);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
  });

  const total = 3 + 3 * n;
  const xrefPos = offset;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}
