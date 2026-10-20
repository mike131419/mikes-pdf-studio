# Mike's PDF Studio

An offline PDF editor for Windows, similar to Adobe Acrobat.

## Download

**[⬇ Download the latest installer](https://github.com/mike131419/mikes-pdf-studio/releases/latest)**: get `MikesPDFStudio-Setup-x.y.z.exe` under *Assets* and run it.

> Windows may show "Windows protected your PC" because the installer isn't code-signed.
> Click **More info → Run anyway**.

Once installed, the app updates itself: when a new version is released it downloads in the background and offers to restart.

## Features

- **View** PDFs; zoom; page thumbnails
- **Edit existing text and pictures** like in Word: click a paragraph and type, change font, size, bold, italic and colour; move, resize or delete pictures. Replaced text is really removed from the saved file.
- **Keeps the original font** when you edit: the PDF's font is found on your PC, or downloaded and installed automatically if it's a free (Google) font. Commercial fonts that aren't installed are replaced by a free font with identical letter widths (e.g. Calibri → Carlito).
- **OCR** for scanned pages (English, Malay, Chinese) turns scanned text into editable text, and the app works out which font the scan used by comparing the letters with the fonts on your PC. The engine downloads on first use.
- **Organize pages**: large page view (button or press **O**), preview size slider / Ctrl + mouse wheel, drag pages to reorder
- **Add text**, including Chinese (简体 / 繁體)
- **Signatures**: draw, type or upload a photo (paper background removed automatically)
- **Stamps**: stamp maker (APPROVED, PAID, LULUS, 已付款 …, rectangle or round chop with date and company name), or upload your company chop
- **Whiteout** and **highlight**
- **Pages**: drag to reorder, rotate, delete, extract or split to a new PDF
- **Merge**: open several PDFs at once, or add more to the current document
- Open PDFs from File Explorer (*Open with → Mike's PDF Studio*)
- Everything runs on your computer. Files are never uploaded.

## For developers

See [DEVELOPING.md](DEVELOPING.md). In short:

```
npm install
npm start          # run the app
npm run dist       # build the Windows installer into release/
```

To publish a release, bump `version` in `package.json` and push to `main`. GitHub Actions builds the installer and publishes release `v<version>`.

## Licences

Built with [Electron](https://www.electronjs.org/), [PDF.js](https://mozilla.github.io/pdf.js/) (Apache 2.0), [pdf-lib](https://pdf-lib.js.org/) (MIT), [Tesseract.js](https://tesseract.projectnaptha.com/) (Apache 2.0) and the WenQuanYi Zen Hei font (GPL v2 with font-embedding exception). See [`licenses/`](licenses/).
