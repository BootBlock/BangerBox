/**
 * Storage safeguards (spec §9.7): persistence request, quota estimation, and the
 * 90 % quota hard-stop check run before any storage-growing write. Every call
 * degrades safely where an API is missing — the capability gate treats these as
 * soft requirements (spec §2.1).
 */
import { QUOTA_HARD_STOP_RATIO } from '@/core/constants';

export interface StorageEstimateResult {
  /** Bytes used by this origin (best-effort; browsers may pad/obfuscate). */
  readonly usage: number;
  /** Total bytes available to this origin. */
  readonly quota: number;
  /** usage / quota in the range 0..1 (0 when unknown). */
  readonly ratio: number;
  /** Whether the estimate API was actually available. */
  readonly supported: boolean;
}

export interface HeadroomCheckResult extends StorageEstimateResult {
  /** False when the proposed write would breach the §9.7 hard stop. */
  readonly allowed: boolean;
}

export async function estimateStorage(): Promise<StorageEstimateResult> {
  if (typeof navigator.storage?.estimate !== 'function') {
    return { usage: 0, quota: 0, ratio: 0, supported: false };
  }
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const ratio = quota > 0 ? usage / quota : 0;
    return { usage, quota, ratio, supported: true };
  } catch {
    return { usage: 0, quota: 0, ratio: 0, supported: false };
  }
}

export async function isStoragePersisted(): Promise<boolean> {
  if (typeof navigator.storage?.persisted !== 'function') return false;
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * Ask the browser to protect this origin's storage from eviction (spec §9.7 —
 * requested at first run). Returns the resulting persisted state; when false the
 * shell shows a persistent dismissible eviction warning.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator.storage?.persist !== 'function') return false;
  try {
    if (await isStoragePersisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * The §9.7 quota hard-stop: refuse gracefully when a proposed write of
 * `additionalBytes` would push origin usage beyond 90 % of quota. An unsupported
 * estimate API allows the write (there is nothing to check against).
 */
export async function checkWriteHeadroom(additionalBytes: number): Promise<HeadroomCheckResult> {
  const estimate = await estimateStorage();
  if (!estimate.supported || estimate.quota <= 0) return { ...estimate, allowed: true };
  const projected = (estimate.usage + Math.max(0, additionalBytes)) / estimate.quota;
  return { ...estimate, allowed: projected <= QUOTA_HARD_STOP_RATIO };
}
