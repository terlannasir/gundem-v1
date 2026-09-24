// Connector-compatible tools: the same tool names, inputs and payload shapes the
// Gündəm web app used through claude.ai connectors — now served with the user's own Google account.
import { google } from "./gapi.js";
import { randomBytes } from "node:crypto";
import { parseDocument, kindOf } from "./parse.js";

export const SERVERS = {
  "Gmail": { scope: "gmail.modify", tools: ["search_threads", "get_thread", "get_message", "update_message_labels", "send_message", "create_draft", "reply", "forward"] },
  "Google Calendar": { scope: "calendar", tools: ["list_events", "create_event"] },
  "Google Drive": { scope: "drive", tools: ["search_files", "read_file_content", "create_file", "trash_file"] },
};
const toolErr = (message) => Object.assign(new Error(message), { status: 422, code: "tool_error" });
const badInput = (message) => Object.assign(new Error(message), { status: 400, code: "bad_request" });
const str = (v, name, max = 100000) => { if (typeof v !== "string" || !v.trim()) throw badInput(`${name} is required`); return v.slice(0, max); };
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]\s*/) : []).map((s) => String(s).trim()).filter(Boolean);

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

/* ================= Gmail ================= */
const hdr = (m, n) => (m.payload?.headers || []).find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
// linear-time helpers (hostile mail must not be able to stall the event loop with regex backtracking)
function splitAddrs(s) {
  const out = []; let cur = "", q = false;
  for (const ch of String(s || "").slice(0, 20000)) { if (ch === '"') q = !q; if (ch === "," && !q) { out.push(cur); cur = ""; } else cur += ch; }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean).slice(0, 200);
}
function stripBlocks(html) {   // drop <style>/<script>/<head> blocks with indexOf scanning
  let out = "", i = 0; const low = html.toLowerCase();
  while (i < html.length) {
    const m = /<(style|script|head)\b/g; m.lastIndex = i; const hit = m.exec(low);
    if (!hit) { out += html.slice(i); break; }
    out += html.slice(i, hit.index);
    const end = low.indexOf("</" + hit[1], hit.index + 1);
    if (end < 0) break;
    const close = low.indexOf(">", end); i = close < 0 ? html.length : close + 1;
  }
  return out;
}
const emailOf = (a) => (String(a).match(/<([^>]+)>/)?.[1] || String(a)).trim().toLowerCase();

function bodyText(part) {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data && !part.filename) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const p of part.parts || []) { const t = bodyText(p); if (t) return t; }
  if (part.mimeType === "text/html" && part.body?.data && !part.filename) {
    return stripBlocks(Buffer.from(part.body.data, "base64url").toString("utf8").slice(0, 400000)).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
      .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  }
  return "";
}
function attachments(part, out = []) {
  if (!part) return out;
  if (part.filename && (part.body?.attachmentId || part.body?.data)) out.push({ filename: part.filename, mimeType: part.mimeType, size: part.body.size || 0 });
  for (const p of part.parts || []) attachments(p, out);
  return out;
}
const msgMeta = (m) => ({
  id: m.id, threadId: m.threadId, labelIds: m.labelIds || [], snippet: m.snippet || "",
  sender: hdr(m, "From"), subject: hdr(m, "Subject"), date: new Date(Number(m.internalDate)).toISOString(),
  toRecipients: splitAddrs(hdr(m, "To")), ccRecipients: splitAddrs(hdr(m, "Cc")),
  viewUrl: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
});

const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
function encAddr(a) {
  const m = String(a).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (!m || !m[1]) return String(a).trim();
  const n = m[1].trim();
  const name = !/^[\x20-\x7e]*$/.test(n) ? encWord(n) : /[()<>@,;:\\".[\]]/.test(n) ? `"${n.replace(/["\\]/g, "\\$&")}"` : n;   // "Doe, John" stays one recipient
  return `${name} <${m[2]}>`;
}
const noCRLF = (s) => String(s || "").replace(/[\r\n]+/g, " ");
function mime({ to, cc, bcc, subject, body, inReplyTo, references, extraParts }) {
  const heads = [
    `To: ${to.map((a) => encAddr(noCRLF(a))).join(", ")}`,
    cc?.length ? `Cc: ${cc.map((a) => encAddr(noCRLF(a))).join(", ")}` : null,
    bcc?.length ? `Bcc: ${bcc.map((a) => encAddr(noCRLF(a))).join(", ")}` : null,
    `Subject: ${encWord(noCRLF(subject))}`, "MIME-Version: 1.0",
    inReplyTo ? `In-Reply-To: ${noCRLF(inReplyTo)}` : null, references ? `References: ${noCRLF(references)}` : null,
  ].filter(Boolean);
  const text = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", Buffer.from(body || "", "utf8").toString("base64").replace(/.{76}/g, "$&\r\n")].join("\r\n");
  if (!extraParts?.length) return Buffer.from([...heads, text].join("\r\n")).toString("base64url");
  const b = "gundem_" + randomBytes(8).toString("hex");
  return Buffer.from([...heads, `Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, text, ...extraParts.flatMap((p) => [`--${b}`, p]), `--${b}--`, ""].join("\r\n"), "latin1").toString("base64url");   // all our parts are ASCII; attached originals are latin1-mapped bytes
}
async function myEmail(gmail) { const { data } = await gmail.users.getProfile({ userId: "me" }); return (data.emailAddress || "").toLowerCase(); }
async function original(gmail, messageId) {
  const { data } = await gmail.users.messages.get({ userId: "me", id: str(messageId, "messageId", 200), format: "metadata", metadataHeaders: ["From", "To", "Cc", "Reply-To", "Subject", "Message-ID", "References"] });
  return data;
}

// Thread metadata keyed by user + thread + historyId: unchanged threads are not fetched again
// (an inbox refresh goes from 41 Gmail calls to 1 + the few threads that actually changed).
const threadCache = new Map();
const TC_MAX = 20000;
const gmailTools = {
  async search_threads(auth, i, ctx = {}) {
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.threads.list({ userId: "me", q: String(i.query || ""), maxResults: Math.min(50, Math.max(1, Number(i.pageSize) || 20)), pageToken: i.pageToken || undefined });
    const threads = await pool(data.threads || [], 10, async (t) => {
      const k = ctx.uid && t.historyId ? `${ctx.uid}:${t.id}:${t.historyId}` : null;
      const hit = k && threadCache.get(k);
      if (hit) { threadCache.delete(k); threadCache.set(k, hit); return hit; }   // LRU touch
      const { data: th } = await gmail.users.threads.get({ userId: "me", id: t.id, format: "metadata", metadataHeaders: ["From", "To", "Cc", "Subject"] });
      const out = { id: th.id, viewUrl: `https://mail.google.com/mail/u/0/#all/${th.id}`, messages: (th.messages || []).map(msgMeta) };
      if (k) { threadCache.set(k, out); if (threadCache.size > TC_MAX) threadCache.delete(threadCache.keys().next().value); }
      return out;
    });
    return { threads, ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
  },
  async get_thread(auth, i) {
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.threads.get({ userId: "me", id: str(i.threadId, "threadId", 200), format: "full" });
    return { id: data.id, messages: (data.messages || []).map((m) => ({ ...msgMeta(m), plaintextBody: bodyText(m.payload).slice(0, 200000), attachments: attachments(m.payload) })) };
  },
  async get_message(auth, i) {
    const gmail = google.gmail({ version: "v1", auth });
    const id = str(i.messageId, "messageId", 200);
    if (String(i.messageFormat).toUpperCase() === "RAW") {
      const { data: meta } = await gmail.users.messages.get({ userId: "me", id, format: "minimal" });
      if (Number(meta.sizeEstimate || 0) > 30e6) throw toolErr("Məktub çox böyükdür (30 MB-dan çox)");
      const { data } = await gmail.users.messages.get({ userId: "me", id, format: "raw" });
      return { id: data.id, threadId: data.threadId, labelIds: data.labelIds || [], raw: data.raw };
    }
    const { data } = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    return { ...msgMeta(data), plaintextBody: bodyText(data.payload), attachments: attachments(data.payload) };
  },
  async update_message_labels(auth, i) {
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.messages.modify({ userId: "me", id: str(i.messageId, "messageId", 200), requestBody: { addLabelIds: list(i.addLabelIds), removeLabelIds: list(i.removeLabelIds) } });
    return { id: data.id, labelIds: data.labelIds || [] };
  },
  async send_message(auth, i) {
    const to = list(i.to); if (!to.length) throw badInput("to is required");
    const gmail = google.gmail({ version: "v1", auth });
    const { data } = await gmail.users.messages.send({ userId: "me", requestBody: { raw: mime({ to, cc: list(i.cc), bcc: list(i.bcc), subject: String(i.subject || ""), body: String(i.body || "") }) } });
    return { id: data.id, threadId: data.threadId, labelIds: data.labelIds || [] };
  },
  async create_draft(auth, i) {
    const gmail = google.gmail({ version: "v1", auth });
    let threadId, inReplyTo, references;
    if (i.replyToMessageId) {
      const o = await original(gmail, i.replyToMessageId);
      threadId = o.threadId; inReplyTo = hdr(o, "Message-ID"); references = [hdr(o, "References"), inReplyTo].filter(Boolean).join(" ");
    }
    const { data } = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { threadId, raw: mime({ to: list(i.to), cc: list(i.cc), subject: String(i.subject || ""), body: String(i.body || ""), inReplyTo, references }) } } });
    return { id: data.id, message: { id: data.message?.id, threadId: data.message?.threadId } };
  },
  async reply(auth, i) {
    const gmail = google.gmail({ version: "v1", auth });
    const o = await original(gmail, i.messageId), me = await myEmail(gmail);
    const from = hdr(o, "Reply-To") || hdr(o, "From");
    let to = list(i.to), cc = list(i.cc);
    if (!to.length) {
      if (emailOf(hdr(o, "From")) === me) to = splitAddrs(hdr(o, "To"));   // replying to my own message → same recipients
      else to = splitAddrs(from);
      if (i.replyAll) {
        const seen = new Set([me, ...to.map(emailOf)]);
        cc = [...splitAddrs(hdr(o, "To")), ...splitAddrs(hdr(o, "Cc"))].filter((a) => { const e = emailOf(a); if (seen.has(e)) return false; seen.add(e); return true; });
      }
    }
    if (!to.length) throw toolErr("Cavab üçün alıcı tapılmadı");
    const subj = hdr(o, "Subject"), msgId = hdr(o, "Message-ID");
    const { data } = await gmail.users.messages.send({ userId: "me", requestBody: { threadId: o.threadId, raw: mime({
      to, cc, subject: /^re:/i.test(subj) ? subj : "Re: " + subj, body: str(i.body, "body"),
      inReplyTo: msgId, references: [hdr(o, "References"), msgId].filter(Boolean).join(" ") }) } });
    return { id: data.id, threadId: data.threadId, to, cc };
  },
  async forward(auth, i) {
    const to = list(i.to); if (!to.length) throw badInput("to is required");
    const gmail = google.gmail({ version: "v1", auth });
    const id = str(i.messageId, "messageId", 200);
    const o = await original(gmail, id);
    if (Number(o.sizeEstimate || 0) > 24e6) throw toolErr("Məktub yönləndirmək üçün çox böyükdür — Gmail-dən yönləndir");
    const { data: raw } = await gmail.users.messages.get({ userId: "me", id, format: "raw" });
    const subj = hdr(o, "Subject");
    const intro = `${i.forwardText ? String(i.forwardText) + "\n\n" : ""}---------- Yönləndirilmiş məktub ----------\nKimdən: ${hdr(o, "From")}\nMövzu: ${subj}\nKimə: ${hdr(o, "To")}\n(Orijinal məktub əlavədədir)`;
    const att = ["Content-Type: message/rfc822", `Content-Disposition: attachment; filename="forwarded.eml"`, "", Buffer.from(raw.raw, "base64url").toString("latin1")].join("\r\n");
    const rawOut = mime({ to, subject: /^fwd?:/i.test(subj) ? subj : "Fwd: " + subj, body: intro, extraParts: [att] });
    const { data } = await gmail.users.messages.send({ userId: "me", requestBody: { raw: rawOut } });
    return { id: data.id, threadId: data.threadId };
  },
};

/* ================= Calendar ================= */
const isoOr400 = (v, name) => { if (!v) return undefined; const d = new Date(v); if (isNaN(d)) throw badInput(`${name} is not a valid date`); return d.toISOString(); };
const calendarTools = {
  async list_events(auth, i) {
    const cal = google.calendar({ version: "v3", auth });
    const { data } = await cal.events.list({ calendarId: i.calendarId || "primary", timeMin: isoOr400(i.startTime, "startTime"), timeMax: isoOr400(i.endTime, "endTime"),
      singleEvents: true, orderBy: "startTime", maxResults: Math.min(250, Number(i.pageSize) || 50), timeZone: i.timeZone || undefined, q: i.query || undefined, pageToken: i.pageToken || undefined });
    return { events: data.items || [], ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
  },
  async create_event(auth, i) {
    const cal = google.calendar({ version: "v3", auth });
    const allDay = /^\d{4}-\d{2}-\d{2}$/.test(String(i.startTime));
    const t = (v) => (allDay ? { date: String(v) } : { dateTime: str(v, "time", 60), timeZone: i.timeZone || undefined });
    const { data } = await cal.events.insert({ calendarId: i.calendarId || "primary", requestBody: {
      summary: str(i.summary, "summary", 1000), start: t(i.startTime), end: t(i.endTime || i.startTime),
      location: i.location || undefined, description: i.description || undefined,
      attendees: list(i.attendees || i.attendeeEmails).map((email) => ({ email })) } });
    return data;
  },
};

/* ================= Drive ================= */
const FILE_FIELDS = "id,name,mimeType,webViewLink,owners(emailAddress,displayName),parents,viewedByMeTime,modifiedTime,createdTime,size";
const fileOut = (f) => ({ id: f.id, title: f.name, mimeType: f.mimeType, viewUrl: f.webViewLink, owner: f.owners?.[0]?.emailAddress || "", parentId: f.parents?.[0] || "", viewedByMeTime: f.viewedByMeTime, modifiedTime: f.modifiedTime, createdTime: f.createdTime });
// connector query syntax → Drive v3: "title" → "name" (outside quoted strings)
function driveQuery(qs) {
  const parts = String(qs || "").split(/('(?:[^'\\]|\\.)*')/);
  const out = parts.map((p, k) => (k % 2 ? p : p.replace(/\btitle\b/g, "name"))).join("").trim();
  return out ? (/\btrashed\b/.test(out) ? out : `(${out}) and trashed = false`) : "trashed = false";
}
async function download(drive, id) {
  const r = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "arraybuffer" });
  return Buffer.from(r.data);
}
const driveTools = {
  async search_files(auth, i) {
    const drive = google.drive({ version: "v3", auth });
    const q = driveQuery(i.query);
    const { data } = await drive.files.list({ q, pageSize: Math.min(100, Number(i.pageSize) || 20), pageToken: i.pageToken || undefined,
      orderBy: /fullText/.test(q) ? undefined : "modifiedTime desc", fields: `nextPageToken,files(${FILE_FIELDS})`, supportsAllDrives: true, includeItemsFromAllDrives: true });
    return { files: (data.files || []).map(fileOut), ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
  },
  async read_file_content(auth, i) {
    const drive = google.drive({ version: "v3", auth });
    const id = str(i.fileId, "fileId", 200);
    const { data: f } = await drive.files.get({ fileId: id, fields: "id,name,mimeType,size", supportsAllDrives: true });
    const exp = async (mimeType) => Buffer.from((await drive.files.export({ fileId: id, mimeType }, { responseType: "arraybuffer" })).data).toString("utf8");
    const mt = f.mimeType || "", size = Number(f.size || 0);
    // untrusted files are parsed in-process on a 512 MB instance → keep them small and time-boxed
    const office = /wordprocessingml|spreadsheetml/.test(mt);
    if (size > (office ? 8 : 20) * 1024 * 1024) throw toolErr(`Fayl oxumaq üçün çox böyükdür (${office ? 8 : 20} MB-dan çox)`);
    let text;
    if (mt === "application/vnd.google-apps.document") text = await exp("text/markdown").catch(() => exp("text/plain"));
    else if (mt === "application/vnd.google-apps.spreadsheet") text = await exp("text/csv");
    else if (mt === "application/vnd.google-apps.presentation" || mt === "application/vnd.google-apps.drawing") text = await exp("text/plain");
    else if (kindOf(mt)) text = await parseDocument(await download(drive, id), kindOf(mt));   // isolated worker
    else if (/^text\/|json|xml|csv|markdown/.test(mt)) text = (await download(drive, id)).toString("utf8");
    else throw toolErr(`Bu fayl növü oxuna bilmir: ${mt}`);
    return { id, title: f.name, mimeType: mt, fileContent: text.slice(0, 400000) };
  },
  async create_file(auth, i) {
    const drive = google.drive({ version: "v3", auth });
    const title = str(i.title, "title", 500), ct = String(i.contentMimeType || (i.textContent != null ? "text/plain" : "application/octet-stream"));
    let body, targetMime;
    if (i.textContent != null) { body = String(i.textContent); if (ct === "text/html") targetMime = "application/vnd.google-apps.document"; }
    else if (typeof i.base64Content === "string") body = Buffer.from(i.base64Content, "base64");
    else throw badInput("textContent or base64Content is required");
    const { Readable } = await import("node:stream");
    const { data } = await drive.files.create({ supportsAllDrives: true, fields: FILE_FIELDS,
      requestBody: { name: title, ...(targetMime ? { mimeType: targetMime } : {}), ...(i.parentId ? { parents: [String(i.parentId)] } : {}) },
      media: { mimeType: ct, body: Readable.from(Buffer.isBuffer(body) ? [body] : [Buffer.from(body, "utf8")]) } });
    return fileOut(data);
  },
  async trash_file(auth, i) {
    const drive = google.drive({ version: "v3", auth });
    const { data } = await drive.files.update({ fileId: str(i.fileId, "fileId", 200), supportsAllDrives: true, requestBody: { trashed: true }, fields: "id,trashed" });
    return data;
  },
};

const IMPL = { "Gmail": gmailTools, "Google Calendar": calendarTools, "Google Drive": driveTools };

/** Run one tool. Google auth failures become {status:409, code:"needs_reauth"}. */
export function forgetUserThreads(uid) { for (const k of threadCache.keys()) if (k.startsWith(uid + ":")) threadCache.delete(k); }
export async function runTool(auth, server, tool, input, ctx = {}) {
  const impl = IMPL[server]?.[tool];
  if (!impl || !SERVERS[server].tools.includes(tool)) throw Object.assign(new Error(`Unknown tool ${server}/${tool}`), { status: 400, code: "not_in_manifest" });
  try {
    return await impl(auth, input && typeof input === "object" ? input : {}, ctx);
  } catch (e) {
    if (e.code === "tool_error" || e.code === "bad_request") throw e;
    const st = e.response?.status || e.status || (typeof e.code === "number" ? e.code : 0);
    const reason = e.response?.data?.error || e.message || "";
    if (st === 401 || /invalid_grant|invalid_token/i.test(String(reason))) throw Object.assign(new Error("Google access expired"), { status: 409, code: "needs_reauth" });
    if (st === 403 && /insufficient|scope|permission/i.test(JSON.stringify(e.response?.data || e.message))) throw Object.assign(new Error("Google permission missing for " + server), { status: 409, code: "needs_reauth" });
    if (st === 429 || st >= 500) throw Object.assign(new Error(`${server}: ${e.message}`), { status: 503, code: "server_unavailable", retryable: true });
    if (st >= 400) throw toolErr(e.response?.data?.error?.message || e.message);
    throw e;
  }
}
