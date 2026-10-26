# Photo → PDF

A static web app that turns photos into a multi-page PDF and joins existing PDFs. Works on iPhone (Safari) and runs entirely in the browser. Photos never leave the device.

## Features
- **📷 Camera**: in-app camera. Tap the shutter repeatedly to capture many pages, then tap **Done**. If camera permission is denied, it falls back to the iOS camera sheet.
- **🖼️ Photos**: pick multiple images from the photo library (HEIC is converted automatically).
- **📄 PDFs**: add existing PDFs to join them, mixed in any order with photos. PDF pages are copied as-is (text stays selectable). Password-protected PDFs are skipped.
- Reorder (◀︎ ▶︎), rotate (⟳), crop (✂︎), and delete (🗑) pages. Rotating a PDF rotates all of its pages.
- **Crop**: drag the corners or edges to resize, or drag inside the box to move it. The original photo is kept, so you can re-crop or **Reset** later.
- Page size: A4, US Letter, or fit to photo. Margins and quality are adjustable.
- **Create PDF** opens the iOS share sheet so you can Save to Files, AirDrop, Mail, and so on.
- Installable: in Safari, tap Share → **Add to Home Screen**. Works offline after the first visit.

## Deploy to GitHub Pages
```bash
git init && git add . && git commit -m "Photo to PDF"
git branch -M main
git remote add origin https://github.com/<you>/pdfmaker.git
git push -u origin main
```
Then in the repo, go to **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick `main` and `/ (root)`, and save.
Open `https://<you>.github.io/pdfmaker/` on your iPhone.

The camera needs HTTPS. GitHub Pages provides it.

## Run locally
```bash
python3 -m http.server 8000   # then open http://localhost:8000
```
(The camera works on `localhost`. Other devices on your LAN need HTTPS for the camera.)

## Updating
After changing files, bump `VERSION` in `sw.js` so installed copies refresh their offline cache.

## Third-party code
`vendor/pdf-lib.esm.min.js` is [pdf-lib](https://github.com/Hopding/pdf-lib) 1.17.1 (MIT, see `vendor/LICENSE.md`), used only for joining PDFs. It loads on demand the first time a PDF is added.
