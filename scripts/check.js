'use strict';
// 構文チェックと、Electron に依存しない部分（保存・暗号化・上限 50 件）のテスト
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const files = ['src', 'src/renderer', 'scripts'].flatMap(d => fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.js')).map(f => path.join(root, d, f)));
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`構文チェック OK（${files.length} ファイル）`);

const vault = require('../src/vault');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  OK ${name}`); };
const empty = () => vault.normalizeData({});
const fake = { protect: b => Buffer.from(b.toString('base64')), unprotect: b => Buffer.from(b.toString(), 'base64') };

t('登録は 50 件まで（51 件目はエラー）', () => {
  const d = empty();
  for (let i = 0; i < 50; i++) vault.upsert(d, { name: `n${i}`, username: `u${i}`, password: `p${i}` });
  assert.strictEqual(d.entries.length, 50);
  assert.throws(() => vault.upsert(d, { name: 'over' }), /50 件まで/);
  // 上限でも既存の編集はできる
  const e = d.entries[3];
  vault.upsert(d, { ...e, password: 'changed' });
  assert.strictEqual(d.entries[3].password, 'changed');
  assert.strictEqual(d.entries.length, 50);
});

t('保存ファイルを直接いじって 51 件以上にしても 50 件に切り詰める', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `n${i}` }));
  assert.strictEqual(vault.normalizeData({ entries: many }).entries.length, 50);
});

t('表示名は必須・長さの上限・制御文字の除去', () => {
  const d = empty();
  assert.throws(() => vault.upsert(d, { name: '  ' }), /表示名/);
  const e = vault.upsert(d, { name: 'a'.repeat(80), password: 'x\u0000y', memo: 'l1\r\nl2' });
  assert.strictEqual(e.name.length, 50);
  assert.strictEqual(e.password, 'xy');
  assert.strictEqual(e.memo, 'l1\nl2');
});

t('削除と並べ替え', () => {
  const d = empty();
  const a = vault.upsert(d, { name: 'a' }), b = vault.upsert(d, { name: 'b' }), c = vault.upsert(d, { name: 'c' });
  assert.ok(vault.move(d, c.id, -1));
  assert.deepStrictEqual(d.entries.map(e => e.name), ['a', 'c', 'b']);
  assert.ok(!vault.move(d, a.id, -1));
  assert.ok(vault.remove(d, b.id));
  assert.deepStrictEqual(d.entries.map(e => e.name), ['a', 'c']);
});

t('画面に渡す一覧にパスワードを含めない', () => {
  const p = vault.publicEntry(vault.normalizeEntry({ name: 'a', password: 'secret' }));
  assert.ok(!('password' in p));
  assert.strictEqual(p.hasPassword, true);
});

t('保存ファイルの読み書き（マスターパスワードなし）', () => {
  const d = empty();
  vault.upsert(d, { name: 'サーバー', username: 'user', password: 'P@ss 日本語' });
  const text = vault.encodeFile(d, { ...fake, protection: 'test', master: null });
  const r = vault.decodeFile(text, fake);
  assert.strictEqual(r.data.entries[0].password, 'P@ss 日本語');
});

t('マスターパスワードあり: 正しいパスワードでのみ開ける・ファイルに平文が残らない', () => {
  const d = empty();
  vault.upsert(d, { name: 'x', password: 'TopSecret123' });
  const text = vault.encodeFile(d, { ...fake, protection: 'test', master: 'master-pw' });
  assert.ok(!Buffer.from(JSON.parse(text).payload, 'base64').toString().includes('TopSecret123'));
  const r = vault.decodeFile(text, fake);
  assert.ok(r.locked);
  assert.throws(() => vault.unlock(r.box, 'wrong'), /パスワードが違います/);
  assert.strictEqual(vault.unlock(r.box, 'master-pw').entries[0].password, 'TopSecret123');
});

t('バックアップの書き出し・読み込み（パスワード違いは拒否）', () => {
  const d = empty();
  vault.upsert(d, { name: 'a', username: 'u', password: 'p' });
  assert.throws(() => vault.exportBackup(d.entries, 'abc'), /4 文字以上/);
  const text = vault.exportBackup(d.entries, 'backup-pw');
  assert.ok(!text.includes('"p"'));
  assert.throws(() => vault.importBackup(text, 'nope'), /パスワードが違います/);
  assert.throws(() => vault.importBackup('{}', 'x'), /バックアップファイルではありません/);
  assert.strictEqual(vault.importBackup(text, 'backup-pw')[0].username, 'u');
});

t('読み込み: 追加・上書き・上限超過分のスキップ・置き換え', () => {
  const d = empty();
  for (let i = 0; i < 48; i++) vault.upsert(d, { name: `n${i}`, username: 'u' });
  const incoming = [{ name: 'n0', username: 'u', password: 'new' }, { name: 'x1' }, { name: 'x2' }, { name: 'x3' }];
  assert.deepStrictEqual(vault.merge(d, incoming, 'merge'), { added: 2, updated: 1, skipped: 1 });
  assert.strictEqual(d.entries.length, 50);
  assert.strictEqual(d.entries[0].password, 'new');
  assert.deepStrictEqual(vault.merge(d, incoming, 'replace'), { added: 4, updated: 0, skipped: 0 });
  assert.strictEqual(d.entries.length, 4);
});

t('設定の補正', () => {
  const s = vault.normalizeSettings({ clearClipboard: 99999, autoLock: -3, hotkey: ' Ctrl+Alt+K ' });
  assert.strictEqual(s.clearClipboard, 600);
  assert.strictEqual(s.autoLock, 0);
  assert.strictEqual(s.hotkey, 'Ctrl+Alt+K');
  assert.strictEqual(vault.normalizeSettings({}).clearClipboard, 30);
});

t('書き込みは一時ファイル経由で置き換える', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  const f = path.join(dir, 'sub', 'vault.json');
  vault.writeAtomic(f, 'a');
  vault.writeAtomic(f, 'b');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'b');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['vault.json']);
});

t('通信するコードが含まれていない（完全オフライン）', () => {
  const src = files.filter(f => f.includes(`${path.sep}src${path.sep}`)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!/\b(fetch|XMLHttpRequest|WebSocket|net\.request|require\(['"](https?|net|dgram|dns|tls)['"]\))/.test(src));
  assert.ok(!/https?:\/\//.test(fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')));
});

console.log(`テスト OK（${n} 件）`);
