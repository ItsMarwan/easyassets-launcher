/// Asset cache manager — mirrors AssetCacheManager from asset-cache.js.
///
/// Cache location: %APPDATA%\EasyAssets\Cache\ (Windows)
///                 ~/Library/Application Support/EasyAssets/Cache/ (macOS)
///                 ~/.local/share/EasyAssets/Cache/ (Linux)

use crate::eaa::{EaaFile, EaaMetadata};
use anyhow::{anyhow, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CachedAssetMeta {
    pub name: Option<String>,
    pub version: Option<String>,
    pub latest_version: Option<String>,
    pub latest_version_id: Option<String>,
    pub cached_at: Option<String>,
    pub eaa_path: Option<String>,
    pub thumbnail: Option<String>,
    pub creator: Option<String>,
    pub description: Option<String>,
    pub has_update: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedAssetInfo {
    pub id: String,
    pub name: Option<String>,
    pub version: Option<String>,
    pub latest_version: Option<String>,
    pub cached_at: Option<String>,
    pub has_update: bool,
    pub thumbnail: Option<String>,
    pub creator: Option<String>,
}

pub fn cache_dir() -> PathBuf {
    let base = dirs::data_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("EasyAssets").join("Cache")
}

fn metadata_file() -> PathBuf {
    cache_dir().join("assets.json")
}

pub fn asset_path(asset_id: &str) -> PathBuf {
    cache_dir().join(format!("{}.eaa", asset_id))
}

fn load_cached_map() -> HashMap<String, CachedAssetMeta> {
    let path = metadata_file();
    if !path.exists() {
        return HashMap::new();
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_cached_map(map: &HashMap<String, CachedAssetMeta>) {
    let path = metadata_file();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(path, json);
    }
}

/// Returns all cached assets with live EAA metadata merged in.
pub fn get_cached_assets() -> Vec<CachedAssetInfo> {
    let map = load_cached_map();
    let mut result = Vec::new();

    for (id, meta) in &map {
        let eaa_path = asset_path(id);
        if !eaa_path.exists() {
            continue;
        }
        // Read metadata from EAA (fast — only header section)
        let eaa_meta = EaaFile::read_metadata(&eaa_path).unwrap_or_default();
        result.push(CachedAssetInfo {
            id: id.clone(),
            name: eaa_meta.name.or_else(|| meta.name.clone()),
            version: meta.version.clone(),
            latest_version: meta.latest_version.clone(),
            cached_at: meta.cached_at.clone(),
            has_update: meta
                .latest_version
                .as_ref()
                .zip(meta.version.as_ref())
                .map(|(lv, v)| lv != v)
                .unwrap_or(false),
            thumbnail: eaa_meta.thumbnail.or_else(|| meta.thumbnail.clone()),
            creator: eaa_meta.creator.or_else(|| meta.creator.clone()),
        });
    }
    result
}

/// Cache a downloaded asset's zip bytes on disk as an EAA file.
pub fn cache_asset(
    asset_id: &str,
    zip_data: Vec<u8>,
    metadata: &EaaMetadata,
) -> Result<CachedAssetInfo> {
    let dir = cache_dir();
    std::fs::create_dir_all(&dir)?;

    let eaa_path = asset_path(asset_id);
    EaaFile::write(&eaa_path, zip_data, metadata)?;

    let mut map = load_cached_map();
    let entry = CachedAssetMeta {
        name: metadata.name.clone(),
        version: metadata.version.clone(),
        latest_version: metadata.version.clone(),
        cached_at: Some(Utc::now().to_rfc3339()),
        eaa_path: Some(eaa_path.to_string_lossy().to_string()),
        ..Default::default()
    };
    map.insert(asset_id.to_string(), entry.clone());
    save_cached_map(&map);

    Ok(CachedAssetInfo {
        id: asset_id.to_string(),
        name: metadata.name.clone(),
        version: metadata.version.clone(),
        latest_version: metadata.version.clone(),
        cached_at: entry.cached_at,
        has_update: false,
        thumbnail: metadata.thumbnail.clone(),
        creator: metadata.creator.clone(),
    })
}

/// Delete a cached asset from disk and metadata.
pub fn delete_cached_asset(asset_id: &str) {
    let path = asset_path(asset_id);
    let _ = std::fs::remove_file(path);
    let mut map = load_cached_map();
    map.remove(asset_id);
    save_cached_map(&map);
}

/// Update the cached metadata map after a version check (called by the command layer
/// after fetching fresh data from the server).
pub fn update_asset_meta(asset_id: &str, updater: impl FnOnce(&mut CachedAssetMeta)) {
    let mut map = load_cached_map();
    let entry = map.entry(asset_id.to_string()).or_default();
    updater(entry);
    save_cached_map(&map);
}

/// Return full metadata map for update-check purposes.
pub fn all_asset_ids() -> Vec<String> {
    load_cached_map().into_keys().collect()
}
