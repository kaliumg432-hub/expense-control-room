// Public demo wrapper for the Expense Control Room.
//
// The app (happynet-expense-control.jsx) was written to run inside Claude, which provides
// window.storage and an authenticated Claude API. To run it as a plain web page this wrapper:
//   1. provides window.storage backed by the browser's localStorage,
//   2. adds the visitor's own API key to question-panel requests (kept in memory only),
//   3. loads synthetic Tende payment exports and M-Pesa revenue statements, shifted so the
//      newest month is always the current month to date.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Papa from "papaparse";
import App, { K, rowMonth, parseUtilityStatement } from "./happynet-expense-control.jsx";
import t07 from "./demo_tende_payments_2026-07.csv";
import t08 from "./demo_tende_payments_2026-08.csv";
import t09 from "./demo_tende_payments_2026-09.csv";
import t10 from "./demo_tende_payments_2026-10.csv";
import u07 from "./demo_utility_statement_2026-07.csv";
import u08 from "./demo_utility_statement_2026-08.csv";
import u09 from "./demo_utility_statement_2026-09.csv";
import u10 from "./demo_utility_statement_2026-10.csv";

// ---- 1. storage --------------------------------------------------------------------------
const NS = "expense-demo:";
window.storage = {
  async get(key) { const v = localStorage.getItem(NS + key); return v === null ? null : { key, value: v }; },
  async set(key, value) { localStorage.setItem(NS + key, value); return { key, value }; },
  async delete(key) { localStorage.removeItem(NS + key); return { key, deleted: true }; },
  async list(prefix = "") { return { keys: Object.keys(localStorage).filter((k) => k.startsWith(NS + prefix)).map((k) => k.slice(NS.length)) }; },
};
const clearDemoStorage = () => Object.keys(localStorage).filter((k) => k.startsWith(NS)).forEach((k) => localStorage.removeItem(k));

// ---- 2. question panel requests ----------------------------------------------------------------
let apiKey = "";
const realFetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (String(url).startsWith("https://api.anthropic.com/")) {
    if (!apiKey) return Promise.reject(new Error('this public demo needs your own Anthropic API key. Click "AI question key" in the bar at the top.'));
    opts = { ...opts, headers: { ...(opts.headers || {}), "x-api-key": apiKey, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } };
  }
  return realFetch(url, opts);
};

// ---- 3. sample data, shifted to the current month -------------------------------------------------
const SAMPLE_LAST = { y: 2026, m: 10 };
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const pad = (n) => String(n).padStart(2, "0");
function shiftYM(y, m, offset) {
  const t = y * 12 + (m - 1) + offset;
  const ny = Math.floor(t / 12), nm = (t % 12) + 1;
  return { y: ny, m: nm, dim: new Date(ny, nm, 0).getDate() };
}

// Tende exports use YYYY-MM-DD dates; remarks like "september salary" name the month too.
function shiftTende(text, offset, cutoffDay, isLast) {
  const rows = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() }).data;
  const out = [];
  for (const r of rows) {
    const m = String(r["DATE INITIATED"]).match(/^(\d{4})-(\d{2})-(\d{2})(.*)$/);
    if (!m) continue;
    const s = shiftYM(+m[1], +m[2], offset);
    const day = Math.min(+m[3], s.dim);
    if (isLast && day > cutoffDay) continue;
    r["DATE INITIATED"] = `${s.y}-${pad(s.m)}-${pad(day)}${m[4]}`;
    r["REMARK"] = String(r["REMARK"] || "").replace(new RegExp(`\\b(${MONTH_NAMES.join("|")})\\b`, "gi"), (w) => {
      const i = MONTH_NAMES.indexOf(w.toLowerCase());
      return MONTH_NAMES[(((i + offset) % 12) + 12) % 12];
    });
    out.push(r);
  }
  return out;
}

// Utility statements use DD-MM-YYYY dates.
function shiftStatement(text, offset, cutoffDay, isLast) {
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    let drop = false;
    const isPeriod = line.startsWith("Time Period");
    let n = 0;
    const shifted = line.replace(/(\d{2})-(\d{2})-(\d{4})/g, (_, d, mo, y) => {
      const s = shiftYM(+y, +mo, offset);
      let day = Math.min(+d, s.dim);
      if (isPeriod && n++ === 1) day = isLast ? Math.min(cutoffDay, s.dim) : s.dim; // the "To" date
      else if (isLast && !isPeriod && day > cutoffDay) drop = true;
      return `${pad(day)}-${pad(s.m)}-${s.y}`;
    });
    if (!drop) lines.push(shifted);
  }
  return lines.join("\n");
}

async function loadDemoData() {
  const now = new Date();
  const offset = (now.getFullYear() * 12 + now.getMonth()) - (SAMPLE_LAST.y * 12 + (SAMPLE_LAST.m - 1));
  const today = now.getDate();
  const tende = [t07, t08, t09, t10], util = [u07, u08, u09, u10];

  // payments: stored per month, exactly as the app's own import stores them
  const raw = tende.flatMap((t, i) => shiftTende(t, offset, today, i === tende.length - 1));
  const months = [...new Set(raw.map(rowMonth))].sort();
  for (const mk of months) await window.storage.set(K.raw(mk), JSON.stringify(raw.filter((r) => rowMonth(r) === mk)));
  await window.storage.set(K.index, JSON.stringify(months));

  // revenue: daily totals from the utility statements
  const days = {}, statements = [];
  util.forEach((u, i) => {
    const st = parseUtilityStatement(shiftStatement(u, offset, today, i === util.length - 1), `demo_utility_statement_${i + 1}.csv`);
    Object.assign(days, st.days);
    statements.push({ ...st.meta, computedIn: st.computedIn, computedOut: st.computedOut, reconciles: st.reconciles, rows: st.rows, importedAt: now.toLocaleString("en-KE") });
  });
  await window.storage.set(K.revenue, JSON.stringify({ days, statements }));
  await window.storage.set(K.log, JSON.stringify(months.map((mk) => ({ at: now.toLocaleString("en-KE"), file: `demo_tende_payments_${mk}.csv`, rows: raw.filter((r) => rowMonth(r) === mk).length, added: raw.filter((r) => rowMonth(r) === mk).length, dups: 0, rejected: 0 }))));
}

// ---- demo bar -----------------------------------------------------------------------------
const bar = {
  wrap: { background: "#16232E", color: "#F3F1EC", font: '13px "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif', padding: "8px 16px", display: "flex", flexWrap: "wrap", gap: "8px 14px", alignItems: "center", borderBottom: "3px solid #2F6E63" },
  tag: { background: "#2F6E63", color: "#fff", borderRadius: 4, padding: "2px 8px", fontWeight: 600, fontSize: 12 },
  btn: { background: "transparent", color: "#F3F1EC", border: "1px solid rgba(243,241,236,.45)", borderRadius: 5, padding: "4px 10px", cursor: "pointer", font: "inherit" },
  link: { color: "#9FD3C4" },
  input: { font: "inherit", padding: "4px 8px", borderRadius: 5, border: "1px solid #4B5A6A", width: 240, maxWidth: "100%" },
};

function DemoShell() {
  const [appKey, setAppKey] = useState(0);
  const [ready, setReady] = useState(!!localStorage.getItem(NS + K.index));
  const [status, setStatus] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [hasKey, setHasKey] = useState(false);

  async function reload(msg) {
    setStatus("Loading demo data…");
    clearDemoStorage();
    await loadDemoData();
    setReady(true);
    setAppKey((k) => k + 1);
    setStatus(msg);
  }
  useEffect(() => { if (!ready) reload("Demo data loaded."); }, []);

  return (
    <>
      <div style={bar.wrap} role="region" aria-label="Demo controls">
        <span style={bar.tag}>Live demo</span>
        <span>Every payee, staff member and amount here is <strong>synthetic</strong>. Nothing leaves your browser.</span>
        <button style={bar.btn} onClick={() => reload("Demo data reset.")}>Reset demo data</button>
        <button style={bar.btn} onClick={() => setShowKey((s) => !s)}>{hasKey ? "AI key added ✓" : "AI question key"}</button>
        <a style={bar.link} href="https://github.com/kaliumg432-hub/expense-control-room">Source on GitHub</a>
        <span aria-live="polite" style={{ opacity: 0.75 }}>{status}</span>
        {showKey && (
          <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", width: "100%" }}>
            <span style={{ opacity: 0.85 }}>The question panel calls the Claude API. Paste your own Anthropic API key to try it; it stays in this tab's memory and is never saved.</span>
            <input style={bar.input} type="password" placeholder="sk-ant-…" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} aria-label="Anthropic API key" />
            <button style={bar.btn} onClick={() => { apiKey = keyDraft.trim(); setHasKey(!!apiKey); setShowKey(false); setKeyDraft(""); }}>Use key</button>
          </span>
        )}
      </div>
      {ready ? <App key={appKey} /> : <div style={{ padding: 40, font: "14px system-ui" }}>Loading demo data…</div>}
    </>
  );
}

createRoot(document.getElementById("root")).render(<DemoShell />);
