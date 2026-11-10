const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apex', {
  getState: () => ipcRenderer.invoke('getState'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
  onShortcut: (callback) => {
    ipcRenderer.on('shortcut', (_event, name) => callback(name));
  },
  add: (payload) => ipcRenderer.invoke('add', payload),
  action: (type, id, extra) => ipcRenderer.invoke('action', { type, id, extra }),
  chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
  saveSettings: (patch) => ipcRenderer.invoke('settings', patch),
  copy: (text) => ipcRenderer.invoke('copy', text),
});
