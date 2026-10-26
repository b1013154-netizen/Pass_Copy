'use strict';
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, dialog, nativeImage, clipboard, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const vault = require('./vault');

if (process.env.PC_USERDATA) app.setPath('userData', process.env.PC_USERDATA);
if (!app.requestSingleInstanceLock()) app.quit();

const DATA_FILE = () => path.join(app.getPath('userData'), 'vault.json');
const ASSET = name => path.join(__dirname, '..', 'build', name);
const DOCS_DIR = () => (app.isPackaged ? path.join(process.resourcesPath, 'docs') : path.join(__dirname, '..', 'docs'));

let data = { entries: [], settings: vault.normalizeSettings({}) };
let master = null;      // マスターパスワード（設定時のみ。メモリ上にだけ持つ）
let lockedBox = null;   // ロック中の暗号化データ
let loadError = null;
let win = null;
let tray = null;
let quitting = false;
let hotkeyError = '';
let clearTimer = null;
let lockTimer = null;

// ---------- 保存（DPAPI で暗号化） ----------
const protection = () => (safeStorage.isEncryptionAvailable() ? 'dpapi' : 'none');
const codec = {
  protect: buf => (protection() === 'dpapi' ? safeStorage.encryptString(buf.toString('utf8')) : buf),
  unprotect: (buf, kind) => (kind === 'dpapi' ? Buffer.from(safeStorage.decryptString(buf), 'utf8') : buf)
};

function load() {
  const file = DATA_FILE();
  if (!fs.existsSync(file)) return;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const kind = JSON.parse(text).protection;
    const r = vault.decodeFile(text, { unprotect: buf => codec.unprotect(buf, kind) });
    if (r.locked) lockedBox = r.box;
    else data = r.data;
  } catch (e) {
    // 読めないファイルは上書きしないよう退避する
    loadError = `保存データを読み込めませんでした（${e.message}）。元のファイルは vault.broken-*.json として残しました。`;
    try { fs.copyFileSync(file, path.join(path.dirname(file), `vault.broken-${Date.now()}.json`)); } catch {}
  }
}

function persist() {
  if (lockedBox) return;
  vault.writeAtomic(DATA_FILE(), vault.encodeFile(data, { protect: codec.protect, protection: protection(), master }));
}

const isLocked = () => !!lockedBox;

function lock() {
  if (!master) return;
  persist();
  lockedBox = vault.seal(data, master);
  data = { entries: [], settings: data.settings };
  master = null;
  pushState();
  updateTray();
}

function touch() {
  clearTimeout(lockTimer);
  const m = data.settings.autoLock;
  if (master && m > 0) lockTimer = setTimeout(lock, m * 60000);
}

// ---------- 画面へ渡す状態 ----------
function state() {
  return {
    locked: isLocked(),
    entries: isLocked() ? [] : data.entries.map(vault.publicEntry),
    settings: data.settings,
    max: vault.MAX_ENTRIES,
    hasMaster: !!master || isLocked(),
    protection: protection(),
    hotkeyError,
    loadError,
    version: app.getVersion(),
    platform: process.platform
  };
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', state());
}

function toast(message, kind = 'info') {
  if (win && !win.isDestroyed()) win.webContents.send('toast', { message, kind });
}

// ---------- 一覧画面 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 560, height: 680, minWidth: 420, minHeight: 420,
    show: false,
    title: 'PassCopy',
    icon: ASSET('icon.png'),
    autoHideMenuBar: true,
    alwaysOnTop: data.settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.once('ready-to-show', () => {
    if (data.settings.showOnStart || isLocked() || process.env.PC_SHOTS) showWindow();
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toggleWindow() {
  if (win && win.isVisible() && win.isFocused()) win.hide();
  else showWindow();
}

// ---------- タスクトレイ・ショートカット ----------
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '一覧を開く', click: showWindow },
    { label: 'ロックする', enabled: !!master, click: lock },
    { type: 'separator' },
    { label: '終了', click: () => { quitting = true; app.quit(); } }
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(ASSET('tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('PassCopy');
  tray.on('click', toggleWindow);
  updateTray();
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  hotkeyError = '';
  const key = data.settings.hotkey;
  if (!key) return;
  try {
    if (!globalShortcut.register(key.replace(/Ctrl/g, 'CommandOrControl'), toggleWindow)) hotkeyError = `ショートカット「${key}」は他のアプリが使っているため登録できませんでした。`;
  } catch {
    hotkeyError = `ショートカット「${key}」の書き方が正しくありません。`;
  }
}

function applySettings() {
  registerHotkey();
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(data.settings.alwaysOnTop);
  if (process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE) {
    app.setLoginItemSettings({ openAtLogin: data.settings.startWithWindows });
  }
}

// ---------- コピー ----------
function copy(id, field) {
  if (isLocked()) throw new Error('ロック中です。');
  const e = data.entries.find(x => x.id === id);
  if (!e) throw new Error('登録情報が見つかりません。');
  const value = field === 'password' ? e.password : e.username;
  if (!value) throw new Error(field === 'password' ? 'パスワードが登録されていません。' : 'ID が登録されていません。');
  clipboard.writeText(value);
  clearTimeout(clearTimer);
  const sec = data.settings.clearClipboard;
  // 一定時間たったら、まだ同じ内容のときだけクリップボードを空にする（その後に別の物をコピーしていたら触らない）
  if (field === 'password' && sec > 0) {
    clearTimer = setTimeout(() => { if (clipboard.readText() === value) clipboard.clear(); }, sec * 1000);
  }
  touch();
  if (data.settings.hideAfterCopy && win) setTimeout(() => win.hide(), 150);
  return { field, clearAfter: field === 'password' ? sec : 0 };
}

// ---------- 画面からの呼び出し ----------
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!win || e.sender !== win.webContents) throw new Error('不正な呼び出しです。');
    return fn(...args);
  });
}

function requireUnlocked() {
  if (isLocked()) throw new Error('ロック中です。マスターパスワードで解除してください。');
}

handle('state', () => state());

handle('entry:get', id => {
  requireUnlocked();
  touch();
  const e = data.entries.find(x => x.id === id);
  return e ? { ...e } : null;
});

handle('entry:save', entry => {
  requireUnlocked();
  const saved = vault.upsert(data, entry);
  persist();
  touch();
  pushState();
  return vault.publicEntry(saved);
});

handle('entry:delete', id => {
  requireUnlocked();
  vault.remove(data, id);
  persist();
  pushState();
});

handle('entry:move', (id, delta) => {
  requireUnlocked();
  if (vault.move(data, id, delta)) { persist(); pushState(); }
});

handle('copy', (id, field) => copy(id, field));

handle('settings:save', s => {
  data.settings = vault.normalizeSettings(Object.assign({}, data.settings, s));
  persist();
  applySettings();
  pushState();
  return state();
});

handle('master:set', (current, next) => {
  requireUnlocked();
  if (master && current !== master) throw new Error('現在のマスターパスワードが違います。');
  if (next && String(next).length < 4) throw new Error('マスターパスワードは 4 文字以上にしてください。');
  master = next || null;
  persist();
  touch();
  pushState();
  updateTray();
});

handle('unlock', password => {
  if (!lockedBox) return true;
  data = vault.unlock(lockedBox, password);
  lockedBox = null;
  master = password;
  applySettings();
  touch();
  pushState();
  updateTray();
  return true;
});

handle('lock', () => lock());

handle('backup:export', async password => {
  requireUnlocked();
  const text = vault.exportBackup(data.entries, password);
  const r = await dialog.showSaveDialog(win, {
    title: 'バックアップを書き出す',
    defaultPath: `PassCopy-backup-${new Date().toISOString().slice(0, 10)}.pcbak`,
    filters: [{ name: 'PassCopy バックアップ', extensions: ['pcbak'] }]
  });
  if (r.canceled || !r.filePath) return null;
  vault.writeAtomic(r.filePath, text);
  return r.filePath;
});

handle('backup:import', async (password, mode) => {
  requireUnlocked();
  const r = await dialog.showOpenDialog(win, {
    title: 'バックアップを読み込む',
    properties: ['openFile'],
    filters: [{ name: 'PassCopy バックアップ', extensions: ['pcbak'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const entries = vault.importBackup(fs.readFileSync(r.filePaths[0], 'utf8'), password);
  const result = vault.merge(data, entries, mode === 'replace' ? 'replace' : 'merge');
  persist();
  pushState();
  return result;
});

handle('docs:read', () => {
  const file = path.join(DOCS_DIR(), '使い方説明書.md');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '説明書が見つかりませんでした。';
});

// ---------- 完全オフライン ----------
// 画面は同梱のファイルだけを表示し、外部への通信はすべて止める
function enforceOffline() {
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const ok = /^(file|devtools|data|blob|chrome-extension):/i.test(details.url);
    cb({ cancel: !ok });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', e => e.preventDefault());
  });
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // 終了時にパスワードがクリップボードに残らないようにする
  if (clearTimer) {
    const text = clipboard.readText();
    if (data.entries.some(e => e.password && e.password === text)) clipboard.clear();
  }
});

app.whenReady().then(async () => {
  enforceOffline();
  load();
  createTray();
  applySettings();
  createWindow();
  if (process.env.PC_SHOTS) return require('../scripts/shots')({ app, getWin: () => win, data, vault, pushState, lock: () => { master = 'demo'; lock(); } });
  if (process.argv.includes('--smoke')) return require('../scripts/smoke')({ app, getWin: () => win, copy, getData: () => data, vault, persist, DATA_FILE, protection });
});
