use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::SystemTime;

use serde::Serialize;

use super::ringbuffer::BoundedRingBuffer;

const RING_CAP: usize = 4 * 1024 * 1024;

/// One spawned background process with bounded log capture and lifecycle
/// status. Mirrors how `pty::session::Session` is owned via `Arc`.
pub struct BackgroundProc {
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub child: Mutex<Option<Child>>,
    pub buffer: Mutex<BoundedRingBuffer>,
    pub exited: AtomicBool,
    pub exit_code: AtomicI32,
    /// Sentinel value when no exit code captured yet (process still alive,
    /// or terminated by signal).
    pub exit_unknown: AtomicBool,
}

#[derive(Serialize)]
pub struct BackgroundLogResponse {
    pub bytes: String,
    pub next_offset: u64,
    pub dropped: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct BackgroundProcInfo {
    pub handle: u32,
    pub command: String,
    pub cwd: Option<String>,
    pub started_at_ms: u64,
    pub exited: bool,
    pub exit_code: Option<i32>,
}

impl BackgroundProc {
    pub fn read_logs(&self, since: u64) -> BackgroundLogResponse {
        let (bytes, next_offset, dropped) = self.buffer.lock().unwrap().read_from(since);
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundLogResponse {
            bytes: String::from_utf8_lossy(&bytes).into_owned(),
            next_offset,
            dropped,
            exited,
            exit_code,
        }
    }

    pub fn kill(&self) {
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
    }

    pub fn info(&self, handle: u32) -> BackgroundProcInfo {
        let exited = self.exited.load(Ordering::Acquire);
        let exit_code = if exited && !self.exit_unknown.load(Ordering::Acquire) {
            Some(self.exit_code.load(Ordering::Acquire))
        } else {
            None
        };
        BackgroundProcInfo {
            handle,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            started_at_ms: self.started_at_ms,
            exited,
            exit_code,
        }
    }
}

impl Drop for BackgroundProc {
    fn drop(&mut self) {
        self.kill();
    }
}

pub fn spawn(command: String, cwd: Option<String>) -> Result<Arc<BackgroundProc>, String> {
    let trimmed = command.trim().to_string();
    if trimmed.is_empty() {
        return Err("empty command".into());
    }
    if let Some(ref dir) = cwd {
        if !PathBuf::from(dir).is_dir() {
            return Err(format!("cwd is not a directory: {dir}"));
        }
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = Command::new(&shell);
    cmd.arg("-lc").arg(&trimmed);
    if let Some(ref dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let stdout_pipe = child.stdout.take().ok_or("no stdout pipe")?;
    let stderr_pipe = child.stderr.take().ok_or("no stderr pipe")?;

    let started_at_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let proc = Arc::new(BackgroundProc {
        command: trimmed,
        cwd,
        started_at_ms,
        child: Mutex::new(Some(child)),
        buffer: Mutex::new(BoundedRingBuffer::new(RING_CAP)),
        exited: AtomicBool::new(false),
        exit_code: AtomicI32::new(0),
        exit_unknown: AtomicBool::new(false),
    });

    // Stdout drainer.
    {
        let proc_ref = proc.clone();
        let mut pipe = stdout_pipe;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        proc_ref.buffer.lock().unwrap().push(&buf[..n]);
                    }
                    Err(_) => break,
                }
            }
        });
    }
    // Stderr drainer (interleaved into the same buffer, prefixed).
    {
        let proc_ref = proc.clone();
        let mut pipe = stderr_pipe;
        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        proc_ref.buffer.lock().unwrap().push(&buf[..n]);
                    }
                    Err(_) => break,
                }
            }
        });
    }
    // Reaper.
    {
        let proc_ref = proc.clone();
        thread::spawn(move || {
            let status_opt = {
                let mut guard = proc_ref.child.lock().unwrap();
                guard.as_mut().map(|c| c.wait())
            };
            if let Some(Ok(status)) = status_opt {
                if let Some(code) = status.code() {
                    proc_ref.exit_code.store(code, Ordering::Release);
                } else {
                    proc_ref.exit_unknown.store(true, Ordering::Release);
                }
            } else {
                proc_ref.exit_unknown.store(true, Ordering::Release);
            }
            proc_ref.exited.store(true, Ordering::Release);
            // Drop the child handle to release fds.
            *proc_ref.child.lock().unwrap() = None;
        });
    }

    Ok(proc)
}
