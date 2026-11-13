# Changelog

All notable changes to Hidden Ink are documented here. The project follows [Semantic Versioning](https://semver.org/).

## 1.0.0 — 2026-11-13

First public release.

### Added

- Drop, paste and file-picker loading for PNG, JPEG, WebP, GIF and AVIF.
- A built-in PNG decoder that keeps colour under full transparency and exact low bits.
- Metadata extraction from PNG text chunks, JPEG EXIF/XMP/comments, WebP EXIF/XMP and GIF comments.
- Faint-content detection with a noise-adaptive threshold and WCAG contrast ratios.
- Transparency report and an alpha-dropped view for inspecting raw RGB values without compositing.
- Low-bit message probe in four layouts.
- Local Tesseract OCR of visible, amplified and alpha-dropped views, with hidden-line comparison, paragraph joining and noise trimming.
- Rule-based instruction scoring with highlighted phrases and explanations.
- Twelve lenses, numbered boxes, verdicts and finding cards.
- Clean copy export, JSON report and lens PNG export.
- Synthetic poisoned demo banner, unit tests, browser tests with real OCR, and CI.

### Reliability and inspection coverage

- Bound PNG decompression to validated scanline sizes and validate chunks, checksums, filters and image dimensions.
- Bound metadata extraction and preserve usable fields when other compressed fields are malformed.
- Handle grayscale/RGB `tRNS` transparency and distinguish raw, reduced-precision and browser-decoded inspection.
- Skip exact low-bit checks when source precision is unavailable; include coverage flags and warnings in JSON reports.
- Guard superseded file, OCR and lens results and reject oversized files before reading their bytes.
- Document English OCR/rule limits and clean-copy transformations without claiming guaranteed removal or agent safety.
