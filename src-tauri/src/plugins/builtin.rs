//! 内置轻应用的安装与升级。
//!
//! 内置轻应用和普通插件走**完全相同**的路径：同样的 plugin.json 校验、
//! 同样的权限白名单、同样能钉住/禁用/卸载。没有特殊通道。
//!
//! 区别只在分发：它们随 app bundle 一起打包，启动时从资源目录同步到
//! `plugins/<id>/`。同步是幂等的，且刻意**不碰**用户的状态文件
//! （启用/钉住在 `plugins-disabled.json` / `plugins-pinned.json` 里，
//! 用户禁用过的内置应用不会被一次升级偷偷复活）。

use crate::core::manifest;
use crate::plugins::store as plugin_store;
use std::path::{Path, PathBuf};

/// 内置轻应用的目录名（同时也是 plugin.json 里的 id）。
pub const BUILTIN_IDS: &[&str] = &["com.knockbox.lock", "com.knockbox.screencap"];

/// 同步全部内置轻应用。失败只记日志、不阻断启动 —— 内置轻应用挂了不该
/// 让整个启动器打不开。
pub fn sync_all() {
    for id in BUILTIN_IDS {
        match install_builtin(id) {
            Ok(true) => eprintln!("[knockbox] 已同步内置轻应用 {id}"),
            Ok(false) => {}
            Err(e) => eprintln!("[knockbox] 同步内置轻应用 {id} 失败: {e}"),
        }
    }
}

/// 把单个内置轻应用拷进插件目录。返回是否真的写了东西。
fn install_builtin(id: &str) -> Result<bool, String> {
    let src = resource_dir().join(id);
    if !src.join(manifest::MANIFEST_FILE).is_file() {
        // 资源目录里没有（开发时可能没打包），跳过而不是报错
        return Ok(false);
    }

    let dest = plugin_store::plugin_dir(id);

    // 内容一致就什么都不做，避免每次启动都无谓地写盘
    if dest.exists() && dirs_equal(&src, &dest)? {
        ensure_pinned(id);
        return Ok(false);
    }

    // 同样是"暂存 → 换入"，不留下半截安装
    let staging = dest.with_extension("builtin-tmp");
    let _ = std::fs::remove_dir_all(&staging);
    copy_dir(&src, &staging)?;

    if dest.exists() {
        let backup = dest.with_extension("builtin-bak");
        let _ = std::fs::remove_dir_all(&backup);
        std::fs::rename(&dest, &backup).map_err(|e| format!("备份旧版本失败: {e}"))?;
        std::fs::rename(&staging, &dest).map_err(|e| {
            let _ = std::fs::remove_dir_all(&backup);
            format!("换入新版本失败: {e}")
        })?;
        let _ = std::fs::remove_dir_all(&backup);
    } else {
        std::fs::rename(&staging, &dest).map_err(|e| format!("安装失败: {e}"))?;
    }

    ensure_pinned(id);
    Ok(true)
}

/// 新装的内置应用默认钉住 —— 装完却搜不到最容易被当成装失败。
/// 注意这里只加不减：用户主动取消钉住的状态会被保留。
fn ensure_pinned(id: &str) {
    if let Some(p) = plugin_store::get(id) {
        if !p.pinned {
            let _ = plugin_store::set_pinned(id, true);
        }
    }
}

/// 资源目录。打包后是 `Contents/Resources/builtins`，
/// 开发时（`cargo run`）退回到工程里的 `src-tauri/builtins`。
fn resource_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("KNOCKBOX_BUILTINS") {
        return PathBuf::from(dir);
    }
    // std::env::current_exe -> .../Knockbox.app/Contents/MacOS/knockbox
    if let Ok(exe) = std::env::current_exe() {
        let mut p = exe.as_path();
        // Contents/MacOS -> Contents -> .app
        for _ in 0..3 {
            p = p.parent().unwrap_or(p);
        }
        let candidate = p.join("Resources").join("builtins");
        if candidate.is_dir() {
            return candidate;
        }
    }
    // 开发模式
    Path::new(env!("CARGO_MANIFEST_DIR")).join("builtins")
}

/// 逐文件比较大小与内容。内置应用只有几个小文件，比校验和更省事。
fn dirs_equal(a: &Path, b: &Path) -> Result<bool, String> {
    let mut files: Vec<(PathBuf, PathBuf)> = Vec::new();
    collect(a, a, &mut files, 0)?;
    for (rel, src) in files {
        let dst = b.join(&rel);
        let Ok(a_meta) = std::fs::metadata(&src) else { return Ok(false) };
        let Ok(b_meta) = std::fs::metadata(&dst) else { return Ok(false) };
        if a_meta.len() != b_meta.len() {
            return Ok(false);
        }
        let a_bytes = std::fs::read(&src).map_err(|e| e.to_string())?;
        let b_bytes = std::fs::read(&dst).map_err(|e| e.to_string())?;
        if a_bytes != b_bytes {
            return Ok(false);
        }
    }
    Ok(true)
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, PathBuf)>, depth: usize) -> Result<(), String> {
    if depth > 4 {
        return Ok(());
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_symlink() {
            // 与安装其它插件一致：插件目录里不该有符号链接
            continue;
        }
        if path.is_dir() {
            collect(root, &path, out, depth + 1)?;
        } else {
            let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
            out.push((rel, path));
        }
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| format!("创建目录失败: {e}"))?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())?.flatten() {
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir(&src, &dst)?;
        } else if !src.is_symlink() {
            std::fs::copy(&src, &dst).map_err(|e| format!("复制失败: {e}"))?;
        }
    }
    Ok(())
}
