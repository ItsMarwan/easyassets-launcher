const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onStatus: (callback) => {
    ipcRenderer.on('status', (_event, message) => callback(message));
  },
  onHealth: (callback) => {
    ipcRenderer.on('health', (_event, payload) => callback(payload));
  },
  isLauncher: true,
  // Asset download and management IPC
  getCachedAssets: () => ipcRenderer.invoke('get-cached-assets'),
  checkAssetUpdates: () => ipcRenderer.invoke('check-asset-updates'),
  installAssetUpdate: (assetId, options) => ipcRenderer.invoke('install-asset-update', assetId, options),
  updateAssetCache: (assetId) => ipcRenderer.invoke('update-asset-cache', assetId),
  downloadAssetZip: (assetId, downloadUrl) => ipcRenderer.invoke('download-asset-zip', assetId, downloadUrl),
  scanUEFNProjects: () => ipcRenderer.invoke('scan-uefn-projects'),
  selectProjectsFolder: () => ipcRenderer.invoke('select-projects-folder'),
  getExistingAssetFolders: (contentPath) => ipcRenderer.invoke('get-existing-asset-folders', contentPath),
  downloadAsset: (assetId, assetData) => ipcRenderer.invoke('download-asset', assetId, assetData),
  extractAssetToProject: (assetPath, projectPath, folderName) => ipcRenderer.invoke('extract-asset-to-project', assetPath, projectPath, folderName),
});