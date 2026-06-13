/// Tauri commands — one-to-one replacements for every Electron ipcMain.handle().
///
/// Electron handler          →  Tauri command
/// ─────────────────────────────────────────────────────────────────────────────
/// get-cached-assets         →  get_cached_assets
/// check-asset-updates       →  check_asset_updates
/// install-asset-update      →  install_asset_update
/// update-asset-cache        →  update_asset_cache
/// download-asset-zip        →  download_asset_zip
/// scan-uefn-projects        →  scan_uefn_projects
/// select-projects-folder    →  select_projects_folder
/// get-existing-asset-folders→  get_existing_asset_folders
/// download-asset            →  download_asset
/// extract-asset-to-project  →  extract_asset_to_project
/// reload-website            →  reload_website

use crate::{cache, download, eaa, uefn, AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, Window};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

// ── Shared helpers ─────────────────────────────────────────────────────────

fn emit_status<R: Runtime>(app: &AppHandle<R>, message: &str) {
    let _ = app.emit("status", message);
}

fn emit_health<R: Runtime>(app: &AppHandle<R>, payload: &Value) {
    let _ = app.emit("health", payload);
}

// ── Serde types ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AssetData {
    pub download_url: Option<String>,
    pub name: Option<String>,
    pub version: Option<String>,
    pub creator: Option<String>,
    pub thumbnail: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptions {
    pub project_path: String,
    pub folder_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub success: bool,
    pub path: String,
}

// ── Commands ───────────────────────────────────────────────────────────────

/// get-cached-assets
#[tauri::command]
pub async fn get_cached_assets() -> Result<Vec<cache::CachedAssetInfo>, String> {
    log::info!("[CMD] get_cached_assets called");
    let result = cache::get_cached_assets();
    log::info!("[CMD] get_cached_assets returning {} items", result.len());
    Ok(result)
}

/// check-asset-updates — fetches fresh metadata for each cached asset from the server.
#[tauri::command]
pub async fn check_asset_updates(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<cache::CachedAssetInfo>, String> {
    let base_url = state.app_url.lock().await.clone();
    let client = download::build_client();
    let ids = cache::all_asset_ids();

    for id in &ids {
        let url = format!("{}/api/launcher/download-url/{}", base_url.trim_end_matches('/'), id);
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(data) = resp.json::<Value>().await {
                    cache::update_asset_meta(id, |meta| {
                        if let Some(v) = data["version"].as_str() {
                            meta.latest_version = Some(v.to_string());
                            meta.latest_version_id = data["versionId"].as_str().map(str::to_string);
                        }
                        if let Some(t) = data["thumbnail"].as_str() {
                            meta.thumbnail = Some(t.to_string());
                        }
                        if let Some(c) = data["creator"].as_str() {
                            meta.creator = Some(c.to_string());
                        }
                        if let Some(n) = data["name"].as_str() {
                            meta.name = Some(n.to_string());
                        }
                        if let Some(d) = data["description"].as_str() {
                            meta.description = Some(d.to_string());
                        }
                    });
                }
            }
            Ok(resp) => {
                log::warn!("Failed to check updates for {}: HTTP {}", id, resp.status());
            }
            Err(e) => {
                log::warn!("Error checking updates for {}: {}", id, e);
            }
        }
    }

    emit_status(&app, "Update check complete.");
    Ok(cache::get_cached_assets())
}

/// install-asset-update — install a cached asset, with an optional target path.
#[tauri::command]
pub async fn install_asset_update(
    app: AppHandle,
    asset_id: String,
    options: Option<InstallOptions>,
) -> Result<DownloadResult, String> {
    let eaa_path = cache::asset_path(&asset_id);
    if !eaa_path.exists() {
        return Err("Asset file not found in cache".into());
    }

    let extract_path: PathBuf = if let Some(opts) = options {
        if !Path::new(&opts.project_path).exists() {
            return Err("Project path does not exist".into());
        }
        let folder = uefn::ensure_asset_folder(&opts.project_path, &opts.folder_name)
            .map_err(|e| e.to_string())?;
        PathBuf::from(folder)
    } else {
        // Let the user pick via dialog
        let picked = app
            .dialog()
            .file()
            .set_title("Select Content Folder to Override")
            .blocking_pick_folder();
        match picked {
            Some(p) => p.as_path().map(|p| p.to_path_buf()).ok_or("Invalid path")?,
            None => return Err("Operation canceled".into()),
        }
    };

    let eaa = eaa::EaaFile::parse(&eaa_path).map_err(|e| e.to_string())?;
    eaa.extract_to(&extract_path).map_err(|e| e.to_string())?;

    emit_status(&app, &format!("Asset installed to {}", extract_path.display()));
    Ok(DownloadResult {
        success: true,
        path: extract_path.to_string_lossy().to_string(),
    })
}

/// update-asset-cache — download the latest version from the server and re-cache it.
#[tauri::command]
pub async fn update_asset_cache(
    app: AppHandle,
    state: State<'_, AppState>,
    asset_id: String,
) -> Result<cache::CachedAssetInfo, String> {
    emit_status(&app, &format!("Updating cache for asset {}…", asset_id));
    let base_url = state.app_url.lock().await.clone();
    let client = download::build_client();

    let api_url = format!(
        "{}/api/launcher/download-url/{}",
        base_url.trim_end_matches('/'),
        asset_id
    );

    let resp = client
        .get(&api_url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    let asset_data: Value = resp.json().await.map_err(|e| e.to_string())?;
    let download_url = asset_data["downloadUrl"]
        .as_str()
        .ok_or("No downloadUrl in response")?
        .to_string();

    let zip_bytes = download::download_bytes(&client, &download_url)
        .await
        .map_err(|e| e.to_string())?;

    let metadata = eaa::EaaMetadata {
        id: Some(asset_id.clone()),
        name: asset_data["name"].as_str().map(str::to_string),
        version: asset_data["version"].as_str().map(str::to_string),
        creator: asset_data["creator"].as_str().map(str::to_string),
        thumbnail: asset_data["thumbnail"].as_str().map(str::to_string),
        downloaded_at: Some(chrono::Utc::now().to_rfc3339()),
        extra: serde_json::Map::new(),
    };

    let cached = cache::cache_asset(&asset_id, zip_bytes.to_vec(), &metadata)
        .map_err(|e| e.to_string())?;

    emit_status(
        &app,
        &format!(
            "Asset {} cache updated to v{}!",
            metadata.name.as_deref().unwrap_or(&asset_id),
            metadata.version.as_deref().unwrap_or("?")
        ),
    );
    Ok(cached)
}

/// download-asset-zip — download an asset ZIP directly to the user's Downloads folder.
#[tauri::command]
pub async fn download_asset_zip(
    app: AppHandle,
    state: State<'_, AppState>,
    asset_id: String,
    download_url: Option<String>,
) -> Result<DownloadResult, String> {
    emit_status(&app, &format!("Downloading {}…", asset_id));
    let base_url = state.app_url.lock().await.clone();
    let client = download::build_client();

    let mut final_url = download_url;
    let mut asset_name = format!("asset-{}", asset_id);
    let mut asset_version = "latest".to_string();

    if final_url.is_none() {
        let api_url = format!(
            "{}/api/launcher/download-url/{}",
            base_url.trim_end_matches('/'),
            asset_id
        );
        let resp = client
            .get(&api_url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;

        let data: Value = resp.json().await.map_err(|e| e.to_string())?;
        if let Some(u) = data["downloadUrl"].as_str() {
            final_url = Some(u.to_string());
        }
        if let Some(n) = data["name"].as_str() {
            asset_name = n.to_string();
        }
        if let Some(v) = data["version"].as_str() {
            asset_version = v.to_string();
        }
    }

    let url = final_url.ok_or("Download URL could not be resolved")?;

    // Make absolute if relative
    let url = if url.starts_with('/') {
        format!("{}{}", base_url.trim_end_matches('/'), url)
    } else {
        url
    };

    let zip_bytes = download::download_bytes(&client, &url)
        .await
        .map_err(|e| e.to_string())?;

    let downloads_dir = dirs::download_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join("Downloads"));

    std::fs::create_dir_all(&downloads_dir).map_err(|e| e.to_string())?;

    let raw_filename = format!("{}-{}.zip", asset_name, asset_version);
    let filename = download::safe_zip_filename(&url, &raw_filename);
    let file_path = downloads_dir.join(&filename);

    std::fs::write(&file_path, &zip_bytes).map_err(|e| e.to_string())?;

    let path_str = file_path.to_string_lossy().to_string();
    emit_status(&app, &format!("ZIP downloaded to {}!", downloads_dir.display()));

    // Reveal in Explorer / Finder
    let _ = tauri_plugin_opener::open_path(&path_str, None::<&str>);

    Ok(DownloadResult { success: true, path: path_str })
}

/// scan-uefn-projects — scan the default Fortnite Projects directory.
#[tauri::command]
pub async fn scan_uefn_projects() -> Result<Vec<uefn::UefnProject>, String> {
    Ok(uefn::scan_default_projects())
}

/// select-projects-folder — show folder picker then scan it.
#[tauri::command]
pub async fn select_projects_folder(
    app: AppHandle,
) -> Result<Vec<uefn::UefnProject>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Select UEFN Projects Folder")
        .blocking_pick_folder();

    match picked {
        Some(path) => {
            let path = path.as_path().ok_or("Invalid path")?.to_path_buf();
            Ok(uefn::scan_projects(&path))
        }
        None => Ok(Vec::new()),
    }
}

/// get-existing-asset-folders
#[tauri::command]
pub async fn get_existing_asset_folders(
    content_path: String,
) -> Result<Vec<String>, String> {
    Ok(uefn::get_existing_asset_folders(&content_path))
}

/// download-asset — download and cache an asset (used by the website's install flow).
#[tauri::command]
pub async fn download_asset(
    app: AppHandle,
    asset_id: String,
    asset_data: AssetData,
) -> Result<serde_json::Value, String> {
    let name = asset_data.name.as_deref().unwrap_or(&asset_id).to_string();
    emit_status(&app, &format!("Downloading {}…", name));

    let download_url = asset_data
        .download_url
        .as_deref()
        .ok_or("Download URL is required")?
        .to_string();

    let client = download::build_client();
    let zip_bytes = download::download_bytes(&client, &download_url)
        .await
        .map_err(|e| e.to_string())?;

    let metadata = eaa::EaaMetadata {
        id: Some(asset_id.clone()),
        name: asset_data.name.clone(),
        version: asset_data.version.clone(),
        creator: asset_data.creator.clone(),
        thumbnail: asset_data.thumbnail.clone(),
        downloaded_at: Some(chrono::Utc::now().to_rfc3339()),
        extra: asset_data.extra.clone(),
    };

    let cached = cache::cache_asset(&asset_id, zip_bytes.to_vec(), &metadata)
        .map_err(|e| e.to_string())?;

    emit_status(&app, &format!("{} downloaded and cached!", name));
    Ok(serde_json::json!({ "success": true, "asset": cached }))
}

/// extract-asset-to-project — extract a cached .eaa to a UEFN project folder.
#[tauri::command]
pub async fn extract_asset_to_project(
    app: AppHandle,
    asset_path: String,
    project_path: String,
    folder_name: String,
) -> Result<serde_json::Value, String> {
    let eaa_path = Path::new(&asset_path);
    if !eaa_path.exists() {
        return Err("Asset file not found".into());
    }
    let extract_dir = uefn::ensure_asset_folder(&project_path, &folder_name)
        .map_err(|e| e.to_string())?;
    let eaa = eaa::EaaFile::parse(eaa_path).map_err(|e| e.to_string())?;
    eaa.extract_to(Path::new(&extract_dir))
        .map_err(|e| e.to_string())?;

    emit_status(&app, &format!("Asset extracted to {}", extract_dir));
    Ok(serde_json::json!({
        "success": true,
        "path": extract_dir,
        "metadata": eaa.metadata,
    }))
}

/// reload-website — trigger the frontend to navigate back to the website URL.
#[tauri::command]
pub async fn reload_website(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let url = state.app_url.lock().await.clone();
    let start_url = build_start_url(&url);
    let _ = app.emit("reload-website", start_url);
    Ok(())
}

// ── Deep-link / launcher action handler ───────────────────────────────────

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkParams {
    pub asset_id: Option<String>,
    pub version_id: Option<String>,
    pub license_id: Option<String>,
    pub download_url: Option<String>,
    pub redirect_url: Option<String>,
}

/// Parse an easyassets:// deep link URL into action + params.
pub fn parse_deep_link(url: &str) -> Option<(String, DeepLinkParams)> {
    let parsed = url::Url::parse(url).ok()?;
    let action = parsed.host_str()?.to_string();
    let params = DeepLinkParams {
        asset_id: parsed.query_pairs().find(|(k, _)| k == "assetId").map(|(_, v)| v.to_string()),
        version_id: parsed.query_pairs().find(|(k, _)| k == "versionId").map(|(_, v)| v.to_string()),
        license_id: parsed.query_pairs().find(|(k, _)| k == "licenseId").map(|(_, v)| v.to_string()),
        download_url: parsed.query_pairs().find(|(k, _)| k == "downloadUrl").map(|(_, v)| v.to_string()),
        redirect_url: parsed.query_pairs().find(|(k, _)| k == "redirectUrl").map(|(_, v)| v.to_string()),
    };
    Some((action, params))
}

/// Emit a deep-link event to the frontend so it can handle UI/redirects,
/// and queue any background action (download/install) via the command layer.
pub fn handle_deep_link<R: Runtime>(app: &AppHandle<R>, url: &str) {
    if let Some((action, params)) = parse_deep_link(url) {
        log::info!("Deep link: action={}, params={:?}", action, params);
        let _ = app.emit("deep-link", serde_json::json!({ "action": action, "params": params }));
    } else {
        log::warn!("Invalid deep link URL: {}", url);
    }
}

// ── Utility ────────────────────────────────────────────────────────────────

fn build_start_url(base: &str) -> String {
    match url::Url::parse(base) {
        Ok(mut u) => {
            if u.path() == "/" || u.path().is_empty() {
                u.set_path("/assets");
            }
            u.to_string()
        }
        Err(_) => format!("{}/assets", base.trim_end_matches('/')),
    }
}
