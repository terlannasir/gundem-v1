import { Worker } from "node:worker_threads";

export const kindOf = (mime, name = "") =>
  /pdf/.test(mime) || /\.pdf$/i.test(name) ? "pdf"
  : /wordprocessingml/.test(mime) || /\.docx$/i.test(name) ? "docx"
  : /spreadsheetml/.test(mime) || /\.xlsx$/i.test(name) ? "xlsx" : null;

// Office files are zips: refuse "zip bombs" before inflating anything (declared uncompressed size, entry count, zip64).
export function zipTooBig(buf, maxBytes = 80e6) {
  const b = Buffer.from(buf), min = Math.max(0, b.length - 65557);
  let eocd = -1;
  for (let i = b.length - 22; i >= min; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return "zip deyil";
  const n = b.readUInt16LE(eocd + 10), cdOff = b.readUInt32LE(eocd + 16);
  if (n === 0xffff || cdOff === 0xffffffff || n > 5000) return "həddən çox fayl";
  let off = cdOff, total = 0;
  for (let k = 0; k < n; k++) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== 0x02014b50) return "zəif zip";
    const usize = b.readUInt32LE(off + 24);
    if (usize === 0xffffffff) return "zip64";
    total += usize; if (total > maxBytes) return "açılanda çox böyükdür";
    off += 46 + b.readUInt16LE(off + 28) + b.readUInt16LE(off + 30) + b.readUInt16LE(off + 32);
  }
  return null;
}

let running = 0;
/** Parse an untrusted document in a throw-away worker (≤200 MB heap, ≤20 s). Resolves to text. */
export function parseDocument(buf, kind, { timeoutMs = 20000 } = {}) {
  if (kind === "docx" || kind === "xlsx") {
    const why = zipTooBig(buf);
    if (why) return Promise.reject(Object.assign(new Error("Fayl oxunmadı: " + why), { status: 422, code: "tool_error" }));
  }
  if (running >= 2) return Promise.reject(Object.assign(new Error("Server məşğuldur — bir az sonra yenidən cəhd et"), { status: 503, code: "server_unavailable", retryable: true }));
  running++;
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./parse-worker.js", import.meta.url), {
      workerData: { buf, kind }, resourceLimits: { maxOldGenerationSizeMb: 200, maxYoungGenerationSizeMb: 32 },
    });
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); running--; w.terminate().catch(() => {}); fn(v); };
    const fail = (m) => Object.assign(new Error(m), { status: 422, code: "tool_error" });
    const timer = setTimeout(() => finish(reject, fail("Faylı oxumaq çox uzun çəkdi")), timeoutMs);
    w.once("message", (m) => (m.ok ? finish(resolve, m.text) : finish(reject, fail("Fayl oxunmadı: " + m.error))));
    w.once("error", (e) => finish(reject, fail(/memory|heap/i.test(e.message) ? "Fayl oxumaq üçün çox ağırdır" : "Fayl oxunmadı")));
    w.once("exit", (c) => finish(reject, fail("Fayl oxunmadı")));
  });
}
