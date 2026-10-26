'use strict';
// 登録情報（ID・パスワード）と設定の保存・暗号化。Electron に依存しない（テストできるように）
//  - 保存ファイルは Windows の DPAPI（Electron の safeStorage）で暗号化する。ログインしている Windows ユーザーでしか読めない
//  - マスターパスワードを設定すると、さらに AES-256-GCM（鍵は scrypt で作る）で暗号化する
//  - バックアップ（書き出し）はパスワードで暗号化したファイルにする。別の PC・別のユーザーでも読み込める
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 50;
const LIMITS = { name: 50, username: 256, password: 256, group: 30, memo: 500 };
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const FILE_VERSION = 1;

const DEFAULT_SETTINGS = {
  hotkey: 'Ctrl+Alt+P',      // 一覧画面を開く・閉じる
  alwaysOnTop: false,        // 一覧画面を常に最前面に表示する
  hideAfterCopy: false,      // コピーしたら一覧画面を隠す
  clearClipboard: 30,        // コピーしたパスワードを消すまでの秒数（0 で消さない）
  autoLock: 0,               // マスターパスワード使用時、操作がない状態が続いたらロックする分数（0 でしない）
  startWithWindows: false,
  showOnStart: true          // 起動したときに一覧画面を開く
};

const newId = () => crypto.randomBytes(8).toString('hex');
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
const int = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const name = str(e.name, LIMITS.name).trim();
  if (!name) return null;
  return {
    id: /^[0-9a-f]{16}$/.test(e.id) ? e.id : newId(),
    name,
    username: str(e.username, LIMITS.username),
    password: str(e.password, LIMITS.password),
    group: str(e.group, LIMITS.group).trim(),
    memo: str(e.memo, LIMITS.memo).replace(/\r\n?/g, '\n'),
    updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date().toISOString()
  };
}

function normalizeSettings(s) {
  s = Object.assign({}, DEFAULT_SETTINGS, s && typeof s === 'object' ? s : {});
  return {
    hotkey: str(s.hotkey, 40).trim(),
    alwaysOnTop: !!s.alwaysOnTop,
    hideAfterCopy: !!s.hideAfterCopy,
    clearClipboard: int(s.clearClipboard, 0, 600, DEFAULT_SETTINGS.clearClipboard),
    autoLock: int(s.autoLock, 0, 240, 0),
    startWithWindows: !!s.startWithWindows,
    showOnStart: !!s.showOnStart
  };
}

// 中身（平文）: { entries, settings }
function normalizeData(d) {
  const entries = [];
  const seen = new Set();
  for (const e of Array.isArray(d && d.entries) ? d.entries : []) {
    const n = normalizeEntry(e);
    if (!n) continue;
    if (seen.has(n.id)) n.id = newId();
    seen.add(n.id);
    entries.push(n);
    if (entries.length >= MAX_ENTRIES) break;
  }
  return { entries, settings: normalizeSettings(d && d.settings) };
}

// ---------- 登録情報の操作（上限 50 件を必ずここで守る） ----------
function upsert(data, entry) {
  const n = normalizeEntry(entry);
  if (!n) throw new Error('表示名を入力してください。');
  const i = data.entries.findIndex(e => e.id === entry.id);
  n.updatedAt = new Date().toISOString();
  if (i >= 0) {
    data.entries[i] = n;
  } else {
    if (data.entries.length >= MAX_ENTRIES) throw new Error(`登録できるのは ${MAX_ENTRIES} 件までです。不要なものを削除してから追加してください。`);
    n.id = newId();
    data.entries.push(n);
  }
  return n;
}

function remove(data, id) {
  const i = data.entries.findIndex(e => e.id === id);
  if (i >= 0) data.entries.splice(i, 1);
  return i >= 0;
}

function move(data, id, delta) {
  const i = data.entries.findIndex(e => e.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= data.entries.length) return false;
  const [e] = data.entries.splice(i, 1);
  data.entries.splice(j, 0, e);
  return true;
}

// 読み込んだ登録情報を足す。同じ表示名・同じ ID のものは上書きし、50 件を超える分は取り込まない
function merge(data, incoming, mode) {
  const list = normalizeData({ entries: incoming }).entries;
  if (mode === 'replace') {
    data.entries = list.map(e => Object.assign(e, { id: newId() }));
    return { added: data.entries.length, updated: 0, skipped: 0 };
  }
  let added = 0, updated = 0, skipped = 0;
  for (const e of list) {
    const same = data.entries.find(x => x.name === e.name && x.username === e.username);
    if (same) { Object.assign(same, e, { id: same.id }); updated++; continue; }
    if (data.entries.length >= MAX_ENTRIES) { skipped++; continue; }
    data.entries.push(Object.assign(e, { id: newId() }));
    added++;
  }
  return { added, updated, skipped };
}

// 画面に渡す一覧（パスワードは渡さない）
function publicEntry(e) {
  const { password, ...rest } = e;
  return Object.assign(rest, { hasPassword: !!password });
}

// ---------- 暗号化 ----------
function deriveKey(password, salt) {
  return crypto.scryptSync(String(password).normalize('NFC'), salt, 32, SCRYPT);
}

function seal(obj, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: body.toString('base64') };
}

function open(box, password) {
  const key = deriveKey(password, Buffer.from(box.salt, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  try {
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  } catch {
    const err = new Error('パスワードが違います。');
    err.code = 'BAD_PASSWORD';
    throw err;
  }
}

// protect / unprotect は Buffer を受けて Buffer を返す関数（Electron では safeStorage = DPAPI）
// 保存ファイル: { app, version, protection, master, payload }
function encodeFile(data, { protect, protection, master }) {
  const inner = master ? { master: true, box: seal(data, master) } : { master: false, data };
  const payload = protect(Buffer.from(JSON.stringify(inner), 'utf8')).toString('base64');
  return JSON.stringify({ app: 'PassCopy', version: FILE_VERSION, protection, master: !!master, payload }, null, 2);
}

// 戻り値: { data } または マスターパスワードが必要なときは { locked: true, box }
function decodeFile(text, { unprotect }) {
  const file = JSON.parse(text);
  if (!file || file.app !== 'PassCopy' || typeof file.payload !== 'string') throw new Error('PassCopy の保存ファイルではありません。');
  const inner = JSON.parse(unprotect(Buffer.from(file.payload, 'base64')).toString('utf8'));
  if (inner.master) return { locked: true, box: inner.box };
  return { data: normalizeData(inner.data) };
}

function unlock(box, master) {
  return normalizeData(open(box, master));
}

// ---------- バックアップ（書き出し・読み込み） ----------
function exportBackup(entries, password) {
  if (!password || String(password).length < 4) throw new Error('バックアップのパスワードは 4 文字以上にしてください。');
  return JSON.stringify({ app: 'PassCopy-backup', version: FILE_VERSION, createdAt: new Date().toISOString(), box: seal({ entries }, password) }, null, 2);
}

function importBackup(text, password) {
  let file;
  try { file = JSON.parse(text); } catch { throw new Error('バックアップファイルを読み取れませんでした。'); }
  if (!file || file.app !== 'PassCopy-backup' || !file.box) throw new Error('PassCopy のバックアップファイルではありません。');
  const inner = open(file.box, password);
  return normalizeData(inner).entries;
}

// 書き込み途中で落ちても壊れないよう、一時ファイルに書いてから置き換える
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = {
  MAX_ENTRIES, LIMITS, DEFAULT_SETTINGS,
  newId, normalizeEntry, normalizeSettings, normalizeData,
  upsert, remove, move, merge, publicEntry,
  seal, open, encodeFile, decodeFile, unlock, exportBackup, importBackup, writeAtomic
};
