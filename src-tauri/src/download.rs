/// HTTP download helpers — mirrors LauncherDownloadManager from launcher-download.js.

use anyhow::{anyhow, Result};
use bytes::Bytes;
use reqwest::Client;
use std::time::Duration;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 EasyAssetsLauncher";

/// Build a shared reqwest client with sensible defaults.
pub fn build_client() -> Client {
    Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .expect("Failed to build HTTP client")
}

/// Download a URL to a byte buffer (Bytes).
pub async fn download_bytes(client: &Client, url: &str) -> Result<Bytes> {
    let resp = client.get(url).send().await?.error_for_status()?;
    let bytes = resp.bytes().await?;
    Ok(bytes)
}

/// Fetch the current website URL from Supabase `website_urls` table.
/// Returns None on any error or missing row.
pub async fn fetch_website_url_from_supabase(
    client: &Client,
    supabase_url: &str,
    anon_key: &str,
) -> Option<String> {
    let rest_url = format!(
        "{}/rest/v1/website_urls?select=url&active=eq.true&order=created_at.desc&limit=1",
        supabase_url.trim_end_matches('/')
    );

    let resp = client
        .get(&rest_url)
        .header("accept", "application/json")
        .header("apikey", anon_key)
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        log::warn!("Supabase fetch responded {} — skipping", resp.status());
        return None;
    }

    let data: serde_json::Value = resp.json().await.ok()?;
    data[0]["url"].as_str().map(|s| s.trim_end_matches('/').to_string())
}

/// Perform a health check against `/api/health` and return true if the server responded.
/// Any HTTP status (even 4xx/5xx) counts as reachable.
pub async fn health_check(client: &Client, app_url: &str) -> bool {
    let health_url = format!("{}/api/health", app_url.trim_end_matches('/'));
    match client
        .get(&health_url)
        .header("accept", "application/json")
        .send()
        .await
    {
        Ok(_) => true,
        Err(e) => {
            log::warn!("Health check failed: {}", e);
            false
        }
    }
}

/// Safe filename for a downloaded ZIP: sanitize path-unsafe chars, enforce .zip extension.
pub fn safe_zip_filename(url: &str, fallback: &str) -> String {
    let base = url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.path_segments()
                .and_then(|segs| segs.last().map(|s| s.to_string()))
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string());

    let safe: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();

    let safe = safe.chars().take(220).collect::<String>();
    if safe.to_lowercase().ends_with(".zip") {
        safe
    } else {
        format!("{}.zip", safe)
    }
}
