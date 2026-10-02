# Deliverables

- `2026-09-14_client-progress-report/report.pdf` — client-facing progress report, visual-first (10 landscape pages: cover + one real app screen per page + status).
  - Screens: `node capture.mjs` (headless Chrome over CDP against the running dev server, 2x crisp, wizard state seeded via localStorage) → `img/s0*.jpg`
  - PDF: edit `report.html`, then `node build-pdf.mjs` (images inlined).
