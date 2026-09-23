// Provider-neutral LLM call: Anthropic (Claude) or Google Gemini, chosen by AI_PROVIDER.
//
// Neutral message format (what the web runtime sends):
//   { role: "user", content: "text" | [{type:"text",text} | {type:"image",mediaType,data(base64)}] }
//   { role: "assistant", content: "text" }                 – plain earlier answer
//   { role: "assistant", raw: <opaque provider content> }  – echo of a tool-calling turn, sent back verbatim
//   { role: "user", toolResults: [{ id, name, output: "text", isError? }] }
// Result: { text, truncated, calls: [{id,name,input}], raw, model, usage: {in, out, cacheRead} }
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const fail = (status, code, message) => Object.assign(new Error(message || code), { status, code: code });
export const modelFor = (tier) => (tier === "quick" ? config.ai.models.fast : config.ai.models.smart);

let _anthropic;
export const anthropicClient = () => (_anthropic ||= new Anthropic({ apiKey: config.ai.anthropicKey }));

/* ---------------- Anthropic ---------------- */
function toAnthropic(messages) {
  return messages.map((m) => {
    if (m.role === "assistant") return { role: "assistant", content: m.raw ?? String(m.content ?? "") };
    if (m.toolResults) return { role: "user", content: m.toolResults.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: String(r.output ?? ""), ...(r.isError ? { is_error: true } : {}) })) };
    if (typeof m.content === "string") return { role: "user", content: m.content };
    return { role: "user", content: m.content.map((p) => (p.type === "image" ? { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } } : { type: "text", text: String(p.text ?? "") })) };
  });
}
async function callAnthropic({ model, system, messages, tools, maxTokens }) {
  let res;
  try {
    res = await anthropicClient().messages.create({
      model, max_tokens: maxTokens,
      ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
      ...(tools?.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description || "", input_schema: t.inputSchema || { type: "object", properties: {} } })) } : {}),
      messages: toAnthropic(messages),
    });
  } catch (e) {
    const s = e.status || 500;
    throw fail(s === 429 ? 429 : s >= 500 ? 502 : 400, s === 429 ? "rate_limited" : s >= 500 ? "upstream_error" : "bad_request", e.message);
  }
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const calls = res.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));
  const u = res.usage || {};
  return { text, truncated: res.stop_reason === "max_tokens", calls, raw: res.content, model,
    usage: { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 } };
}

/* ---------------- Gemini ---------------- */
function toGemini(messages) {
  return messages.map((m) => {
    if (m.role === "assistant") return { role: "model", parts: m.raw ?? [{ text: String(m.content ?? "") }] };
    if (m.toolResults) return { role: "user", parts: m.toolResults.map((r) => ({ functionResponse: { ...(r.id && !String(r.id).startsWith("gcall_") ? { id: r.id } : {}), name: r.name, response: r.isError ? { error: String(r.output ?? "") } : { result: String(r.output ?? "") } } })) };
    if (typeof m.content === "string") return { role: "user", parts: [{ text: m.content }] };
    return { role: "user", parts: m.content.map((p) => (p.type === "image" ? { inlineData: { mimeType: p.mediaType, data: p.data } } : { text: String(p.text ?? "") })) };
  });
}
// "Thinking" tokens are billed/counted as output and were most of the usage → keep it minimal except for "complex".
function thinking(model, tier) {
  if (process.env.GEMINI_THINKING === "default" || tier === "complex") return {};
  if (/gemini-2\.5-pro/.test(model)) return { thinkingConfig: { thinkingBudget: 128 } };
  if (/gemini-2\.5/.test(model)) return { thinkingConfig: { thinkingBudget: 0 } };
  return { thinkingConfig: { thinkingLevel: tier === "quick" ? "minimal" : "low" } };
}
async function callGemini({ model, system, messages, tools, maxTokens, json, tier }) {
  const body = {
    contents: toGemini(messages),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || "", parametersJsonSchema: t.inputSchema || { type: "object", properties: {} } })) }] } : {}),
    generationConfig: { maxOutputTokens: maxTokens, ...(json && !tools?.length ? { responseMimeType: "application/json" } : {}), ...thinking(model, tier) },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let r;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": config.ai.geminiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  } catch (e) { throw fail(502, "upstream_error", "Gemini: " + e.message); }
  let data = await r.json().catch(() => ({}));
  if (r.status === 400 && body.generationConfig.thinkingConfig && /thinking/i.test(data?.error?.message || "")) {
    delete body.generationConfig.thinkingConfig;
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": config.ai.geminiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    data = await r.json().catch(() => ({}));
  }
  if (!r.ok) {
    const msg = data?.error?.message || `HTTP ${r.status}`;
    throw fail(r.status === 429 ? 429 : r.status >= 500 ? 502 : 400, r.status === 429 ? "rate_limited" : r.status >= 500 ? "upstream_error" : "bad_request", "Gemini: " + msg);
  }
  if (data.promptFeedback?.blockReason) throw fail(400, "blocked", "Gemini blocked the request: " + data.promptFeedback.blockReason);
  const cand = data.candidates?.[0] || {};
  const parts = cand.content?.parts || [];
  const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
  const calls = parts.filter((p) => p.functionCall).map((p, i) => ({ id: p.functionCall.id || `gcall_${i}`, name: p.functionCall.name, input: p.functionCall.args || {} }));
  const u = data.usageMetadata || {};
  return { text, truncated: cand.finishReason === "MAX_TOKENS", calls, raw: parts, model,
    usage: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), thoughts: u.thoughtsTokenCount || 0, cacheRead: u.cachedContentTokenCount || 0 } };
}

// Free-tier quotas are per model: when one model answers 429 (limit reached), try the next one and
// leave the exhausted model alone for a while (a minute for per-minute limits, an hour for daily ones).
const cooldown = new Map();   // model -> until (ms)
function chainFor(tier) {
  const first = modelFor(tier);
  const extra = (tier === "quick" ? config.ai.fallbackFast : config.ai.fallbackSmart).filter((m) => m && m !== first);
  const all = [first, ...extra];
  const ready = all.filter((m) => !(cooldown.get(m) > Date.now()));
  return ready.length ? ready : [all.sort((a, b) => (cooldown.get(a) || 0) - (cooldown.get(b) || 0))[0]];
}
export async function generate({ tier = "default", system, messages, tools, maxTokens = 2000, json = false }) {
  if (config.ai.provider !== "gemini") return callAnthropic({ model: modelFor(tier), system, messages, tools, maxTokens });
  const chain = chainFor(tier);
  const hasRaw = messages.some((m) => m.raw);   // a tool-calling turn can't move to another model (thought signatures)
  let last, quotaErr;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try { return await callGemini({ model, system, messages, tools, maxTokens, json, tier }); }
    catch (e) {
      last = e;
      // retired / unknown model ("no longer available", "not found", "not supported") → skip it for a day
      const gone = (e.status === 400 || e.status === 403 || e.status === 404) && /no longer available|not found|not supported|unknown model|deprecated|does not exist/i.test(e.message);
      if (e.code === "rate_limited") { quotaErr = e; cooldown.set(model, Date.now() + (/per ?day|daily/i.test(e.message) ? 3600e3 : 60e3)); }
      else if (gone) cooldown.set(model, Date.now() + 24 * 3600e3);
      else throw e;
      if (hasRaw) break;
    }
  }
  throw quotaErr || last;   // "limit reached" is the useful message, not a retired fallback model
}
