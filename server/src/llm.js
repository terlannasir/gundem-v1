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
async function callGemini({ model, system, messages, tools, maxTokens, json }) {
  const body = {
    contents: toGemini(messages),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(tools?.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description || "", parametersJsonSchema: t.inputSchema || { type: "object", properties: {} } })) }] } : {}),
    generationConfig: { maxOutputTokens: maxTokens, ...(json && !tools?.length ? { responseMimeType: "application/json" } : {}) },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  let r;
  try {
    r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": config.ai.geminiKey }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  } catch (e) { throw fail(502, "upstream_error", "Gemini: " + e.message); }
  const data = await r.json().catch(() => ({}));
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
    usage: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), cacheRead: u.cachedContentTokenCount || 0 } };
}

export async function generate({ tier = "default", system, messages, tools, maxTokens = 2000, json = false }) {
  const model = modelFor(tier);
  return config.ai.provider === "gemini"
    ? callGemini({ model, system, messages, tools, maxTokens, json })
    : callAnthropic({ model, system, messages, tools, maxTokens });
}
