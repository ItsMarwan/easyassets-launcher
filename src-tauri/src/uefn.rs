/// UEFN project scanner — mirrors UEFNProjectScanner from uefn-scanner.js.

use anyhow::Result;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UefnProject {
    pub name: String,
    pub path: String,
    pub content_path: String,
}

/// Returns the default Fortnite Projects directory on Windows.
/// Falls back to ~/Documents/Fortnite Projects on other platforms.
pub fn default_projects_path() -> PathBuf {
    // Windows: C:\Users\<username>\Documents\Fortnite Projects
    if let Some(docs) = dirs::document_dir() {
        return docs.join("Fortnite Projects");
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Documents")
        .join("Fortnite Projects")
}

/// Scan a directory for UEFN projects.
/// Supports both old (plugins/ sub-tree) and new (Content/ sibling) layouts.
pub fn scan_projects(base_path: &Path) -> Vec<UefnProject> {
    let mut projects = Vec::new();

    if !base_path.exists() {
        return projects;
    }

    let entries = match std::fs::read_dir(base_path) {
        Ok(e) => e,
        Err(_) => return projects,
    };

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };

        // --- New layout: projectName/projectName.uefnproject + projectName/Content ---
        let project_file = entry_path.join(format!("{}.uefnproject", name));
        if project_file.exists() {
            let content = entry_path.join("Content");
            if content.exists() {
                projects.push(UefnProject {
                    name: name.clone(),
                    path: entry_path.to_string_lossy().to_string(),
                    content_path: content.to_string_lossy().to_string(),
                });
                continue;
            }
        }

        // --- Old layout: projectName/plugins/projectName/Content ---
        let old_content = entry_path.join("plugins").join(&name).join("Content");
        let old_project_file = entry_path
            .join("plugins")
            .join(&name)
            .join(format!("{}.uefnproject", name));
        if old_project_file.exists() && old_content.exists() {
            projects.push(UefnProject {
                name,
                path: entry_path.to_string_lossy().to_string(),
                content_path: old_content.to_string_lossy().to_string(),
            });
        }
    }

    projects
}

/// Scan the default projects path.
pub fn scan_default_projects() -> Vec<UefnProject> {
    scan_projects(&default_projects_path())
}

/// Create (or verify) a sub-folder inside a Content directory.
/// Returns the full path of the created/existing folder.
pub fn ensure_asset_folder(content_path: &str, folder_name: &str) -> Result<String> {
    validate_folder_name(folder_name)?;
    let folder = Path::new(content_path).join(folder_name);
    std::fs::create_dir_all(&folder)?;
    Ok(folder.to_string_lossy().to_string())
}

/// List existing sub-directories of a Content folder.
pub fn get_existing_asset_folders(content_path: &str) -> Vec<String> {
    let path = Path::new(content_path);
    if !path.exists() {
        return Vec::new();
    }
    let mut names: Vec<String> = std::fs::read_dir(path)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    names.sort();
    names
}

/// Validate that a folder name is safe: alphanumeric, underscore, hyphen only.
pub fn validate_folder_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > 255 {
        anyhow::bail!("Folder name must be 1–255 characters");
    }
    let re = Regex::new(r"^[a-zA-Z0-9_\-]+$").unwrap();
    if !re.is_match(name) {
        anyhow::bail!("Folder name contains invalid characters: {}", name);
    }
    Ok(())
}

/// Sanitize a folder name — replace unsafe chars with underscore, trim.
pub fn sanitize_folder_name(name: &str) -> String {
    let re = Regex::new(r"[^a-zA-Z0-9_\-]").unwrap();
    let sanitized = re.replace_all(name.trim(), "_").to_string();
    sanitized
        .trim_matches('_')
        .chars()
        .take(255)
        .collect()
}
