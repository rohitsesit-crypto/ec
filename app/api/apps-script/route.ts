// =============================================================================
// app/api/apps-script/route.ts   —  SERVER-SIDE APPS SCRIPT PROXY
// =============================================================================
// Why this exists: APPS_SCRIPT_URL has no NEXT_PUBLIC_ prefix, so it is a
// server-only variable and must never be shipped to the browser. This route
// runs on the server, reads the variable, and forwards the call to the Apps
// Script Web App.
//
// Apps Script specifics handled here:
//   * the body must be text/plain (application/json triggers a CORS preflight
//     that Apps Script refuses)
//   * the response is a 302 redirect, so redirect: 'follow' is required
//   * a misconfigured deployment answers with an HTML page, which is converted
//     into a readable JSON error instead of crashing the client
//
// ORIGIN TRANSFER CONTROL
//   Every response leaving a Function is billed as Fast Origin Transfer. The
//   dashboards poll this route, and the Apps Script snapshot is large, so the
//   same bytes used to be paid for on every poll. Four guards now apply:
//     1. a short TTL cache shared by every visitor
//     2. single-flight de-duplication of identical in-flight reads
//     3. strong ETag + 304 so an unchanged snapshot costs ~0 bytes
//     4. gzip on the way out
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import {
  buildEntry,
  gzipFor,
  invalidateAll,
  isReadAction,
  readCache,
  requestKey,
  runSingleFlight,
  warmInBackground,
  writeCache,
  type CachedResponse,
} from "../../lib/server/appsScriptCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Upstream call budget. Large attachment uploads need the longer window. */
const UPSTREAM_TIMEOUT_MS = 60_000;

function appsScriptUrl(): string {
  return (process.env.APPS_SCRIPT_URL || "").trim();
}

function missingUrlResponse() {
  return NextResponse.json(
    {
      success: false,
      message:
        "APPS_SCRIPT_URL is not configured on the server. Add it to .env.local " +
        "(or the deployment's environment variables) and restart the app.",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}

/** Talks to Apps Script and returns the raw JSON text of a successful reply. */
async function callUpstream(url: string, payload: unknown): Promise<string> {
  const upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  const text = await upstream.text();

  try {
    JSON.parse(text);
  } catch {
    throw new AppsScriptShapeError(
      "Apps Script did not return JSON. Re-deploy the Web App with " +
        '"Execute as: Me" and "Who has access: Anyone", then confirm ' +
        "APPS_SCRIPT_URL points at the /exec URL."
    );
  }

  return text;
}

class AppsScriptShapeError extends Error {}

/** Read path: fetch, memoise, and never cache a failed payload. */
async function fetchAndCache(url: string, key: string, payload: unknown): Promise<string> {
  const text = await callUpstream(url, payload);

  // A negative result (bad email, denied access) is still a valid, cacheable
  // answer — it must not hammer Apps Script on every poll either.
  writeCache(key, text);
  return text;
}

function wantsGzip(request: NextRequest): boolean {
  return (request.headers.get("accept-encoding") || "").includes("gzip");
}

function sendCached(
  request: NextRequest,
  entry: CachedResponse,
  allowNotModified: boolean
): NextResponse {
  const headers = new Headers({
    ETag: entry.etag,
    "Cache-Control": "private, no-store",
    Vary: "Accept-Encoding",
  });

  if (allowNotModified && request.headers.get("if-none-match") === entry.etag) {
    return new NextResponse(null, { status: 304, headers });
  }

  const compressed = wantsGzip(request) ? gzipFor(entry) : null;
  if (compressed) headers.set("Content-Encoding", "gzip");

  headers.set("Content-Type", "application/json; charset=utf-8");

  // Buffer is a valid runtime body; the cast satisfies the DOM BodyInit typing.
  const body = compressed ? (compressed as unknown as BodyInit) : entry.body;

  return new NextResponse(body, {
    status: 200,
    headers,
  });
}

export async function POST(request: NextRequest) {
  const url = appsScriptUrl();
  if (!url) return missingUrlResponse();

  let payload: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, message: "Invalid JSON request body." },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const action = String(payload.action ?? "");
  const key = requestKey(action, payload);

  // ---- Writes and uploads: always reach Apps Script, then drop stale reads ----
  if (!isReadAction(action)) {
    try {
      const body = await callUpstream(url, payload);
      invalidateAll();
      return new NextResponse(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "private, no-store",
        },
      });
    } catch (error) {
      return upstreamErrorResponse(error);
    }
  }

  // ---- Reads: cache -> conditional -> compressed ----
  const cached = readCache(key);

  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      // Stale-while-revalidate: answer now, refresh quietly.
      warmInBackground(key, () => fetchAndCache(url, key, payload));
    }
    return sendCached(request, cached, true);
  }

  try {
    const body = await runSingleFlight(key, () => fetchAndCache(url, key, payload));
    const entry = readCache(key) ?? buildEntry(body);
    return sendCached(request, entry, true);
  } catch (error) {
    return upstreamErrorResponse(error);
  }
}

function upstreamErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  const timedOut = /abort|timeout/i.test(message);

  return NextResponse.json(
    {
      success: false,
      message: timedOut
        ? "The Apps Script call timed out. Please try again."
        : error instanceof AppsScriptShapeError
          ? message
          : `Could not reach Apps Script: ${message}`,
    },
    { status: 502, headers: { "Cache-Control": "no-store" } }
  );
}

/** Health check: confirms the server can see the configured URL. */
export async function GET() {
  const url = appsScriptUrl();
  return NextResponse.json({
    success: true,
    configured: Boolean(url),
    message: url
      ? "Apps Script proxy is ready."
      : "APPS_SCRIPT_URL is not configured on the server.",
  });
}