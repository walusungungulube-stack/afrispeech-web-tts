/**
 * AfriSpeech Listen — standalone, no Upstash dependency.
 */
import { checkAuth, corsHeaders } from "./lib/auth.mjs";
import { checkFlood, claimBudget } from "./lib/ratelimit.mjs";
import { readSource, synthesise } from "./lib/pipeline.mjs";
import { languageCatalogue } from "./lib/languages.mjs";
import { markDone, markFailed, markRunning, putAudio, getMeta, getAudio, isValidRunId } from "./lib/store.mjs";

const USAGE_NOTICE = { status: "self-hosted", message: "This endpoint is not a shared public service.", production: "Deploy your own instance with your own paid Gemini API key." };
async function attempt(work) { try { return { ok: true, value: await work() }; } catch (error) { return { ok: false, name: (error?.name) || "Error", message: String(error?.message || error).slice(0, 300) }; } }
export function describe(failure) { if (/quota|rate limit|RESOURCE_EXHAUSTED|\b429\b|\b503\b|UNAVAILABLE|overloaded|capacity/i.test(failure.message)) return "The speech service is busy just now. Please try again in a moment."; if (/ETIMEDOUT|timeout|ECONNRESET|fetch failed|ENOTFOUND|ECONNREFUSED|socket|disconnect/i.test(failure.message)) return "The connection to the speech service dropped. Please try again."; return failure.message || "Something went wrong."; }
export function audioOut(result) { const mp3 = result && result.mp3; return { ...result, mp3: Buffer.isBuffer(mp3) ? mp3.toString("base64") : mp3 }; }
export function audioIn(mp3) { if (Buffer.isBuffer(mp3)) return mp3; if (typeof mp3 === "string") return Buffer.from(mp3, "base64"); if (mp3 && Array.isArray(mp3.data)) return Buffer.from(mp3.data); throw new TypeError("a recording came back as something other than audio"); }
function generateRunId() { const bytes = crypto.getRandomValues(new Uint8Array(16)); return "wfr_" + Buffer.from(bytes).toString("base64").replace(/=/g, "").slice(0, 20); }
async function runSynthesis(runId, body) {
  const read = await attempt(() => readSource(body));
  if (!read.ok) { markFailed(runId, describe(read)); return; }
  const source = read.value;
  const made = await attempt(async () => { const result = await synthesise({ text: source.text, lang: body.lang, locale: body.locale }); return { spoken: audioOut(result.spoken), meta: result.meta }; });
  if (!made.ok) { markFailed(runId, describe(made)); return; }
  const mp3 = audioIn(made.value.spoken.mp3);
  const meta = { ...made.value.meta, via: source.via };
  putAudio(runId, mp3); markDone(runId, meta);
}
function limitResponse(limit, cors) { return Response.json({ error: limit.error }, { status: limit.status, headers: { ...cors, "retry-after": String(limit.retryAfter ?? 60), "x-listen-limit": limit.scope ?? "" } }); }
const worker = { async fetch(request) {
  const url = new URL(request.url); const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname === "/languages" && request.method === "GET") return Response.json({ notice: USAGE_NOTICE, languages: languageCatalogue() }, { headers: { ...cors, "cache-control": "public, max-age=3600" } });
  const auth = checkAuth(request); if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status, headers: cors });
  if (url.pathname === "/languages" && request.method === "GET") return Response.json({ notice: USAGE_NOTICE, languages: languageCatalogue() }, { headers: { ...cors, "cache-control": "public, max-age=3600" } });
  if (url.pathname === "/status" && request.method === "GET") { const run = url.searchParams.get("run"); if (!isValidRunId(run)) return Response.json({ error: "bad run id" }, { status: 400, headers: cors }); const meta = getMeta(run); if (!meta) return Response.json({ state: "unknown" }, { headers: cors }); return Response.json(meta, { headers: cors }); }
  if (url.pathname === "/audio" && request.method === "GET") { const run = url.searchParams.get("run"); if (!isValidRunId(run)) return Response.json({ error: "bad run id" }, { status: 400, headers: cors }); const mp3 = getAudio(run); if (!mp3) return Response.json({ error: "not ready" }, { status: 404, headers: cors }); return new Response(mp3, { headers: { ...cors, "content-type": "audio/mpeg", "content-length": String(mp3.length), "cache-control": "private, max-age=3600" } }); }
  if (url.pathname === "/speak" && request.method === "POST") {
    // Flood guard runs BEFORE body validation: a malformed request still costs
    // a socket, so it counts against the per-minute limit.
    const flood = await checkFlood(request); if (!flood.ok) return limitResponse(flood, cors);
    const contentType = request.headers.get("content-type") || ""; if (!contentType.includes("application/json")) return Response.json({ error: "send JSON with text" }, { status: 415, headers: cors });
    const raw = await request.clone().text(); if (raw.length > 20_000) return Response.json({ error: "body too large" }, { status: 413, headers: cors });
    let body; try { body = JSON.parse(raw); } catch { return Response.json({ error: "invalid JSON" }, { status: 400, headers: cors }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "send a JSON object with text" }, { status: 400, headers: cors });
    if (typeof body.text !== "string" || !body.text.trim().length) return Response.json({ error: "give me something to read: text" }, { status: 400, headers: cors });
    const budget = await claimBudget(request); if (!budget.ok) return limitResponse(budget, cors);
    const runId = generateRunId(); markRunning(runId);
    runSynthesis(runId, body).catch((err) => { console.error("synthesis failed:", err); markFailed(runId, err.message || "Unknown error"); });
    return Response.json({ workflowRunId: runId, finishCondition: "success" }, { headers: cors });
  }
  return Response.json({ error: "not found" }, { status: 404, headers: cors });
}};
export default worker;
