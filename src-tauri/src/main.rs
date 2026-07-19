// Prevents an extra console window on Windows in release. Harmless on macOS, kept so the crate is
// not silently platform-locked at the source level.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rasputin_overlay_lib::run()
}
