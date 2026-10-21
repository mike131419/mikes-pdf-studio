// Lets the editor receive PDFs that Windows opens with this app, and use the PC's fonts. Nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pdfStudioHost', {
  onOpenFiles(cb) {
    ipcRenderer.removeAllListeners('open-files');
    ipcRenderer.on('open-files', (_e, files) => cb(files.map(f => ({ name: String(f.name), data: new Uint8Array(f.data) }))));
    ipcRenderer.send('renderer-ready');
  },
  fonts: {
    list: () => ipcRenderer.invoke('fonts:list'),
    read: (file, index) => ipcRenderer.invoke('fonts:read', file, index),
    download: (family, weight, italic) => ipcRenderer.invoke('fonts:download', family, weight, italic),
  },
});
