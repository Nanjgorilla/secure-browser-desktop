const { contextBridge, ipcRenderer } = require('electron');
const send = ['nav','back','forward','reload','stop','home','new-tab','close-tab','activate','clear-data'];
const on = ['tabs','blocked','popup-blocked','download','toast','focus-address'];
contextBridge.exposeInMainWorld('sb', {
  send: (ch, arg) => { if (send.includes(ch)) ipcRenderer.send(ch, arg); },
  on: (ch, fn) => { if (on.includes(ch)) ipcRenderer.on(ch, (_e, v) => fn(v)); },
});
