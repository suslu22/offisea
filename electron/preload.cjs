// Offisea önyükleme betiği: sayfaya yalnızca dar işlevler açar (dosya açma, kapanış bildirimi, güncelleme).
// ipcRenderer'ın kendisi asla sayfaya verilmez.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('offiseaDesktop', {
  platform: 'windows',
  onOpenFile(cb) {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('open-file', (_e, file) => {
      if (!file || typeof file.name !== 'string' || !(file.data instanceof ArrayBuffer || ArrayBuffer.isView(file.data))) return;
      cb({ name: file.name.slice(0, 255), data: file.data });
    });
    ipcRenderer.send('renderer-ready');
  },
  // Dosyasız güncelleme: yalnızca bu beş dar işlem açılır.
  update: {
    info: () => ipcRenderer.invoke('update:info'),
    check: () => ipcRenderer.invoke('update:check'),
    confirm: (build) => ipcRenderer.invoke('update:confirm', Number(build)),
    applyNow: () => ipcRenderer.invoke('update:apply'),
    reset: () => ipcRenderer.invoke('update:reset'),
  },
  onCloseRequest(cb) {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('close-request', () => {
      let p;
      try { p = Promise.resolve(cb()); } catch { p = Promise.resolve(); }
      p.catch(() => {}).finally(() => ipcRenderer.send('close-ok'));
    });
  },
});
