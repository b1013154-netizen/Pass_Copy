'use strict';
// 一覧・設定・ヘルプ画面
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let st = null;
let filter = '';
let editingId = null;
let docLoaded = false;

// ---------- 共通 ----------
let toastTimer = null;
function toast(message, kind = 'info') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

async function call(ch, ...args) {
  try {
    return await window.pc.invoke(ch, ...args);
  } catch (e) {
    // Electron は「Error invoking remote method 'x': Error: 本文」の形で返すので本文だけ出す
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    throw new Error(msg);
  }
}

function showTab(tab) {
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.id !== `tab-${tab}`;
  if (tab === 'help') loadDoc();
  if (tab === 'list') $('#search').focus();
}

// ---------- 一覧 ----------
function matches(e) {
  if (!filter) return true;
  const q = filter.toLowerCase();
  return [e.name, e.username, e.group, e.memo].some(v => String(v || '').toLowerCase().includes(q));
}

function renderList() {
  const list = $('#list');
  const items = st.entries.filter(matches);
  $('#count').textContent = `${st.entries.length} / ${st.max} 件`;
  $('#count').classList.toggle('full', st.entries.length >= st.max);
  $('#addBtn').disabled = st.entries.length >= st.max;
  $('#addBtn').title = st.entries.length >= st.max ? `登録できるのは ${st.max} 件までです` : '';
  const sec = st.settings.clearClipboard;
  $('#clipNote').textContent = sec > 0 ? `コピーしたパスワードは ${sec} 秒後に消えます` : '';
  $('#empty').hidden = st.entries.length > 0;
  $('#groups').innerHTML = [...new Set(st.entries.map(e => e.group).filter(Boolean))].map(g => `<option value="${esc(g)}">`).join('');

  list.innerHTML = items.map((e, i) => `
    <li class="item" data-id="${e.id}">
      <div class="head">
        <span class="name">${esc(e.name)}</span>
        ${e.group ? `<span class="tag">${esc(e.group)}</span>` : ''}
        <span class="spacer"></span>
        <button class="mini" data-act="up" title="上へ" ${i === 0 || filter ? 'disabled' : ''}>▲</button>
        <button class="mini" data-act="down" title="下へ" ${i === items.length - 1 || filter ? 'disabled' : ''}>▼</button>
        <button class="mini" data-act="edit" title="編集">✎</button>
        <button class="mini danger" data-act="delete" title="削除">🗑</button>
      </div>
      <div class="copies">
        <button class="copy" data-act="copy-user" ${e.username ? '' : 'disabled'} title="ID をコピー">
          <span class="label">ID</span><span class="value">${e.username ? esc(e.username) : '（未登録）'}</span><span class="ico">⧉</span>
        </button>
        <button class="copy pass" data-act="copy-pass" ${e.hasPassword ? '' : 'disabled'} title="パスワードをコピー">
          <span class="label">パスワード</span><span class="value">${e.hasPassword ? '••••••••' : '（未登録）'}</span><span class="ico">⧉</span>
        </button>
      </div>
      ${e.memo ? `<div class="memo">${esc(e.memo)}</div>` : ''}
    </li>`).join('');
  if (!items.length && st.entries.length) list.innerHTML = '<li class="empty">一致する登録はありません。</li>';
}

$('#list').addEventListener('click', async ev => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.item').dataset.id;
  const act = btn.dataset.act;
  try {
    if (act === 'copy-user' || act === 'copy-pass') {
      const r = await call('copy', id, act === 'copy-user' ? 'username' : 'password');
      btn.classList.add('done');
      setTimeout(() => btn.classList.remove('done'), 900);
      toast(r.field === 'password' ? `パスワードをコピーしました${r.clearAfter ? `（${r.clearAfter} 秒後に消えます）` : ''}` : 'ID をコピーしました', 'ok');
    } else if (act === 'edit') {
      openEditor(await call('entry:get', id));
    } else if (act === 'delete') {
      const e = st.entries.find(x => x.id === id);
      if (window.confirm(`「${e.name}」を削除しますか？\n元に戻せません。`)) {
        await call('entry:delete', id);
        toast('削除しました');
      }
    } else if (act === 'up' || act === 'down') {
      await call('entry:move', id, act === 'up' ? -1 : 1);
    }
  } catch (e) {
    toast(e.message, 'error');
  }
});

$('#search').addEventListener('input', e => { filter = e.target.value.trim(); renderList(); });
$('#addBtn').addEventListener('click', () => openEditor(null));

// ---------- 登録・編集 ----------
const form = $('#editForm');
function openEditor(entry) {
  editingId = entry ? entry.id : null;
  $('#editTitle').textContent = entry ? '編集' : '追加';
  for (const k of ['name', 'group', 'username', 'password', 'memo']) form.elements[k].value = entry ? entry[k] || '' : '';
  form.elements.password.type = 'password';
  $('#editError').hidden = true;
  $('#editDlg').showModal();
  form.elements.name.focus();
}

form.addEventListener('submit', async ev => {
  ev.preventDefault();
  const entry = { id: editingId };
  for (const k of ['name', 'group', 'username', 'password', 'memo']) entry[k] = form.elements[k].value;
  try {
    await call('entry:save', entry);
    $('#editDlg').close();
    toast(editingId ? '保存しました' : '追加しました', 'ok');
  } catch (e) {
    $('#editError').textContent = e.message;
    $('#editError').hidden = false;
  }
});
$('#editCancel').addEventListener('click', () => $('#editDlg').close());
$('#editDlg').addEventListener('close', () => { form.elements.password.value = ''; });
$('#pwShow').addEventListener('click', () => {
  const p = form.elements.password;
  p.type = p.type === 'password' ? 'text' : 'password';
});
$('#pwGen').addEventListener('click', () => {
  // 紛らわしい文字（0/O、1/l/I）を除いた 16 文字
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+-=?@';
  const buf = new Uint32Array(16);
  crypto.getRandomValues(buf);
  form.elements.password.value = Array.from(buf, n => chars[n % chars.length]).join('');
  form.elements.password.type = 'text';
});

// ---------- パスワードを尋ねる小窓 ----------
// fields: [{ name, label }]。OK を押すと onOk(values) を呼び、エラーなら表示して閉じない
function ask({ title, desc, fields, ok = 'OK', extra = '', onOk }) {
  $('#askTitle').textContent = title;
  $('#askDesc').innerHTML = desc || '';
  $('#askFields').innerHTML = fields.map(f => `<label>${esc(f.label)}<input name="${f.name}" type="password" autocomplete="off"></label>`).join('') + extra;
  $('#askOk').textContent = ok;
  $('#askError').hidden = true;
  const dlg = $('#askDlg');
  const f = $('#askForm');
  f.onsubmit = async ev => {
    ev.preventDefault();
    const values = {};
    for (const el of f.elements) if (el.name) values[el.name] = el.type === 'radio' ? (el.checked ? el.value : values[el.name]) : el.value;
    try {
      await onOk(values);
      dlg.close();
    } catch (e) {
      $('#askError').textContent = e.message;
      $('#askError').hidden = false;
    }
  };
  dlg.showModal();
  const first = f.querySelector('input');
  if (first) first.focus();
}
$('#askCancel').addEventListener('click', () => $('#askDlg').close());
$('#askDlg').addEventListener('close', () => { $('#askFields').innerHTML = ''; });

// ---------- 設定 ----------
function renderSettings() {
  const s = st.settings;
  $('#s-hotkey').value = s.hotkey;
  $('#s-clear').value = s.clearClipboard;
  $('#s-hide').checked = s.hideAfterCopy;
  $('#s-top').checked = s.alwaysOnTop;
  $('#s-show').checked = s.showOnStart;
  $('#s-startup').checked = s.startWithWindows;
  $('#s-autolock').value = s.autoLock;
  $('#hotkeyError').textContent = st.hotkeyError;
  $('#hotkeyError').hidden = !st.hotkeyError;
  $('#masterBox').innerHTML = st.hasMaster
    ? '<p class="state on">設定済み</p><div class="btns"><button id="mChange">変更する</button><button id="mRemove">解除する</button></div>'
    : '<p class="state">未設定</p><div class="btns"><button id="mSet">設定する</button></div>';
  $('#lockBtn').hidden = !st.hasMaster;
  const prot = st.protection === 'dpapi' ? 'Windows の DPAPI で暗号化して保存' : '暗号化なしで保存（この環境では DPAPI を使えません）';
  $('#aboutLine').textContent = `PassCopy ${st.version} ・ 完全オフライン（通信しません） ・ ${prot}`;
}

async function saveSettings() {
  const s = {
    hotkey: $('#s-hotkey').value,
    clearClipboard: $('#s-clear').value,
    hideAfterCopy: $('#s-hide').checked,
    alwaysOnTop: $('#s-top').checked,
    showOnStart: $('#s-show').checked,
    startWithWindows: $('#s-startup').checked,
    autoLock: $('#s-autolock').value
  };
  try {
    await call('settings:save', s);
    toast('設定を保存しました', 'ok');
  } catch (e) {
    toast(e.message, 'error');
  }
}
for (const id of ['#s-hotkey', '#s-clear', '#s-autolock']) $(id).addEventListener('change', saveSettings);
for (const id of ['#s-hide', '#s-top', '#s-show', '#s-startup']) $(id).addEventListener('change', saveSettings);

$('#masterBox').addEventListener('click', ev => {
  const id = ev.target.id;
  if (id === 'mSet') {
    ask({
      title: 'マスターパスワードを設定',
      desc: '4 文字以上で入力してください。<strong>忘れると登録情報を取り出せなくなります。</strong>',
      fields: [{ name: 'next', label: '新しいマスターパスワード' }, { name: 'again', label: 'もう一度入力' }],
      onOk: async v => {
        if (v.next !== v.again) throw new Error('2 回の入力が一致しません。');
        await call('master:set', '', v.next);
        toast('マスターパスワードを設定しました', 'ok');
      }
    });
  } else if (id === 'mChange') {
    ask({
      title: 'マスターパスワードを変更',
      fields: [{ name: 'current', label: '現在のマスターパスワード' }, { name: 'next', label: '新しいマスターパスワード' }, { name: 'again', label: 'もう一度入力' }],
      onOk: async v => {
        if (!v.next) throw new Error('新しいマスターパスワードを入力してください。');
        if (v.next !== v.again) throw new Error('2 回の入力が一致しません。');
        await call('master:set', v.current, v.next);
        toast('マスターパスワードを変更しました', 'ok');
      }
    });
  } else if (id === 'mRemove') {
    ask({
      title: 'マスターパスワードを解除',
      desc: '解除すると、起動時にパスワードを聞かなくなります（保存データは引き続き DPAPI で暗号化されます）。',
      fields: [{ name: 'current', label: '現在のマスターパスワード' }],
      ok: '解除する',
      onOk: async v => {
        await call('master:set', v.current, '');
        toast('マスターパスワードを解除しました', 'ok');
      }
    });
  }
});

$('#exportBtn').addEventListener('click', () => ask({
  title: 'バックアップを書き出す',
  desc: 'バックアップファイルを守るパスワードを決めてください（4 文字以上）。読み込むときに必要です。',
  fields: [{ name: 'pw', label: 'バックアップのパスワード' }, { name: 'again', label: 'もう一度入力' }],
  ok: '保存先を選ぶ…',
  onOk: async v => {
    if (v.pw !== v.again) throw new Error('2 回の入力が一致しません。');
    const file = await call('backup:export', v.pw);
    if (file) toast(`書き出しました: ${file}`, 'ok');
  }
}));

$('#importBtn').addEventListener('click', () => ask({
  title: 'バックアップを読み込む',
  desc: `書き出したときのパスワードを入力してください。登録は合計 ${st.max} 件までです。`,
  fields: [{ name: 'pw', label: 'バックアップのパスワード' }],
  extra: `<fieldset class="radios"><label class="check"><input type="radio" name="mode" value="merge" checked> 今の登録に追加する（同じ表示名と ID のものは上書き）</label>
    <label class="check"><input type="radio" name="mode" value="replace"> 今の登録をすべて置き換える</label></fieldset>`,
  ok: 'ファイルを選ぶ…',
  onOk: async v => {
    const r = await call('backup:import', v.pw, v.mode);
    if (!r) return;
    toast(`追加 ${r.added} 件・上書き ${r.updated} 件${r.skipped ? `・上限のため ${r.skipped} 件を取り込めませんでした` : ''}`, r.skipped ? 'error' : 'ok');
  }
}));

// ---------- ロック ----------
$('#lockBtn').addEventListener('click', () => call('lock'));
$('#unlockForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  try {
    await call('unlock', $('#unlockPw').value);
    $('#unlockPw').value = '';
    $('#unlockError').hidden = true;
  } catch (e) {
    $('#unlockError').textContent = e.message;
    $('#unlockError').hidden = false;
    $('#unlockPw').select();
  }
});

// ---------- ヘルプ ----------
async function loadDoc() {
  if (docLoaded) return;
  const { html, headings } = window.PCMarkdown.render(await call('docs:read'));
  $('#doc').innerHTML = html;
  $('#toc').innerHTML = headings.map(h => `<a href="#${h.id}">${esc(h.text)}</a>`).join('');
  docLoaded = true;
}
$('#toc').addEventListener('click', ev => {
  const a = ev.target.closest('a');
  if (!a) return;
  ev.preventDefault();
  const el = document.getElementById(a.getAttribute('href').slice(1));
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// ---------- 起動 ----------
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));

function apply(next) {
  const wasLocked = st && st.locked;
  st = next;
  $('#lockScreen').hidden = !st.locked;
  if (st.locked) {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    setTimeout(() => $('#unlockPw').focus(), 50);
  }
  if (wasLocked && !st.locked) showTab('list');
  const n = $('#notice');
  n.textContent = st.loadError || '';
  n.hidden = !st.loadError;
  renderList();
  renderSettings();
}

window.pc.on('state', apply);
window.pc.on('toast', t => toast(t.message, t.kind));
call('state').then(apply);
window.showTab = showTab;
