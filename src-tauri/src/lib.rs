//! The overlay shell.
//!
//! Four things a browser cannot do for itself, and nothing else:
//!   1. a transparent, undecorated, always-on-top window
//!   2. click-through, so the orb floats over Rider without stealing input
//!   3. a global hotkey that works while another app has focus
//!   4. staying off the Dock and the app switcher
//!
//! All behaviour — synthesis, features, the orb, subtitles — lives in the Node daemon and the web
//! renderer. Keeping this crate thin is deliberate: the renderer is developed in Chrome with hot
//! reload and devtools, then loaded here unchanged.

use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Whether the window currently ignores the cursor.
///
/// Tracked here rather than queried, because there is no getter for it — asking the window would
/// mean keeping a shadow copy anyway.
struct OverlayState {
    click_through: std::sync::Mutex<bool>,
}

/// Lets the mouse pass through to whatever is behind the orb.
///
/// The overlay is always-on-top and covers a large area, so without this it would swallow clicks
/// meant for the editor underneath — the orb would make the machine unusable rather than assist.
#[tauri::command]
fn set_click_through(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(enabled).map_err(|e| e.to_string())?;
    if let Some(state) = window.app_handle().try_state::<OverlayState>() {
        *state.click_through.lock().unwrap() = enabled;
    }
    Ok(())
}

#[tauri::command]
fn is_click_through(window: WebviewWindow) -> bool {
    window
        .app_handle()
        .try_state::<OverlayState>()
        .map(|s| *s.click_through.lock().unwrap())
        .unwrap_or(false)
}

/// Shows and focuses the overlay, or hides it if already visible.
#[tauri::command]
fn toggle_overlay(window: WebviewWindow) -> Result<(), String> {
    if window.is_visible().map_err(|e| e.to_string())? {
        window.hide().map_err(|e| e.to_string())
    } else {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(OverlayState { click_through: std::sync::Mutex::new(true) })
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            set_click_through,
            is_click_through,
            toggle_overlay
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window missing");

            // Click-through from the start. The overlay is idle on launch, and an orb that eats
            // clicks before the user has asked it for anything is worse than no orb.
            let _ = window.set_ignore_cursor_events(true);

            // Above full-screen apps and every normal window. Without the higher level the orb
            // sits under a maximised editor, which defeats the point of an overlay.
            //
            // No window effects are applied: vibrancy or blur behind a transparent window turns
            // the background milky, and the orb supplies its own light. None is the default, so
            // this is a note rather than a call.
            #[cfg(target_os = "macos")]
            let _ = window.set_visible_on_all_workspaces(true);

            // Cmd+Shift+R toggles AMBIENT <-> INTERACTIVE. Registered globally so it fires while
            // Rider or a terminal has focus — the whole reason this crate exists rather than a
            // browser tab.
            //
            // Not show/hide: the orb is meant to be present the way a status light is, and an
            // overlay you have to summon before it can tell you anything defeats the observing
            // half of the project. Ambient = visible but click-through; interactive = focused and
            // clickable so the text field can be used.
            let hotkey = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyR);
            let handle = app.handle().clone();
            app.global_shortcut().on_shortcut(hotkey, move |_app, _shortcut, event| {
                // Fire on press only; without this check the action runs twice per keypress.
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                let Some(w) = handle.get_webview_window("main") else { return };
                let state = handle.state::<OverlayState>();
                let mut through = state.click_through.lock().unwrap();
                *through = !*through;
                let _ = w.set_ignore_cursor_events(*through);
                if !*through {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                // The renderer shows or hides its controls to match.
                let _ = handle.emit("overlay-interactive", !*through);
            })?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running rasputin overlay");
}
