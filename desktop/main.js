// Mike's PDF Studio — Windows app shell (Electron). The editor itself is index.html.
const { app, BrowserWindow, Menu, shell, dialog, ipcMain, net } = require('electron');
const { createFontService } = require('./fonts-host.js');
const path = require('path');
const fs = require('fs');

app.setName("Mike's PDF Studio");
app.setAppUserModelId('com.mike.pdfstudio');

// Keep saved signatures/stamps from the earlier "PDF Studio" build.
try {
  const appData = app.getPath('appData');
  const now = path.join(appData, "Mike's PDF Studio"), old = path.join(appData, 'PDF Studio');
  if (!fs.existsSync(now) && fs.existsSync(old)) fs.cpSync(old, now, { recursive: true });
  app.setPath('userData', now);
} catch (e) { console.error(e); }

if (!app.requestSingleInstanceLock()) { app.quit(); }

const MAX_BYTES = 500 * 1024 * 1024;
function pdfsFromArgs(argv, cwd) {
  return argv.slice(1)
    .filter(a => !a.startsWith('-') && /\.pdf$/i.test(a))
    .map(a => path.resolve(cwd || process.cwd(), a))
    .filter(p => { try { const s = fs.statSync(p); return s.isFile() && s.size <= MAX_BYTES; } catch { return false; } });
}
let win = null, pageReady = false, pending = [];
function sendFiles(paths) {
  if (!paths.length) return;
  if (!win || !pageReady) { pending.push(...paths); return; }
  const files = [];
  for (const p of paths) { try { files.push({ name: path.basename(p), data: fs.readFileSync(p) }); } catch (e) { console.error(e); } }
  if (files.length) win.webContents.send('open-files', files);
}
// Fonts: list installed fonts, read one, or download + install a free one (Google Fonts)
let fontSvc = null;
const fromApp = e => win && e.sender === win.webContents;
ipcMain.handle('fonts:list', e => fromApp(e) ? fontSvc.getList() : []);
ipcMain.handle('fonts:read', (e, file, index) => fromApp(e) ? fontSvc.read(String(file), Number(index) || 0) : null);
ipcMain.handle('fonts:download', (e, family, bold, italic) => fromApp(e) ? fontSvc.download(net, String(family), !!bold, !!italic) : null);

ipcMain.on('renderer-ready', e => {
  if (!win || e.sender !== win.webContents) return;
  pageReady = true; const p = pending; pending = []; sendFiles(p);
});

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, title: "Mike's PDF Studio", autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => { win.maximize(); win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('did-start-loading', () => { pageReady = false; });
  win.webContents.on('will-prevent-unload', e => {
    const choice = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1,
      title: "Mike's PDF Studio", message: 'You have unsaved changes.', detail: "Close Mike's PDF Studio anyway?" });
    if (choice === 0) e.preventDefault();
  });
}
app.on('second-instance', (e, argv, cwd) => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  sendFiles(pdfsFromArgs(argv, cwd));
});
app.whenReady().then(() => { fontSvc = createFontService(app); createWindow(); pending.push(...pdfsFromArgs(process.argv)); setupAutoUpdate(); });

// Automatic updates from GitHub Releases (only in the installed app made by the Setup.exe).
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; } // not present in hand-made builds
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', e => console.error('update check failed', e && e.message));
  autoUpdater.on('update-downloaded', info => {
    if (!win) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1, title: "Mike's PDF Studio",
      message: `Version ${info.version} is ready.`,
      detail: 'Restart now to use it, or it will be installed the next time you close the app. (Save your work first.)',
    });
    if (choice === 0) setImmediate(() => autoUpdater.quitAndInstall());
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 6 * 60 * 60 * 1000);
}
app.on('window-all-closed', () => app.quit());
