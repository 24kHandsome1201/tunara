use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::client;
use russh::keys::ssh_key::{HashAlg, PublicKey};
use tauri::ipc::Channel as IpcChannel;
use tokio::sync::oneshot;

use crate::modules::pty::{HostKeyPersistenceStatus, PtyEvent};
use crate::modules::ssh::known_hosts::{self, Verdict};
use crate::modules::ssh::reverse_forward::ReverseForwardHub;
/// How to handle a host key the store can't confirm (Unknown / Unverifiable).
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub enum HostKeyPolicy {
    /// Ask the user to confirm the fingerprint via a frontend dialog (default,
    /// the safe TOFU behavior). A Match still proceeds silently; a Mismatch is
    /// always refused.
    #[default]
    Prompt,
    /// Accept and persist without asking. Only set when the user has already
    /// confirmed (e.g. an explicit "trust without prompting" opt-in).
    AcceptUnknown,
    /// Test-only delayed TCP proxies terminate locally but forward the real
    /// server key. Accept without touching the user's known_hosts file.
    #[cfg(test)]
    AcceptForTest,
}

/// Pending host-key confirmations, keyed by a per-prompt id. `check_server_key`
/// parks a oneshot here while the frontend dialog is up; `resolve_host_key_prompt`
/// (driven by the `ssh_host_key_decision` command) wakes it.
#[derive(Clone, Copy, Debug)]
pub struct HostKeyDecision {
    accept: bool,
    remember: bool,
}

static PENDING_PROMPTS: OnceLock<Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>>> =
    OnceLock::new();

const HOST_KEY_PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

fn pending_prompts() -> &'static Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>> {
    PENDING_PROMPTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a host-key prompt the frontend answered. Returns false if the prompt
/// id is unknown (already resolved / timed out).
pub fn resolve_host_key_prompt(prompt_id: &str, accept: bool, remember: bool) -> bool {
    let tx = pending_prompts()
        .lock()
        .ok()
        .and_then(|mut m| m.remove(prompt_id));
    match tx {
        Some(tx) => tx.send(HostKeyDecision { accept, remember }).is_ok(),
        None => false,
    }
}

/// Monotonic-ish unique prompt id without pulling in a uuid/rng dep: a counter
/// plus the host. Uniqueness only needs to hold among concurrently-open prompts.
fn next_prompt_id(host: &str, port: u16) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("hkp-{host}-{port}-{n}")
}

async fn await_host_key_decision(
    receiver: oneshot::Receiver<HostKeyDecision>,
    timeout: Duration,
) -> HostKeyDecision {
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(decision)) => decision,
        Ok(Err(_)) | Err(_) => HostKeyDecision {
            accept: false,
            remember: false,
        },
    }
}

async fn await_host_key_decision_or_cancel(
    receiver: oneshot::Receiver<HostKeyDecision>,
    timeout: Duration,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> HostKeyDecision {
    if *cancel.borrow() {
        return HostKeyDecision {
            accept: false,
            remember: false,
        };
    }
    tokio::select! {
        decision = await_host_key_decision(receiver, timeout) => decision,
        _ = cancel.changed() => HostKeyDecision { accept: false, remember: false },
    }
}

/// russh client handler. Host-key verification happens in `check_server_key`.
pub struct ClientHandler {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) policy: HostKeyPolicy,
    /// Used to emit a HostKeyPrompt to the frontend when policy is Prompt.
    pub(crate) on_event: IpcChannel<PtyEvent>,
    pub(crate) verified_host_key: Arc<std::sync::Mutex<Option<String>>>,
    /// Attempt-scoped cancellation also reaches russh's detached handshake
    /// task, so a parked host-key prompt cannot retain a route after cancel.
    pub(crate) cancel: tokio::sync::watch::Receiver<bool>,
    /// Connection-level termination signal. Channel EOF alone is not proof
    /// that the multiplexed SSH transport was lost.
    pub(crate) disconnected: tokio::sync::watch::Sender<bool>,
    /// Reverse-forward listeners registered on this multiplexed client.
    pub(crate) reverse_hub: ReverseForwardHub,
}

impl ClientHandler {
    /// Ask the frontend to confirm a fingerprint, blocking until it replies (or
    /// the channel/dialog goes away, treated as "reject"). `reason` tells the
    /// dialog whether this is genuine first-use (`"unknown"`) or a host already
    /// in known_hosts whose key we couldn't confirm (`"unverifiable"`), so the
    /// copy can differ and never falsely claim the key will be saved.
    async fn prompt_user(&self, key: &PublicKey, reason: &str) -> HostKeyDecision {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let key_type = key.algorithm().to_string();
        let prompt_id = next_prompt_id(&self.host, self.port);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut m) = pending_prompts().lock() {
            m.insert(prompt_id.clone(), tx);
        } else {
            return HostKeyDecision {
                accept: false,
                remember: false,
            };
        }
        // Guard removes the registry entry on every exit path — normal return,
        // channel-send failure, sender-dropped, AND if this future is cancelled
        // mid-await (e.g. the connect attempt is dropped). Prevents a leaked
        // oneshot sender lingering in PENDING_PROMPTS.
        struct PromptGuard<'a>(&'a str);
        impl Drop for PromptGuard<'_> {
            fn drop(&mut self) {
                let _ = pending_prompts().lock().map(|mut m| m.remove(self.0));
            }
        }
        let _guard = PromptGuard(&prompt_id);

        let sent = self.on_event.send(PtyEvent::HostKeyPrompt {
            prompt_id: prompt_id.clone(),
            host: self.host.clone(),
            port: self.port,
            fingerprint,
            key_type,
            reason: reason.to_string(),
        });
        if sent.is_err() {
            return HostKeyDecision {
                accept: false,
                remember: false,
            }; // frontend channel gone
        }
        // A lost frontend event must not park ssh_open_v2 forever. Cancellation
        // is selected here because russh performs KEX in a detached task: just
        // dropping connect_stream's caller is not enough to stop this waiter.
        await_host_key_decision_or_cancel(rx, HOST_KEY_PROMPT_TIMEOUT, self.cancel.clone()).await
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        let _ = self.disconnected.send(true);
        async move {
            match reason {
                client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
                client::DisconnectReason::Error(error) => Err(error),
            }
        }
    }

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let accepted = match known_hosts::verify(&self.host, self.port, key) {
            Verdict::Match => Ok::<bool, russh::Error>(true),
            Verdict::Mismatch => {
                log::warn!("ssh host-key mismatch — refusing");
                Ok(false)
            }
            Verdict::Revoked => {
                log::warn!("ssh host key revoked — refusing");
                Ok(false)
            }
            Verdict::Unknown => match self.policy {
                #[cfg(test)]
                HostKeyPolicy::AcceptForTest => Ok(true),
                HostKeyPolicy::AcceptUnknown => {
                    let status = match known_hosts::remember(&self.host, self.port, key) {
                        Ok(()) => HostKeyPersistenceStatus::Saved,
                        Err(known_hosts::RememberError::CommittedButDurabilityUnknown(_)) => {
                            log::warn!("ssh host-key saved but directory durability is unknown");
                            HostKeyPersistenceStatus::CommittedButDurabilityUnknown
                        }
                        Err(known_hosts::RememberError::TrustChanged)
                        | Err(known_hosts::RememberError::PreCommitFailure(_)) => {
                            log::warn!("ssh host-key persistence failed before commit");
                            return Ok(false);
                        }
                    };
                    let _ = self.on_event.send(PtyEvent::HostKeyPersistence {
                        host: self.host.clone(),
                        port: self.port,
                        status,
                    });
                    Ok(true)
                }
                HostKeyPolicy::Prompt => {
                    let decision = self.prompt_user(key, "unknown").await;
                    if !decision.accept {
                        return Ok(false);
                    }
                    let persistence = if decision.remember {
                        match known_hosts::remember(&self.host, self.port, key) {
                            Ok(()) => HostKeyPersistenceStatus::Saved,
                            Err(known_hosts::RememberError::TrustChanged) => {
                                log::warn!(
                                    "ssh: known_hosts trust changed while prompting — refusing"
                                );
                                return Ok(false);
                            }
                            Err(known_hosts::RememberError::PreCommitFailure(_)) => {
                                log::warn!("ssh host-key persistence failed");
                                HostKeyPersistenceStatus::PreCommitFailure
                            }
                            Err(known_hosts::RememberError::CommittedButDurabilityUnknown(_)) => {
                                log::warn!(
                                    "ssh host-key saved but directory durability is unknown"
                                );
                                HostKeyPersistenceStatus::CommittedButDurabilityUnknown
                            }
                        }
                    } else {
                        if !known_hosts::confirm_session_only(&self.host, self.port, key) {
                            log::warn!("ssh: known_hosts trust changed while prompting — refusing");
                            return Ok(false);
                        }
                        HostKeyPersistenceStatus::SessionOnly
                    };
                    let _ = self.on_event.send(PtyEvent::HostKeyPersistence {
                        host: self.host.clone(),
                        port: self.port,
                        status: persistence,
                    });
                    Ok(true)
                }
            },
            Verdict::Unverifiable => {
                log::warn!("ssh host key cannot be safely verified — refusing");
                Ok(false)
            }
        }?;
        if accepted {
            let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
            *self
                .verified_host_key
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(fingerprint);
        }
        Ok(accepted)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Some(accept) = self
            .reverse_hub
            .try_accept(connected_address, connected_port)
        else {
            return Ok(());
        };
        tokio::spawn(async move {
            if let Err(error) = accept.relay(channel).await {
                log::debug!("ssh reverse forward relay ended: {error}");
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn host_key_prompt_accepts_an_explicit_decision() {
        let (tx, rx) = oneshot::channel();
        tx.send(HostKeyDecision {
            accept: true,
            remember: true,
        })
        .expect("decision receiver alive");
        assert!(
            await_host_key_decision(rx, Duration::from_secs(1))
                .await
                .accept
        );
    }

    #[tokio::test]
    async fn host_key_prompt_timeout_fails_closed() {
        let (_tx, rx) = oneshot::channel();
        assert!(
            !await_host_key_decision(rx, Duration::from_millis(1))
                .await
                .accept
        );
    }

    #[tokio::test]
    async fn host_key_prompt_attempt_cancellation_fails_closed_promptly() {
        let (_decision_tx, decision_rx) = oneshot::channel();
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let waiting =
            await_host_key_decision_or_cancel(decision_rx, Duration::from_secs(120), cancel_rx);
        tokio::pin!(waiting);
        tokio::task::yield_now().await;
        cancel_tx.send(true).expect("cancel receiver alive");
        let decision = tokio::time::timeout(Duration::from_millis(50), waiting)
            .await
            .expect("attempt cancellation must wake host-key waiter");
        assert!(!decision.accept);
        assert!(!decision.remember);
    }
}
