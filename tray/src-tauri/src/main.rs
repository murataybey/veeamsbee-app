// Windows'ta release derlemede konsol penceresi açılmasın
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    sbee_tray_lib::run()
}
