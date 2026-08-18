//! Durable copy of the optional terminal wallpaper image.
//!
//! Settings persist only the wallpaper *choice*. Custom photos are copied into
//! the config directory so a later file move does not break the setting, and so
//! the original path never has to stay in the sandbox.

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::config;
use super::fs::expand_tilde;
use super::fs::file::{image_preview, ReadResult, MAX_IMAGE_PIXELS};

const MAX_WALLPAPER_BYTES: u64 = 8 * 1024 * 1024;
const WALLPAPER_DIR: &str = "wallpaper";
const WALLPAPER_STEM: &str = "current";

#[derive(Clone, Debug, Serialize)]
pub struct WallpaperImportResult {
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

fn wallpaper_dir_at(config_dir: &Path) -> PathBuf {
    config_dir.join(WALLPAPER_DIR)
}

fn extension_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

fn current_wallpaper_path(dir: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut match_path = None;
    for entry in entries {
        let entry = entry.ok()?;
        let path = entry.path();
        let name = path.file_name()?.to_str()?;
        if let Some(stem) = name
            .strip_suffix(".png")
            .or_else(|| name.strip_suffix(".jpg"))
            .or_else(|| name.strip_suffix(".webp"))
            .or_else(|| name.strip_suffix(".gif"))
        {
            if stem == WALLPAPER_STEM {
                match_path = Some(path);
            }
        }
    }
    match_path
}

fn clear_wallpaper_dir(dir: &Path) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("read wallpaper dir failed: {e}"))? {
        let entry = entry.map_err(|e| format!("read wallpaper dir failed: {e}"))?;
        let path = entry.path();
        if path.is_file() {
            fs::remove_file(&path).map_err(|e| format!("remove wallpaper failed: {e}"))?;
        }
    }
    Ok(())
}

fn read_image_file(path: &Path) -> Result<(Vec<u8>, &'static str, u32, u32), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("wallpaper path must not be a symlink".into());
    }
    if !meta.is_file() {
        return Err("wallpaper path is not a file".into());
    }
    let size = meta.len();
    if size > MAX_WALLPAPER_BYTES {
        return Err(format!(
            "wallpaper is larger than {} bytes",
            MAX_WALLPAPER_BYTES
        ));
    }
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(size as usize);
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let preview =
        image_preview(&bytes).ok_or_else(|| "wallpaper is not a supported image".to_string())?;
    if extension_for_mime(preview.mime).is_none() {
        return Err("wallpaper must be PNG, JPEG, WebP, or GIF".into());
    }
    if u64::from(preview.width).saturating_mul(u64::from(preview.height)) > MAX_IMAGE_PIXELS {
        return Err("wallpaper pixel count is too large".into());
    }
    Ok((bytes, preview.mime, preview.width, preview.height))
}

fn import_into(config_dir: &Path, source: &Path) -> Result<WallpaperImportResult, String> {
    let (bytes, mime, width, height) = read_image_file(source)?;
    let ext = extension_for_mime(mime).expect("mime already validated");
    let dir = wallpaper_dir_at(config_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("create wallpaper dir failed: {e}"))?;
    clear_wallpaper_dir(&dir)?;
    let dest = dir.join(format!("{WALLPAPER_STEM}.{ext}"));
    let tmp = dir.join(format!(
        ".{WALLPAPER_STEM}.{}.{}.tmp",
        std::process::id(),
        width
    ));
    fs::write(&tmp, &bytes).map_err(|e| format!("write wallpaper failed: {e}"))?;
    if let Err(error) = fs::rename(&tmp, &dest) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("replace wallpaper failed: {error}"));
    }
    Ok(WallpaperImportResult {
        mime,
        width,
        height,
    })
}

fn load_from(config_dir: &Path) -> Result<Option<ReadResult>, String> {
    let dir = wallpaper_dir_at(config_dir);
    let Some(path) = current_wallpaper_path(&dir) else {
        return Ok(None);
    };
    let (bytes, mime, width, height) = read_image_file(&path)?;
    Ok(Some(ReadResult::Image {
        size: bytes.len() as u64,
        bytes,
        mime,
        width,
        height,
    }))
}

fn clear_from(config_dir: &Path) -> Result<(), String> {
    clear_wallpaper_dir(&wallpaper_dir_at(config_dir))
}

#[tauri::command]
pub fn terminal_wallpaper_import(path: String) -> Result<WallpaperImportResult, String> {
    import_into(&config::config_dir()?, &expand_tilde(&path))
}

#[tauri::command]
pub fn terminal_wallpaper_load() -> Result<Option<ReadResult>, String> {
    load_from(&config::config_dir()?)
}

#[tauri::command]
pub fn terminal_wallpaper_clear() -> Result<(), String> {
    clear_from(&config::config_dir()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    // 1×1 transparent PNG.
    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn temp_dir(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("tunara-wallpaper-test-{name}-{unique}"))
    }

    #[test]
    fn import_copies_png_and_load_round_trips() {
        let root = temp_dir("roundtrip");
        let source = root.join("source.png");
        fs::create_dir_all(&root).unwrap();
        fs::write(&source, PNG_1X1).unwrap();
        let config_dir = root.join("config");
        let imported = import_into(&config_dir, &source).unwrap();
        assert_eq!(imported.mime, "image/png");
        assert_eq!(imported.width, 1);
        assert_eq!(imported.height, 1);
        let loaded = load_from(&config_dir).unwrap().expect("stored wallpaper");
        match loaded {
            ReadResult::Image {
                mime,
                width,
                height,
                bytes,
                ..
            } => {
                assert_eq!(mime, "image/png");
                assert_eq!(width, 1);
                assert_eq!(height, 1);
                assert_eq!(bytes, PNG_1X1);
            }
            other => panic!("unexpected wallpaper load result: {}", other_kind(&other)),
        }
        clear_from(&config_dir).unwrap();
        assert!(load_from(&config_dir).unwrap().is_none());
        let _ = fs::remove_dir_all(root);
    }

    fn other_kind(result: &ReadResult) -> &'static str {
        match result {
            ReadResult::Text { .. } => "text",
            ReadResult::Binary { .. } => "binary",
            ReadResult::Image { .. } => "image",
            ReadResult::ImageTooLarge { .. } => "imagetoolarge",
            ReadResult::TooLarge { .. } => "toolarge",
        }
    }

    #[test]
    fn rejects_non_image_and_symlink() {
        let root = temp_dir("reject");
        fs::create_dir_all(&root).unwrap();
        let text = root.join("note.txt");
        fs::write(&text, b"hello").unwrap();
        let err = import_into(&root.join("config"), &text).unwrap_err();
        assert!(err.contains("supported image"), "{err}");

        let png = root.join("ok.png");
        fs::write(&png, PNG_1X1).unwrap();
        let link = root.join("link.png");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&png, &link).unwrap();
            let err = import_into(&root.join("config"), &link).unwrap_err();
            assert!(err.contains("symlink"), "{err}");
        }
        let _ = fs::remove_dir_all(root);
    }
}
