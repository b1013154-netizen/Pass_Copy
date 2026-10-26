'use strict';
// Windows 上での動作確認（CI で `electron . --smoke` として実行する）
//  DPAPI での暗号化保存・上限 50 件・コピーとクリップボードの自動消去・マスターパスワード・通信の遮断を確かめる
const fs = require('fs');
const path = require('path');
const { clipboard } = require('electron');

const log = t => fs.writeSync(1, `${t}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function smoke({ app, getWin, copy, getData, vault, persist, DATA_FILE, protection }) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok });
    log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  };
  const tryCheck = async (name, fn) => {
    try { const r = await fn(); check(name, r !== false, typeof r === 'string' ? r : ''); } catch (e) { check(name, false, e.message); }
  };
  process.on('uncaughtException', e => log(`FAIL uncaughtException ${e.stack}`));

  await sleep(2000);
  const win = getWin();
  const data = getData();
  check('一覧画面が表示される', win && win.isVisible());
  if (process.platform === 'win32') check('DPAPI で暗号化できる', protection() === 'dpapi', protection());

  await tryCheck('50 件まで登録でき、51 件目は拒否される', () => {
    for (let i = 0; i < 50; i++) vault.upsert(data, { name: `smoke ${i}`, username: `user${i}`, password: `Pw-${i}-秘密 !"#$%` });
    try { vault.upsert(data, { name: 'over' }); return false; } catch (e) { return /50 件まで/.test(e.message) && data.entries.length === 50; }
  });

  persist();
  if (protection() === 'dpapi') await tryCheck('保存ファイルにパスワードが平文で残らない', () => {
    const text = fs.readFileSync(DATA_FILE(), 'utf8');
    return !text.includes('Pw-1-') && !Buffer.from(JSON.parse(text).payload, 'base64').toString('utf8').includes('Pw-1-');
  });

  const e0 = data.entries[0];
  await tryCheck('ID をコピーできる', () => { copy(e0.id, 'username'); return clipboard.readText() === e0.username; });

  data.settings.clearClipboard = 2;
  await tryCheck('パスワードをコピーできる（記号・日本語を含む）', () => { copy(e0.id, 'password'); return clipboard.readText() === e0.password; });
  await sleep(3000);
  check('設定した秒数でクリップボードが消える', clipboard.readText() === '', JSON.stringify(clipboard.readText()));

  copy(e0.id, 'password');
  clipboard.writeText('ユーザーが別にコピーした文字');
  await sleep(3000);
  check('その後に別の物をコピーしていたら消さない', clipboard.readText() === 'ユーザーが別にコピーした文字');

  await tryCheck('外部への通信は遮断される', async () => {
    const r = await win.webContents.executeJavaScript(`new Promise(res => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('blocked'); i.src = 'https://www.example.com/favicon.ico?' + Date.now(); })`);
    return r === 'blocked' || r;
  });

  await tryCheck('マスターパスワードでロック・解除できる', () => {
    const text = vault.encodeFile(data, { protect: b => b, protection: 'test', master: 'smoke-master' });
    const r = vault.decodeFile(text, { unprotect: b => b });
    if (!r.locked) return false;
    try { vault.unlock(r.box, 'wrong'); return false; } catch {}
    return vault.unlock(r.box, 'smoke-master').entries.length === 50;
  });

  await tryCheck('画面を開き直すと一覧に 50 件表示される', async () => {
    win.webContents.reload();
    await sleep(1500);
    const n = await win.webContents.executeJavaScript(`document.querySelectorAll('#list .item').length`);
    return n === 50 || `表示 ${n} 件`;
  });

  const out = path.join(__dirname, '..', 'smoke-out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'list.png'), (await win.webContents.capturePage()).toPNG());

  const failed = results.filter(r => !r.ok).length;
  log(`${results.length - failed}/${results.length} OK`);
  app.exit(failed ? 1 : 0);
};
