//! 通用资源拉取：探测路径、HTTP 下载、解压 zip、删除。
//! 写入限制在 plugins/ 下，避免插件把任意 URL 写到用户磁盘其它位置。

use std::fs::{self, File};
use std::io::{copy, BufWriter};
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::procs::base_dir;

const ALLOWED_PREFIXES: &[&str] = &[
    "https://download.blender.org/",
    "https://mirrors.aliyun.com/blender/",
    "https://mirror.freedif.org/blender/",
];

#[derive(Clone, Serialize)]
struct DownloadProgress {
    dest: String,
    done: u64,
    total: u64,
}

fn plugins_root() -> PathBuf {
    base_dir().join("plugins")
}

fn ensure_under_plugins(path: &Path) -> Result<PathBuf, String> {
    let plugins = plugins_root();
    fs::create_dir_all(&plugins).map_err(|e| format!("创建插件目录失败: {e}"))?;
    let plugins_can = plugins
        .canonicalize()
        .map_err(|e| format!("解析插件目录失败: {e}"))?;

    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        plugins.join(path)
    };

    let parent = abs.parent().ok_or("路径没有父目录")?;
    fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    let parent_can = parent
        .canonicalize()
        .map_err(|e| format!("解析目标目录失败: {e}"))?;
    if !(parent_can.starts_with(&plugins_can) || parent_can == plugins_can) {
        return Err("只允许写入 plugins/ 目录".into());
    }
    Ok(abs)
}

fn ensure_url_allowed(url: &str) -> Result<(), String> {
    if ALLOWED_PREFIXES.iter().any(|p| url.starts_with(p)) {
        return Ok(());
    }
    Err("下载地址不在允许的镜像列表里".into())
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

fn is_reparse_point(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 联接/符号链接只断开，不跟随删除目标；普通目录整棵删掉。
#[tauri::command]
pub fn remove_path(path: String) -> Result<(), String> {
    let abs = ensure_under_plugins(Path::new(&path))?;
    if !abs.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(&abs).map_err(|e| format!("读取路径失败: {e}"))?;
    if is_reparse_point(&meta) {
        if meta.file_type().is_dir() || abs.is_dir() {
            fs::remove_dir(&abs).map_err(|e| format!("断开目录联接失败: {e}"))
        } else {
            fs::remove_file(&abs).map_err(|e| format!("断开文件链接失败: {e}"))
        }
    } else if abs.is_dir() {
        fs::remove_dir_all(&abs).map_err(|e| format!("删除目录失败: {e}"))
    } else {
        fs::remove_file(&abs).map_err(|e| format!("删除文件失败: {e}"))
    }
}

#[tauri::command]
pub async fn http_download(app: AppHandle, url: String, dest: String) -> Result<(), String> {
    ensure_url_allowed(&url)?;
    let dest_path = ensure_under_plugins(Path::new(&dest))?;
    let part = dest_path.with_extension(
        dest_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{e}.part"))
            .unwrap_or_else(|| "part".into()),
    );

    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) beep-host")
        .build()
        .map_err(|e| format!("创建下载客户端失败: {e}"))?;
    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    {
        let mut file = BufWriter::new(
            File::create(&part).map_err(|e| format!("创建临时文件失败: {e}"))?,
        );
        let mut done = 0u64;
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("读取下载数据失败: {e}"))?
        {
            copy(&mut chunk.as_ref(), &mut file).map_err(|e| format!("写入失败: {e}"))?;
            done += chunk.len() as u64;
            let _ = app.emit(
                "http-download-progress",
                DownloadProgress {
                    dest: dest.clone(),
                    done,
                    total,
                },
            );
        }
    }

    if dest_path.exists() {
        fs::remove_file(&dest_path).map_err(|e| format!("覆盖旧文件失败: {e}"))?;
    }
    fs::rename(&part, &dest_path).map_err(|e| format!("落盘失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn zip_extract(zip_path: String, dest_dir: String) -> Result<(), String> {
    let zip_abs = ensure_under_plugins(Path::new(&zip_path))?;
    let dest_abs = ensure_under_plugins(Path::new(&dest_dir))?;
    if !zip_abs.is_file() {
        return Err("压缩包不存在".into());
    }
    fs::create_dir_all(&dest_abs).map_err(|e| format!("创建解压目录失败: {e}"))?;
    let file = File::open(&zip_abs).map_err(|e| format!("打开压缩包失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取压缩包失败: {e}"))?;
    archive
        .extract(&dest_abs)
        .map_err(|e| format!("解压失败: {e}"))?;
    Ok(())
}
