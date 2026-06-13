/// EAA (EasyAssets Archive) file format handler.
///
/// Binary layout:
/// [Magic: 4 bytes 0xEA 0xAA 0x00 0x01]
/// [Version: 1 byte  = 0x01]
/// [Metadata JSON length: 4 bytes big-endian u32]
/// [Metadata JSON: UTF-8]
/// [ZIP data: remainder]

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use std::io::{Cursor, Read, Write};
use std::path::Path;

const MAGIC: [u8; 4] = [0xEA, 0xAA, 0x00, 0x01];
const VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EaaMetadata {
    pub id: Option<String>,
    pub name: Option<String>,
    pub version: Option<String>,
    pub creator: Option<String>,
    pub thumbnail: Option<String>,
    pub downloaded_at: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

pub struct EaaFile {
    pub metadata: EaaMetadata,
    pub zip_data: Vec<u8>,
}

impl EaaFile {
    /// Build an in-memory EAA buffer from zip bytes + metadata.
    pub fn create(zip_data: Vec<u8>, metadata: &EaaMetadata) -> Result<Vec<u8>> {
        let meta_json = serde_json::to_string(metadata)?;
        let meta_bytes = meta_json.as_bytes();
        let meta_len = meta_bytes.len() as u32;

        let mut buf: Vec<u8> = Vec::with_capacity(4 + 1 + 4 + meta_bytes.len() + zip_data.len());
        buf.extend_from_slice(&MAGIC);
        buf.push(VERSION);
        buf.extend_from_slice(&meta_len.to_be_bytes());
        buf.extend_from_slice(meta_bytes);
        buf.extend_from_slice(&zip_data);
        Ok(buf)
    }

    /// Write EAA file to disk.
    pub fn write(path: &Path, zip_data: Vec<u8>, metadata: &EaaMetadata) -> Result<()> {
        let buf = Self::create(zip_data, metadata)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, buf)?;
        Ok(())
    }

    /// Parse an EAA file from disk.
    pub fn parse(path: &Path) -> Result<Self> {
        let buf = std::fs::read(path)?;
        Self::parse_bytes(&buf)
    }

    /// Parse EAA from a raw byte slice.
    pub fn parse_bytes(buf: &[u8]) -> Result<Self> {
        if buf.len() < 9 {
            bail!("EAA file too short");
        }
        if buf[0..4] != MAGIC {
            bail!("Invalid EAA magic header");
        }
        if buf[4] != VERSION {
            bail!("Unsupported EAA version: {}", buf[4]);
        }
        let meta_len = u32::from_be_bytes([buf[5], buf[6], buf[7], buf[8]]) as usize;
        let meta_start = 9;
        let meta_end = meta_start + meta_len;
        if buf.len() < meta_end {
            bail!("EAA metadata truncated");
        }
        let metadata: EaaMetadata = serde_json::from_slice(&buf[meta_start..meta_end])?;
        let zip_data = buf[meta_end..].to_vec();
        Ok(Self { metadata, zip_data })
    }

    /// Extract the embedded ZIP into `extract_path`, rejecting any path-traversal entries.
    pub fn extract_to(&self, extract_path: &Path) -> Result<()> {
        std::fs::create_dir_all(extract_path)?;
        let cursor = Cursor::new(&self.zip_data);
        let mut archive = zip::ZipArchive::new(cursor)?;

        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let raw_name = entry.name().to_string();
            let safe_name = sanitize_zip_entry(&raw_name)?;

            let dest = extract_path.join(&safe_name);

            // Path-traversal guard
            let canon_dest = dest
                .components()
                .collect::<std::path::PathBuf>();
            let canon_base = extract_path
                .components()
                .collect::<std::path::PathBuf>();
            if !canon_dest.starts_with(&canon_base) {
                bail!("Unsafe ZIP entry path: {}", raw_name);
            }

            if entry.is_dir() {
                std::fs::create_dir_all(&dest)?;
            } else {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let mut out = std::fs::File::create(&dest)?;
                let mut data = Vec::new();
                entry.read_to_end(&mut data)?;
                out.write_all(&data)?;
            }
        }
        Ok(())
    }

    /// Read only the metadata from an EAA file without loading the full ZIP.
    pub fn read_metadata(path: &Path) -> Result<EaaMetadata> {
        let buf = std::fs::read(path)?;
        if buf.len() < 9 {
            bail!("EAA file too short");
        }
        if buf[0..4] != MAGIC {
            bail!("Invalid EAA magic header");
        }
        let meta_len = u32::from_be_bytes([buf[5], buf[6], buf[7], buf[8]]) as usize;
        let meta_start = 9;
        let meta_end = meta_start + meta_len;
        if buf.len() < meta_end {
            bail!("EAA metadata truncated");
        }
        let metadata: EaaMetadata = serde_json::from_slice(&buf[meta_start..meta_end])?;
        Ok(metadata)
    }
}

fn sanitize_zip_entry(name: &str) -> Result<String> {
    // Normalise backslashes and strip leading slashes
    let normalized = name.replace('\\', "/");
    let stripped = normalized.trim_start_matches('/');

    // Reject obvious traversal
    if stripped.split('/').any(|seg| seg == "..") {
        bail!("Path traversal in ZIP entry: {}", name);
    }
    if stripped.is_empty() || stripped == "." {
        bail!("Empty ZIP entry name");
    }

    Ok(stripped.to_string())
}
