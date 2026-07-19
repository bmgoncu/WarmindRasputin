//! The overlay shell.
//!
//! A menu-bar app: no Dock icon, no app-switcher entry, one tray glyph whose menu is the only
//! chrome. Everything a browser cannot do for itself lives here and nothing else —
//!
//!   1. a transparent, undecorated, always-on-top window
//!   2. click-through, so the orb floats over Rider without stealing input
//!   3. a global hotkey that fires while another app has focus
//!   4. the tray icon, its menu, and the preferences window
//!
//! All behaviour — synthesis, features, the orb, subtitles — is in the Node daemon and the web
//! renderer, which loads unchanged from Chrome.

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Live window state.
///
/// Tracked rather than queried: there is no getter for `ignore_cursor_events`, so asking the
/// window would mean keeping a shadow copy anyway.
struct OverlayState {
    click_through: std::sync::Mutex<bool>,
}

/// Lets the mouse pass through to whatever is behind the orb.
///
/// The overlay is always-on-top and covers a large area, so without this it swallows clicks meant
/// for the editor underneath — the orb would make the machine unusable rather than assist.
#[tauri::command]
fn set_click_through(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window missing")?;
    window.set_ignore_cursor_events(enabled).map_err(|e| e.to_string())?;
    if let Some(state) = app.try_state::<OverlayState>() {
        *state.click_through.lock().unwrap() = enabled;
    }
    let _ = app.emit("overlay-interactive", !enabled);
    Ok(())
}

#[tauri::command]
fn is_click_through(app: tauri::AppHandle) -> bool {
    app.try_state::<OverlayState>()
        .map(|s| *s.click_through.lock().unwrap())
        .unwrap_or(false)
}

/// Move mode: the whole window becomes a drag handle.
///
/// Repositioning requires the window to accept the cursor, so this is click-through's inverse and
/// not an independent setting — enabling move mode necessarily makes the orb clickable.
#[tauri::command]
fn set_move_mode(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    set_click_through(app.clone(), !enabled)?;
    let _ = app.emit("overlay-move-mode", enabled);
    Ok(())
}

/// Current overlay position and size, so preferences can show and restore it.
#[tauri::command]
fn get_overlay_bounds(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let w = app.get_webview_window("main").ok_or("main window missing")?;
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    let size = w.outer_size().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "x": pos.x, "y": pos.y, "width": size.width, "height": size.height }))
}

#[tauri::command]
fn set_overlay_bounds(app: tauri::AppHandle, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
    let w = app.get_webview_window("main").ok_or("main window missing")?;
    w.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    w.set_size(tauri::PhysicalSize::new(width, height)).map_err(|e| e.to_string())
}

#[tauri::command]
fn center_overlay(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("main").ok_or("main window missing")?.center().map_err(|e| e.to_string())
}

/// Opens preferences, or focuses it if already open.
///
/// A separate window rather than a panel inside the overlay: the overlay is click-through and
/// often fully transparent, which are both hostile to a form.
#[tauri::command]
fn open_preferences(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("preferences") {
        w.show().map_err(|e| e.to_string())?;
        return w.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, "preferences", WebviewUrl::App("preferences.html".into()))
        .title("Rasputin Preferences")
        .inner_size(430.0, 640.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(OverlayState { click_through: std::sync::Mutex::new(true) })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            set_click_through,
            is_click_through,
            set_move_mode,
            get_overlay_bounds,
            set_overlay_bounds,
            center_overlay,
            open_preferences
        ])
        .setup(|app| {
            // Menu-bar app: no Dock icon, no app-switcher entry. Accessory is what makes the tray
            // the only affordance, which is the point of this shape.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let window = app.get_webview_window("main").expect("main window missing");

            // Click-through from the start. The overlay is idle on launch, and an orb that eats
            // clicks before being asked for anything is worse than no orb.
            let _ = window.set_ignore_cursor_events(true);
            #[cfg(target_os = "macos")]
            let _ = window.set_visible_on_all_workspaces(true);

            // --- tray ---------------------------------------------------------------------
            let show_item = CheckMenuItem::with_id(app, "show", "Show Orb", true, true, None::<&str>)?;
            let interactive_item =
                CheckMenuItem::with_id(app, "interactive", "Interactive (⌘⇧R)", true, false, None::<&str>)?;
            let move_item = CheckMenuItem::with_id(app, "move", "Move Overlay", true, false, None::<&str>)?;
            let prefs_item = MenuItem::with_id(app, "prefs", "Preferences…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit Rasputin", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &show_item,
                    &interactive_item,
                    &move_item,
                    &PredefinedMenuItem::separator(app)?,
                    &prefs_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ],
            )?;

            // The template image lives beside the binary in the bundle but next to the crate in
            // dev, so fall back to the app icon rather than panicking when it is not found.
            let tray_icon = app
                .path()
                .resolve("icons/tray-template.png", tauri::path::BaseDirectory::Resource)
                .ok()
                .and_then(|p| tauri::image::Image::from_path(p).ok())
                .or_else(|| tauri::image::Image::from_path("icons/tray-template.png").ok())
                .unwrap_or_else(|| app.default_window_icon().expect("no default icon").clone());

            TrayIconBuilder::with_id("rasputin")
                .icon(tray_icon)
                // Template mode: macOS ignores the colour and paints the alpha shape black on a
                // light menu bar and white on a dark one. Without it the glyph is a black smudge
                // in dark mode.
                .icon_as_template(true)
                .menu(&menu)
                // Open the menu on left click too, matching every other menu-bar app.
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let visible = w.is_visible().unwrap_or(false);
                            let _ = if visible { w.hide() } else { w.show() };
                        }
                    }
                    "interactive" => {
                        let now = is_click_through(app.clone());
                        let _ = set_click_through(app.clone(), !now);
                    }
                    "move" => {
                        // click_through tells us whether move mode is on, since move mode is
                        // exactly "not click-through".
                        let moving = !is_click_through(app.clone());
                        let _ = set_move_mode(app.clone(), !moving);
                    }
                    "prefs" => {
                        let _ = open_preferences(app.clone());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // --- global hotkey ------------------------------------------------------------
            // Cmd+Shift+R toggles ambient <-> interactive, not show/hide: the orb should be
            // present the way a status light is, and an overlay you must summon before it can
            // tell you anything defeats the observing half of the project.
            let hotkey = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyR);
            let handle = app.handle().clone();
            app.global_shortcut().on_shortcut(hotkey, move |_app, _shortcut, event| {
                // Press only; without this the action runs twice per keypress.
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let now = is_click_through(handle.clone());
                let _ = set_click_through(handle.clone(), !now);
                if now {
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            })?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running rasputin overlay");
}
