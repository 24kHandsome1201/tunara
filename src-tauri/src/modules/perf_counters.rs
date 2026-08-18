//! Low-overhead, label-free counters for local performance baselines.
//!
//! These atomics are observational only: they are not exported over IPC and
//! never contain paths, commands, session ids, or other potentially sensitive
//! values. Tests and benchmark fixtures may reset/snapshot them.

use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfSnapshot {
    pub sftp_readdir: u64,
    pub sftp_lstat: u64,
    pub sftp_lstat_peak_in_flight: u64,
    pub sftp_read_bytes: u64,
    pub ssh_exec_channels: u64,
    pub git_processes: u64,
    pub cancel_samples: u64,
    pub cancel_latency_micros: u64,
    pub binding_timer_polls: u64,
    pub binding_lock_acquisitions: u64,
    pub binding_lease_drain_samples: u64,
    pub binding_lease_drain_micros: u64,
    pub binding_lease_drain_slow: u64,
}

macro_rules! counters {
    ($($name:ident),+ $(,)?) => { $(static $name: AtomicU64 = AtomicU64::new(0);)+ };
}
counters!(
    SFTP_READDIR,
    SFTP_LSTAT,
    SFTP_LSTAT_IN_FLIGHT,
    SFTP_LSTAT_PEAK_IN_FLIGHT,
    SFTP_READ_BYTES,
    SSH_EXEC_CHANNELS,
    GIT_PROCESSES,
    CANCEL_SAMPLES,
    CANCEL_LATENCY_MICROS,
    BINDING_TIMER_POLLS,
    BINDING_LOCK_ACQUISITIONS,
    BINDING_LEASE_DRAIN_SAMPLES,
    BINDING_LEASE_DRAIN_MICROS,
    BINDING_LEASE_DRAIN_SLOW
);

#[inline]
pub fn sftp_readdir() {
    SFTP_READDIR.fetch_add(1, Ordering::Relaxed);
}
#[inline]
pub fn sftp_lstat() {
    SFTP_LSTAT.fetch_add(1, Ordering::Relaxed);
}

/// Tracks one bounded LSTAT operation. The guard makes cancellation and early
/// returns decrement the gauge reliably.
pub struct SftpLstatGuard;

pub fn sftp_lstat_begin() -> SftpLstatGuard {
    sftp_lstat();
    let current = SFTP_LSTAT_IN_FLIGHT.fetch_add(1, Ordering::Relaxed) + 1;
    SFTP_LSTAT_PEAK_IN_FLIGHT.fetch_max(current, Ordering::Relaxed);
    SftpLstatGuard
}

impl Drop for SftpLstatGuard {
    fn drop(&mut self) {
        SFTP_LSTAT_IN_FLIGHT.fetch_sub(1, Ordering::Relaxed);
    }
}
#[inline]
pub fn sftp_read_bytes(bytes: usize) {
    SFTP_READ_BYTES.fetch_add(bytes as u64, Ordering::Relaxed);
}
#[inline]
pub fn ssh_exec_channel() {
    SSH_EXEC_CHANNELS.fetch_add(1, Ordering::Relaxed);
}
#[inline]
pub fn git_process() {
    GIT_PROCESSES.fetch_add(1, Ordering::Relaxed);
}
#[inline]
pub fn cancel_latency(micros: u64) {
    CANCEL_SAMPLES.fetch_add(1, Ordering::Relaxed);
    CANCEL_LATENCY_MICROS.fetch_add(micros, Ordering::Relaxed);
}
#[inline]
pub fn binding_timer_poll() {
    BINDING_TIMER_POLLS.fetch_add(1, Ordering::Relaxed);
}
#[inline]
pub fn binding_lock_acquisition() {
    BINDING_LOCK_ACQUISITIONS.fetch_add(1, Ordering::Relaxed);
}
#[inline]
pub fn binding_lease_drain(micros: u64) {
    BINDING_LEASE_DRAIN_SAMPLES.fetch_add(1, Ordering::Relaxed);
    BINDING_LEASE_DRAIN_MICROS.fetch_add(micros, Ordering::Relaxed);
    if micros > 500_000 {
        BINDING_LEASE_DRAIN_SLOW.fetch_add(1, Ordering::Relaxed);
    }
}

#[cfg(test)]
pub fn snapshot() -> PerfSnapshot {
    PerfSnapshot {
        sftp_readdir: SFTP_READDIR.load(Ordering::Relaxed),
        sftp_lstat: SFTP_LSTAT.load(Ordering::Relaxed),
        sftp_lstat_peak_in_flight: SFTP_LSTAT_PEAK_IN_FLIGHT.load(Ordering::Relaxed),
        sftp_read_bytes: SFTP_READ_BYTES.load(Ordering::Relaxed),
        ssh_exec_channels: SSH_EXEC_CHANNELS.load(Ordering::Relaxed),
        git_processes: GIT_PROCESSES.load(Ordering::Relaxed),
        cancel_samples: CANCEL_SAMPLES.load(Ordering::Relaxed),
        cancel_latency_micros: CANCEL_LATENCY_MICROS.load(Ordering::Relaxed),
        binding_timer_polls: BINDING_TIMER_POLLS.load(Ordering::Relaxed),
        binding_lock_acquisitions: BINDING_LOCK_ACQUISITIONS.load(Ordering::Relaxed),
        binding_lease_drain_samples: BINDING_LEASE_DRAIN_SAMPLES.load(Ordering::Relaxed),
        binding_lease_drain_micros: BINDING_LEASE_DRAIN_MICROS.load(Ordering::Relaxed),
        binding_lease_drain_slow: BINDING_LEASE_DRAIN_SLOW.load(Ordering::Relaxed),
    }
}

#[cfg(test)]
pub fn reset() {
    for counter in [
        &SFTP_READDIR,
        &SFTP_LSTAT,
        &SFTP_LSTAT_IN_FLIGHT,
        &SFTP_LSTAT_PEAK_IN_FLIGHT,
        &SFTP_READ_BYTES,
        &SSH_EXEC_CHANNELS,
        &GIT_PROCESSES,
        &CANCEL_SAMPLES,
        &CANCEL_LATENCY_MICROS,
        &BINDING_TIMER_POLLS,
        &BINDING_LOCK_ACQUISITIONS,
        &BINDING_LEASE_DRAIN_SAMPLES,
        &BINDING_LEASE_DRAIN_MICROS,
        &BINDING_LEASE_DRAIN_SLOW,
    ] {
        counter.store(0, Ordering::Relaxed);
    }
}

#[cfg(test)]
pub fn delta(after: PerfSnapshot, baseline: PerfSnapshot) -> PerfSnapshot {
    macro_rules! d {
        ($f:ident) => {
            after.$f.saturating_sub(baseline.$f)
        };
    }
    PerfSnapshot {
        sftp_readdir: d!(sftp_readdir),
        sftp_lstat: d!(sftp_lstat),
        // A peak is a gauge watermark, not an additive counter.
        sftp_lstat_peak_in_flight: after.sftp_lstat_peak_in_flight,
        sftp_read_bytes: d!(sftp_read_bytes),
        ssh_exec_channels: d!(ssh_exec_channels),
        git_processes: d!(git_processes),
        cancel_samples: d!(cancel_samples),
        cancel_latency_micros: d!(cancel_latency_micros),
        binding_timer_polls: d!(binding_timer_polls),
        binding_lock_acquisitions: d!(binding_lock_acquisitions),
        binding_lease_drain_samples: d!(binding_lease_drain_samples),
        binding_lease_drain_micros: d!(binding_lease_drain_micros),
        binding_lease_drain_slow: d!(binding_lease_drain_slow),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reset_snapshot_and_delta_are_stable() {
        reset();
        let baseline = snapshot();
        sftp_readdir();
        sftp_read_bytes(41);
        git_process();
        cancel_latency(12);
        binding_lease_drain(500_001);
        let change = delta(snapshot(), baseline);
        assert_eq!(change.sftp_readdir, 1);
        assert_eq!(change.sftp_read_bytes, 41);
        assert_eq!(change.git_processes, 1);
        assert_eq!(change.cancel_samples, 1);
        assert_eq!(change.cancel_latency_micros, 12);
        assert_eq!(change.binding_lease_drain_samples, 1);
        assert_eq!(change.binding_lease_drain_micros, 500_001);
        assert_eq!(change.binding_lease_drain_slow, 1);
        reset();
        assert_eq!(snapshot(), PerfSnapshot::default());
    }
}
