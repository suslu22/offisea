// pdf.js ortak ayarları. Güvenlik: PDF içi JavaScript yüklenmez, XFA ve WebAssembly kapalı,
// eval kullanılmaz (pdf.js 6.x; CVE-2024-4367 bu sürümlerde kapalı).
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetUrl = (p) => new URL(p, document.baseURI).href;

/** pdf.js yükleme görevi. Veri kopyalanır; pdf.js arabelleği işçiye aktarıp boşaltır. */
export function loadPdfJs(bytes, { password } = {}) {
  return pdfjs.getDocument({
    data: new Uint8Array(bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes.slice()),
    password,
    enableXfa: false,
    useWasm: false,
    isEvalSupported: false,
    disableAutoFetch: true,
    stopAtErrors: false,
    cMapUrl: assetUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('pdfjs/standard_fonts/'),
    wasmUrl: assetUrl('pdfjs/wasm/'),
    iccUrl: assetUrl('pdfjs/iccs/'),
  });
}

export { pdfjs };
