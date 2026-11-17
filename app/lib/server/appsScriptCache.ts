// =============================================================================
// app/lib/server/appsScriptCache.ts   —  SERVER-ONLY RESPONSE CACHE
// =============================================================================
// Fast Origin Transfer is billed on the bytes a Function sends back through the
// CDN. This app polls the full Google Sheet snapshot every few seconds, so the
// same ~800 KB payload was leaving the Function over and over.
//
// This module gives the proxy route three levers:
//   * a short shared TTL cache  -> many clients, one upstream call
//   * single-flight de-duplication -> parallel polls share one in-flight call
//   * a stable ETag per payload  -> unchanged data answers with 304 (0 bytes)
//
// Node runtime only (uses node:crypto and node:zlib).
// =============================================================================

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/** How long a successful read stays fresh before it is refreshed in the background. */
const DEFAULT_TTL_MS = 20_000;

/** Above this size the body is worth compressing before it leaves the Function. */
const MIN_GZIP_BYTES = 1_024;

/** Small LRU: a handful of actions × a few users is all that is ever needed. */
const MAX_ENTRIES = 32;

export interface CachedResponse {
  body: string;
  etag: string;
  /** Lazily produced, reused buffer so repeated hits skip the compression cost. */
  gzip?: Buffer | null;
  expiresAt: number;
}

const store = new Map<string, CachedResponse>();
const inflight = new Map<string, Promise<string>>();

/**
 * Reads that may be served from cache. Everything else (writes, uploads,
 * access changes) must always reach Apps Script.
 */
const READ_ACTIONS = new Set([
  "getAdminData",
  "getUserDashboardData",
  "getItemNames",
  "getHolidaysAndSundays",
  "getCompanyAutoFill",
  "getEntryIdReport",
  "getEntryById",
  "verifyUser",
]);

export function isReadAction(action: string): boolean {
  return READ_ACTIONS.has(action);
}

/** TTL is configurable so the owner can trade freshness for fewer upstream calls. */
export function cacheTtlMs(): number {
  const raw = Number(process.env.APPS_SCRIPT_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_TTL_MS;
}

/**
 * Deterministic key. Client payload key order can vary, so the body is
 * normalised before hashing — otherwise the same request would miss the cache.
 */
export function requestKey(action: string, body: Record<string, unknown>): string {
  return `${action}::${stableStringify(body)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);

  return `{${entries.join(",")}}`;
}

export function buildEntry(body: string): CachedResponse {
  return {
    body,
    etag: `"${createHash("sha1").update(body).digest("base64url")}"`,
    expiresAt: Date.now() + cacheTtlMs(),
  };
}

/** Recent entries are re-inserted so the LRU evicts genuinely old keys. */
export function readCache(key: string): CachedResponse | null {
  const hit = store.get(key);
  if (!hit) return null;
  store.delete(key);
  store.set(key, hit);
  return hit;
}

export function writeCache(key: string, body: string): CachedResponse {
  const entry = buildEntry(body);
  store.delete(key);
  store.set(key, entry);

  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (!oldest) break;
    store.delete(oldest);
  }

  return entry;
}

/** Compresses once per payload version, then reuses the buffer. */
export function gzipFor(entry: CachedResponse): Buffer | null {
  if (entry.gzip !== undefined) return entry.gzip;
  entry.gzip = entry.body.length < MIN_GZIP_BYTES ? null : gzipSync(entry.body);
  return entry.gzip;
}

/** Any write makes every cached snapshot stale. */
export function invalidateAll(): void {
  store.clear();
}

/**
 * Collapses parallel identical requests (several tabs, or the page's first load
 * plus the poller's first tick) into a single upstream call.
 */
export function runSingleFlight(key: string, task: () => Promise<string>): Promise<string> {
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = task().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

/**
 * Stale-while-revalidate: serve the cached snapshot immediately and refresh it
 * in the background, so nobody waits on Apps Script and no data is lost.
 */
export function warmInBackground(key: string, task: () => Promise<string>): void {
  if (inflight.has(key)) return;
  void runSingleFlight(key, task).catch(() => {
    /* the next request retries; a warm failure must never surface to the user */
  });
}