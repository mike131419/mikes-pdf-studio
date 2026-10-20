// Lets the editor receive PDFs that Windows opens with this app. Nothing else is exposed.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pdfStudioHost', {
  onOpenFiles(cb) {
    ipcRenderer.removeAllListeners('open-files');
    ipcRenderer.on('open-files', (_e, files) => cb(files.map(f => ({ name: String(f.name), data: new Uint8Array(f.data) }))));
    ipcRenderer.send('renderer-ready');
  },
});
