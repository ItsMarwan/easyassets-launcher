mod cache;
mod commands;
mod download;
mod eaa;
mod uefn;

use commands::*;
use download::{build_client, fetch_website_url_from_supabase, health_check};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tokio::sync::Mutex;

// ── App-wide state ─────────────────────────────────────────────────────────

pub struct AppState {
    pub app_url: Mutex<String>,
}

const FALLBACK_URL: &str = "https://easyassets-uefn.vercel.app";
const MAX_LOAD_ATTEMPTS: u32 = 3;

// ── Bridge script — injected into every page the WebView loads ────────────
// This is the compiled content of frontend-bridge/launcher-bridge.js.
// We embed it at compile time so it's always present regardless of the
// initializationScript config field (which doesn't exist in Tauri v2 config).
const BRIDGE_SCRIPT: &str = include_str!("../../frontend/launcher-bridge.js");

// ── URL resolution ─────────────────────────────────────────────────────────

async fn resolve_app_url() -> String {
    let client = build_client();

    let supabase_url = std::env::var("SUPABASE_URL")
        .or_else(|_| std::env::var("NEXT_PUBLIC_SUPABASE_URL"))
        .unwrap_or_default();
    let anon_key = std::env::var("SUPABASE_ANON_KEY")
        .or_else(|_| std::env::var("NEXT_PUBLIC_SUPABASE_ANON_KEY"))
        .unwrap_or_default();

    if !supabase_url.is_empty() && !anon_key.is_empty() {
        if let Some(url) =
            fetch_website_url_from_supabase(&client, &supabase_url, &anon_key).await
        {
            log::info!("App URL from Supabase: {}", url);
            return url;
        }
    }

    if let Ok(env_url) = std::env::var("EASYASSETS_APP_URL")
        .or_else(|_| std::env::var("NEXT_PUBLIC_APP_URL"))
    {
        let url = env_url.trim_end_matches('/').to_string();
        log::info!("App URL from env: {}", url);
        return url;
    }

    log::info!("App URL using hard-coded fallback: {}", FALLBACK_URL);
    FALLBACK_URL.to_string()
}

pub fn build_start_url(base: &str) -> String {
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

// ── Website loading with retry + fallback ─────────────────────────────────

async fn try_load_website<R: Runtime>(app: &AppHandle<R>, app_url: &str, attempt: u32) {
    let start_url = build_start_url(app_url);
    log::info!("Load attempt {}/{}: {}", attempt, MAX_LOAD_ATTEMPTS, start_url);
    let _ = app.emit("status", format!("Checking website… (attempt {})", attempt));

    let client = build_client();
    if health_check(&client, app_url).await {
        if let Some(window) = app.get_webview_window("main") {
            let url = url::Url::parse(&start_url).expect("invalid start URL");
            let _ = window.navigate(url);
        }
        return;
    }

    if attempt < MAX_LOAD_ATTEMPTS {
        let delay = std::time::Duration::from_millis((attempt as u64) * 2000);
        let _ = app.emit(
            "status",
            format!("Website unreachable. Retrying in {}s… ({}/{})", delay.as_secs(), attempt, MAX_LOAD_ATTEMPTS),
        );
        tokio::time::sleep(delay).await;
        Box::pin(try_load_website(app, app_url, attempt + 1)).await;
    } else {
        load_fallback_page(app, app_url, "Website unreachable after maximum retries.");
    }
}

fn load_fallback_page<R: Runtime>(app: &AppHandle<R>, app_url: &str, reason: &str) {
    log::warn!("Loading fallback page. Reason: {}", reason);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.location.href = '/index.html';");
    }
    let _ = app.emit("status", reason);
    let _ = app.emit(
        "health",
        serde_json::json!({
            "status": "offline",
            "message": reason,
            "websiteUrl": build_start_url(app_url),
            "services": { "database": "down", "auth": "down", "storage": "down" },
            "responseTime": 0,
            "timestamp": chrono::Utc::now().to_rfc3339(),
            "source": "launcher",
        }),
    );
}

// ── lib entry point ────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    {
        let _ = dotenvy::dotenv();
    }
    // In release, load .env from next to the executable
    #[cfg(not(debug_assertions))]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                let _ = dotenvy::from_path(dir.join(".env"));
            }
        }
    }

    env_logger::init();

    let start_url = WebviewUrl::External(
        format!("{}/assets", FALLBACK_URL).parse().expect("invalid fallback URL"),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            if let Some(url) = argv.iter().find(|a| a.starts_with("easyassets://")) {
                handle_deep_link(app, url);
            }
        }))
        .manage(AppState {
            app_url: Mutex::new(FALLBACK_URL.to_string()),
        })
        .invoke_handler(tauri::generate_handler![
            get_cached_assets,
            check_asset_updates,
            install_asset_update,
            update_asset_cache,
            download_asset_zip,
            scan_uefn_projects,
            select_projects_folder,
            get_existing_asset_folders,
            download_asset,
            extract_asset_to_project,
            reload_website,
        ])
        .setup(|app| {
            // ── Create the main window with the bridge script injected ──────
            // initializationScript is a BUILDER method, not a config field.
            // This is the only correct way to inject JS into a remote WebView in Tauri v2.
            let _window = WebviewWindowBuilder::new(app, "main", start_url)
                .title("EasyAssets")
                .inner_size(1200.0, 820.0)
                .center()
                .resizable(true)
                .initialization_script(BRIDGE_SCRIPT)
                .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 EasyAssetsLauncher")
                .build()?;

            // ── Deep-link handler ──────────────────────────────────────────
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&app_handle, url.as_str());
                }
            });

            // ── Async init: resolve URL then load website ──────────────────
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let url = resolve_app_url().await;
                {
                    let state = app_handle.state::<AppState>();
                    *state.app_url.lock().await = url.clone();
                }
                try_load_website(&app_handle, &url, 1).await;

                // Handle deep link passed on first launch (Windows protocol activation)
                let args: Vec<String> = std::env::args().collect();
                if let Some(link) = args.iter().find(|a| a.starts_with("easyassets://")) {
                    handle_deep_link(&app_handle, link);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
