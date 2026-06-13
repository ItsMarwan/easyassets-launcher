(function () {
  "use strict";

  if (window.__EASYASSETS_BRIDGE_INIT__) return;
  window.__EASYASSETS_BRIDGE_INIT__ = true;

  // ── Debug helper ──────────────────────────────────────────────────────────
  function dbg(msg, ...args) {
    console.log('[EasyAssets Bridge]', msg, ...args);
  }

  // ── Lazy Tauri resolver ───────────────────────────────────────────────────
  function invoke(cmd, args) {
    dbg('invoke called:', cmd, args);

    if (!window.__TAURI_INTERNALS__) {
      throw new Error('__TAURI_INTERNALS__ not available');
    }

    return window.__TAURI_INTERNALS__.invoke(cmd, args);
  }

  function listen(event, cb) {
    if (!window.__TAURI_INTERNALS__?.event) {
      throw new Error('__TAURI_INTERNALS__.event not available');
    }

    return window.__TAURI_INTERNALS__.event.listen(event, cb);
  }

  function listen(event, cb) {
    return getTauri().then((t) => t.event.listen(event, cb));
  }

  // ── Set window.electronAPI SYNCHRONOUSLY ─────────────────────────────────
  window.electronAPI = {
    isLauncher: true,
    onStatus:        (cb) => listen("status",        (e) => cb(e.payload)),
    onHealth:        (cb) => listen("health",         (e) => cb(e.payload)),
    onDeepLink:      (cb) => listen("deep-link",      (e) => cb(e.payload)),
    onReloadWebsite: (cb) => listen("reload-website", (e) => cb(e.payload)),
    getCachedAssets:   ()                     => invoke("get_cached_assets"),
    checkAssetUpdates: ()                     => invoke("check_asset_updates"),
    installAssetUpdate:(assetId, options)     => invoke("install_asset_update", { assetId, options: options || null }),
    updateAssetCache:  (assetId)              => invoke("update_asset_cache",   { assetId }),
    downloadAssetZip:  (assetId, downloadUrl) => invoke("download_asset_zip",   { assetId, downloadUrl: downloadUrl || null }),
    scanUEFNProjects:        ()               => invoke("scan_uefn_projects"),
    selectProjectsFolder:    ()               => invoke("select_projects_folder"),
    getExistingAssetFolders: (contentPath)    => invoke("get_existing_asset_folders", { contentPath }),
    downloadAsset:        (assetId, assetData)                => invoke("download_asset",            { assetId, assetData }),
    extractAssetToProject:(assetPath, projectPath, folderName) => invoke("extract_asset_to_project", { assetPath, projectPath, folderName }),
    reloadWebsite: () => invoke("reload_website"),
  };

  window.launcherAPI = window.electronAPI;

  dbg('Bridge initialized. isLauncher =', window.electronAPI.isLauncher);
  dbg('window.__TAURI__ at init time:', !!window.__TAURI__);
})();