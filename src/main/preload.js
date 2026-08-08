/*
 * syncto — Folder comparison and synchronization
 * Copyright (C) 2026 Just Edit (Arnaud Augst)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const api = {
  platform  : process.platform,
  getVersion: ()        => ipcRenderer.invoke('get-version'),

  loadPrefs : ()        => ipcRenderer.invoke('load-prefs'),
  savePrefs : (p)       => ipcRenderer.invoke('save-prefs', p),

  browseFolder : (title)=> ipcRenderer.invoke('browse-folder', title),
  revealPath   : (p)    => ipcRenderer.invoke('reveal-path', p),
  openExternal : (u)    => ipcRenderer.invoke('open-external', u),
  openPath     : (p)    => ipcRenderer.invoke('open-path', p),
  diskFree     : (p)    => ipcRenderer.invoke('disk-free', p),
  folderExists : (p)    => ipcRenderer.invoke('folder-exists', p),

  jobNew     : ()        => ipcRenderer.invoke('job-new'),
  jobOpen    : ()        => ipcRenderer.invoke('job-open'),
  jobOpenPath: (p)       => ipcRenderer.invoke('job-open-path', p),
  jobSave    : (job, as) => ipcRenderer.invoke('job-save', job, as),
  getOverview: ()        => ipcRenderer.invoke('get-overview'),

  compare      : (job)  => ipcRenderer.invoke('compare', job),
  compareCancel: ()     => ipcRenderer.invoke('compare-cancel'),
  getRows      : (o,l,v)=> ipcRenderer.invoke('get-rows', o, l, v),
  setDirection : (i,d)  => ipcRenderer.invoke('set-direction', i, d),
  setActive    : (i,a)  => ipcRenderer.invoke('set-active', i, a),
  toggleActive : (i)    => ipcRenderer.invoke('toggle-active', i),
  invertAll    : ()     => ipcRenderer.invoke('invert-all'),
  visibleIndices:(v)    => ipcRenderer.invoke('visible-indices', v),

  sync        : (job)   => ipcRenderer.invoke('sync', job),
  syncCancel  : ()      => ipcRenderer.invoke('sync-cancel'),
  syncPause   : ()      => ipcRenderer.invoke('sync-pause'),
  syncResume  : ()      => ipcRenderer.invoke('sync-resume'),

  verifyFolder: (p)     => ipcRenderer.invoke('verify-folder', p),
  verifyCancel: ()      => ipcRenderer.invoke('verify-cancel'),

  onCompareProgress: cb => sub('compare-progress', cb),
  onSyncProgress   : cb => sub('sync-progress', cb),
  onVerifyProgress : cb => sub('verify-progress', cb),
  onMenu           : cb => sub('menu', cb),
  onUpdateAvailable: cb => sub('update-available', cb),

  winMinimize: () => ipcRenderer.send('win-minimize'),
  winMaximize: () => ipcRenderer.send('win-maximize'),
  winClose   : () => ipcRenderer.send('win-close'),

  getPathForFile: (file) => {
    try { return webUtils ? webUtils.getPathForFile(file) : (file.path || ''); }
    catch (_) { return file.path || ''; }
  },
};

function sub(channel, cb) {
  const handler = (_, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

if (process.contextIsolated) contextBridge.exposeInMainWorld('syncto', api);
else window.syncto = api;
