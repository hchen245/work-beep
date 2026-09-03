//! Blender IPC 桥的薄客户端：每条命令一次短连接，JSON-lines 一问一答。
//! Rust 侧只做这个转发（前端 JS 没有原始 TCP 能力），不含任何业务逻辑。

use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::time::Duration;

/// 调一次桥命令：{"cmd": cmd, "params": params} -> 响应的 data 字段
pub fn call(port: u16, cmd: &str, params: &serde_json::Value) -> Result<serde_json::Value, String> {
    let mut stream =
        TcpStream::connect(("127.0.0.1", port)).map_err(|e| format!("连接桥失败: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(120)))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_secs(120)))
        .ok();

    let req = serde_json::json!({"cmd": cmd, "params": params});
    stream
        .write_all(req.to_string().as_bytes())
        .and_then(|_| stream.write_all(b"\n"))
        .map_err(|e| format!("发送命令失败: {e}"))?;

    let mut line = String::new();
    BufReader::new(&stream)
        .read_line(&mut line)
        .map_err(|e| format!("读取响应失败: {e}"))?;
    let resp: serde_json::Value =
        serde_json::from_str(line.trim()).map_err(|e| format!("响应不是合法 JSON: {e}"))?;

    if resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(resp.get("data").cloned().unwrap_or(serde_json::Value::Null))
    } else {
        Err(resp
            .get("error")
            .map(|e| e.to_string())
            .unwrap_or_else(|| "未知错误".into()))
    }
}
