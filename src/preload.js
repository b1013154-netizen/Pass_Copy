'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 画面から呼べる処理の一覧
const INVOKE = new Set([
  'state', 'entry:get', 'entry:save', 'entry:delete', 'entry:move', 'copy',
  'settings:save', 'master:set', 'unlock', 'lock', 'backup:export', 'backup:import', 'docs:read'
]);
const ON = new Set(['state', 'toast']);

contextBridge.exposeInMainWorld('pc', {
  invoke: (ch, ...args) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error(`unknown channel ${ch}`))),
  on: (ch, cb) => {
    if (!ON.has(ch)) return () => {};
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  }
});
