use std::path::{Path, PathBuf};

use tauri::Manager;

/// File types the app exports. Only these are saved, opened or shown, so a
/// page script can never use the commands to run a program.
const EXPORT_TYPES: &[&str] = &["png", "svg", "ttf", "json", "pdf"];

fn has_export_type(path: &Path) -> bool {
  path
    .extension()
    .and_then(|e| e.to_str())
    .is_some_and(|e| EXPORT_TYPES.contains(&e.to_ascii_lowercase().as_str()))
}

/// `%D0%9F…` → text (file names travel URL-encoded in a header).
fn percent_decode(s: &str) -> String {
  let bytes = s.as_bytes();
  let hex = |b: u8| (b as char).to_digit(16);
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
        out.push((hi * 16 + lo) as u8);
        i += 3;
        continue;
      }
    }
    out.push(bytes[i]);
    i += 1;
  }
  String::from_utf8_lossy(&out).into_owned()
}

/// A plain file name: no folders, no characters Windows forbids.
fn clean_name(name: &str) -> String {
  let cleaned: String = name
    .chars()
    .map(|c| if c.is_control() || r#"\/:*?"<>|"#.contains(c) { '_' } else { c })
    .collect();
  let cleaned = cleaned.trim().trim_start_matches('.').to_string();
  if cleaned.is_empty() { "file".into() } else { cleaned }
}

/// `name.png`, then `name (1).png`, `name (2).png`… — never overwrite an earlier export.
fn free_path(dir: &Path, name: &str) -> PathBuf {
  let first = dir.join(name);
  if !first.exists() {
    return first;
  }
  let (stem, ext) = match name.rfind('.') {
    Some(dot) if dot > 0 => (&name[..dot], &name[dot..]),
    _ => (name, ""),
  };
  (1..)
    .map(|n| dir.join(format!("{stem} ({n}){ext}")))
    .find(|p| !p.exists())
    .unwrap()
}

/// An exported file the user asks about: must still exist, be one of ours and lie in Downloads.
fn exported_file(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
  let path = PathBuf::from(path);
  if !path.exists() {
    return Err("Файл не найден: возможно, его переместили или удалили.".into());
  }
  let downloads = app.path().download_dir().map_err(|e| e.to_string())?;
  let inside = match (path.canonicalize(), downloads.canonicalize()) {
    (Ok(p), Ok(d)) => p.starts_with(d),
    _ => false,
  };
  if !inside || !has_export_type(&path) {
    return Err("Этот файл открыть нельзя.".into());
  }
  Ok(path)
}

/// Saves an export (raw bytes; the name in the `x-file-name` header) into Downloads; returns the full path.
#[tauri::command]
fn save_download(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
  let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
    return Err("ожидались байты файла".into());
  };
  let name = request
    .headers()
    .get("x-file-name")
    .and_then(|v| v.to_str().ok())
    .map(percent_decode)
    .map(|n| clean_name(&n))
    .unwrap_or_else(|| "file".into());
  if !has_export_type(Path::new(&name)) {
    return Err(format!("Такой файл сохранить нельзя: {name}"));
  }
  let dir = app.path().download_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let path = free_path(&dir, &name);
  std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
  Ok(path.to_string_lossy().into_owned())
}

/// Shows the file selected in its folder (Explorer / Finder).
#[tauri::command]
fn reveal_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
  let path = exported_file(&app, &path)?;
  #[cfg(target_os = "windows")]
  let spawned = {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", path.display())).spawn()
  };
  #[cfg(target_os = "macos")]
  let spawned = std::process::Command::new("open").arg("-R").arg(&path).spawn();
  #[cfg(all(unix, not(target_os = "macos")))]
  let spawned = std::process::Command::new("xdg-open").arg(path.parent().unwrap_or(&path)).spawn();
  spawned.map(|_| ()).map_err(|e| e.to_string())
}

/// Opens the file in its usual program.
#[tauri::command]
fn open_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
  let path = exported_file(&app, &path)?;
  #[cfg(target_os = "windows")]
  let spawned = std::process::Command::new("explorer").arg(&path).spawn();
  #[cfg(target_os = "macos")]
  let spawned = std::process::Command::new("open").arg(&path).spawn();
  #[cfg(all(unix, not(target_os = "macos")))]
  let spawned = std::process::Command::new("xdg-open").arg(&path).spawn();
  spawned.map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![save_download, reveal_file, open_file])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn names_are_decoded_and_cleaned() {
    assert_eq!(percent_decode("%D0%9B%D0%B8%D1%81%D1%82%201.png"), "Лист 1.png");
    assert_eq!(percent_decode("100%"), "100%");
    assert_eq!(clean_name("../..\\evil:name?.png"), "_.._evil_name_.png");
    assert_eq!(clean_name("   "), "file");
  }

  #[test]
  fn only_export_types_are_allowed() {
    assert!(has_export_type(Path::new("a.PNG")));
    assert!(has_export_type(Path::new("doc.handbook.json")));
    assert!(!has_export_type(Path::new("setup.exe")));
    assert!(!has_export_type(Path::new("noext")));
  }

  #[test]
  fn existing_files_are_not_overwritten() {
    let dir = std::env::temp_dir().join(format!("handbook-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.png"), b"1").unwrap();
    assert_eq!(free_path(&dir, "a.png"), dir.join("a (1).png"));
    assert_eq!(free_path(&dir, "b.png"), dir.join("b.png"));
    std::fs::remove_dir_all(&dir).unwrap();
  }
}
