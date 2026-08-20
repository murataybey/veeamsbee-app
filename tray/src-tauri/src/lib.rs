// Sbee tray uygulaması: sağ alt köşede durum ikonu, tıklayınca özet penceresi.
// Tüm HTTP istekleri Rust tarafından yapılır (CORS/CSP derdi yok); webview yalnızca arayüzü çizer.
use std::time::Duration;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_opener::OpenerExt as _;
use tauri_plugin_positioner::{Position, WindowExt as _};

const TRAY_ID: &str = "sbee-tray";

fn toggle_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.as_ref().window().move_window(Position::TrayBottomCenter);
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

/// Sbee backend'ine HTTP isteği. Cevap her zaman {"status":N,"body":"..."} JSON'ı olarak döner.
#[tauri::command]
async fn api_request(
    base: String,
    path: String,
    method: Option<String>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.unwrap_or(30_000)))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| e.to_string())?;
    let m = method.as_deref().unwrap_or("GET").to_uppercase();
    let mut req = match m.as_str() {
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };
    if let Some(b) = body {
        req = req.header("Content-Type", "application/json").body(b);
    }
    let res = req.send().await.map_err(|e| format!("Bağlantı hatası: {e}"))?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": status, "body": text }).to_string())
}

/// Tray ikonunu ve ipucu metnini genel duruma göre değiştirir.
#[tauri::command]
fn set_status(app: AppHandle, status: String, tooltip: Option<String>) {
    let bytes: &[u8] = match status.as_str() {
        "ok" => include_bytes!("../icons-tray/tray-green.png"),
        "warning" => include_bytes!("../icons-tray/tray-yellow.png"),
        "critical" => include_bytes!("../icons-tray/tray-red.png"),
        _ => include_bytes!("../icons-tray/tray-gray.png"),
    };
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(img) = Image::from_bytes(bytes) {
            let _ = tray.set_icon(Some(img));
        }
        let _ = tray.set_tooltip(tooltip.as_deref().or(Some("Sbee")));
    }
}

#[tauri::command]
fn notify(app: AppHandle, title: String, body: String) {
    let _ = app.notification().builder().title(title).body(body).show();
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    let l = app.autolaunch();
    if enabled { l.enable() } else { l.disable() }.map_err(|e| e.to_string())
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // İkinci kopya açılırsa mevcut pencereyi öne getir
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None,
            ))?;

            let show = MenuItem::with_id(app, "show", "Durumu Göster", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Çıkış", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(Image::from_bytes(include_bytes!("../icons-tray/tray-gray.png"))?)
                .tooltip("Sbee — bağlanıyor…")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => toggle_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Popup davranışı: odak kaybedince gizlen
            if window.label() == "main" {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            api_request,
            set_status,
            notify,
            autostart_enabled,
            autostart_set,
            open_url,
            hide_window
        ])
        .run(tauri::generate_context!())
        .expect("Sbee tray başlatılamadı");
}
