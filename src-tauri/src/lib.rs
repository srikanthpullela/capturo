use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, ImageFormat};
use serde::Deserialize;
use std::io::Cursor;
use tauri::{AppHandle, Emitter, Manager};

fn reveal_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn hide_main_window_inner(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}


#[derive(Deserialize, Clone)]
pub struct CropRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

mod commands {
    use super::*;

    /// Interactive capture: hides window, shows native macOS crosshair selector,
    /// returns the selected region as base64 PNG. No fullscreen mode needed.
    #[tauri::command]
    pub async fn capture_interactive(app: AppHandle, hide_window: Option<bool>) -> Result<String, String> {
        #[cfg(target_os = "macos")]
        {
            // Consume macOS' first screencapture/TCC initialization pass before
            // the interactive crosshair appears. This prevents the first real
            // drag after launch from being eaten by a silent screencapture exit.
            let warmup_tmp = "/tmp/.capturo_capture_warmup.png";
            let _ = std::process::Command::new("screencapture")
                .args(["-x", "-R", "0,0,1,1", warmup_tmp])
                .status();
            let _ = std::fs::remove_file(warmup_tmp);
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        }

        let should_hide_window = hide_window.unwrap_or(true);
        let was_visible = app
            .get_webview_window("main")
            .and_then(|win| win.is_visible().ok())
            .unwrap_or(false);
        if should_hide_window {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }
        }
        // Wait long enough for the window compositor to fully remove the window
        // before screencapture starts — 250ms was too short on some machines.
        tokio::time::sleep(std::time::Duration::from_millis(450)).await;

        #[cfg(target_os = "macos")]
        {
            let tmp = format!(
                "/tmp/snapcraft_{}.png",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            );

            // -i = interactive (native crosshair), -x = no sound, -t png
            let status = std::process::Command::new("screencapture")
                .args(["-i", "-x", "-t", "png", &tmp])
                .status()
                .map_err(|e| format!("screencapture launch error: {e}"))?;

            // Let macOS restore the system cursor from screencapture before
            // we show the window — eliminates crosshair bleed-through reliably.
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;

            // User pressed Esc: screencapture exits non-zero or doesn't create the file
            if !status.success() || !std::path::Path::new(&tmp).exists() {
                // Restore only if the window was visible before capture.
                // If the user had already closed/hidden Capturo, Esc should
                // leave it in the background instead of reopening the editor.
                if was_visible {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                return Err("cancelled".to_string());
            }

            // Give the OS a short moment to flush the PNG to disk; on the
            // first capture after launch, the file can exist but be empty.
            let mut bytes: Vec<u8> = Vec::new();
            for _ in 0..6 {
                if let Ok(b) = std::fs::read(&tmp) {
                    if b.len() >= 8 {
                        bytes = b;
                        break;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            }
            if bytes.is_empty() {
                bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
            }
            std::fs::remove_file(&tmp).ok();

            // Validate PNG magic bytes: \x89PNG\r\n\x1a\n
            // screencapture exits 0 but writes an empty/corrupt file when
            // Screen Recording permission is denied on macOS 14+.
            const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
            if bytes.len() < 8 || &bytes[..8] != PNG_MAGIC {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                return Err("permission_denied".to_string());
            }

            let b64 = general_purpose::STANDARD.encode(&bytes);

            // Show window AFTER the result is ready — avoids showing the
            // "Preparing capture" spinner and prevents the window focus event
            // from racing with the pending IPC invoke response.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
                let win_c = win.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    let _ = win_c.emit("cursor-reset", ());
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    let _ = win_c.emit("cursor-reset", ());
                });
            }

            return Ok(b64);
        }

        #[cfg(not(target_os = "macos"))]
        {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Err("Interactive capture not supported on this platform".to_string())
        }
    }

    /// Crop a base64 PNG to the given region.
    #[tauri::command]
    pub fn crop_image(base64_png: String, region: CropRegion) -> Result<String, String> {
        let bytes = general_purpose::STANDARD
            .decode(&base64_png)
            .map_err(|e| e.to_string())?;
        let img = image::load_from_memory_with_format(&bytes, ImageFormat::Png)
            .map_err(|e| e.to_string())?;

        let sx = region.scale_factor.max(1.0);
        let sy = region.scale_factor.max(1.0);
        let x = (region.x * sx) as u32;
        let y = (region.y * sy) as u32;
        let w = ((region.width * sx) as u32)
            .max(1)
            .min(img.width().saturating_sub(x));
        let h = ((region.height * sy) as u32)
            .max(1)
            .min(img.height().saturating_sub(y));

        let cropped = img.crop_imm(x, y, w, h);
        let buf = cropped
            .write_to_bytes(ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(general_purpose::STANDARD.encode(&buf))
    }

    /// Save a base64 PNG to disk.
    #[tauri::command]
    pub fn save_image(base64_png: String, file_path: String) -> Result<(), String> {
        let bytes = general_purpose::STANDARD
            .decode(&base64_png)
            .map_err(|e| e.to_string())?;
        std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())
    }

    /// Write a base64 PNG to a temp file for drag-out and return the file path.
    #[tauri::command]
    pub fn write_temp_image(id: String, base64_png: String) -> Result<String, String> {
        let bytes = general_purpose::STANDARD
            .decode(&base64_png)
            .map_err(|e| e.to_string())?;
        let path = format!("/tmp/capturo_drag_{}.png", id);
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        Ok(path)
    }

    /// Quick-save a base64 PNG to ~/Downloads/Capturo-<timestamp>.png
    #[tauri::command]
    pub fn save_to_downloads(base64_png: String, file_extension: Option<String>, filename_template: Option<String>) -> Result<String, String> {
        let bytes = general_purpose::STANDARD
            .decode(&base64_png)
            .map_err(|e| format!("decode: {e}"))?;
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let dir = std::path::PathBuf::from(&home).join("Downloads");
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let ext = match file_extension.as_deref() {
            Some("jpg") | Some("jpeg") => "jpg",
            _ => "png",
        };
        let base = filename_template
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Capturo-{datetime}".to_string())
            .replace("{datetime}", &ts.to_string())
            .replace("{date}", &ts.to_string())
            .replace("{time}", &ts.to_string());
        let clean: String = base
            .chars()
            .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ' ') { ch } else { '-' })
            .collect::<String>()
            .trim_matches(|ch| matches!(ch, '-' | '.' | ' '))
            .to_string();
        let filename = format!("{}.{}", if clean.is_empty() { format!("Capturo-{ts}") } else { clean }, ext);
        let path = dir.join(&filename);
        std::fs::write(&path, &bytes).map_err(|e| format!("write: {e}"))?;
        Ok(filename)
    }

    /// Copy a base64 PNG to the system clipboard using arboard.
    #[tauri::command]
    pub fn copy_image_to_clipboard(base64_png: String) -> Result<(), String> {
        let bytes = general_purpose::STANDARD
            .decode(&base64_png)
            .map_err(|e| e.to_string())?;
        let img = image::load_from_memory_with_format(&bytes, ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        let raw: Vec<u8> = rgba.into_raw();

        let mut ctx = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        ctx.set_image(arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(raw),
        })
        .map_err(|e| e.to_string())
    }

    /// Open macOS Screen Recording settings panel.
    #[tauri::command]
    pub fn open_screen_permission_settings() -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// No-op: Capturo itself doesn't need screen recording permission.
    /// The screencapture subprocess handles its own TCC grant.
    #[tauri::command]
    pub fn check_screen_permission() -> bool { true }

    /// No-op: never call CGRequestScreenCaptureAccess from Capturo.
    /// Calling it causes macOS to show the TCC dialog for Capturo itself,
    /// and the grant resets whenever the binary changes. screencapture handles
    /// its own permission — we just run it as a subprocess.
    #[tauri::command]
    pub fn request_screen_permission() -> bool { true }

    #[tauri::command]
    pub fn show_main_window(app: AppHandle) {
        reveal_main_window(&app);
    }

    #[tauri::command]
    pub fn hide_main_window(app: AppHandle) {
        hide_main_window_inner(&app);
    }

    /// Capture the entire screen without any interactive selection.
    #[tauri::command]
    pub async fn capture_fullscreen(app: AppHandle) -> Result<String, String> {
        #[cfg(target_os = "macos")]
        {
            let was_visible = app
                .get_webview_window("main")
                .and_then(|win| win.is_visible().ok())
                .unwrap_or(false);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.hide();
            }
            tokio::time::sleep(std::time::Duration::from_millis(380)).await;

            let tmp = format!(
                "/tmp/capturo_fs_{}.png",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
            );

            let status = std::process::Command::new("screencapture")
                .args(["-x", "-t", "png", &tmp])
                .status()
                .map_err(|e| format!("screencapture error: {e}"))?;

            tokio::time::sleep(std::time::Duration::from_millis(200)).await;

            if !status.success() || !std::path::Path::new(&tmp).exists() {
                if was_visible {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                }
                return Err("fullscreen capture failed".to_string());
            }

            let mut bytes: Vec<u8> = Vec::new();
            for _ in 0..6 {
                if let Ok(b) = std::fs::read(&tmp) {
                    if b.len() >= 8 { bytes = b; break; }
                }
                tokio::time::sleep(std::time::Duration::from_millis(60)).await;
            }
            if bytes.is_empty() {
                bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
            }
            std::fs::remove_file(&tmp).ok();

            const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
            if bytes.len() < 8 || &bytes[..8] != PNG_MAGIC {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
                return Err("permission_denied".to_string());
            }

            let b64 = general_purpose::STANDARD.encode(&bytes);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
            return Ok(b64);
        }

        #[cfg(not(target_os = "macos"))]
        {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Err("Fullscreen capture not supported on this platform".to_string())
        }
    }

    /// Toggle always-on-top for the main window.
    #[tauri::command]
    pub fn set_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
        if let Some(win) = app.get_webview_window("main") {
            win.set_always_on_top(enabled).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Windows: capture the primary screen and go fullscreen so the
    /// frontend can show a selection overlay on top of the screenshot.
    #[tauri::command]
    pub async fn capture_full_screen_windows(app: AppHandle) -> Result<serde_json::Value, String> {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.hide();
        }
        tokio::time::sleep(std::time::Duration::from_millis(350)).await;

        #[cfg(target_os = "windows")]
        {
            use xcap::Monitor;
            let monitors = Monitor::all().map_err(|e| e.to_string())?;
            let monitor = monitors
                .iter()
                .find(|m| m.is_primary())
                .or_else(|| monitors.first())
                .ok_or_else(|| "No monitor found".to_string())?;

            let image = monitor.capture_image().map_err(|e| e.to_string())?;
            let (width, height) = (image.width(), image.height());
            let dyn_img = DynamicImage::ImageRgba8(image);
            let mut buf = Vec::new();
            dyn_img
                .write_to(&mut Cursor::new(&mut buf), ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            let b64 = general_purpose::STANDARD.encode(&buf);

            // Maximize so the selection overlay covers the entire screen
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_fullscreen(true);
                let _ = win.show();
                let _ = win.set_focus();
            }
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;

            return Ok(serde_json::json!({
                "base64": b64,
                "screenWidth": width,
                "screenHeight": height
            }));
        }

        #[allow(unreachable_code)]
        {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
            }
            Err("Windows-only command".to_string())
        }
    }

    /// Windows: exit fullscreen after the user finishes the selection overlay.
    #[tauri::command]
    pub async fn exit_windows_capture(app: AppHandle) -> Result<(), String> {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.set_fullscreen(false);
            let _ = win.show();
            let _ = win.set_focus();
        }
        Ok(())
    }
}

trait ImageExt {
    fn write_to_bytes(&self, fmt: ImageFormat) -> image::ImageResult<Vec<u8>>;
}
impl ImageExt for DynamicImage {
    fn write_to_bytes(&self, fmt: ImageFormat) -> image::ImageResult<Vec<u8>> {
        let mut buf = Vec::new();
        self.write_to(&mut Cursor::new(&mut buf), fmt)?;
        Ok(buf)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            reveal_main_window(app);
        }))
        .setup(|app| {
            // ── System tray ──────────────────────────────────────────────
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
            use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

            let screenshot_item  = MenuItem::with_id(app, "screenshot",  "Take Screenshot  ⌘⇧9", true, None::<&str>)?;
            let show_item        = MenuItem::with_id(app, "show",        "Show Capturo",          true, None::<&str>)?;
            let preferences_item = MenuItem::with_id(app, "preferences", "Preferences",           true, None::<&str>)?;
            let sep              = PredefinedMenuItem::separator(app)?;
            let quit_item        = MenuItem::with_id(app, "quit",        "Quit Capturo",          true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&screenshot_item, &show_item, &preferences_item, &sep, &quit_item])?;

            #[cfg(target_os = "macos")]
            let tray_bytes = include_bytes!("../icons/tray-icon-template.png");
            #[cfg(not(target_os = "macos"))]
            let tray_bytes = include_bytes!("../icons/tray-icon.png");
            let tray_img = image::load_from_memory(tray_bytes).expect("decode tray icon");
            let tray_rgba = tray_img.to_rgba8();
            let (tw, th) = tray_rgba.dimensions();
            let tray_icon = tauri::image::Image::new_owned(tray_rgba.into_raw(), tw, th);

            TrayIconBuilder::new()
                .icon(tray_icon)
                .menu(&menu)
                .tooltip("Capturo — Screenshot Tool")
                .icon_as_template(cfg!(target_os = "macos"))
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "screenshot" => {
                        // Emit to frontend — window may be hidden but webview keeps running
                        let _ = app.emit("tray-screenshot", ());
                    }
                    "show" => {
                        reveal_main_window(app);
                    }
                    "preferences" => {
                        reveal_main_window(app);
                        let _ = app.emit("open-preferences", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left-click tray icon → show / focus window
                    if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                        let app = tray.app_handle();
                        reveal_main_window(&app);
                    }
                })
                .build(app)?;

            Ok(())
        })
        // ── Red-X hides to tray instead of quitting ──────────────────────
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture_interactive,
            commands::capture_fullscreen,
            commands::crop_image,
            commands::save_image,
            commands::write_temp_image,
            commands::copy_image_to_clipboard,
            commands::save_to_downloads,
            commands::open_screen_permission_settings,
            commands::check_screen_permission,
            commands::request_screen_permission,
            commands::show_main_window,
            commands::hide_main_window,
            commands::set_always_on_top,
            commands::capture_full_screen_windows,
            commands::exit_windows_capture,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Capturo")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows: false, .. } = event {
                reveal_main_window(app);
            }
        });
}
