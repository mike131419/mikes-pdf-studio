# Developer notes

## Layout
- `src/` — the editor: `app.html`, `app.css`, `app.js` (UI; PDF.js renders, pdf-lib writes), `cjk.js` (Chinese text, subset-font embedding), `redact.js` (removes replaced originals from page content on save)
- `assets/` — `cjk.ttf` (WenQuanYi Zen Hei subset, built by `tools/make_cjk_font.py`) and its character map
- `vendor/` — pinned copies of pdfjs-dist 6.2.108 (legacy build, cmaps, fonts, wasm) and pdf-lib 1.17.1
- `build.mjs` — bundles everything into one offline file, `desktop/index.html`
- `desktop/` — Electron shell: `main.js` (window, "Open with" files, single instance, auto-update), `preload.js`,
  `fonts-host.js` (lists PC fonts, reads them, downloads + installs Google Fonts per-user), `sfnt.js` (font parser/subsetter/PDF embedder, also inlined into the editor)
- `src/fonts.js` — finds the original font for edited text (installed → download → metric-compatible free font)
- `tests/` — Playwright end-to-end scripts (need sample PDFs; `mk.cjs` makes simple ones)
- `tools/` — font subsetter, shortcut maker, exe icon/version patcher (used for the hand-made build only)

## Release
1. Bump `version` in `package.json`.
2. Commit and push to `main`.
3. The *Build Windows installer* workflow sees the new version and builds `MikesPDFStudio-Setup-X.Y.Z.exe` + `latest.yml` and publishes the GitHub Release.
   Installed copies pick the update up automatically (electron-updater, GitHub provider).

## Testing fonts
`tests/fonts.cjs text|scan` runs the real app shell (Linux Electron) with `PDFSTUDIO_FONT_DIRS`, `PDFSTUDIO_INSTALL_FONT_DIR` and a mock Google Fonts server (`tests/gfmock.cjs`, `PDFSTUDIO_GFONTS_URL`).

## Notes
- OCR uses tesseract.js 5.1.1 from jsDelivr, loaded on first use (needs internet once; then cached).
- Saved signatures/stamps live in the app's localStorage under `%APPDATA%\Mike's PDF Studio\`.
