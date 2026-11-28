'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('modelConnections', {
  googleAccounts: () => ipcRenderer.invoke('agy-lab:google-accounts'),
  googleSwitch: email => ipcRenderer.invoke('agy-lab:google-switch', email),
  googleAdd: () => ipcRenderer.invoke('agy-lab:google-add'),
  googleRemove: email => ipcRenderer.invoke('agy-lab:google-remove', email),
  siwcAccounts: () => ipcRenderer.invoke('agy-lab:siwc-accounts'),
  siwcAdd: () => ipcRenderer.invoke('agy-lab:siwc-add'),
  siwcSignIn: (id, reconsent) => ipcRenderer.invoke('agy-lab:siwc-signin', id, reconsent),
  siwcActivate: id => ipcRenderer.invoke('agy-lab:siwc-activate', id),
  siwcRemove: id => ipcRenderer.invoke('agy-lab:siwc-remove', id),
  siwcCancelSignIn: () => ipcRenderer.invoke('agy-lab:siwc-cancel-signin'),
  list: () => ipcRenderer.invoke('agy-lab:list'),
  discover: input => ipcRenderer.invoke('agy-lab:discover', input),
  saveDiscovered: input => ipcRenderer.invoke('agy-lab:save-discovered', input),
  test: (id, mode) => ipcRenderer.invoke('agy-lab:test', id, mode),
  remove: id => ipcRenderer.invoke('agy-lab:remove', id),
  setContext: (id, tokens) => ipcRenderer.invoke('agy-lab:set-context', id, tokens),
});
