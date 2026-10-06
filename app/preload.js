'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jizi', Object.freeze({
  bootstrap: () => ipcRenderer.invoke('jizi:bootstrap'),
  render: payload => ipcRenderer.invoke('jizi:render', payload),
  candidates: char => ipcRenderer.invoke('jizi:candidates', { char }),
  exportPng: payload => ipcRenderer.invoke('jizi:export', payload),
}));
