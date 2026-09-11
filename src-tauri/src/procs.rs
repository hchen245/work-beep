//! 通用子进程与窗口嵌入：拉起任意外部进程（可选注入 {port}）、按 PID 把其主窗口
//! SetParent 嵌入本应用并在 WebView 上挖洞、跟随布局移动、TCP 桥命令薄转发。
//! 全部与 Blender 无关——可执行路径与启动参数由前端（插件）传入。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::bridge;
use crate::fetch;

/// Windows 窗口嵌入原语：SetParent 真子窗口 + WebView 挖洞
/// （WebView2 airspace 问题会盖住一切子窗口，故从 WebView 上剪洞让子窗口露出；仅 Windows）
#[cfg(windows)]
mod win32 {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    /// 按窗口类名找直接子窗口
    pub fn find_child_by_class(parent: HWND, want: &str) -> Option<HWND> {
        struct Ctx {
            found: HWND,
        }
        unsafe extern "system" fn cb(hwnd: HWND, lp: LPARAM) -> i32 {
            let ctx = &mut *(lp as *mut Ctx);
            let mut cls = [0u16; 64];
            let n = GetClassNameW(hwnd, cls.as_mut_ptr(), cls.len() as i32) as usize;
            if String::from_utf16_lossy(&cls[..n]) == "WRY_WEBVIEW" {
                ctx.found = hwnd;
                return 0;
            }
            1
        }
        let _ = want; // 类名写死在回调里（WRY_WEBVIEW），参数保留备扩展
        let mut ctx = Ctx {
            found: std::ptr::null_mut(),
        };
        unsafe { EnumChildWindows(parent, Some(cb), &mut ctx as *mut Ctx as LPARAM) };
        (!ctx.found.is_null()).then_some(ctx.found)
    }

    /// 在 WebView 窗口上剪掉一块矩形区域（物理剪掉渲染与命中测试），
    /// 让该区域下的外部子窗口露出并接收鼠标键盘。
    /// hole 为 WebView 客户区坐标（WebView 铺满父窗口客户区，与父客户区坐标一致）。
    pub fn punch_hole(webview: HWND, x: i32, y: i32, w: i32, h: i32) {
        unsafe {
            let mut rc = RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            };
            GetClientRect(webview, &mut rc);
            let full = CreateRectRgn(rc.left, rc.top, rc.right, rc.bottom);
            let hole = CreateRectRgn(x, y, x + w, y + h);
            CombineRgn(full, full, hole, RGN_DIFF);
            DeleteObject(hole as _);
            // SetWindowRgn 后系统接管 region 的所有权，不能再 DeleteObject(full)
            SetWindowRgn(webview, full, 1);
        }
    }

    /// SetParent 真·子窗口嵌入，置于 z-order 底部（WebView 之下）。
    /// 配合 WebView 挖洞：外部窗口从洞里露出来。
    pub fn embed_child(child_hwnd: HWND, parent_hwnd: HWND, x: i32, y: i32, w: i32, h: i32) {
        unsafe {
            let parent_style = GetWindowLongPtrW(parent_hwnd, GWL_STYLE) as u32;
            SetWindowLongPtrW(
                parent_hwnd,
                GWL_STYLE,
                (parent_style | WS_CLIPCHILDREN) as isize,
            );
            let style = GetWindowLongPtrW(child_hwnd, GWL_STYLE) as u32;
            let new_style = (style & !(WS_POPUP | WS_CAPTION | WS_THICKFRAME)) | WS_CHILD;
            SetWindowLongPtrW(child_hwnd, GWL_STYLE, new_style as isize);
            SetParent(child_hwnd, parent_hwnd);
            SetWindowPos(
                child_hwnd,
                1 as HWND, // HWND_BOTTOM：压到 WebView 渲染链之下，靠挖洞区露出
                x,
                y,
                w,
                h,
                SWP_FRAMECHANGED | SWP_SHOWWINDOW | SWP_NOACTIVATE,
            );
        }
    }

    /// 同步子窗口位置（跟随前端布局），子窗口坐标即父窗口客户区坐标，保持 z-order 不变
    pub fn move_child(child_hwnd: HWND, x: i32, y: i32, w: i32, h: i32) {
        unsafe {
            SetWindowPos(
                child_hwnd,
                std::ptr::null_mut(),
                x,
                y,
                w,
                h,
                SWP_NOZORDER | SWP_NOACTIVATE,
            )
        };
    }

    /// 按进程 ID 找可见、无 owner、有标题的顶层窗口（即外部程序的主窗口）
    pub fn find_main_window(pid: u32) -> Option<HWND> {
        struct Ctx {
            pid: u32,
            found: HWND,
        }
        unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> i32 {
            let ctx = &mut *(lparam as *mut Ctx);
            let mut window_pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut window_pid);
            if window_pid == ctx.pid
                && IsWindowVisible(hwnd) != 0
                && GetWindow(hwnd, GW_OWNER).is_null()
            {
                let mut title = [0u16; 256];
                if GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32) > 0 {
                    ctx.found = hwnd;
                    return 0; // 找到即停止枚举
                }
            }
            1
        }
        let mut ctx = Ctx {
            pid,
            found: std::ptr::null_mut(),
        };
        unsafe { EnumWindows(Some(callback), &mut ctx as *mut Ctx as LPARAM) };
        (!ctx.found.is_null()).then_some(ctx.found)
    }
}

/// 单个外部进程的嵌入状态
struct ProcEntry {
    child: Child,
    /// 已嵌入的外部主窗口句柄，0 = 未嵌入
    hwnd: isize,
    /// WRY_WEBVIEW 子窗口句柄（挖洞目标），0 = 未获取
    webview_hwnd: isize,
}

/// 外部进程表：pid -> 状态（全局单例；多插件可各拉各的进程）
#[derive(Default)]
pub struct ProcTable(Mutex<HashMap<u32, ProcEntry>>);

impl Drop for ProcTable {
    // 应用退出时杀掉全部子进程，避免残留
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            for (_, mut entry) in guard.drain() {
                let _ = entry.child.kill();
            }
        }
    }
}

/// 相对路径的锚定基准：开发期 = 项目根（src-tauri 的上一级），发布版 = exe 所在目录。
/// 插件资源正式走"插件目录 + resolveAsset"是阶段 C 的事，这里先保住两段都能跑。
pub(crate) fn base_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri 应有父目录")
            .to_path_buf()
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .unwrap_or_default()
    }
}

/// 在本机挑一个空闲端口（供桥接类子进程使用）
fn pick_free_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .map_err(|e| format!("分配空闲端口失败: {e}"))
}

/// 轮询等待本机 TCP 服务就绪
fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("等待端口 {port} 就绪超时（{}秒）", timeout.as_secs()))
}

/// proc_start 的返回值
#[derive(serde::Serialize)]
pub struct ProcInfo {
    pid: u32,
    /// 有 {port} 占位符时为挑选出的端口，否则为 null
    port: Option<u16>,
}

/// 通用子进程拉起。
/// 约定两个占位符：executable/args 中的 `{base}` 替换为基准目录（见 base_dir），
/// args 中的 `{port}` 出现即挑一个空闲端口替换、并阻塞等该端口 TCP 就绪（60s）后返回。
/// 相对路径的 executable 相对基准目录解析。是否允许重复启动由调用方（插件）自行约束。
#[tauri::command]
pub fn proc_start(
    state: tauri::State<ProcTable>,
    executable: String,
    args: Vec<String>,
) -> Result<ProcInfo, String> {
    let needs_port = args.iter().any(|a| a.contains("{port}"));
    let port = if needs_port { Some(pick_free_port()?) } else { None };
    let port_str = port.map(|p| p.to_string()).unwrap_or_default();

    let base = base_dir();
    let base_str = base.to_string_lossy().to_string();
    let subst = |s: &str| s.replace("{base}", &base_str).replace("{port}", &port_str);

    let exe = PathBuf::from(subst(&executable));
    let exe = if exe.is_absolute() { exe } else { base.join(exe) };
    if !exe.exists() {
        return Err(format!("找不到可执行文件: {}", exe.display()));
    }
    let final_args: Vec<String> = args.iter().map(|a| subst(a)).collect();

    let child = Command::new(&exe)
        .args(&final_args)
        .spawn()
        .map_err(|e| format!("启动进程失败: {e}"))?;
    let pid = child.id();
    state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(pid, ProcEntry { child, hwnd: 0, webview_hwnd: 0 });

    if let Some(p) = port {
        wait_for_port(p, Duration::from_secs(60))?;
    }
    Ok(ProcInfo { pid, port })
}

#[derive(serde::Serialize)]
pub struct CaptureResult {
    code: i32,
    stdout: String,
    stderr: String,
}

/// 短生命周期子进程：捕获输出后退出。用于 blender --version 等探测，不入 ProcTable。
#[tauri::command]
pub fn proc_capture(
    executable: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<CaptureResult, String> {
    use std::sync::mpsc;
    use std::thread;

    let base = base_dir();
    let base_str = base.to_string_lossy().to_string();
    let subst = |s: &str| s.replace("{base}", &base_str);
    let exe = PathBuf::from(subst(&executable));
    let exe = if exe.is_absolute() { exe } else { base.join(exe) };
    if !exe.exists() {
        return Err(format!("找不到可执行文件: {}", exe.display()));
    }
    let final_args: Vec<String> = args.iter().map(|a| subst(a)).collect();
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000));

    let (tx, rx) = mpsc::channel();
    let exe_clone = exe.clone();
    thread::spawn(move || {
        let output = Command::new(&exe_clone).args(&final_args).output();
        let _ = tx.send(output);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(output)) => Ok(CaptureResult {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        }),
        Ok(Err(e)) => Err(format!("启动进程失败: {e}")),
        Err(_) => Err(format!(
            "进程超时（{}ms）: {}",
            timeout.as_millis(),
            exe.display()
        )),
    }
}

#[derive(Clone, Serialize)]
struct StreamLine {
    session: String,
    stream: String,
    line: String,
}

/// 仅允许 plugins/ 下的 fetch_blender.exe；逐行 emit stdout/stderr，返回 exit code。
#[tauri::command]
pub async fn proc_stream(
    app: AppHandle,
    session: String,
    executable: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<i32, String> {
    let exe = fetch::ensure_under_plugins(Path::new(&executable))?;
    let name = exe
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if !name.eq_ignore_ascii_case("fetch_blender.exe") && name != "fetch_blender" {
        return Err("只允许运行插件自带的 fetch_blender.exe".into());
    }
    if !exe.is_file() {
        return Err(format!("找不到 fetch_blender.exe: {}", exe.display()));
    }

    let cwd_path = if let Some(c) = cwd {
        Some(fetch::ensure_under_plugins(Path::new(&c))?)
    } else {
        None
    };

    let session_out = session.clone();
    let session_err = session.clone();
    let app_out = app.clone();
    let app_err = app.clone();
    let exe_run = exe.clone();
    let args_run = args.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&exe_run);
        cmd.args(&args_run)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(ref c) = cwd_path {
            cmd.current_dir(c);
        }
        let mut child = cmd.spawn().map_err(|e| format!("启动进程失败: {e}"))?;

        let stdout = child.stdout.take().ok_or("无法捕获 stdout")?;
        let stderr = child.stderr.take().ok_or("无法捕获 stderr")?;

        let out_handle = thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        let _ = app_out.emit(
                            "proc-stream-line",
                            StreamLine {
                                session: session_out.clone(),
                                stream: "stdout".into(),
                                line: l,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });
        let err_handle = thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        let _ = app_err.emit(
                            "proc-stream-line",
                            StreamLine {
                                session: session_err.clone(),
                                stream: "stderr".into(),
                                line: l,
                            },
                        );
                    }
                    Err(_) => break,
                }
            }
        });

        let status = child.wait().map_err(|e| format!("等待进程失败: {e}"))?;
        let _ = out_handle.join();
        let _ = err_handle.join();
        Ok(status.code().unwrap_or(-1))
    })
    .await
    .map_err(|e| format!("进程任务失败: {e}"))?
}

/// 把 pid 对应进程的主窗口嵌入本应用指定区域（物理像素，本应用客户区坐标系）
#[tauri::command]
pub fn proc_embed(
    window: tauri::WebviewWindow,
    state: tauri::State<ProcTable>,
    pid: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    proc_embed_impl(window, state, pid, x, y, w, h)
}

#[cfg(windows)]
fn proc_embed_impl(
    window: tauri::WebviewWindow,
    state: tauri::State<ProcTable>,
    pid: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    let entry = guard.get_mut(&pid).ok_or("该 pid 不是本应用拉起的进程")?;

    // 等外部程序主窗口出现（重试约 10 秒）
    let deadline = Instant::now() + Duration::from_secs(10);
    let target_hwnd = loop {
        if let Some(hwnd) = win32::find_main_window(pid) {
            break hwnd;
        }
        if Instant::now() > deadline {
            return Err("找不到目标进程的主窗口".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    };

    let our_hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    win32::embed_child(target_hwnd, our_hwnd as _, x, y, w, h);
    entry.hwnd = target_hwnd as isize;

    // 在 WebView 上剪掉目标区域：外部窗口从洞里露出并接收输入
    let webview_hwnd = win32::find_child_by_class(our_hwnd as _, "WRY_WEBVIEW")
        .ok_or("找不到 WRY_WEBVIEW 子窗口")?;
    win32::punch_hole(webview_hwnd, x, y, w, h);
    entry.webview_hwnd = webview_hwnd as isize;
    Ok(())
}

#[cfg(not(windows))]
fn proc_embed_impl(
    _window: tauri::WebviewWindow,
    _state: tauri::State<ProcTable>,
    _pid: u32,
    _x: i32,
    _y: i32,
    _w: i32,
    _h: i32,
) -> Result<(), String> {
    Err("窗口嵌入目前仅支持 Windows".into())
}

/// 同步已嵌入外部窗口的位置（未嵌入时静默跳过）
#[tauri::command]
pub fn proc_move(
    state: tauri::State<ProcTable>,
    pid: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    if let Some(entry) = guard.get(&pid) {
        if entry.hwnd != 0 {
            win32::move_child(entry.hwnd as _, x, y, w, h);
            // WebView 的 region 不随子窗口移动自动更新，布局变化后重剪
            if entry.webview_hwnd != 0 {
                win32::punch_hole(entry.webview_hwnd as _, x, y, w, h);
            }
        }
    }
    Ok(())
}

/// TCP JSON-lines 桥命令薄转发（前端 JS 没有原始 TCP 能力），无业务逻辑
#[tauri::command]
pub fn bridge_call(port: u16, cmd: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
    bridge::call(port, cmd, &params)
}

/// 杀掉 proc_start 拉起的子进程（未嵌入的窗口随进程消失；不在表里则静默跳过）
#[tauri::command]
pub fn proc_kill(state: tauri::State<ProcTable>, pid: u32) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut entry) = guard.remove(&pid) {
        let _ = entry.child.kill();
    }
    Ok(())
}

/// 插件目录（基准目录下的 plugins/）：确保存在、加进 fs 运行时 scope、返回绝对路径。
/// 前端加载器据此扫描 plugin.json / 读取插件 ESM 产物（exe 旁 plugins/ 便携路线）。
#[tauri::command]
pub fn plugins_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_fs::FsExt;
    let dir = base_dir().join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败: {e}"))?;
    app.fs_scope()
        .allow_directory(&dir, true)
        .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// 用户选定工作区后，把该目录加进 fs 插件的运行时 scope（递归），
/// 之后前端 fs API 才能访问工作区内文件。scope 是能力面的物理边界。
#[tauri::command]
pub fn set_workspace(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_fs::FsExt;
    app.fs_scope()
        .allow_directory(&path, true)
        .map_err(|e| e.to_string())
}

/// 读基准目录下的 .env（release 锚 exe 同目录、dev 锚仓库根目录，与 base_dir 一致）。
/// release 包的 LLM 运行时配置入口：Vite 的 VITE_* 是构建期注入的，打包 exe 读不到，
/// 由前端在 import.meta.env 缺失时回退到本命令。文件不存在返回空串（不算错误）。
#[tauri::command]
pub fn root_env() -> Result<String, String> {
    match std::fs::read_to_string(base_dir().join(".env")) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()),
    }
}
