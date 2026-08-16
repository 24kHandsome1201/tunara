export interface TransferRateSample {
  at: number;
  bytes: number;
}

export interface TransferRateSnapshot {
  bytesPerSec: number;
  etaSeconds: number | null;
}

const MIN_WINDOW_MS = 400;

export function transferRate(samples: readonly TransferRateSample[], now = Date.now()): TransferRateSnapshot | null {
  if (samples.length < 2) return null;
  const latest = samples[samples.length - 1];
  if (!latest) return null;
  let start = samples[0];
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    const candidate = samples[index];
    if (!candidate) continue;
    if (now - candidate.at >= MIN_WINDOW_MS) {
      start = candidate;
      break;
    }
  }
  if (!start) return null;
  const elapsedMs = Math.max(1, (latest.at || now) - start.at);
  const delta = Math.max(0, latest.bytes - start.bytes);
  const bytesPerSec = (delta * 1000) / elapsedMs;
  return { bytesPerSec, etaSeconds: null };
}

export function transferEta(bytesTransferred: number, totalBytes: number | null | undefined, bytesPerSec: number): number | null {
  if (!totalBytes || totalBytes <= bytesTransferred || bytesPerSec <= 0) return null;
  return (totalBytes - bytesTransferred) / bytesPerSec;
}

export function formatTransferBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function formatTransferRate(bytesPerSec: number): string {
  return `${formatTransferBytes(bytesPerSec)}/s`;
}

export function formatTransferEta(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

export function pushRateSample(samples: TransferRateSample[], sample: TransferRateSample, limit = 12): TransferRateSample[] {
  const next = samples.length && samples[samples.length - 1]?.bytes === sample.bytes
    ? [...samples.slice(0, -1), sample]
    : [...samples, sample];
  return next.length > limit ? next.slice(next.length - limit) : next;
}
