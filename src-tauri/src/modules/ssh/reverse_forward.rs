//! Reverse (`RemoteForward`) hub for RFC 4254 `tcpip-forward`.
//!
//! Incoming `forwarded-tcpip` channels are matched to a loopback local target.
//! Remote listen addresses and local targets are both 127.0.0.1 / ::1 only.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::watch;

const MAX_CONNECTIONS_PER_RULE: usize = 32;

#[derive(Clone, Default)]
pub struct ReverseForwardHub {
    inner: Arc<Mutex<HashMap<(String, u32), ReverseSlot>>>,
}

struct ReverseSlot {
    local_host: IpAddr,
    local_port: u16,
    cancel: watch::Receiver<bool>,
    active: Arc<AtomicUsize>,
}

pub struct ReverseAccept {
    local_host: IpAddr,
    local_port: u16,
    cancel: watch::Receiver<bool>,
    active: Arc<AtomicUsize>,
}

impl Drop for ReverseAccept {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

pub(crate) fn parse_loopback_host(host: &str) -> Result<IpAddr, String> {
    match host.parse::<IpAddr>() {
        Ok(ip)
            if ip == IpAddr::from([127, 0, 0, 1])
                || ip == IpAddr::from([0, 0, 0, 0, 0, 0, 0, 1]) =>
        {
            Ok(ip)
        }
        _ => Err("bindHost must be exactly 127.0.0.1 or ::1".into()),
    }
}

fn canonical_loopback(host: &str) -> Option<String> {
    parse_loopback_host(host).ok().map(|ip| ip.to_string())
}

impl ReverseForwardHub {
    pub fn insert(
        &self,
        remote_bind_host: &str,
        remote_port: u32,
        local_host: IpAddr,
        local_port: u16,
        cancel: watch::Receiver<bool>,
    ) -> Result<(), String> {
        let key = (
            canonical_loopback(remote_bind_host)
                .ok_or_else(|| "remote bind host must be exactly 127.0.0.1 or ::1".to_string())?,
            remote_port,
        );
        if local_port == 0 {
            return Err("localTargetPort must be non-zero".into());
        }
        let mut map = self
            .inner
            .lock()
            .map_err(|_| "reverse forward hub unavailable")?;
        if map.contains_key(&key) {
            return Err("remote forward already registered for this bind".into());
        }
        map.insert(
            key,
            ReverseSlot {
                local_host,
                local_port,
                cancel,
                active: Arc::new(AtomicUsize::new(0)),
            },
        );
        Ok(())
    }

    pub fn remove(&self, remote_bind_host: &str, remote_port: u32) {
        let Ok(key_host) = canonical_loopback(remote_bind_host).ok_or(()) else {
            return;
        };
        if let Ok(mut map) = self.inner.lock() {
            map.remove(&(key_host, remote_port));
        }
    }

    pub fn try_accept(
        &self,
        connected_address: &str,
        connected_port: u32,
    ) -> Option<ReverseAccept> {
        let key_host = canonical_loopback(connected_address)?;
        let map = self.inner.lock().ok()?;
        let slot = map.get(&(key_host, connected_port))?;
        if *slot.cancel.borrow() {
            return None;
        }
        let active = slot.active.load(Ordering::SeqCst);
        if active >= MAX_CONNECTIONS_PER_RULE {
            return None;
        }
        slot.active.fetch_add(1, Ordering::SeqCst);
        Some(ReverseAccept {
            local_host: slot.local_host,
            local_port: slot.local_port,
            cancel: slot.cancel.clone(),
            active: slot.active.clone(),
        })
    }
}

impl ReverseAccept {
    pub async fn relay(self, channel: russh::Channel<russh::client::Msg>) -> Result<(), String> {
        let mut cancelled = self.cancel.clone();
        if *cancelled.borrow() {
            return Err("remote forward cancelled".into());
        }
        let mut stream = tokio::select! {
            biased;
            _ = cancelled.changed() => return Err("remote forward cancelled".into()),
            result = TcpStream::connect((self.local_host, self.local_port)) => {
                result.map_err(|error| format!("local reverse-forward target unavailable: {error}"))?
            }
        };
        let peer = stream
            .peer_addr()
            .map_err(|error| format!("local reverse-forward peer unavailable: {error}"))?;
        if !peer.ip().is_loopback() {
            let _ = stream.shutdown().await;
            return Err("local reverse-forward target is not loopback".into());
        }
        let mut ssh_stream = channel.into_stream();
        tokio::select! {
            biased;
            _ = cancelled.changed() => Err("remote forward cancelled".into()),
            result = tokio::io::copy_bidirectional(&mut ssh_stream, &mut stream) => {
                result.map(|_| ()).map_err(|error| error.to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_are_exact() {
        assert!(parse_loopback_host("127.0.0.1").is_ok());
        assert!(parse_loopback_host("::1").is_ok());
        assert!(parse_loopback_host("0.0.0.0").is_err());
        assert!(parse_loopback_host("localhost").is_err());
    }

    #[test]
    fn hub_accepts_up_to_connection_limit() {
        let hub = ReverseForwardHub::default();
        let (_cancel, cancelled) = watch::channel(false);
        hub.insert(
            "127.0.0.1",
            8080,
            IpAddr::from([127, 0, 0, 1]),
            3000,
            cancelled,
        )
        .unwrap();
        let mut held = Vec::new();
        for _ in 0..MAX_CONNECTIONS_PER_RULE {
            held.push(hub.try_accept("127.0.0.1", 8080).expect("slot"));
        }
        assert!(hub.try_accept("127.0.0.1", 8080).is_none());
        drop(held);
        assert!(hub.try_accept("127.0.0.1", 8080).is_some());
        assert!(hub.try_accept("0.0.0.0", 8080).is_none());
    }
}
