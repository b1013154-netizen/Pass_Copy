'use strict';
// 説明書・README 用のスクリーンショットを撮る（PC_SHOTS=1 で起動。Linux の xvfb 上でも動く）
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SAMPLE = [
  { name: '社内ファイルサーバー', group: '仕事', username: 'CORP\\yamada', password: 'Fs-2026!demo', memo: '\\\\fileserver01 の共有フォルダ' },
  { name: 'リモートデスクトップ（開発機）', group: '仕事', username: 'dev-admin', password: 'Rd#7788demo' },
  { name: '勤怠システム', group: '仕事', username: 'yamada.taro', password: 'Kintai-demo1' },
  { name: '自宅 NAS', group: '自宅', username: 'admin', password: 'Nas-demo-99', memo: 'http://192.168.0.10' },
  { name: 'Wi-Fi（ゲスト用）', group: '自宅', username: '', password: 'guest-wifi-demo' }
];

module.exports = async function shots({ app, getWin, data, vault, pushState, lock }) {
  fs.mkdirSync(OUT, { recursive: true });
  const win = getWin();
  const page = async name => fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  const js = code => win.webContents.executeJavaScript(code);
  for (const e of SAMPLE) vault.upsert(data, e);
  pushState();
  win.setBounds({ x: 40, y: 40, width: 560, height: 680 });
  win.show();
  await sleep(1500);
  await page('list');

  await js(`document.querySelector('.copy.pass').click()`);
  await sleep(300);
  await page('copied');
  await sleep(2800);

  await js(`document.querySelector('[data-act=edit]').click()`);
  await sleep(600);
  await page('edit');
  await js(`document.querySelector('#editDlg').close()`);

  await js(`document.querySelector('#search').value = '自宅'; document.querySelector('#search').dispatchEvent(new Event('input'))`);
  await sleep(300);
  await page('search');
  await js(`document.querySelector('#search').value = ''; document.querySelector('#search').dispatchEvent(new Event('input'))`);

  for (const tab of ['settings', 'help']) {
    await js(`showTab(${JSON.stringify(tab)})`);
    await sleep(800);
    await page(tab);
  }
  await js(`showTab('list')`);
  // 上限に達したときの表示
  for (let i = data.entries.length; i < vault.MAX_ENTRIES; i++) vault.upsert(data, { name: `登録 ${i + 1}`, username: `user${i + 1}`, password: 'x' });
  pushState();
  await sleep(500);
  await page('full');

  lock();
  await sleep(600);
  await page('locked');
  // 解除できることも確かめる
  await js(`document.querySelector('#unlockPw').value = 'wrong'; document.querySelector('#unlockForm').requestSubmit()`);
  await sleep(1500);
  const err = await js(`document.querySelector('#unlockError').textContent`);
  await js(`document.querySelector('#unlockPw').value = 'demo'; document.querySelector('#unlockForm').requestSubmit()`);
  await sleep(1500);
  console.log('unlock check:', err, await js(`document.querySelectorAll('#list .item').length`), await js(`document.querySelector('#lockScreen').hidden`));
  app.exit(0);
};
