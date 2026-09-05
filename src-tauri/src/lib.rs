// 应用入口：窗口壳 + 通用桌面能力（子进程拉起/窗口嵌入/桥转发，见 procs.rs）。
// 不含任何具体插件（Blender 等）的业务逻辑。
mod bridge;
mod fetch;
mod procs;

use procs::ProcTable;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // Win11 Snap Layout：在最大化按钮上放透明 Win32 覆盖层，
        // 悬停触发系统原生 Snap 面板，最大化/还原由该通道自动处理（非 Windows 平台为 no-op）
        .plugin(
            tauri_plugin_snap_layout::init()
                .button_id("snap-btn")
                .build(),
        )
        .manage(ProcTable::default())
        .invoke_handler(tauri::generate_handler![
            procs::proc_start,
            procs::proc_embed,
            procs::proc_move,
            procs::proc_kill,
            procs::bridge_call,
            procs::plugins_dir,
            procs::set_workspace,
            procs::root_env,
            fetch::file_exists,
            fetch::http_download,
            fetch::zip_extract,
            fetch::remove_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
