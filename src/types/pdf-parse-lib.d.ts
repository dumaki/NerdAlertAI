// ============================================================
// src/types/pdf-parse-lib.d.ts
// ============================================================
// Module declaration for pdf-parse/lib/pdf-parse.
//
// We import pdf-parse from its /lib path rather than the package
// root because pdf-parse's index.js has a debug-mode shim that
// runs at module-load time and tries to read a test fixture from
// disk. That fixture isn't shipped with the npm package, so the
// bare 'pdf-parse' import throws ENOENT at startup in production.
//
// @types/pdf-parse only declares types for the package root, not
// the /lib path, so this file fills the gap with the same shape.
// ============================================================

declare module 'pdf-parse/lib/pdf-parse' {
  interface PDFData {
    text:      string;
    numpages:  number;
    numrender: number;
    info?:     Record<string, unknown>;
    metadata?: unknown;
    version?:  string;
  }

  function pdf(buffer: Buffer): Promise<PDFData>;
  export default pdf;
}
