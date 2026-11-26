'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('modelConnections', {
  siwcStatus: () => ipcRenderer.invoke('agy-lab:siwc-status'),
  siwcSignIn: reconsent => ipcRenderer.invoke('agy-lab:siwc-signin', reconsent),
  siwcCancelSignIn: () => ipcRenderer.invoke('agy-lab:siwc-cancel-signin'),
  siwcSignOut: () => ipcRenderer.invoke('agy-lab:siwc-signout'),
  list: () => ipcRenderer.invoke('agy-lab:list'),
  discover: input => ipcRenderer.invoke('agy-lab:discover', input),
  saveDiscovered: input => ipcRenderer.invoke('agy-lab:save-discovered', input),
  test: (id, mode) => ipcRenderer.invoke('agy-lab:test', id, mode),
  remove: id => ipcRenderer.invoke('agy-lab:remove', id),
});
