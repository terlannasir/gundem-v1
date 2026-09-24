// Untrusted file parsing (PDF / Word / Excel) runs here, in a worker thread with its own memory cap,
// so a zip bomb or a pathological PDF can only kill this worker — never the server.
import { parentPort, workerData } from "node:worker_threads";

async function pdfText(buf) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, disableFontFace: true }).promise;
  const out = [];
  for (let p = 1; p <= Math.min(doc.numPages, 80); p++) {
    const c = await (await doc.getPage(p)).getTextContent();
    out.push(c.items.map((x) => x.str + (x.hasEOL ? "\n" : " ")).join(""));
  }
  await doc.destroy();
  return out.join("\n\n");
}
async function docxText(buf) { const mammoth = (await import("mammoth")).default; return (await mammoth.extractRawText({ buffer: Buffer.from(buf) })).value; }
async function xlsxText(buf) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(buf));
  return wb.worksheets.slice(0, 20).map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= 2000) return;
      rows.push(row.values.slice(1, 60).map((v) => {
        const x = v && typeof v === "object" ? (v.result ?? v.text ?? v.richText?.map((r) => r.text).join("") ?? "") : v ?? "";
        const s = String(x).slice(0, 500);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(","));
    });
    return `## ${ws.name}\n${rows.join("\n")}`;
  }).join("\n\n");
}

const { buf, kind } = workerData;
const run = kind === "pdf" ? pdfText : kind === "docx" ? docxText : kind === "xlsx" ? xlsxText : null;
(run ? run(buf) : Promise.reject(new Error("unsupported")))
  .then((text) => parentPort.postMessage({ ok: true, text: String(text).slice(0, 400000) }))
  .catch((e) => parentPort.postMessage({ ok: false, error: String(e && e.message || e).slice(0, 300) }));
