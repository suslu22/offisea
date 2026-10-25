/* Offisea yazı tanıma işçisi (Tesseract, WebAssembly).
 * Yalnızca uygulamanın kendi dosyalarını (ocr/ klasörü) yükler; internete bağlanmaz.
 * Gelen: { id, type: 'recognize', image: ArrayBuffer (PNG/JPEG) }
 * Giden: { id, ok, text, words: [[x0, y0, x1, y1, güven, metin, blok, paragraf, satır]] } */
'use strict';

var BASE = new URL('./ocr/', self.location.href).href;
var ready = null;
var api = null;
var Module = null;

function fetchBytes(name) {
  return fetch(BASE + name, { credentials: 'same-origin' }).then(function (r) {
    if (!r.ok) throw new Error('Yazı tanıma dosyası yüklenemedi: ' + name);
    return r.arrayBuffer();
  });
}

// Dil verisi gzip ile sıkıştırılmış gelir; sunucu kendisi açmışsa olduğu gibi kullanılır.
function gunzip(buf) {
  var head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return Promise.resolve(buf);
  var ds = new DecompressionStream('gzip');
  var stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Response(stream).arrayBuffer();
}

function init() {
  if (ready) return ready;
  ready = (async function () {
    // SIMD desteği (Chrome 91+, Safari 16.4+); yoksa açık bir hata verilir
    var simd = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
    if (typeof WebAssembly !== 'object' || !WebAssembly.validate(simd)) throw new Error('Bu cihazın tarayıcısı yazı tanımayı desteklemiyor. Android System WebView’i güncelleyip tekrar deneyin.');
    var parts = await Promise.all([fetchBytes('tesseract-core-simd-lstm.wasm'), fetchBytes('tur.traineddata.bin').then(gunzip)]);
    importScripts(BASE + 'tesseract-core-simd-lstm.js');
    Module = await self.TesseractCore({
      wasmBinary: new Uint8Array(parts[0]),
      print: function () {},
      printErr: function () {},
    });
    Module.FS.writeFile('tur.traineddata', new Uint8Array(parts[1]));
    api = new Module.TessBaseAPI();
    if (api.Init(null, 'tur', 1) === -1) throw new Error('Yazı tanıma başlatılamadı.');
    api.SetVariable('user_defined_dpi', '300');
  })();
  ready.catch(function () { ready = null; });
  return ready;
}

function parseTsv(tsv) {
  var words = [];
  var lines = String(tsv || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var c = lines[i].split('\t');
    if (c.length < 12 || c[0] !== '5') continue;
    var text = c.slice(11).join('\t').trim();
    var conf = +c[10];
    if (!text || conf < 0) continue;
    var x = +c[6], y = +c[7], w = +c[8], hh = +c[9];
    words.push([x, y, x + w, y + hh, conf, text, +c[2], +c[3], +c[4]]);
  }
  return words;
}

self.onmessage = async function (e) {
  var msg = e.data || {};
  if (msg.type !== 'recognize' && msg.type !== 'init') return;
  try {
    await init();
    if (msg.type === 'init') { self.postMessage({ id: msg.id, ok: true }); return; }
    Module.FS.writeFile('/input', new Uint8Array(msg.image));
    if (api.SetImageFile(1, 0) === 1) throw new Error('Resim okunamadı.');
    api.Recognize(null);
    var words = parseTsv(api.GetTSVText());
    var text = api.GetUTF8Text();
    try { Module.FS.unlink('/input'); } catch (_) { /* yok say */ }
    self.postMessage({ id: msg.id, ok: true, text: text, words: words });
  } catch (err) {
    self.postMessage({ id: msg.id, ok: false, error: (err && err.message) || String(err) });
  }
};
