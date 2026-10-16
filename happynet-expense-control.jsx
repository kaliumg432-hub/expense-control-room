/* Happynet Expense Control Room
   Import Tende payment CSVs → classified expense register, dashboard, trend analysis,
   recurring/unusual detection, budget vs actual, pending obligations, daily/weekly
   reports and a plain-language question panel.
   Raw Tende rows are stored untouched; classifications and reviews are stored separately. */
import React, { useState, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from "recharts";
/* ======================================================================
   ENGINE — pure functions. Raw Tende rows are never modified; every
   analytical field lives on a separate record object.
   ====================================================================== */

// ---------- CONFIGURATION (edit freely) ----------
const CATEGORY_ORDER = [
  "Staff & Payroll", "Inventory & Equipment", "Connectivity", "Fuel & Transport",
  "Premises", "Administration", "Other Operating", "Unclassified",
];

const WALLETS = [
  { re: /overall/i, short: "Overall", expects: null },
  { re: /payroll/i, short: "Payroll", expects: ["Staff & Payroll"] },
  { re: /inventory/i, short: "Inventory", expects: ["Inventory & Equipment"] },
  { re: /internet link|rent/i, short: "Link & Rent", expects: ["Connectivity", "Premises", "Fuel & Transport"] },
  { re: /variable float/i, short: "Variable Float", expects: null },
  { re: /hotspot rollout/i, short: "Hotspot Rollout", expects: ["Inventory & Equipment"] },
];

const EXPENSE_SERVICES = ["SEND M-PESA", "BUYGOODS", "PAY BILL", "POCHI", "SEND BANK", "AIRTIME"];
const INTERNAL_SERVICES = ["SND_TENDE"];
const INFLOW_SERVICES = ["INCOMING"];
const INTERNAL_NAME_RE = /HAPPYNET TECHNOLOGIES LIMITED LIABILITY/i;

// Spelling clean-up applied to remarks before rules run (originals are kept)
const NORMALIZE = [
  [/(\d)([a-z])/g, "$1 $2"],
  [/buddles?/g, "bundles"],
  [/\bbundle\b/g, "bundles"],
  [/\bp\.?\s?cord(e|es|s)?\b|\bpcords?\b|parch\s?cord(e|es|s)?|purch\s?cord(e|es|s)?|patch\s?cord(e|es|s)?/g, "patch cord"],
  // splitter is often misspelt: spritter, sprinter, splinter, spliter, splitta…
  [/\b(?:sp[lr]{0,2}it{1,2}(?:er|a|ar|re)s?|sp[lr]{1,2}int{1,2}ers?)\b/g, "splitter"],
  [/slives/g, "sleeves"],
  [/tender router/g, "tenda router"],
  [/waveteck|wave tech/g, "wavetech"],
  [/dublicat/g, "duplicat"],
  [/mururui/g, "marurui"],
  [/ffuel/g, "fuel"],
  [/cables ties?/g, "cable ties"],
  [/rooter/g, "router"],
  [/\bpatch ?ods?\b|\bpatch ?codes?\b|\bpach ?cords?\b|\bpurchase cords?\b/g, "patch cord"],
  [/\bcat ?(5e?|6a?)\b/g, "cat$1"],
  [/\(\s*(\d+)\s*\)/g, (m, n) => (+n >= 50 ? ` ${n} ` : ` ${n} units `)],
  [/[()]/g, " "],
  [/\b(fats?|splitters?) 1 (2|4|8|16|32|64)\b/g, "$1 1:$2"],
  [/grand ?stream/g, "grandstream"],
  [/grandstream,? (routers?)/g, "grandstream $1"],
  [/\b1 ?(?:by|x|\/|:|-) ?(2|4|8|16|32|64)\b/g, "1:$1"],
  [/\s+/g, " "],
];

// Level 1 → Level 2. Ordered: first match wins. weak = keyword alone is not strong evidence.
// Add subcategories freely; the screens pick them up automatically.
const MONTH_RE_SRC = "january|february|march|april|may|june|july|august|september|october|november|december";
const RULES = [
  { cat: "Fuel & Transport", sub: "Generator fuel", re: /generator\s*fuel|fuel.{0,10}generator/ },
  { cat: "Fuel & Transport", sub: "Vehicle fuel", re: /\b(car|kbs|vehicle)\b.{0,12}fuel|fuel.{0,8}\b(kbs|car|vehicle)\b|\bkbs \d{3,}/ },
  { cat: "Fuel & Transport", sub: "Bike fuel", re: /\b(bikes?|technicians?|riders?)\b.{0,25}fuel|technicians? bikes? \d{3,}/ },
  { cat: "Fuel & Transport", sub: "Bike rent", re: /\bbikes?\b.{0,15}\b(rent|payments?)\b/ },
  { cat: "Fuel & Transport", sub: "Vehicle expense", re: /\bparking\b|car service|radiator|car wash|tyres?|puncture|mechanic/ },
  { cat: "Fuel & Transport", sub: "Delivery fees", re: /deliver(y|ies)/ },
  { cat: "Connectivity", sub: "Internet link", re: /link carrier|internet link|bandwidth|\blink (january|february|march|april|may|june|july|august|september|october|november|december)\b|\b(january|february|march|april|may|june|july|august|september|october|november|december) link\b/ },
  { cat: "Connectivity", sub: "Hotspot tokens", re: /hotspot tokens?|tokens?.{0,15}hotspot/ },
  { cat: "Premises", sub: "Electricity", re: /server room token|electricity|kplc|power token|\btokens?\b/ },
  { cat: "Connectivity", sub: "Advanta bundles", re: /advanta/ },
  { cat: "Connectivity", sub: "Data bundles", re: /family connect/ },
  { cat: "Connectivity", sub: "Data bundles", re: /bundles|customer service data|\bdata\b/ },
  { cat: "Connectivity", sub: "ISP system (OneISP)", re: /oneisp|one isp/ },
  { cat: "Staff & Payroll", sub: "Commission", re: /caretaker|commi?s+ion/ },
  { cat: "Premises", sub: "Rent", re: /\brent\b/ },
  { cat: "Staff & Payroll", sub: "Salary advance", re: /\badvance\b/ },
  { cat: "Staff & Payroll", sub: "Salary", re: new RegExp(`payroll|salar(y|ies)|wages|month payment|\\b(${MONTH_RE_SRC}) pay(ment)?\\b|\\bnet pay\\b`) },
  { cat: "Staff & Payroll", sub: "Bonus", re: /\bbonus/ },
  { cat: "Staff & Payroll", sub: "Allowance", re: /allowance/ },
  { cat: "Staff & Payroll", sub: "Other staff payment", re: /retention payment/, weak: true },
  { cat: "Staff & Payroll", sub: "Casual labour", re: /\blabou?r\b|casual/, weak: true },
  { cat: "Staff & Payroll", sub: "Staff welfare", re: /lunch|\btea\b|snacks?|meals?/ },
  { cat: "Fuel & Transport", sub: "Transport", re: /transport|\buber\b|\btaxi\b|\bbike (ride|to|from)\b|\bfare\b|matatu/ },
  { cat: "Administration", sub: "Printing & stationery", re: /print|scann|photocop|copies|envelope|stationery/ },
  { cat: "Administration", sub: "Office supplies", re: /toilet paper|tissue|\bmop\b|\bomo\b|detergent|cleaning|office/ },
  { cat: "Administration", sub: "Office expenses", re: /key duplicat|\bkeys?\b/ },
  { cat: "Administration", sub: "Office furniture", re: /\bdesk\b|chairs?|furniture/ },
  { cat: "Inventory & Equipment", sub: "Tools", re: /splicing machine|cleaver|stripper|climbers?|cutter|\baxe\b|\bsaw\b|blade|crimp|\btools?\b|ladder|harness/ },
  { cat: "Inventory & Equipment", sub: "Routers", re: /xpon|router|tenda|\bonu\b|\bont\b/ },
  { cat: "Inventory & Equipment", sub: "Electrical materials", re: /\bpoe\b|socket|patrix|\bavs\b/ },
  { cat: "Inventory & Equipment", sub: "Connectors & fibre accessories", re: /patch cord|\batbs?\b|\bfat\b|splitter|sleeves?/ },
  { cat: "Inventory & Equipment", sub: "Installation materials", re: /cable ties?|cable clips?|tensions?|strap|trunking|truc?king|saddle|pipes?|coupler|copler|\bbends?\b|screws?|\btape\b|stickers?/ },
  { cat: "Inventory & Equipment", sub: "Cable", re: /drop cable|\bdrop\b|\badss\b|\bcables?\b|fib(re|er)/ },
  { cat: "Inventory & Equipment", sub: "Other equipment", re: /\binventory\b|\belectronics\b|\bhardware\b/ },
  { cat: "Other Operating", sub: "Advertising", re: /advert|marketing|posters?|flyers?/ },
  { cat: "Other Operating", sub: "Site works & installation", re: /welding|installation|mapping|activations?/, weak: true },
  { cat: "Other Operating", sub: "Donations & CSR", re: /charity|donation|children'?s home/ },
  { cat: "Fuel & Transport", sub: "Fuel (unspecified)", re: /\bfuel\b/, weak: true },
  // added after checking October remarks that nothing above recognised
  { cat: "Inventory & Equipment", sub: "Tools", re: /hammer|knife|knives|stripping|tester|screw ?driver|pliers|\bdrill\b/ },
  { cat: "Inventory & Equipment", sub: "Installation materials", re: /\bclips?\b|\bflex\b|conduit|draw wire|padlock/ },
  { cat: "Administration", sub: "Office equipment", re: /\bmouse\b|keyboard|laptop|desktop|monitor|windows repair/ },
  { cat: "Administration", sub: "Software & subscriptions", re: /\bclaude\b|chatgpt|\bai payment|app hosting|subscription|licen[cs]e/ },
  { cat: "Administration", sub: "Meetings & refreshments", re: /meeting/ },
  // added after the 1–10 Oct export
  { cat: "Fuel & Transport", sub: "Vehicle expense", re: /carwash|\bbikes? (strip|repairs?|service|spares?|puncture)\b/ },
  { cat: "Fuel & Transport", sub: "Transport", re: /^bikes?$/ },
  { cat: "Administration", sub: "Call centre", re: /call ?cent(er|re)/ },
  { cat: "Inventory & Equipment", sub: "Tools", re: /c[lr]imp(ing)? tools?/ },
  { cat: "Inventory & Equipment", sub: "Installation materials", re: /\bnails?\b/ },
  { cat: "Inventory & Equipment", sub: "Other equipment", re: /grandstream/ },
  { cat: "Inventory & Equipment", sub: "Cable", re: /\bcat6\b|\bsc?oo?p\b|\bspool\b/ },
  { cat: "Inventory & Equipment", sub: "Connectors & fibre accessories", re: /\brj ?45s?\b|\brjs?\b/ },
];

// Used only when the remark gives no answer
const RECEIVER_RULES = [
  { re: /\b(TOTAL|RUBIS|SHELL|ASTROL|PETROL|SERVI?SE? STATION|OILIBYA|VIVO|HASS)\b/i, cat: "Fuel & Transport", sub: "Fuel (unspecified)" },
  { re: /ADVANTA/i, cat: "Connectivity", sub: "Advanta bundles" },
  { re: /SAFARICOM/i, cat: "Connectivity", sub: "Data bundles" },
];

// Level 3 for inventory: named items read from the remark. Specific phrases first.
const ITEMS = [
  { base: "ATB stickers", sub: "Installation materials", re: /atb stickers?/g },
  { base: "Splicing machine", sub: "Tools", re: /splicing machine/g },
  { base: "Fibre cleaver", sub: "Tools", re: /cleaver/g },
  { base: "Fibre stripper", sub: "Tools", re: /stripper/g },
  { base: "ADSS cable", sub: "Cable", re: /\badss\b( \d+ core)?( drums?)?/g },
  { base: "Drop cable", sub: "Cable", re: /drop cables?|\bdrop\b/g },
  { base: "Cable clips", sub: "Installation materials", re: /cable clips?|\bclips?\b/g },
  { base: "Cable ties", sub: "Installation materials", re: /cable ties?|\bties\b/g },
  { base: "Router", variant: "XPON", sub: "Routers", re: /\be?xpon( routers?)?/g },
  { base: "Router", variant: "Tenda", sub: "Routers", re: /tenda( routers?)?/g },
  { base: "Router", variant: "Grandstream", sub: "Routers", re: /grandstream( routers?)?/g },
  { base: "Router", variant: "type not stated", sub: "Routers", re: /\brouters?\b/g },
  { base: "ONU", sub: "Routers", re: /\bonus?\b/g },
  { base: "ONT", sub: "Routers", re: /\bonts?\b/g },
  { base: "POE adapter", sub: "Electrical materials", re: /\bpoe\b/g },
  { base: "Patrix box", sub: "Electrical materials", re: /patrix( box(es)?)?|patress(es)?/g },
  { base: "Socket", sub: "Electrical materials", re: /(twin )?sockets?/g },
  { base: "AVS", sub: "Electrical materials", re: /\bavs\b/g },
  { base: "Patch cord", spec: "patch", sub: "Connectors & fibre accessories", re: /patch ?cords?|parch ?cord(?:es)?s?/g },
  { base: "ATB", sub: "Connectors & fibre accessories", re: /\batbs?\b/g },
  { base: "FAT box", spec: "ratio", sub: "Connectors & fibre accessories", re: /\bfats?( box(es)?)?\b/g },
  { base: "Splitter", spec: "ratio", sub: "Connectors & fibre accessories", re: /splitters?|spliters?|sprinters?/g },
  { base: "RJ45 connectors", sub: "Connectors & fibre accessories", re: /\brj ?45s?\b|\brjs?\b/g },
  { base: "Flex", sub: "Installation materials", re: /\bflex\b/g },
  { base: "Crimping tool", sub: "Tools", re: /c[lr]imp(?:ing)? tools?/g },
  { base: "Sleeves", sub: "Connectors & fibre accessories", re: /sleeves?/g },
  { base: "Cat 6 cable", sub: "Cable", re: /(?<!\brjs? (?:45 )?)(?:sc?oo?p |spool )?\bcat6\b(?! ?rjs?)( cables?)?/g },
  { base: "Cable", variant: "type not stated", sub: "Cable", re: /\bcables?\b/g },
  { base: "Tension clamp", sub: "Installation materials", re: /tensions?/g },
  { base: "Harness strap", sub: "Installation materials", re: /harness( strap)?/g },
  { base: "Trunking", sub: "Installation materials", re: /truc?king|trunking/g },
  { base: "Saddle", sub: "Installation materials", re: /saddles?/g },
  { base: "Pipe", sub: "Installation materials", re: /\bpipes?\b/g },
  { base: "Coupler", sub: "Installation materials", re: /coupl?ers?|coplers?/g },
  { base: "Bends", sub: "Installation materials", re: /\bbends?\b/g },
  { base: "Screws", sub: "Installation materials", re: /screws?/g },
  { base: "Tape", sub: "Installation materials", re: /(masking )?\btape\b/g },
  { base: "Padlock", sub: "Installation materials", re: /padlocks?/g },
  { base: "Climbers", sub: "Tools", re: /climbers?/g },
  { base: "Cutter", sub: "Tools", re: /cutters?/g },
  { base: "Axe / saw", sub: "Tools", re: /\baxe( saw)?\b|\bsaw\b/g },
  { base: "Blade", sub: "Tools", re: /blades?/g },
  { base: "Tester", sub: "Tools", re: /\btesters?\b/g },
  { base: "Hammer", sub: "Tools", re: /hammers?/g },
  { base: "Knife", sub: "Tools", re: /\bknife|\bknives/g },
];
// Common item names offered when you type an itemised breakdown (any other name is allowed too)
const ITEM_SUGGESTIONS = ["Router — Tenda", "Router — XPON", "Router — Grandstream", "ONU", "ONT", "FAT box — 1:8", "FAT box — 1:16", "Splitter — 1:4", "Splitter — 1:8", "Splitter — 1:16", "Patch cord — SC-SC", "Patch cord — LC-LC", "Patch cord — SC-LC", "Patch cord — SC/APC-SC/APC", "ATB", "Drop cable", "Sleeves", "Cable clips", "Cable ties", "Tension clamp", "POE adapter", "Trunking", "Saddle", "Pipe", "Coupler", "Screws", "Tape", "Padlock", "Climbers", "Tester", "Splicing machine"];
const LEGACY_ITEM = { "XPON router": "Router — XPON", "Tenda router": "Router — Tenda", "Router (type not stated)": "Router — type not stated", "Cable (type not stated)": "Cable — type not stated" };
const itemBaseSub = (name) => { const base = String(name).split(" — ")[0]; const it = ITEMS.find((x) => x.base.toLowerCase() === base.toLowerCase()); return { base: it ? it.base : base, sub: it ? it.sub : "Other equipment" }; };

const UNIT_WORDS = { units: "pcs", unit: "pcs", drums: "drums", drum: "drums", pcs: "pcs", pc: "pcs", piece: "pcs", pieces: "pcs", pkt: "packets", pkts: "packets", packet: "packets", packets: "packets", roll: "rolls", rolls: "rolls", km: "km", m: "m", meter: "m", meters: "m", metre: "m", metres: "m" };
const UNIT_RE = "pcs|pc|pieces|piece|pkts|pkt|packets|packet|rolls|roll|drums|drum|units|unit|km|metres|metre|meters|meter|m";

// PRICE LIST — what things cost at our suppliers. "now" is the current price; "also" are other prices seen before.
// Used to split one bulk payment across the items in its remark (the first price that makes the total add up wins)
// and shown on the Inventory page. Update here when a new quotation or receipt comes in.
const PRICE_LIST = [
  { name: "Router — XPON", unit: "pc", now: 1300, also: [1200, 1250], date: "2026-10-12", source: "Supplier A quotation" },
  { name: "Router — Tenda", unit: "pc", now: 900, also: [1000], date: "2026-10-07", source: "Supplier B", note: "1,000 on 6 Oct" },
  { name: "FAT box — 1:16", unit: "pc", now: 1400, also: [2200], date: "2026-10-12", source: "Supplier A quotation", note: "Empty. Campaign price 2,200 was probably with the splitter" },
  { name: "FAT box — 1:8", unit: "pc", now: 800, also: [], date: "2026-09-29", source: "Hotspot campaign", note: "Empty" },
  { name: "FAT box", unit: "pc", now: 1400, also: [1500, 1300], date: "2026-10-12", source: "Supplier A quotation", note: "Ratio not stated", hidden: true },
  { name: "Splitter — 1:8", unit: "pc", now: 300, also: [150], date: "2026-10-07", source: "Supplier C" },
  { name: "Splitter", unit: "pc", now: 300, also: [150], date: "2026-10-07", source: "Supplier C", hidden: true },
  { name: "Patch cord", unit: "pc", now: 120, also: [50], date: "2026-10-12", source: "Supplier A quotation", note: "SC/UPC 2 m" },
  { name: "ATB", unit: "pc", now: 50, also: [], date: "2026-10-12", source: "Supplier A quotation", note: "Empty" },
  { name: "Cable ties", unit: "pc", now: 180, also: [], date: "2026-10-12", source: "Supplier A quotation", note: "Quoted as 2 pcs @180. Campaign price was 200 per packet, a different unit" },
  { name: "Cat 6 cable", unit: "roll", now: 3600, also: [], date: "2026-10-12", source: "Supplier A quotation", note: "Scoop (spool)" },
  { name: "RJ45 connectors — Cat 6", unit: "pkt", now: 3000, also: [], date: "2026-10-12", source: "Supplier A quotation", note: "Cat 5 packet was 1,000 in the campaign" },
  { name: "RJ45 connectors", unit: "pc", now: 10, also: [], date: "2026-10-07", source: "Supplier C", note: "Loose" },
  { name: "Tension clamp", unit: "pc", now: 250, also: [200], date: "2026-10-02", source: "Supplier C" },
  { name: "Sleeves", unit: "pc", now: 4, also: [], date: "2026-09-28", source: "Hotspot campaign" },
];
const PRICE_BOOK = Object.fromEntries(PRICE_LIST.map((p) => [p.name, [p.now, ...p.also.filter((x) => x !== p.now)]]));
const bookKey = (name) => PRICE_BOOK[name] ? name : PRICE_BOOK[String(name).split(" — ")[0]] ? String(name).split(" — ")[0] : null;

// Staff payment types (Level 2 → payroll column)
const PAY_TYPE = { "Salary": "Salary", "Salary advance": "Salary advance", "Commission": "Commission", "Allowance": "Allowance", "Bonus": "Bonus" };
const PAY_TYPES = ["Salary", "Salary advance", "Commission", "Allowance", "Bonus", "Other staff payment"];
const BUSINESS_NAME_RE = /\b(BANK|LTD|LIMITED|PAYBILL|PLC|SACCO|SOLUTIONS|ENTERPRISES?|CO|STATION|SHELL|TOTAL|RUBIS|FOODS?|STORES?|SUPERMARKET|SHOP|HARDWARE|MART|ELECTRICAL|SERVICES)\b/i;

// ---------- DATE HELPERS (string-based, timezone-safe) ----------
const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromKey = (k) => new Date(Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)));
const addDays = (k, n) => { const d = fromKey(k); d.setUTCDate(d.getUTCDate() + n); return toKey(d); };
const dayDiff = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000);
const weekStart = (k) => { const d = fromKey(k); const wd = (d.getUTCDay() + 6) % 7; return addDays(k, -wd); };
const monthKey = (k) => k.slice(0, 7);
const monthEnd = (mk) => { const d = new Date(Date.UTC(+mk.slice(0, 4), +mk.slice(5, 7), 0)); return toKey(d); };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (k) => `${+k.slice(8, 10)} ${MONTHS[+k.slice(5, 7) - 1]} ${k.slice(0, 4)}`;
const fmtMonth = (mk) => `${MONTHS[+mk.slice(5, 7) - 1]} ${mk.slice(0, 4)}`;
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// ---------- SMALL UTILITIES ----------
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "").trim()); return Number.isFinite(n) ? n : null; };
const unq = (s) => String(s ?? "").replace(/^=?"?/, "").replace(/"$/, "").trim();
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sum = (a, f = (x) => x) => a.reduce((t, x) => t + (f(x) || 0), 0);
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function walletInfo(account) {
  const code = (account.match(/\((KOC\d+)\)/) || [])[1] || account;
  const w = WALLETS.find((x) => x.re.test(account));
  return { code, short: w ? w.short : account.split("(")[0].trim(), expects: w ? w.expects : null };
}

function normalizeRemark(s) {
  let n = String(s || "").toLowerCase().replace(/\\n|\n/g, " ");
  for (const [re, rep] of NORMALIZE) n = n.replace(re, rep);
  return n.trim();
}

function rowId(raw) {
  const ref = String(raw["REF"] || "").trim();
  if (ref) return ref;
  const basis = [raw["DATE INITIATED"], raw["AMOUNT"], raw["RECEIVER"], raw["SERVICE"], raw["ACCOUNT"]].join("|");
  let h = 0; for (let i = 0; i < basis.length; i++) h = (h * 31 + basis.charCodeAt(i)) | 0;
  return "H" + (h >>> 0).toString(36);
}

const REQUIRED_COLUMNS = ["DATE INITIATED", "REF", "ACCOUNT", "SERVICE", "AMOUNT", "STATUS"];

// ---------- RECORD BUILD ----------
function buildRecord(raw) {
  const date = String(raw["DATE INITIATED"] || "").trim();
  const day = /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null;
  const account = String(raw["ACCOUNT"] || "").trim();
  const w = walletInfo(account);
  const service = String(raw["SERVICE"] || "").trim().toUpperCase();
  const statusRaw = String(raw["STATUS"] || "").trim();
  const st = statusRaw.toUpperCase();
  const statusNorm = st === "SUCCESS" || st === "SUCCESSFUL" || st === "COMPLETED" ? "SUCCESS"
    : /REVERS/.test(st) ? "REVERSED"
    : /FAIL|DECLIN|ERROR|CANCEL|REJECT/.test(st) ? "FAILED"
    : /PEND|PROCESS|QUEUE|AWAIT|INITIAT/.test(st) ? "PENDING" : "UNKNOWN";
  const receiverId = unq(raw["RECEIVER"]);
  const name = String(raw["NAME"] || "").replace(/\s+/g, " ").trim();
  const remark = String(raw["REMARK"] || "").replace(/\\n|\n/g, " ").replace(/\s+/g, " ").trim();
  const initiator = String(raw["INITIATED BY"] || "").replace(/\s+/g, " ").trim();
  const approver = String(raw["APPROVED BY"] || "").replace(/\s+/g, " ").trim();
  return {
    id: rowId(raw), raw, date, day, ts: day ? date.replace(" ", "T") : "",
    account, wallet: w.short, walletCode: w.code, walletExpects: w.expects,
    service, amount: num(raw["AMOUNT"]), charge: num(raw["CHARGE"]) || 0,
    receiverId, payee: name || receiverId || "(no recipient)", payeeKey: (receiverId || name).toUpperCase(),
    remark, norm: normalizeRemark(remark), txnRef: String(raw["REF NO"] || "").trim(),
    statusRaw, statusNorm, initiator, approver,
    cls: "UNVERIFIED", clsReason: "", category: null, subcategory: null,
    confidence: null, basis: "", flags: [], recurring: false, isRefund: false,
  };
}

// ---------- TRANSACTION CLASS (expense / internal / funding / failed / pending / unverified) ----------
function assignClasses(recs) {
  const sends = recs.filter((r) => INTERNAL_SERVICES.includes(r.service) && r.statusNorm === "SUCCESS");
  const used = new Set();
  const destCode = (r) => (r.receiverId.match(/\((KOC\d+)\)/) || [])[1] || r.receiverId;
  const knownCodes = new Set(recs.map((r) => r.walletCode));
  const tsMs = (r) => Date.parse(r.ts + "Z") || 0;

  for (const r of recs) {
    if (!r.day) { r.cls = "UNVERIFIED"; r.clsReason = "Missing or unreadable date"; continue; }
    if (r.amount === null) { r.cls = "UNVERIFIED"; r.clsReason = "Missing or unreadable amount"; continue; }
    if (r.statusNorm === "FAILED") { r.cls = "FAILED"; r.clsReason = `Status: ${r.statusRaw}`; continue; }
    if (r.statusNorm === "REVERSED") { r.cls = "REVERSED"; r.clsReason = `Status: ${r.statusRaw}`; continue; }
    if (r.statusNorm === "PENDING") { r.cls = "PENDING"; r.clsReason = `Status: ${r.statusRaw}`; continue; }
    if (r.statusNorm === "UNKNOWN") { r.cls = "UNVERIFIED"; r.clsReason = `Unrecognised status "${r.statusRaw}"`; continue; }

    if (INTERNAL_SERVICES.includes(r.service)) {
      const d = destCode(r);
      if (knownCodes.has(d) || /KOC\d+/.test(r.receiverId)) { r.cls = "INTERNAL"; r.clsReason = "Sent to another Happynet Tende wallet"; }
      else { r.cls = "UNVERIFIED"; r.clsReason = "Tende transfer to an unrecognised wallet"; }
      continue;
    }
    if (INFLOW_SERVICES.includes(r.service)) {
      // try to pair with a wallet-to-wallet send
      let match = sends.find((s) => !used.has(s.id) && s.txnRef && s.txnRef === r.txnRef);
      if (!match) match = sends.find((s) => !used.has(s.id) && destCode(s) === r.walletCode && s.amount === r.amount && Math.abs(tsMs(s) - tsMs(r)) <= 15 * 60000);
      if (match) { used.add(match.id); r.cls = "INTERNAL"; r.clsReason = `Receiving side of wallet transfer ${match.id}`; }
      else if (INTERNAL_NAME_RE.test(r.payee)) { r.cls = "INTERNAL"; r.clsReason = "Incoming from Happynet's own Tende wallet"; }
      else { r.cls = "FUNDING"; r.clsReason = /^OWNER\b/i.test(r.payee) ? "Owner / related-party money in (owner) — a loan in the Profit First owner loan ledger" : "Money into Tende from outside (bank or M-Pesa utility)"; }
      continue;
    }
    if (EXPENSE_SERVICES.includes(r.service)) { r.cls = "EXPENSE"; r.clsReason = `Outgoing ${r.service}`; continue; }
    r.cls = "UNVERIFIED"; r.clsReason = `Unrecognised service "${r.service}"`;
  }
}

// ---------- CATEGORY CLASSIFICATION ----------
function classifyOne(r) {
  const hits = RULES.filter((x) => x.re.test(r.norm));
  const first = hits[0];
  const bigNums = (r.norm.match(/\b\d{3,}\b/g) || []).length;
  const subs = new Set(hits.map((h) => h.sub));
  const mixed = subs.size >= 2 && bigNums >= 2;
  r.isRefund = /refund|reimburs/.test(r.norm);

  if (first) {
    const walletOk = !r.walletExpects || r.walletExpects.includes(first.cat);
    r.category = first.cat; r.subcategory = first.sub;
    if (first.weak) { r.confidence = "Medium"; r.basis = "Remark (general keyword)" + (walletOk ? "" : `; paid from ${r.wallet} wallet`); }
    else if (walletOk) { r.confidence = "High"; r.basis = r.walletExpects ? `Remark + ${r.wallet} wallet agree` : "Remark"; }
    else { r.confidence = "Medium"; r.basis = `Remark; unusual for ${r.wallet} wallet`; }
    if (mixed) r.mixedWith = [...subs].filter((s) => s !== first.sub);
    return;
  }
  if (r.service === "AIRTIME") { r.category = "Connectivity"; r.subcategory = "Airtime"; r.confidence = "Medium"; r.basis = "Service type AIRTIME"; return; }
  const rr = RECEIVER_RULES.find((x) => x.re.test(r.payee));
  if (rr) { r.category = rr.cat; r.subcategory = rr.sub; r.confidence = "Medium"; r.basis = "Recipient type (remark unclear)"; return; }
  // Money leaving the Payroll wallet with a vague remark ("Staff Payments") is treated as salary, flagged Medium so it is easy to confirm
  if (r.wallet === "Payroll") { r.category = "Staff & Payroll"; r.subcategory = "Salary"; r.confidence = "Medium"; r.basis = "Paid from the Payroll wallet; remark does not say why — please confirm"; return; }
  // "topup" paid from the Inventory wallet = extra money on an earlier purchase (e.g. the price turned out higher than the remark said)
  if (r.wallet === "Inventory" && /\btop ?up\b/.test(r.norm)) { r.category = "Inventory & Equipment"; r.subcategory = "Top-up on earlier purchase"; r.confidence = "Medium"; r.basis = "Top-up paid from the Inventory wallet — open it and add it to the purchase it belongs to"; return; }
  r.category = "Unclassified"; r.subcategory = "Review required"; r.confidence = "Unclassified"; r.basis = "No rule matched";
}

function receiverHistoryPass(exp) {
  const byPayee = {};
  for (const r of exp) if (r.confidence === "High") (byPayee[r.payeeKey] ||= []).push(r);
  for (const r of exp) {
    if (r.category !== "Unclassified" || r.manual) continue;
    const hist = byPayee[r.payeeKey]; if (!hist || hist.length < 2) continue;
    const counts = {}; for (const h of hist) { const k = h.category + "|" + h.subcategory; counts[k] = (counts[k] || 0) + 1; }
    const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (n / hist.length >= 0.8 && !/^Staff & Payroll\|(Salary|Salary advance)$/.test(best)) {
      const [c, s] = best.split("|");
      r.category = c; r.subcategory = s; r.confidence = "Low";
      r.basis = `Recipient history only (${n} of ${hist.length} earlier payments) — supporting evidence, please confirm`;
    }
  }
}

// A payment counts as salary only when its remark says so (salary, payroll, wages, "<month> payment", "this month payment")
// or a reviewer set it as salary. Payments to staff for anything else — e.g. money sent to the accountant to pay
// suppliers — are never treated as salary.
const isSalaryPayment = (r) => r.category === "Staff & Payroll" && r.payType === "Salary" && r.confidence !== "Low";

// ---------- DETAIL: items & quantities, staff payments, month relating to ----------
function parseItems(norm) {
  const taken = [];
  const hits = [];
  for (const it of ITEMS) {
    it.re.lastIndex = 0; let m;
    while ((m = it.re.exec(norm))) {
      const s0 = m.index, e0 = m.index + m[0].length;
      if (!m[0] || taken.some(([a, b]) => s0 < b && e0 > a)) continue;
      taken.push([s0, e0]); hits.push({ it, start: s0, end: e0 });
    }
  }
  hits.sort((a, b) => a.start - b.start);
  const out = [];
  let prevConsumed = null;
  hits.forEach((h, i) => {
    const before = norm.slice(i ? hits[i - 1].end : 0, h.start);
    let after = norm.slice(h.end, i < hits.length - 1 ? hits[i + 1].start : norm.length);
    // variant: fixed by the item word (Tenda, XPON…), or read from the remark (ratio, connectors)
    let variant = h.it.variant || null, specFound = !!h.it.variant && !/not stated/.test(h.it.variant);
    if (h.it.spec === "ratio") {
      const m = after.match(/^[^,;]*?\b1[:\/ ](2|4|8|16|32|64)\b/) || before.match(/\b1[:\/ ](2|4|8|16|32|64)\s*$/);
      variant = m ? `1:${m[1]}` : "ratio not stated"; specFound = !!m;
    }
    if (h.it.spec === "patch") {
      const c = after.match(/^[^,;]*?\b(lc|sc|fc|st)(?:[\/ -]?(apc|upc))?\s*(?:-|\/|to|\s)\s*(lc|sc|fc|st)(?:[\/ -]?(apc|upc))?\b/);
      const len = after.match(/^[^,;]*?\b(\d+(?:\.\d+)?)\s*(m|metres?|meters?)\b/);
      const parts = [];
      if (c) parts.push(`${c[1].toUpperCase()}${c[2] ? "/" + c[2].toUpperCase() : ""}-${c[3].toUpperCase()}${c[4] ? "/" + c[4].toUpperCase() : ""}`);
      if (len) { parts.push(`${len[1]}m`); after = after.replace(len[0], " "); }
      variant = parts.length ? parts.join(" ") : "type not stated"; specFound = parts.length > 0;
    }
    // inline hints: "12x1300" = qty x price; a bare number right after the item is a quantity (small) or an amount (50+)
    let hint = null;
    const aft = after.replace(/^\s*1[\/: ]\s*(2|4|8|16|32|64)\b/, "").replace(/^\s*\(?\s*/, "");
    const mx = aft.match(/^(\d+)\s*x\s*(\d+)(?![\d])/);
    if (mx) hint = { qty: +mx[1], unitPrice: +mx[2], consumed: mx[0] };
    else { const mb = aft.match(/^(\d+)(?![\w./:])/); if (mb) hint = +mb[1] >= 50 ? { amount: +mb[1], consumed: mb[0] } : { qty: +mb[1], consumed: mb[0] }; }
    let beforeQ = before;
    if (prevConsumed) beforeQ = before.replace(prevConsumed, " ");
    let qty = null, unit = "pcs";
    const b = beforeQ.match(new RegExp(`(?:^|[^\\w./:])(\\d+)\\s*(?:(${UNIT_RE})\\b)?\\s*(?:of\\s+)?(?:(?!mm\\b|cm\\b|inch|kg\\b)[a-z]+\\s+)?$`));
    if (b) { qty = +b[1]; if (b[2]) unit = UNIT_WORDS[b[2]] || b[2]; if (hint && hint.qty && !hint.unitPrice) hint = null; } // "5 atbs 2 patch cords": the 2 belongs to the next item
    else if (hint && hint.qty && !hint.unitPrice) qty = hint.qty; // "Xpon 4"
    else {
      const a2 = after.match(new RegExp(`^\\s*(?:\\d+\\s+)?(\\d+)(?![\\d./:])\\s*(${UNIT_RE})\\b`));
      if (a2) { qty = +a2[1]; unit = UNIT_WORDS[a2[2]] || a2[2]; }
    }
    if (qty === 0) qty = null;
    const name = variant ? `${h.it.base} — ${variant}` : h.it.base;
    const prev = out[out.length - 1];
    if (prev && prev.name === name && qty === null) return; // "axe saw", repeated words
    out.push({ base: h.it.base, variant, name, sub: h.it.sub, qty, unit, qtySource: qty === null ? "none" : "source", specMissing: !!h.it.spec && !specFound || /not stated/.test(variant || ""), amount: null, hint });
    prevConsumed = hint ? hint.consumed : null;
  });
  return out;
}

function relatesFromRemark(norm, day) {
  const py = +day.slice(0, 4), pm = +day.slice(5, 7) - 1;
  const shift = (k) => toKey(new Date(Date.UTC(py, pm + k, 1))).slice(0, 7);
  if (/\blast month\b|previous month/.test(norm)) return { month: shift(-1), how: 'Remark says "last month"' };
  if (/\bnext month\b/.test(norm)) return { month: shift(1), how: 'Remark says "next month"' };
  if (/\bthis month\b|current month/.test(norm)) return { month: shift(0), how: 'Remark says "this month"' };
  const m = norm.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\b/);
  if (!m) return null;
  const IDX = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const mi = IDX[m[1].slice(0, m[1] === "sept" ? 4 : 3)] ?? IDX[m[1]];
  const yr = norm.match(/\b(20\d\d)\b/);
  let y = yr ? +yr[1] : py;
  if (!yr) { if (mi - pm > 6) y--; else if (pm - mi > 6) y++; }
  return { month: `${y}-${pad(mi + 1)}`, how: `Remark names "${m[1]}"${yr ? " " + yr[1] : ""}` };
}

function deriveDetail(r) {
  // month the payment relates to (any expense)
  const rel = relatesFromRemark(r.norm, r.day);
  r.relatesTo = rel ? rel.month : null; r.relatesHow = rel ? rel.how : "Not specified in source";
  // staff
  r.payType = null; r.employee = null; r.advanceUnspecified = false;
  if (r.category === "Staff & Payroll") {
    r.payType = PAY_TYPE[r.subcategory] || "Other staff payment";
    r.employee = BUSINESS_NAME_RE.test(r.payee) || /^\d+$/.test(r.payee) || r.payee === "(no recipient)" ? null : titleCase(r.payee);
    if (r.payType === "Salary advance") {
      if (!r.relatesTo || r.relatesTo <= monthKey(r.day)) {
        if (r.relatesTo) r.relatesHow = `Remark names ${fmtMonth(r.relatesTo)}, which is not a future month — period of the advance unclear`;
        r.relatesTo = null; r.advanceUnspecified = true;
        if (!rel) r.relatesHow = "Future period not specified";
      }
    }
  }
  // inventory items
  r.items = []; r.unitCost = null; r.purchaseDetail = null;
  if (r.category === "Inventory & Equipment") {
    r.items = parseItems(r.norm);
    const subs = [...new Set(r.items.map((i) => i.sub))];
    if (subs.length === 1 && !r.manual) r.subcategory = subs[0];
    else if (subs.length > 1 && !r.manual) r.subcategory = "Mixed purchase";
    autoPrice(r);
    finishPurchase(r);
  }
}
// Split a multi-item payment using what the remark says and the price book. Only accepted when the numbers add up.
function autoPrice(r) {
  const its = r.items || [];
  r.autoPriced = false;
  if (its.length < 2 || r.manual) return;
  const rows = its.map((i) => {
    const h = i.hint || {};
    let qty = i.qty, amount = null, src = null;
    if (h.qty && h.unitPrice) { qty = qty || h.qty; amount = h.qty * h.unitPrice; src = "remark"; }
    else if (h.amount && !(qty && bookKey(i.name))) { amount = h.amount; src = "remark"; }
    else if (h.qty && !qty) qty = h.qty;
    return { i, qty, amount, src, cands: amount === null && qty && bookKey(i.name) ? PRICE_BOOK[bookKey(i.name)] : null };
  });
  const pending = rows.filter((x) => x.cands), unknown = rows.filter((x) => x.amount === null && !x.cands);
  if (unknown.length > 1 || (!pending.length && !unknown.length && Math.abs(sum(rows, (x) => x.amount) - r.amount) > 1)) return;
  const known = sum(rows, (x) => x.amount || 0);
  const combos = pending.reduce((acc, x) => acc.flatMap((c) => x.cands.map((p) => [...c, p])), [[]]).slice(0, 200);
  for (const c of combos) {
    const tot = known + sum(pending.map((x, k) => x.qty * c[k]), (v) => v);
    const rest = r.amount - tot;
    if (unknown.length === 0 && Math.abs(rest) <= 1) { pending.forEach((x, k) => { x.amount = x.qty * c[k]; x.src = "price book"; }); }
    else if (unknown.length === 1 && rest > 0) { pending.forEach((x, k) => { x.amount = x.qty * c[k]; x.src = "price book"; }); unknown[0].amount = rest; unknown[0].src = "what is left"; }
    else continue;
    rows.forEach((x) => { if (x.qty && !x.i.qty) { x.i.qty = x.qty; x.i.qtySource = "source"; } x.i.amount = x.amount; x.i.amountSrc = x.src; });
    r.autoPriced = true; return;
  }
}
function finishPurchase(r) {
  const its = r.items || [];
  const amts = its.map((i) => i.amount);
  r.itemsCosted = its.length > 1 && amts.every((x) => x !== null && x !== undefined) && Math.abs(sum(amts) - r.amount) <= 1;
  r.costMismatch = its.length > 1 && amts.some((x) => x !== null && x !== undefined) && !r.itemsCosted;
  for (const i of its) {
    i.lineCost = its.length === 1 ? r.amount : r.itemsCosted ? i.amount : null;
    i.unitCost = i.lineCost !== null && i.qty ? i.lineCost / i.qty : null;
  }
  r.unitCost = its.length === 1 ? its[0].unitCost : null;
  r.unitCostSource = its.length === 1
    ? (its[0].unitCost ? (its[0].qtySource === "manual" ? "Calculated from reviewer quantity" : "Calculated (amount ÷ quantity in remark)") : "Not available in source")
    : r.itemsCosted ? "From the line amounts entered by a reviewer" : r.costMismatch ? "Line amounts entered don't add up to the payment" : "Not separable — several items in one payment";
  const missing = [];
  if (!its.length) missing.push("item");
  else {
    if (its.some((i) => !i.qty)) missing.push("quantity");
    if (its.some((i) => i.specMissing)) missing.push("type / size");
  }
  r.detailMissing = missing;
  r.purchaseDetail = missing.length ? (missing[0] === "item" ? "Item not identified" : `Missing ${missing.join(" & ")}`) : its.length === 1 || r.itemsCosted ? "Complete" : "Quantities only";
}

// ---------- RECURRING ----------
function detectRecurring(exp) {
  const groups = {};
  for (const r of exp) {
    if (r.category === "Unclassified") continue;
    (groups[r.category + "|" + r.subcategory] ||= []).push(r);
  }
  const out = {};
  for (const [k, list] of Object.entries(groups)) {
    const s = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
    const days = [...new Set(s.map((r) => r.day))];
    const weeks = new Set(s.map((r) => weekStart(r.day)));
    const months = new Set(s.map((r) => monthKey(r.day)));
    const gaps = []; for (let i = 1; i < days.length; i++) gaps.push(dayDiff(days[i - 1], days[i]));
    const mg = median(gaps);
    let pattern = null;
    const span = s.length ? dayDiff(s[0].day, s[s.length - 1].day) : 0;
    if (s.length >= 4 && weeks.size >= 2 && mg <= 14) pattern = mg <= 2 ? "Several times a week" : mg <= 8 ? "About weekly" : "About fortnightly";
    else if (months.size >= 2) {
      const ms = [...months].sort(); let consecutive = true;
      for (let i = 1; i < ms.length; i++) { const a = fromKey(ms[i - 1] + "-01"), b = fromKey(ms[i] + "-01"); if ((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() !== 1) consecutive = false; }
      if (consecutive) pattern = "Monthly";
    }
    const label = pattern || (s.length === 1 ? "Once" : "Irregular");
    out[k] = { key: k, pattern, label, recurring: !!pattern, count: s.length, weeks: weeks.size, months: months.size, medianGap: mg, span };
    // only routine-sized payments in a repeating pattern count as recurring; one-off big buys do not
    const m = median(s.map((r) => r.amount));
    if (pattern) for (const r of s) if (r.amount <= m * 3 && r.amount >= m / 4) r.recurring = true;
  }
  return out;
}

// Frequency label for any list of payments (items, recipients, employees)
function frequencyOf(list) {
  if (!list.length) return "—";
  const s = [...list].sort((a, b) => a.ts.localeCompare(b.ts));
  if (s.length === 1) return "Once";
  const days = [...new Set(s.map((r) => r.day))];
  const weeks = new Set(s.map((r) => weekStart(r.day)));
  const months = [...new Set(s.map((r) => monthKey(r.day)))].sort();
  const gaps = []; for (let i = 1; i < days.length; i++) gaps.push(dayDiff(days[i - 1], days[i]));
  const mg = median(gaps);
  let consecutive = months.length >= 2;
  for (let i = 1; i < months.length; i++) { const a = fromKey(months[i - 1] + "-01"), b = fromKey(months[i] + "-01"); if ((b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() !== 1) consecutive = false; }
  if (consecutive && s.length / months.length <= 1.5) return "Monthly";
  if (s.length >= 4 && weeks.size >= 2 && mg <= 14) return mg <= 2 ? "Several times a week" : mg <= 8 ? "About weekly" : "About fortnightly";
  if (consecutive) return "Monthly";
  return "Irregular";
}

// ---------- FUEL — one car (KBS) and two motorbikes. Car is given 1,000–2,000, each bike 300–500. ----------
const FUEL_SUBS = ["Vehicle fuel", "Bike fuel", "Fuel (unspecified)"];
const FUEL_LIMITS = { carMin: 1000, carMax: 2000, bikeMin: 300, bikeMax: 500, bikes: 2 };
function fuelParts(r) {
  const t = r.norm || "";
  const car = t.match(/\b(?:kbs|car|vehicle)\b\D{0,8}(\d{3,5})/), bk = t.match(/\bbikes?\b\D{0,10}(\d{3,5})/);
  const parts = [];
  if (car) parts.push({ who: "Car", amount: +car[1], sure: true });
  if (bk) parts.push({ who: "Bikes", amount: +bk[1], sure: true });
  if (parts.length && Math.abs(sum(parts, (p) => p.amount) - r.amount) <= 1) return parts;
  if (/\b(kbs|car)\b/.test(t) && /\bbikes?\b/.test(t)) return [{ who: "Car + bikes", amount: r.amount, sure: true }];
  if (r.subcategory === "Vehicle fuel") return [{ who: "Car", amount: r.amount, sure: true }];
  if (r.subcategory === "Bike fuel") return [{ who: "Bikes", amount: r.amount, sure: true }];
  return [{ who: r.amount >= FUEL_LIMITS.carMin ? "Car" : "Bikes", amount: r.amount, sure: false }];
}
function fuelCheck(p) {
  const L = FUEL_LIMITS;
  if (p.who === "Car") return p.amount > L.carMax ? `Car fuel KSh ${p.amount.toLocaleString()} is above the usual ${L.carMin.toLocaleString()}–${L.carMax.toLocaleString()}` : null;
  if (p.who === "Car + bikes") { const mx = L.carMax + L.bikeMax * L.bikes; return p.amount > mx ? `Car and bike fuel together KSh ${p.amount.toLocaleString()} is above ${mx.toLocaleString()}` : null; }
  const max = L.bikeMax * L.bikes;
  return p.amount > max ? `Bike fuel KSh ${p.amount.toLocaleString()} is above ${L.bikeMax} per bike (${max.toLocaleString()} for both bikes)` : null;
}

// ---------- ANOMALIES (detected, never "confirmed" until a person says so) ----------
function detectAnomalies(exp) {
  const byCat = {}, bySub = {};
  for (const r of exp) {
    (byCat[r.category] ||= []).push(r.amount);
    (bySub[r.category + "|" + r.subcategory] ||= []).push(r.amount);
  }
  const statsOf = (arr) => { const m = median(arr); const mad = median(arr.map((x) => Math.abs(x - m))); return { m, mad, n: arr.length }; };
  const subStats = {}, catStats = {};
  for (const k in bySub) subStats[k] = statsOf(bySub[k]);
  for (const k in byCat) catStats[k] = statsOf(byCat[k]);

  const firstDay = exp.reduce((m, r) => (r.day < m ? r.day : m), "9999");
  const sorted = [...exp].sort((a, b) => a.ts.localeCompare(b.ts));
  const seenPayee = new Map(); // payeeKey -> first day
  const sameDay = {};
  for (const r of sorted) (sameDay[r.payeeKey + "|" + r.day] ||= []).push(r);

  for (const r of sorted) {
    const add = (code, label, detail) => r.flags.push({ code, label, detail });
    // unusual amount
    // own subcategory baseline when it has 5+ payments; category baseline only for one-off items of KSh 5,000+
    let st = subStats[r.category + "|" + r.subcategory], basisLbl = r.subcategory, minAmt = 2000;
    if (!st || st.n < 5) {
      if (st && st.n <= 2) { st = catStats[r.category]; basisLbl = r.category; minAmt = 5000; } else st = null;
    }
    const isFuel = r.category === "Fuel & Transport" && FUEL_SUBS.includes(r.subcategory);
    if (isFuel) { for (const p of fuelParts(r)) { const msg = fuelCheck(p); if (msg) add("FUEL_RANGE", "Fuel above usual", msg); } }
    if (r.category === "Inventory & Equipment") {
      for (const it of r.items || []) { const bk = bookKey(it.name); if (bk && it.unitCost && it.unitCost > Math.max(...PRICE_BOOK[bk]) * 1.25) add("PRICE_ABOVE_BOOK", "Price above usual", `${it.name} at KSh ${Math.round(it.unitCost).toLocaleString()} each; usually up to KSh ${Math.max(...PRICE_BOOK[bk]).toLocaleString()}`); }
    }
    if (st && st.n >= 5 && r.category !== "Unclassified" && !isFuel && r.category !== "Inventory & Equipment") {
      const limit = Math.max(st.m * 3, st.m + 3 * 1.4826 * st.mad);
      if (r.amount >= minAmt && r.amount > limit) add("UNUSUAL_AMOUNT", "Unusual amount", `KSh ${Math.round(r.amount).toLocaleString()} vs typical KSh ${Math.round(st.m).toLocaleString()} for ${basisLbl}`);
    }
    // duplicates / same-day multiples
    const sd = sameDay[r.payeeKey + "|" + r.day];
    if (r.payeeKey && sd.length >= 2 && r.category !== "Inventory & Equipment") {
      const earlierSame = sd.filter((x) => x !== r && x.amount === r.amount && x.ts <= r.ts);
      if (earlierSame.length && sd.indexOf(r) > sd.indexOf(earlierSame[0])) add("POSSIBLE_DUPLICATE", "Possible duplicate", `Same recipient and amount earlier on ${fmtDay(r.day)} (${earlierSame[0].id})`);
      else if (sd.indexOf(r) === sd.length - 1 && !sd.some((x) => x !== r && x.amount === r.amount) && (sd.length >= 3 || sum(sd, (x) => x.amount) >= 10000)) add("MULTIPLE_SAME_DAY", "Multiple payments same day", `${sd.length} payments to this recipient on ${fmtDay(r.day)}, KSh ${sum(sd, (x) => x.amount).toLocaleString()} in total`);
    }
    // new recipient, large — only once there is enough history
    if (r.payeeKey && !seenPayee.has(r.payeeKey)) {
      if (dayDiff(firstDay, r.day) >= 28 && r.amount >= 10000) add("NEW_RECIPIENT_LARGE", "New recipient, large payment", `First payment ever to this recipient`);
      seenPayee.set(r.payeeKey, r.day);
    }
    // outside normal pattern — category not seen in the previous 60 days (needs 60+ days history)
    if (dayDiff(firstDay, r.day) >= 60 && r.amount >= 2000 && r.category !== "Unclassified") {
      const from = addDays(r.day, -60);
      const seen = sorted.some((x) => x !== r && x.subcategory === r.subcategory && x.category === r.category && x.day >= from && x.day < r.day);
      if (!seen) add("OUTSIDE_PATTERN", "Outside normal pattern", `No ${r.subcategory} payments in the previous 60 days`);
    }
    if (r.isRefund) add("REIMBURSEMENT", "Reimbursement — confirm original", "Remark says refund/reimbursement; confirm the original cost is not also recorded");
    if (/fail|revers/.test(r.norm)) add("STATUS_IN_REMARK", "Status note in remark", "Remark mentions a failed or reversed payment");
    if (r.mixedWith && r.amount >= 1000 && r.category !== "Inventory & Equipment" && !(isFuel && r.mixedWith.every((m) => FUEL_SUBS.includes(m) || /fuel/i.test(m)))) add("MIXED_PURPOSE", "Mixed purpose", `Remark also mentions ${r.mixedWith.join(", ")}`);
    if (r.category === "Unclassified") add("UNCLASSIFIED", "Classification review", "No reliable evidence for a category");
    else if (r.confidence === "Low") add("LOW_CONFIDENCE", "Low-confidence classification", r.basis);
    if (r.advanceUnspecified) add("ADVANCE_PERIOD", "Advance — period not specified", "Salary advance with no future month stated in the source; confirm which month it should be recovered from");
  }
}

// ---------- MASTER ANALYSE ----------
function analyse(rawRows, overrides = {}) {
  const recs = rawRows.map(buildRecord);
  assignClasses(recs);
  for (const r of recs) {
    const o = overrides[r.id];
    if (o && o.cls) { r.cls = o.cls; r.clsReason = "Set manually"; r.manualCls = true; }
  }
  const exp = recs.filter((r) => r.cls === "EXPENSE" || r.cls === "PENDING");
  for (const r of exp) {
    classifyOne(r);
    const o = overrides[r.id];
    if (o && o.category) { r.category = o.category; r.subcategory = o.subcategory || "General"; r.confidence = "Manual"; r.basis = "Set by reviewer"; r.manual = true; delete r.mixedWith; }
  }
  const paid = exp.filter((r) => r.cls === "EXPENSE");
  receiverHistoryPass(paid);
  for (const r of exp) {
    deriveDetail(r);
    const o = overrides[r.id] || {};
    if (o.relatesTo) { r.relatesTo = o.relatesTo; r.relatesHow = "Set by reviewer"; r.advanceUnspecified = false; }
    if (r.category === "Staff & Payroll") {
      if (o.employee) { r.employee = o.employee; r.employeeManual = true; }
      if (o.payType) { r.payType = o.payType; r.payTypeManual = true; r.advanceUnspecified = o.payType === "Salary advance" && !r.relatesTo; }
    }
    const lines = o.itemLines || (o.item ? [{ name: LEGACY_ITEM[o.item] || o.item, qty: o.qty, unit: o.unit }] : null);
    if (lines && lines.filter((l) => l.name).length && (r.category === "Inventory & Equipment" || o.category === "Inventory & Equipment")) {
      r.items = lines.filter((l) => l.name).map((l) => {
        const { base, sub } = itemBaseSub(l.name);
        const variant = l.name.includes(" — ") ? l.name.split(" — ").slice(1).join(" — ") : null;
        const q = +l.qty || null;
        return { base, variant, name: l.name, sub, qty: q, unit: UNIT_WORDS[l.unit] || l.unit || "pcs", qtySource: q ? (l.fromSource ? "source" : "manual") : "none", specMissing: /not stated/.test(variant || ""), amount: l.amount !== "" && l.amount !== undefined && l.amount !== null ? +l.amount : null, manual: true };
      });
      const subs = [...new Set(r.items.map((i) => i.sub))];
      if (!o.category) r.subcategory = subs.length === 1 ? subs[0] : "Mixed purchase";
      r.itemsManual = true;
      finishPurchase(r);
    } else if (o.qty && r.items && r.items.length === 1) { r.items[0] = { ...r.items[0], qty: +o.qty, unit: o.unit || r.items[0].unit, qtySource: "manual" }; finishPurchase(r); }
    r.history = o.history || [];
  }
  const recurring = detectRecurring(paid);
  detectAnomalies(paid);
  for (const r of paid) {
    const o = overrides[r.id];
    r.review = (o && o.review) || (r.flags.length ? "open" : null);
    r.reviewNote = (o && o.reviewNote) || "";
    r.note = (o && o.note) || "";
  }
  const days = recs.map((r) => r.day).filter(Boolean).sort();
  return { recs, expenses: paid, pendingRows: exp.filter((r) => r.cls === "PENDING"), recurring, firstDay: days[0] || null, lastDay: days[days.length - 1] || null };
}

// ---------- PERIODS ----------
function makePeriod(mode, anchor) {
  if (mode === "day") return { mode, from: anchor, to: anchor, label: fmtDay(anchor) };
  if (mode === "week") { const f = weekStart(anchor); return { mode, from: f, to: addDays(f, 6), label: `Week of ${fmtDay(f)}` }; }
  if (mode === "month") { const mk = monthKey(anchor); return { mode, from: mk + "-01", to: monthEnd(mk), label: fmtMonth(mk) }; }
  if (mode === "year") { const y = anchor.slice(0, 4); return { mode, from: `${y}-01-01`, to: `${y}-12-31`, label: y }; }
  return { mode: "all", from: "0000-01-01", to: "9999-12-31", label: "All history" };
}
function shiftAnchor(mode, anchor, dir) {
  if (mode === "day") return addDays(anchor, dir);
  if (mode === "week") return addDays(anchor, 7 * dir);
  if (mode === "month") { const d = fromKey(monthKey(anchor) + "-01"); d.setUTCMonth(d.getUTCMonth() + dir); return toKey(d); }
  if (mode === "year") return `${+anchor.slice(0, 4) + dir}${anchor.slice(4)}`;
  return anchor;
}
// Effective window (truncated to the last data day for partial periods) and a like-for-like previous window
function windows(period, lastDay) {
  if (period.mode === "all") return { cur: { from: period.from, to: period.to }, prev: null, partial: false };
  const partial = lastDay && lastDay >= period.from && lastDay < period.to;
  const curTo = partial ? lastDay : period.to;
  const span = dayDiff(period.from, curTo);
  const prevAnchor = shiftAnchor(period.mode, period.from, -1);
  const pp = makePeriod(period.mode, prevAnchor);
  let prevTo = addDays(pp.from, span);
  if (prevTo > pp.to) prevTo = pp.to;
  return { cur: { from: period.from, to: curTo }, prev: { from: pp.from, to: prevTo, label: pp.label }, partial };
}
const inWin = (r, w) => w && r.day >= w.from && r.day <= w.to;

// ---------- AGGREGATES ----------
function groupTotals(list, keyFn) {
  const m = {};
  for (const r of list) { const k = keyFn(r); (m[k] ||= { key: k, total: 0, count: 0, max: 0, list: [] }); m[k].total += r.amount; m[k].count++; m[k].max = Math.max(m[k].max, r.amount); m[k].list.push(r); }
  return Object.values(m).sort((a, b) => b.total - a.total);
}
function change(cur, prev) {
  if (prev === null || prev === undefined) return { diff: null, pct: null };
  return { diff: cur - prev, pct: prev ? ((cur - prev) / prev) * 100 : null };
}
function recurringTable(an, curList, prevList) {
  const rows = [];
  for (const g of Object.values(an.recurring)) {
    if (!g.recurring) continue;
    const [cat, sub] = g.key.split("|");
    const inP = curList.filter((r) => r.recurring && r.category === cat && r.subcategory === sub).sort((a, b) => a.ts.localeCompare(b.ts));
    if (!inP.length) continue;
    const amts = inP.map((r) => r.amount);
    const prevT = prevList ? sum(prevList.filter((r) => r.recurring && r.category === cat && r.subcategory === sub), (r) => r.amount) : null;
    let trend = "Insufficient data", trendBasis = "";
    const total = sum(amts);
    if (prevList && prevT > 0) {
      const p = ((total - prevT) / prevT) * 100;
      trend = p > 15 ? "Increasing" : p < -15 ? "Decreasing" : "Stable"; trendBasis = `vs previous period (${p >= 0 ? "+" : ""}${p.toFixed(0)}%)`;
    } else if (inP.length >= 4) {
      const mid = inP[0].day < inP[inP.length - 1].day ? addDays(inP[0].day, Math.floor(dayDiff(inP[0].day, inP[inP.length - 1].day) / 2)) : inP[0].day;
      const a = sum(inP.filter((r) => r.day <= mid), (r) => r.amount), b = sum(inP.filter((r) => r.day > mid), (r) => r.amount);
      const na = inP.filter((r) => r.day <= mid).length, nb = inP.length - na;
      if (a > 0 && b > 0 && na >= 3 && nb >= 3) { const p = ((b - a) / a) * 100; trend = p > 15 ? "Increasing" : p < -15 ? "Decreasing" : "Stable"; trendBasis = `second half vs first half of period (${p >= 0 ? "+" : ""}${p.toFixed(0)}%)`; }
    }
    const spanDays = Math.max(1, dayDiff(inP[0].day, inP[inP.length - 1].day) + 1);
    rows.push({
      category: cat, subcategory: sub, pattern: g.pattern, count: inP.length, total, avg: total / inP.length,
      min: Math.min(...amts), max: Math.max(...amts), last: inP[inP.length - 1].day, previous: inP.length > 1 ? inP[inP.length - 2].day : null,
      perWeek: (inP.length / Math.max(1, spanDays / 7)), recipients: new Set(inP.map((r) => r.payee)).size, trend, trendBasis,
    });
  }
  return rows.sort((a, b) => b.total - a.total);
}

/* ======================================================================
   SHARED ANALYTICS USED BY SCREENS, REPORTS AND THE ASK PANEL
   ====================================================================== */
const ksh = (n) => (n === null || n === undefined || Number.isNaN(n) ? "—" : "KSh " + Math.round(n).toLocaleString("en-KE"));
const pctTxt = (p) => (p === null || p === undefined || !Number.isFinite(p) ? "—" : (p >= 0 ? "+" : "") + p.toFixed(1) + "%");
const diffTxt = (d) => (d === null || d === undefined ? "—" : (d >= 0 ? "+" : "−") + "KSh " + Math.abs(Math.round(d)).toLocaleString("en-KE"));

function daysInMonthKey(mk) { return +monthEnd(mk).slice(8, 10); }

// Budget for a window, pro-rated by day where the window covers part of a month
function budgetForWindow(budgets, win, category) {
  if (!win || win.from === "0000-01-01") return null;
  let total = 0, any = false, prorated = false;
  let m = monthKey(win.from);
  const last = monthKey(win.to);
  while (m <= last) {
    const b = budgets[m] && budgets[m][category];
    const from = win.from > m + "-01" ? win.from : m + "-01";
    const to = win.to < monthEnd(m) ? win.to : monthEnd(m);
    const days = dayDiff(from, to) + 1, dim = daysInMonthKey(m);
    if (b !== undefined && b !== null && b !== "") { any = true; total += (+b) * (days / dim); if (days !== dim) prorated = true; }
    const d = fromKey(m + "-01"); d.setUTCMonth(d.getUTCMonth() + 1); m = toKey(d).slice(0, 7);
  }
  return any ? { budget: total, prorated } : null;
}

function budgetRows(an, budgets, win) {
  const cur = an.expenses.filter((r) => inWin(r, win));
  return CATEGORY_ORDER.map((c) => {
    const actual = sum(cur.filter((r) => r.category === c), (r) => r.amount);
    const b = budgetForWindow(budgets, win, c);
    const variance = b ? actual - b.budget : null;
    return { category: c, actual, budget: b ? b.budget : null, prorated: b ? b.prorated : false, variance, variancePct: b && b.budget ? (variance / b.budget) * 100 : null };
  }).filter((r) => r.actual > 0 || r.budget !== null);
}

function pendingSummary(pending, an, win, cal) {
  const t = todayKey();
  const open = pending.filter((p) => p.status === "open");
  const tendePending = an.pendingRows || [];
  const calOpen = cal ? cal.rows.filter((r) => r.remaining > 0) : [];
  const calOverdue = calOpen.filter((r) => r.status === "Overdue" || (r.status === "Part paid" && an.lastDay && an.lastDay > r.due));
  return {
    openTotal: sum(open, (p) => +p.amount) + sum(tendePending, (r) => r.amount) + sum(calOpen, (r) => r.remaining),
    openCount: open.length + tendePending.length + calOpen.length,
    overdue: open.filter((p) => p.due && p.due < t),
    dueInWindow: win ? open.filter((p) => p.due && p.due >= win.from && p.due <= win.to) : [],
    tendePending, calOpen, calOverdue, calMonth: cal ? cal.mk : null,
  };
}

// Evidence-based attention items; never explains *why*
function attentionItems(an, ctx) {
  const { win, budgets, pending, overrides } = ctx;
  const cur = an.expenses.filter((r) => inWin(r, win.cur));
  const prev = win.prev ? an.expenses.filter((r) => inWin(r, win.prev)) : null;
  const items = [];
  if (prev && prev.length) {
    const pc = groupTotals(prev, (r) => r.category), cc = groupTotals(cur, (r) => r.category);
    for (const c of CATEGORY_ORDER) {
      const a = (pc.find((x) => x.key === c) || {}).total || 0, b = (cc.find((x) => x.key === c) || {}).total || 0;
      if (a > 0 && b > a && (b - a) >= 5000 && (b - a) / a >= 0.2) items.push({ level: "watch", text: `${c} spending increased from ${ksh(a)} to ${ksh(b)} (${diffTxt(b - a)} / ${pctTxt(((b - a) / a) * 100)}). Review transaction-level detail to determine the reason.` });
      if (a === 0 && b >= 5000) items.push({ level: "watch", text: `${c}: ${ksh(b)} spent this period with no spending in the previous period.` });
    }
  }
  const big = [...cur].sort((a, b) => b.amount - a.amount).filter((r) => r.amount >= 20000).slice(0, 3);
  for (const r of big) items.push({ level: "info", text: `Large payment: ${ksh(r.amount)} to ${titleCase(r.payee)} on ${fmtDay(r.day)} — "${r.remark}".` });
  const open = cur.filter((r) => r.review === "open");
  if (open.length) {
    const byCode = {}; for (const r of open) for (const f of r.flags) byCode[f.label] = (byCode[f.label] || 0) + 1;
    items.push({ level: "review", text: `${open.length} payment${open.length > 1 ? "s" : ""} flagged for review: ${Object.entries(byCode).map(([k, v]) => `${v} × ${k.toLowerCase()}`).join(", ")}.` });
  }
  const confirmed = cur.filter((r) => r.review === "confirmed");
  if (confirmed.length) items.push({ level: "review", text: `${confirmed.length} confirmed problem${confirmed.length > 1 ? "s" : ""} recorded by a reviewer this period (${ksh(sum(confirmed, (r) => r.amount))}).` });
  const ps = pendingSummary(pending, an, win.cur, ctx.calendar);
  if (ps.calOverdue.length) items.push({ level: "watch", text: `${ps.calOverdue.length} scheduled payment${ps.calOverdue.length > 1 ? "s are" : " is"} overdue in the ${fmtMonth(ps.calMonth)} payment calendar: ${ksh(sum(ps.calOverdue, (r) => r.remaining))} (${ps.calOverdue.slice(0, 4).map((r) => r.name).join(", ")}${ps.calOverdue.length > 4 ? "…" : ""}).` });
  if (ps.overdue.length) items.push({ level: "review", text: `${ps.overdue.length} pending obligation${ps.overdue.length > 1 ? "s are" : " is"} past due: ${ksh(sum(ps.overdue, (p) => +p.amount))}.` });
  if (ps.dueInWindow.length) items.push({ level: "info", text: `${ps.dueInWindow.length} obligation${ps.dueInWindow.length > 1 ? "s" : ""} due in this period: ${ksh(sum(ps.dueInWindow, (p) => +p.amount))}.` });
  if (dayDiff(win.cur.from, win.cur.to) >= 6) for (const b of budgetRows(an, budgets, win.cur)) if (b.budget !== null && b.variance > 0) items.push({ level: "watch", text: `${b.category} is above budget: ${ksh(b.actual)} against ${ksh(b.budget)}${b.prorated ? " (pro-rated)" : ""}, ${diffTxt(b.variance)} / ${pctTxt(b.variancePct)}.` });
  if (ctx.revenue && ctx.revenue.days) {
    const rvA = revenueFor(ctx.revenue.days, win.cur.from, win.cur.to);
    const pA = (+((ctx.calState || {}).opexPct) || 60) / 100;
    if (rvA.days && rvA.firstDay <= win.cur.from && rvA.lastDay >= win.cur.to) {
      const spentA = sum(cur, (r) => r.amount + r.charge);
      if (spentA > rvA.total * pA) items.push({ level: "watch", text: `Spending was ${((spentA / rvA.total) * 100).toFixed(1)}% of revenue (${ksh(spentA)} of ${ksh(rvA.total)}), above the ${pA * 100}% OpEx share by ${ksh(spentA - rvA.total * pA)}.` });
    }
  }
  for (const p of priceHistory(an)) {
    if (!p.prev || !inWin({ day: p.last.day }, win.cur) || Math.abs(p.last.pct) < 10) continue;
    items.push({ level: p.last.change > 0 ? "watch" : "info", text: `${p.name} price ${p.last.change > 0 ? "rose" : "fell"} from ${ksh(p.prev.unitCost)} to ${ksh(p.last.unitCost)} ${perUnit(p.unit)} (${pctTxt(p.last.pct)}) on ${fmtDay(p.last.day)} — ${p.last.supplier}.` });
  }
  if (cur.length && cur.every((r) => !r.approver)) items.push({ level: "info", text: `Approver field is empty on all ${cur.length} payments in this export, so approval control cannot be evidenced from Tende data.` });
  return items;
}

function trendBuckets(list, gran, win, an) {
  const from = win.from === "0000-01-01" ? an.firstDay : win.from;
  const to = win.to === "9999-12-31" ? an.lastDay : win.to;
  if (!from || !to) return [];
  const keyOf = (d) => (gran === "day" ? d : gran === "week" ? weekStart(d) : monthKey(d));
  const keys = []; const seen = new Set(); let d = from; let guard = 0;
  while (d <= to && guard++ < 4000) { const k = keyOf(d); if (!seen.has(k)) { seen.add(k); keys.push(k); } d = addDays(d, 1); }
  const map = {}; for (const k of keys) map[k] = { key: k, total: 0, count: 0 };
  for (const r of list) { const k = keyOf(r.day); if (map[k]) { map[k].total += r.amount; map[k].count++; } }
  return keys.map((k, i) => {
    const b = map[k], p = i ? map[keys[i - 1]] : null;
    const label = gran === "day" ? `${+k.slice(8)} ${MONTHS[+k.slice(5, 7) - 1]}` : gran === "week" ? `Wk ${+k.slice(8)} ${MONTHS[+k.slice(5, 7) - 1]}` : fmtMonth(k);
    return { ...b, label, avg: b.count ? b.total / b.count : 0, ...(p ? change(b.total, p.total) : { diff: null, pct: null }) };
  });
}

function normalDailyLevel(an, day) {
  const from = addDays(day, -30);
  const start = an.firstDay > from ? an.firstDay : from;
  const end = addDays(day, -1);
  if (!an.firstDay || start > end) return null;
  const n = dayDiff(start, end) + 1;
  if (n < 7) return null;
  const totals = {}; for (const r of an.expenses) if (r.day >= start && r.day <= end) totals[r.day] = (totals[r.day] || 0) + r.amount;
  const arr = []; for (let i = 0; i < n; i++) arr.push(totals[addDays(start, i)] || 0);
  return { median: median(arr), days: n };
}

/* ---------- natural-language query executor ---------- */
function resolveQueryPeriod(p, an) {
  const t = todayKey(); p = p || {};
  const P = (mode, anchor) => { const x = makePeriod(mode, anchor); return { from: x.from, to: x.to }; };
  switch (p.preset) {
    case "today": return { from: t, to: t };
    case "yesterday": { const y = addDays(t, -1); return { from: y, to: y }; }
    case "this_week": return { from: weekStart(t), to: t };
    case "last_week": return P("week", addDays(t, -7));
    case "this_month": return { from: monthKey(t) + "-01", to: t };
    case "last_month": return P("month", shiftAnchor("month", t, -1));
    case "this_year": return { from: t.slice(0, 4) + "-01-01", to: t };
    case "latest_day": return an.lastDay ? { from: an.lastDay, to: an.lastDay } : { from: t, to: t };
    case "latest_month": return an.lastDay ? P("month", an.lastDay) : P("month", t);
    case "custom": return { from: p.from || an.firstDay || t, to: p.to || an.lastDay || t };
    default: return { from: an.firstDay || "0000-01-01", to: an.lastDay || "9999-12-31" };
  }
}
function previousWindow(w) {
  const span = dayDiff(w.from, w.to) + 1;
  const isMonth = w.from.slice(8) === "01" && w.to === monthEnd(monthKey(w.from));
  if (isMonth) { const p = makePeriod("month", shiftAnchor("month", w.from, -1)); return { from: p.from, to: p.to }; }
  return { from: addDays(w.from, -span), to: addDays(w.from, -1) };
}
function filterRows(list, f) {
  f = f || {}; const lc = (s) => String(s || "").toLowerCase();
  return list.filter((r) =>
    (!f.category || lc(r.category).includes(lc(f.category))) &&
    (!f.subcategory || lc(r.subcategory).includes(lc(f.subcategory))) &&
    (!f.recipient || lc(r.payee).includes(lc(f.recipient)) || lc(r.receiverId).includes(lc(f.recipient))) &&
    (!f.wallet || lc(r.wallet).includes(lc(f.wallet)) || lc(r.account).includes(lc(f.wallet))) &&
    (!f.initiator || lc(r.initiator).includes(lc(f.initiator))) &&
    (!f.text || r.norm.includes(normalizeRemark(f.text)) || lc(r.remark).includes(lc(f.text))) &&
    (!f.employee || lc(r.employee).includes(lc(f.employee)) || lc(r.payee).includes(lc(f.employee))) &&
    (!f.pay_type || lc(r.payType).includes(lc(f.pay_type))) &&
    (!f.item || (r.items || []).some((i) => lc(i.name).includes(lc(f.item)))) &&
    (!f.min_amount || r.amount >= +f.min_amount) && (!f.max_amount || r.amount <= +f.max_amount));
}
const slim = (r) => ({
  id: r.id, mpesa_ref: r.txnRef, date: r.date, wallet: r.wallet, category: r.category, subcategory: r.subcategory, description: r.remark, amount: r.amount, recipient: r.payee,
  confidence: r.confidence, classification_basis: r.basis, relates_to: r.relatesTo || null, relates_basis: r.relatesHow,
  ...(r.category === "Staff & Payroll" ? { employee: r.employee || "Not available in source", payment_type: r.payType } : {}),
  ...(r.category === "Inventory & Equipment" ? { items: r.items.map((i) => ({ item: i.name, quantity: i.qty ?? "Not available in source", unit: i.qty ? i.unit : null, quantity_source: i.qtySource })), unit_cost: r.unitCost ? Math.round(r.unitCost * 100) / 100 : null, unit_cost_basis: r.unitCostSource } : {}),
  flags: r.flags.map((f) => f.label), review: r.review,
});

function executeQuery(q, an, ctx) {
  const w = resolveQueryPeriod(q.period, an);
  const base = filterRows(an.expenses.filter((r) => inWin(r, w)), q.filters);
  const limit = Math.min(+q.limit || 15, 40);
  const coverage = { first_day: an.firstDay, last_day: an.lastDay };
  const out = { metric: q.metric, period_used: w, data_coverage: coverage, matched_transactions: base.length };
  if (an.lastDay && (w.from > an.lastDay || (an.firstDay && w.to < an.firstDay))) out.limitation = "No imported Tende data covers this period.";
  else if (an.lastDay && w.to > an.lastDay) out.limitation = `Imported data ends on ${an.lastDay}; period is only partly covered.`;
  let rows = [];
  const grp = (fn) => groupTotals(base, fn).slice(0, limit).map((g) => ({ name: g.key, total: g.total, count: g.count, average: Math.round(g.total / g.count), largest: g.max }));
  switch (q.metric) {
    case "summary": {
      const top = [...base].sort((a, b) => b.amount - a.amount)[0];
      Object.assign(out, { total: sum(base, (r) => r.amount), count: base.length, average: base.length ? Math.round(sum(base, (r) => r.amount) / base.length) : 0, charges: sum(base, (r) => r.charge), largest: top ? slim(top) : null });
      rows = [...base].sort((a, b) => b.amount - a.amount).slice(0, limit); break;
    }
    case "transactions": rows = [...base].sort(q.sort === "date" ? (a, b) => b.ts.localeCompare(a.ts) : (a, b) => b.amount - a.amount).slice(0, limit); out.total = sum(base, (r) => r.amount); break;
    case "by_category": out.groups = grp((r) => r.category); break;
    case "by_subcategory": out.groups = grp((r) => r.category + " / " + r.subcategory); break;
    case "by_recipient": out.groups = grp((r) => r.payee); break;
    case "by_wallet": out.groups = grp((r) => r.wallet); break;
    case "by_initiator": out.groups = grp((r) => r.initiator || "(not recorded)"); break;
    case "trend": out.buckets = trendBuckets(base, q.granularity || "week", w, an).map((b) => ({ period: b.label, total: b.total, count: b.count, change: b.diff, change_pct: b.pct === null ? null : +b.pct.toFixed(1) })); break;
    case "compare": {
      const pw = q.compare_to ? resolveQueryPeriod(q.compare_to, an) : previousWindow(w);
      const prev = filterRows(an.expenses.filter((r) => inWin(r, pw)), q.filters);
      const by = q.group_by === "subcategory" ? (r) => r.category + " / " + r.subcategory : q.group_by === "recipient" ? (r) => r.payee : (r) => r.category;
      const a = groupTotals(prev, by), b = groupTotals(base, by);
      const keys = [...new Set([...a.map((x) => x.key), ...b.map((x) => x.key)])];
      out.previous_period = pw; out.current_total = sum(base, (r) => r.amount); out.previous_total = sum(prev, (r) => r.amount);
      out.groups = keys.map((k) => { const c = (b.find((x) => x.key === k) || {}).total || 0, p = (a.find((x) => x.key === k) || {}).total || 0; const ch = change(c, p); return { name: k, current: c, previous: p, change: ch.diff, change_pct: ch.pct === null ? null : +ch.pct.toFixed(1) }; }).sort((x, y) => Math.abs(y.change) - Math.abs(x.change)).slice(0, limit);
      if (!prev.length) out.limitation = (out.limitation ? out.limitation + " " : "") + "No data in the comparison period.";
      break;
    }
    case "recurring": out.recurring = recurringTable(an, base, null).slice(0, limit).map((r) => ({ ...r, avg: Math.round(r.avg), perWeek: +r.perWeek.toFixed(2) })); break;
    case "anomalies": rows = base.filter((r) => r.flags.length && r.review !== "cleared").sort((a, b) => b.amount - a.amount).slice(0, limit); out.flagged = base.filter((r) => r.flags.length && r.review !== "cleared").length; out.note = "Detected anomalies are review prompts, not confirmed problems."; break;
    case "pending": { const ps = pendingSummary(ctx.pending, an, w, ctx.calendar); out.open_total = ps.openTotal; out.open_items = ctx.pending.filter((p) => p.status === "open"); out.overdue = ps.overdue.length; if (!ctx.pending.length) out.limitation = "No pending obligations have been recorded in the Control screen."; break; }
    case "payroll": {
      const month = w.from.slice(8) === "01" && w.to === monthEnd(monthKey(w.from)) ? monthKey(w.from) : null;
      const ps = payrollSummary(an, base, month);
      out.by_payment_type = ps.byType; out.total_cash_paid = ps.total;
      out.employees = ps.employees.slice(0, limit).map((e) => ({ employee: e.name, employee_in_source: e.person, total: e.total, ...Object.fromEntries(PAY_TYPES.filter((t) => e[t]).map((t) => [t, e[t]])), payments: e.rows.map((r) => ({ type: r.payType, amount: r.amount, paid: r.day, relates_to: relText(r), ref: r.txnRef })) }));
      if (ps.cashVsPeriod) { const cv = ps.cashVsPeriod; out.cash_vs_period = { cash_paid: cv.cash, relates_to_this_month: cv.current, relates_to_earlier_months: sum(cv.earlier, (r) => r.amount), advances_for_future_months: sum(cv.future, (r) => r.amount), advances_month_not_stated: sum(cv.advUnspecified, (r) => r.amount), month_not_stated: sum(cv.unstated, (r) => r.amount), staff_expense_confirmed_for_this_month_any_payment_date: sum(cv.expenseForMonth, (r) => r.amount) }; }
      break;
    }
    case "items": out.items = itemSummary(base).slice(0, limit).map((x) => ({ item: x.name, subcategory: x.sub, payments: x.payments, quantity_stated: x.unitsText || "Not available in source", spend_when_bought_alone: x.soloSpend, average_unit_cost_calculated: x.avgUnitCost ? Math.round(x.avgUnitCost) : null, mixed_purchases_cost_not_separable: x.mixedPayments, suppliers: x.suppliers })); out.note = "Spend is attributed to an item only when a payment bought that item alone."; break;
    case "purchases": rows = base.filter((r) => r.category === "Inventory & Equipment").sort((a, b) => b.amount - a.amount).slice(0, limit); out.total = sum(base.filter((r) => r.category === "Inventory & Equipment"), (r) => r.amount); break;
    case "advanta": { const adv = base.filter((r) => r.subcategory === "Advanta bundles"); out.total = sum(adv, (r) => r.amount); out.transactions_count = adv.length; out.quantity = "Not available in source"; rows = adv.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit); break; }
    case "inventory_record": {
      const rec = inventoryRecord(base.filter((r) => r.category === "Inventory & Equipment"));
      out.items = rec.rows.slice(0, limit).map((x) => ({ item: x.name, quantity: x.qtyText || "Not stated", total_spent: x.spend || null, unit_cost: x.unitCost ? Math.round(x.unitCost) : null, in_mixed_purchases: x.inMixed }));
      Object.assign(out, { total: rec.total, cost_not_split: rec.mixedT, items_not_stated: rec.unstatedT });
      out.price_changes = priceHistory(an).filter((p) => p.prev).map((p) => ({ item: p.name, previous: Math.round(p.prev.unitCost), latest: Math.round(p.last.unitCost), change_pct: +p.last.pct.toFixed(1), date: p.last.day, supplier: p.last.supplier }));
      break;
    }
    case "alerts": {
      const a = ctx.alerts;
      if (!a) { out.limitation = "Alerts unavailable."; break; }
      out.as_of = a.today; out.tende_data_to = a.dataTo; out.warning_days = a.ahead;
      out.alerts = ALERT_ORDER.map((l) => ({ level: ALERT_LEVELS[l].label, count: a.counts[l], total: a.totals[l], items: a.groups[l].slice(0, limit).map((x) => ({ obligation: x.row.name, payee: x.row.payeeLabel, due: x.row.due, still_to_pay: x.row.remaining, status: x.row.status, days_late: x.daysLate || null, note: x.hint || null })) })).filter((g) => g.count);
      out.snoozed = a.snoozed.length;
      break;
    }
    case "revenue": {
      const rvq = revenueFor((ctx.revenue && ctx.revenue.days) || {}, w.from, w.to);
      const p = (+((ctx.calState || {}).opexPct) || 60) / 100;
      const tf = tendeFlows(an, w.from, w.to);
      Object.assign(out, { revenue: rvq.total, hotspot: rvq.hotspot, pppoe: rvq.pppoe, revenue_days_covered: rvq.days, opex_share_pct: p * 100, opex_allowed: Math.round(rvq.total * p), business_money_into_tende: tf.business, owner_money_into_tende: tf.owner, spent_from_tende_incl_charges: tf.spent, target: ((ctx.calState || {}).targets || {})[monthKey(w.from)] || null });
      if (!rvq.days) out.limitation = (out.limitation ? out.limitation + " " : "") + "No utility account statement covers this period.";
      break;
    }
    case "budget": out.budget = budgetRows(an, ctx.budgets, w); if (!out.budget.some((b) => b.budget !== null)) out.limitation = "No budget has been entered for this period."; break;
    default: out.error = "Unknown metric";
  }
  out.transactions = rows.map(slim);
  return { result: out, rows };
}

const ASK_SYSTEM = (an, ctx) => `You answer questions about Happynet ISP's expenses (Kenya, amounts in KSh) using ONLY results computed by the app from Tende payment data.
Data coverage: ${an.firstDay} to ${an.lastDay}. Today's date: ${todayKey()}.
Only actual expenses are queried (internal wallet transfers and incoming funding are already excluded).
Categories: ${CATEGORY_ORDER.join(", ")}.
Subcategories in use: ${[...new Set(an.expenses.map((r) => r.subcategory))].join(", ")}.
Wallets: ${[...new Set(an.expenses.map((r) => r.wallet))].join(", ")}.

To get data, reply with one or more blocks and nothing else:
<query>{"metric": "...", "period": {"preset": "..."}, "filters": {...}, ...}</query>
metric: inventory_record (month inventory record: items, quantities, spend, unit costs, price changes) | alerts (fixed payments overdue, due today, due soon, or not yet confirmable) | revenue (utility-statement revenue, OpEx allowed vs money into Tende vs spent) | summary | transactions | by_category | by_subcategory | by_recipient | by_wallet | by_initiator | trend | compare | recurring | anomalies | pending | budget | payroll (person-by-person, payment types, cash vs period) | items (inventory item quantities and unit costs) | purchases (inventory payments) | advanta
period.preset: today | yesterday | this_week | last_week | this_month | last_month | this_year | latest_day | latest_month | all | custom (with "from","to" as YYYY-MM-DD)
filters (all optional, case-insensitive contains): category, subcategory, recipient, wallet, initiator, employee, pay_type (Salary | Salary advance | Commission | Allowance | Bonus | Other staff payment), item (e.g. "XPON router", "Patch cord", "Drop cable"), text (searches remarks), min_amount, max_amount
optional: granularity (day|week|month) for trend; group_by (category|subcategory|recipient) and compare_to (a period object) for compare; sort (amount|date) and limit for transactions.
Fuel lives in subcategories such as "Vehicle fuel", "Bike fuel", "Generator fuel" — use filters.category "Fuel" plus filters.text "fuel" when the user means fuel only.
If the user's period has no data (e.g. "yesterday" after the data ends), say so and offer the latest period available.

Quantities and unit costs exist only where the Tende remark states them; unit costs marked calculated were worked out by the app. Never estimate a quantity, unit price, employee, supplier, purpose or month that the results don't contain — say "Not available in source".

After you receive <results>, reply in plain text with these parts:
Answer: one or two sentences.
Confirmed data: figures taken directly from Tende records.
Calculated data: totals, averages and unit costs the app computed (say how).
Unavailable data: what the source doesn't contain (say "None" if none).
Inferred information: anything that rests on interpretation, e.g. recipient-history classifications or low-confidence items (say "None" if none).
Period used: the dates.
Never invent numbers. Never explain why spending changed — say it changed and to review transaction detail. Never call an anomaly fraud.`;


/* ======================================================================
   DETAIL HELPERS — drill-down keys, item summaries, payroll, month comparison
   ====================================================================== */
const detailKey = (r) => {
  if (r.category === "Staff & Payroll") return r.employee || `Not available in source (paid to ${titleCase(r.payee)})`;
  if (r.category === "Inventory & Equipment") return r.items && r.items.length === 1 ? r.items[0].name : r.items && r.items.length ? `Several items: ${r.items.map((i) => i.name).join(", ")}` : "Item not identified in remark";
  return titleCase(r.payee);
};
const detailLabel = (cat) => (cat === "Staff & Payroll" ? "Employee / recipient" : cat === "Inventory & Equipment" ? "Item" : "Paid to");
const itemsText = (r) => (r.items || []).map((i) => `${i.name}${i.qty ? ` × ${i.qty}${!["units", "pcs"].includes(i.unit) ? " " + i.unit : ""}` : ""}`).join(", ");
const relText = (r) => (r.relatesTo ? fmtMonth(r.relatesTo) : r.payType === "Salary advance" ? "Future period not specified" : "Not specified in source");

// Item-level summary. Spend is attributed to an item only when known: the payment bought that item alone,
// or a reviewer entered line amounts that add up to the payment.
function itemSummary(list) {
  const m = {};
  for (const r of list) {
    if (r.category !== "Inventory & Equipment") continue;
    const items = r.items && r.items.length ? r.items : [{ base: "Item not identified", variant: null, name: "Item not identified in remark", sub: r.subcategory, qty: null, unit: "units", lineCost: r.amount, specMissing: false }];
    for (const it of items) {
      const x = (m[it.name] ||= { name: it.name, base: it.base || it.name, variant: it.variant || null, sub: it.sub, specMissing: !!it.specMissing, payments: 0, units: {}, soloSpend: 0, soloPayments: 0, unitCostSpend: 0, unitCostQty: 0, unitCostUnit: null, mixedPayments: 0, mixedValue: 0, qtyMissing: 0, suppliers: new Set(), rows: [] });
      x.payments++; x.rows.push(r); x.suppliers.add(titleCase(r.payee));
      if (it.qty) x.units[it.unit] = (x.units[it.unit] || 0) + it.qty; else x.qtyMissing++;
      const lc = it.lineCost !== undefined ? it.lineCost : (items.length === 1 ? r.amount : null);
      if (lc !== null && lc !== undefined) { x.soloSpend += lc; x.soloPayments++; if (it.qty && (!x.unitCostUnit || x.unitCostUnit === it.unit)) { x.unitCostSpend += lc; x.unitCostQty += it.qty; x.unitCostUnit = it.unit; } }
      else { x.mixedPayments++; x.mixedValue += r.amount; }
    }
  }
  return Object.values(m).map((x) => ({ ...x, suppliers: [...x.suppliers], avgUnitCost: x.unitCostQty ? x.unitCostSpend / x.unitCostQty : null, unitsText: Object.entries(x.units).map(([u, q]) => `${q} ${u}`).join(" + ") || null }))
    .sort((a, b) => a.base.localeCompare(b.base) || (b.soloSpend + b.mixedValue) - (a.soloSpend + a.mixedValue));
}

function payrollSummary(an, list, month) {
  const staff = list.filter((r) => r.category === "Staff & Payroll");
  const byType = Object.fromEntries(PAY_TYPES.map((t) => [t, sum(staff.filter((r) => r.payType === t), (r) => r.amount)]));
  const emps = {};
  for (const r of staff) { const k = detailKey(r); (emps[k] ||= { name: k, person: !!r.employee, rows: [], total: 0, ...Object.fromEntries(PAY_TYPES.map((t) => [t, 0])) }); emps[k].rows.push(r); emps[k].total += r.amount; emps[k][r.payType] += r.amount; }
  let cashVsPeriod = null;
  if (month) {
    const all = an.expenses.filter((r) => r.category === "Staff & Payroll");
    const cur = staff;
    cashVsPeriod = {
      cash: sum(cur, (r) => r.amount),
      current: sum(cur.filter((r) => r.relatesTo === month), (r) => r.amount),
      earlier: cur.filter((r) => r.relatesTo && r.relatesTo < month),
      future: cur.filter((r) => r.relatesTo && r.relatesTo > month),
      advUnspecified: cur.filter((r) => !r.relatesTo && r.payType === "Salary advance"),
      unstated: cur.filter((r) => !r.relatesTo && r.payType !== "Salary advance"),
      expenseForMonth: all.filter((r) => r.relatesTo === month),
    };
  }
  return { staff, byType, total: sum(staff, (r) => r.amount), employees: Object.values(emps).sort((a, b) => b.total - a.total), cashVsPeriod };
}

function monthsEnding(an, endMonth, n = 6) {
  if (!an.firstDay) return [];
  const first = monthKey(an.firstDay), out = [];
  let m = endMonth;
  while (out.length < n && m >= first) { out.unshift(m); m = shiftAnchor("month", m + "-01", -1).slice(0, 7); }
  return out;
}

/* ======================================================================
   STORAGE — raw rows kept per month, analytical overrides kept separately
   ====================================================================== */
const store = {
  ok: () => typeof window !== "undefined" && !!window.storage,
  async get(k, fb) { try { const r = await window.storage.get(k, false); return r && r.value ? JSON.parse(r.value) : fb; } catch { return fb; } },
  async set(k, v) { try { await window.storage.set(k, JSON.stringify(v), false); return true; } catch (e) { console.error("storage", k, e); return false; } },
  async del(k) { try { await window.storage.delete(k, false); } catch { /* ignore */ } },
};
const K = { index: "hnx:index", raw: (m) => `hnx:raw:${m}`, overrides: "hnx:overrides", budgets: "hnx:budgets", pending: "hnx:pending", log: "hnx:log", reviewer: "hnx:reviewer", calendar: "hnx:calendar", revenue: "hnx:revenue" };
const rowMonth = (raw) => { const d = String(raw["DATE INITIATED"] || ""); return /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : "unknown"; };

/* ======================================================================
   STYLE
   ====================================================================== */
const CAT_COLORS = {
  "Staff & Payroll": "#2F5D8A", "Fuel & Transport": "#C2652A", "Inventory & Equipment": "#0F6E6A", "Connectivity": "#6A4C9C",
  "Premises": "#8C6B22", "Administration": "#4F7A3A", "Other Operating": "#8E4E68", "Unclassified": "#9AA3A8",
};
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Sans+Condensed:wght@500;600&display=swap');
.hx{--ink:#17242E;--ink2:#4A5A66;--mute:#7C8A94;--line:#D8DEDB;--paper:#EEF1EF;--panel:#FFFFFF;--teal:#0F6E6A;--amber:#B7791F;--amberbg:#FBF3E4;--red:#A83F37;--redbg:#F8E9E7;--indigo:#4F56B8;--indigobg:#ECEDF8;--green:#2E7D4F;
  font-family:"IBM Plex Sans","Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--paper);min-height:100vh;font-size:14px;line-height:1.45}
.hx *{box-sizing:border-box}
.hx .flex{display:flex}.hx .flex-wrap{flex-wrap:wrap}.hx .items-center{align-items:center}.hx .items-end{align-items:flex-end}.hx .items-start{align-items:flex-start}.hx .justify-between{justify-content:space-between}.hx .grid{display:grid}
.hx .num{font-variant-numeric:tabular-nums}
.hx .cond{font-family:"IBM Plex Sans Condensed","IBM Plex Sans",system-ui,sans-serif}
.hx button{font:inherit;cursor:pointer}
.hx button:focus-visible,.hx input:focus-visible,.hx select:focus-visible,.hx textarea:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
.hx input,.hx select,.hx textarea{font:inherit;color:var(--ink);background:#fff;border:1px solid var(--line);border-radius:6px;padding:6px 8px}
.hx .top{background:var(--ink);color:#fff}
.hx .top .sub{color:#A9B6BF}
.hx .tab{padding:10px 14px;border:0;background:transparent;color:#C9D3D9;border-bottom:3px solid transparent}
.hx .tab[aria-selected=true]{color:#fff;border-bottom-color:#7FC8C2}
.hx .seg{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden;background:#fff}
.hx .seg button{border:0;background:#fff;padding:6px 10px;color:var(--ink2)}
.hx .seg button[aria-pressed=true]{background:var(--ink);color:#fff}
.hx .btn{border:1px solid var(--line);background:#fff;border-radius:7px;padding:6px 12px;color:var(--ink)}
.hx .btn:hover{border-color:var(--ink2)}
.hx .btn.primary{background:var(--teal);border-color:var(--teal);color:#fff}
.hx .btn.small{padding:3px 8px;font-size:12px}
.hx .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px}
.hx .h2{font-size:15px;font-weight:600;margin:0}
.hx .muted{color:var(--mute)}
.hx table.t{width:100%;border-collapse:collapse}
.hx table.t th{font-weight:500;color:var(--ink2);text-align:left;font-size:12px;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap;background:#F7F9F8;position:sticky;top:0}
.hx table.t td{padding:7px 10px;border-bottom:1px solid #EDF0EE;vertical-align:top}
.hx table.t tr.click:hover td{background:#F3F7F6;cursor:pointer}
.hx .r{text-align:right}
.hx table.t th.r{text-align:right}
.hx table.t td.r{white-space:nowrap}
.hx button.stat{display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;color:inherit}
.hx .scroll{overflow:auto}
.hx .chip{display:inline-block;font-size:11.5px;padding:1px 7px;border-radius:99px;white-space:nowrap}
.hx .chip.review{background:var(--amberbg);color:#7A4F0F}
.hx .chip.ok{background:#E5F2EA;color:var(--green)}
.hx .chip.bad{background:var(--redbg);color:var(--red)}
.hx .chip.pend{background:var(--indigobg);color:var(--indigo)}
.hx .chip.ex{background:#EEF0F1;color:var(--ink2)}
.hx .dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;vertical-align:baseline}
.hx .ribbon{display:flex;height:34px;border-radius:6px;overflow:hidden;background:#E3E8E6}
.hx .ribbon button{border:0;padding:0;height:100%;min-width:2px;transition:filter .15s}
.hx .ribbon button:hover{filter:brightness(1.12)}
.hx .stat{padding:14px 16px;border-right:1px solid var(--line)}
.hx .stat:last-child{border-right:0}
.hx .stat .lbl{font-size:12.5px;color:var(--ink2)}
.hx .stat .val{font-size:20px;font-weight:600;margin-top:2px}
.hx .stat .note{font-size:12px;color:var(--mute);margin-top:2px}
.hx .att{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #EDF0EE}
.hx .att:last-child{border-bottom:0}
.hx .bar{width:4px;border-radius:2px;flex:none}
.hx .drawer{position:fixed;inset:0 0 0 auto;width:min(560px,100%);background:#fff;border-left:1px solid var(--line);box-shadow:-12px 0 30px rgba(23,36,46,.12);z-index:50;display:flex;flex-direction:column}
.hx .scrim{position:fixed;inset:0;background:rgba(23,36,46,.25);z-index:40}
.hx .kv{display:grid;grid-template-columns:150px 1fr;gap:4px 12px;font-size:13px}
.hx .kv dt{color:var(--ink2)}
.hx .kv dd{margin:0;word-break:break-word}
.hx .pill{border:1px solid var(--line);background:#fff;border-radius:99px;padding:4px 11px;color:var(--ink2);font-size:13px}
.hx .pill[aria-pressed=true]{background:var(--ink);border-color:var(--ink);color:#fff}
.hx .report{white-space:pre-wrap;font-size:13.5px;line-height:1.55;background:#FAFBFA;border:1px solid var(--line);border-radius:8px;padding:16px}
.hx .msg{border-radius:10px;padding:10px 12px;max-width:100%}
.hx .msg.user{background:var(--ink);color:#fff;margin-left:40px}
.hx .msg.bot{background:#F4F6F5;border:1px solid var(--line);white-space:pre-wrap}
.hx .shell{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}
.hx .side{background:var(--ink);color:#C9D3D9;position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:18px 12px 14px;overflow:auto}
.hx .brand{padding:2px 10px 14px;border-bottom:1px solid #2C3A44;margin-bottom:8px}
.hx .nav{display:flex;flex-direction:column;gap:2px}
.hx .nav .grp{font-size:11.5px;color:#7F909B;padding:14px 10px 4px;letter-spacing:.02em}
.hx .nav button{display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;color:#C9D3D9;padding:9px 10px;border-radius:8px;text-align:left;font-size:14px}
.hx .nav button:hover:not(:disabled){background:rgba(255,255,255,.06);color:#fff}
.hx .nav button:disabled{opacity:.4;cursor:default}
.hx .nav button[aria-current=page]{background:rgba(127,200,194,.15);color:#fff;box-shadow:inset 3px 0 0 #7FC8C2}
.hx .nbadge{margin-left:auto;font-size:11.5px;line-height:18px;min-width:20px;text-align:center;padding:0 6px;border-radius:99px;background:#3A4A55;color:#fff;font-variant-numeric:tabular-nums}
.hx .nbadge.hot{background:#C2453B}
.hx .sidefoot{margin-top:auto;padding-top:14px;display:flex;flex-direction:column;gap:6px}
.hx .sidebtn{display:flex;align-items:center;gap:8px;justify-content:center;border:1px solid #3A4A55;background:transparent;color:#E4EAED;border-radius:8px;padding:8px 10px}
.hx .sidebtn:hover{border-color:#7F909B}
.hx .sidebtn.primary{background:var(--teal);border-color:var(--teal);color:#fff}
.hx .content{min-width:0}
.hx .pagehead{position:sticky;top:0;z-index:20;background:rgba(238,241,239,.94);backdrop-filter:blur(6px);border-bottom:1px solid var(--line);padding:16px 28px 0}
.hx .pagehead:not(:has(.subtabs)){padding-bottom:14px}
.hx .subtabs{display:flex;gap:2px;overflow-x:auto;margin-top:12px}
.hx .subtabs button{border:0;background:none;padding:9px 12px;color:var(--ink2);border-bottom:2px solid transparent;white-space:nowrap;display:flex;align-items:center}
.hx .subtabs button:hover{color:var(--ink)}
.hx .subtabs button[aria-selected=true]{color:var(--ink);border-bottom-color:var(--teal);font-weight:600}
.hx .page{padding:20px 28px 56px;max-width:1380px}
.hx .bell{display:flex;align-items:center;gap:6px;padding:5px 9px}
.hx .bell .nbadge{margin-left:0}
.hx .mob{display:none;gap:6px}
.hx .note-strip{padding:9px 14px;border-radius:8px;margin-bottom:14px;background:var(--indigobg);font-size:13px}
.hx .hero{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:20px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:16px}
.hx .heroside{display:grid;grid-template-columns:1fr 1fr;gap:18px;border-left:1px solid var(--line);padding-left:20px}
.hx .heroside>div{display:flex;flex-direction:column;gap:4px}
.hx .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:16px}
.hx .tile{display:flex;flex-direction:column;gap:8px;align-items:flex-start;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;color:inherit;transition:border-color .15s,transform .15s}
.hx .tile:hover{border-color:var(--ink2);transform:translateY(-1px)}
.hx .prog{width:100%;height:8px;border-radius:99px;background:#E3E8E6;overflow:hidden}
.hx .prog>span{display:block;height:100%;border-radius:99px}
.hx .linkbtn{border:0;background:none;padding:0;color:var(--teal);text-align:left;font-size:12.5px;text-decoration:underline}
.hx .catrow{display:flex;align-items:center;justify-content:space-between;gap:8px;border:0;background:none;padding:5px 0;border-bottom:1px solid #EDF0EE;text-align:left;font-size:13px;color:inherit}
.hx .catrow:hover{color:var(--teal)}
@media (max-width:900px){
  .hx .shell{grid-template-columns:minmax(0,1fr)}
  .hx .side{position:sticky;top:0;z-index:30;height:auto;flex-direction:row;align-items:center;padding:6px 8px;overflow-x:auto}
  .hx .brand,.hx .nav .grp,.hx .sidefoot{display:none}
  .hx .nav{flex-direction:row;gap:2px}
  .hx .nav button{width:auto;white-space:nowrap;padding:8px 10px;font-size:13px}
  .hx .nav button[aria-current=page]{box-shadow:inset 0 -3px 0 #7FC8C2}
  .hx .pagehead{position:static;padding:14px 16px 0}
  .hx .page{padding:16px}
  .hx .mob{display:flex}
  .hx .hero{grid-template-columns:1fr}
  .hx .heroside{border-left:0;padding-left:0;border-top:1px solid var(--line);padding-top:14px}
}
@media (max-width:760px){.hx .stat{border-right:0;border-bottom:1px solid var(--line)}.hx .kv{grid-template-columns:1fr}.hx .heroside{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){.hx *{transition:none!important}}
`;

/* ======================================================================
   SMALL COMPONENTS
   ====================================================================== */
const CatDot = ({ c }) => <span className="dot" style={{ background: CAT_COLORS[c] || "#999" }} />;
const ChangeTxt = ({ d, p, invert }) => {
  if (d === null || d === undefined) return <span className="muted">—</span>;
  const up = d > 0;
  return <span className="num" style={{ color: d === 0 ? "var(--ink2)" : up !== !!invert ? "var(--red)" : "var(--green)" }}>{diffTxt(d)} <span className="muted">({pctTxt(p)})</span></span>;
};
const ReviewChip = ({ r }) => r.review === "open" ? <span className="chip review">Review</span> : r.review === "cleared" ? <span className="chip ok">Cleared</span> : r.review === "confirmed" ? <span className="chip bad">Confirmed problem</span> : null;
const ClsChip = ({ cls }) => {
  const map = { EXPENSE: ["ok", "Expense"], INTERNAL: ["ex", "Internal transfer"], FUNDING: ["ex", "Funding in"], FAILED: ["bad", "Failed"], REVERSED: ["bad", "Reversed"], PENDING: ["pend", "Pending"], UNVERIFIED: ["review", "Unverified"], OWNER_REPAYMENT: ["ex", "Owner loan repayment"] };
  const [k, l] = map[cls] || ["ex", cls];
  return <span className={`chip ${k}`}>{l}</span>;
};
function Empty({ children }) { return <div className="muted" style={{ padding: "28px 16px", textAlign: "center" }}>{children}</div>; }
function Section({ title, right, children, pad = true }) {
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="flex items-center justify-between" style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", gap: 12, flexWrap: "wrap" }}>
        <h2 className="h2">{title}</h2>{right}
      </div>
      <div style={pad ? { padding: 16 } : {}}>{children}</div>
    </section>
  );
}
function downloadCSV(name, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click();
}

/* ======================================================================
   DASHBOARD
   ====================================================================== */
/* ======================================================================
   NAVIGATION — one page per area, each with its own sub-tabs
   ====================================================================== */
const PAGES = [
  { k: "overview", label: "Today", group: "", icon: "grid", desc: "What needs your attention, and where the money stands" },
  { k: "fixed", label: "Fixed payments", group: "Daily work", icon: "calendar", month: true, desc: "Rent, links, caretakers and other scheduled payments — checked against Tende", subs: [["schedule", "This month"], ["other", "Other obligations"], ["register", "Set up"]] },
  { k: "payroll", label: "Payroll", group: "Daily work", icon: "people", desc: "Who has been paid this month and who has not", subs: [["schedule", "This month", true], ["people", "History"]] },
  { k: "inventory", label: "Inventory", group: "Daily work", icon: "box", desc: "What was bought, how many, and what each unit cost" },
  { k: "fuel", label: "Fuel & vehicles", group: "Daily work", icon: "fuel", desc: "Car and motorbike fuel against the usual amounts" },
  { k: "money", label: "Money in", group: "Daily work", icon: "coins", month: true, desc: "Revenue from M-Pesa, the OpEx allocation and cash plan", subs: [["revenue", "Revenue"], ["cash", "Cash plan"], ["budget", "Budget"]] },
  { k: "expenses", label: "All expenses", group: "More", more: true, icon: "list", desc: "Every Tende payment, searchable" },
  { k: "analysis", label: "Analysis", group: "More", more: true, icon: "chart", desc: "Where the money went and what changed", subs: [["drill", "Where it went"], ["compare", "Month comparison"], ["trend", "Trend"], ["connectivity", "Internet links"], ["recipients", "Recipients"], ["recurring", "Recurring"]] },
  { k: "reports", label: "Reports", group: "More", more: true, icon: "doc", desc: "Daily, weekly and monthly reports ready to share" },
  { k: "review", label: "Needs checking", group: "More", more: true, icon: "check", desc: "Odd payments to look at, and the quality of the imported data", subs: [["review", "Odd payments"], ["control", "Payment control"], ["health", "Data health"]] },
];
const pageOf = (k) => PAGES.find((p) => p.k === k) || PAGES[0];

const ICONS = {
  grid: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  calendar: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4",
  people: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 20c0-3 3-5 6-5s6 2 6 5M16 11a3 3 0 0 0 0-6M21 20c0-2.5-1.8-4.3-4-4.8",
  box: "M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10",
  list: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01",
  coins: "M12 3v18M17 7H9.5a2.5 2.5 0 0 0 0 5h5a2.5 2.5 0 0 1 0 5H7",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  doc: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7",
  check: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5",
  fuel: "M5 20V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v15M3 20h13M14 9h2.5a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 0 3 0V8l-3-3M7 8h5",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  ask: "M4 5h16v11H9l-5 4zM9 9h6M9 12h4",
};
const Icon = ({ name, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[name]} /></svg>
);

/* ======================================================================
   OVERVIEW — the month at a glance, with a way into every area
   ====================================================================== */
function Overview({ an, win, per, ctx, alerts, calendar, go, goDrill, openAlerts }) {
  const cur = an.expenses.filter((r) => inWin(r, win.cur));
  const prev = win.prev ? an.expenses.filter((r) => inWin(r, win.prev)) : null;
  const total = sum(cur, (r) => r.amount), prevTotal = prev ? sum(prev, (r) => r.amount) : null;
  const ch = change(total, prevTotal);
  const cats = groupTotals(cur, (r) => r.category);
  const rv = revenueFor((ctx.revenue && ctx.revenue.days) || {}, win.cur.from, win.cur.to);
  const pct = (+(ctx.calState && ctx.calState.opexPct) || 60) / 100;
  const ms = alerts.month;
  const payRows = calendar.rows.filter((r) => r.kind === "pay");
  const payDone = payRows.filter((r) => ["Paid", "Paid late", "Settled manually"].includes(r.status));
  const staff = payrollSummary(an, cur, null);
  const inv = inventoryRecord(cur.filter((r) => r.category === "Inventory & Equipment"));
  const priceMoves = priceHistory(an).filter((p) => p.prev && inWin({ day: p.last.day }, win.cur) && Math.abs(p.last.pct) >= 0.5);
  const ops = cur.filter((r) => !["Staff & Payroll", "Inventory & Equipment"].includes(r.category));
  const opsCats = groupTotals(ops, (r) => r.category);
  const att = attentionItems(an, { ...ctx, win });
  const urgent = [...alerts.groups.overdue, ...alerts.groups.today];
  const upcoming = alerts.groups.soon;
  const monthMode = ["day", "week", "month"].includes(per.mode);

  const Tile = ({ onClick, title, icon, children, tone }) => (
    <button className="tile" onClick={onClick} style={tone ? { borderTop: `3px solid ${tone}` } : {}}>
      <div className="flex items-center justify-between" style={{ width: "100%" }}>
        <span className="flex items-center" style={{ gap: 8, fontWeight: 600 }}><span style={{ color: "var(--teal)" }}><Icon name={icon} size={17} /></span>{title}</span>
        <span className="muted" style={{ fontSize: 12.5 }}>Open</span>
      </div>
      {children}
    </button>
  );
  const Prog = ({ v, of, color }) => <div className="prog" aria-hidden="true"><span style={{ width: `${of ? Math.min(100, (v / of) * 100) : 0}%`, background: color || "var(--teal)" }} /></div>;

  return (
    <div>
      {/* headline */}
      <section className="hero">
        <div>
          <div className="muted" style={{ fontSize: 13 }}>Spent in {per.label}{win.partial ? " so far" : ""}</div>
          <div className="num cond" style={{ fontSize: 44, fontWeight: 600, lineHeight: 1.05 }}>{ksh(total)}</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>{win.prev ? <>vs {ksh(prevTotal)} in the same span of {win.prev.label}: <ChangeTxt d={ch.diff} p={ch.pct} /></> : <span className="muted">No earlier data to compare with</span>}</div>
        </div>
        <div className="heroside">
          <div>
            <div className="muted" style={{ fontSize: 12.5 }}>Revenue</div>
            {rv.days ? <><div className="num" style={{ fontSize: 22, fontWeight: 600 }}>{ksh(rv.total)}</div><div style={{ fontSize: 12.5 }}>OpEx allowed {ksh(rv.total * pct)} · spent <span style={{ color: total > rv.total * pct ? "var(--red)" : "var(--green)", fontWeight: 600 }}>{rv.total ? ((total / rv.total) * 100).toFixed(0) : "—"}%</span> of revenue</div></>
              : <><div className="muted" style={{ fontSize: 15, fontWeight: 600 }}>Not imported</div><button className="linkbtn" onClick={() => go("money", "revenue")}>Import the M-Pesa utility statement</button></>}
          </div>
          <div>
            <div className="muted" style={{ fontSize: 12.5 }}>Fixed payments · {fmtMonth(alerts.view)}</div>
            <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>{ms.settled} of {ms.scheduled} settled</div>
            <Prog v={ms.settled} of={ms.scheduled} />
          </div>
        </div>
      </section>

      {/* areas */}
      <div className="tiles">
        <Tile onClick={() => go("fixed", "schedule")} title="Fixed payments" icon="calendar" tone={alerts.counts.overdue ? "var(--red)" : alerts.counts.today ? "var(--amber)" : null}>
          <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{ksh(ms.unpaid)} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>still to settle</span></div>
          <div style={{ fontSize: 13 }}>
            {alerts.counts.overdue ? <span style={{ color: "var(--red)" }}>{alerts.counts.overdue} overdue · </span> : null}
            {alerts.counts.today ? <span style={{ color: "var(--amber)" }}>{alerts.counts.today} due today · </span> : null}
            {alerts.counts.soon ? `${alerts.counts.soon} due in ${alerts.ahead} days` : !alerts.counts.overdue && !alerts.counts.today ? "Nothing urgent" : ""}
          </div>
        </Tile>
        <Tile onClick={() => go("payroll", payRows.length ? "schedule" : "people")} title="Payroll" icon="people">
          {payRows.length ? <>
            <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{payDone.length} of {payRows.length} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>staff paid</span></div>
            <Prog v={payDone.length} of={payRows.length} />
            <div style={{ fontSize: 13 }}>{ksh(sum(payRows, (r) => r.paid))} of {ksh(sum(payRows, (r) => r.expected))} net pay</div>
          </> : <>
            <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{ksh(staff.total)}</div>
            <div style={{ fontSize: 13 }}>paid to staff · salary {ksh(staff.byType.Salary)} · advances {ksh(staff.byType["Salary advance"])}</div>
          </>}
        </Tile>
        <Tile onClick={() => go("inventory", "record")} title="Inventory" icon="box">
          <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{ksh(inv.total)}</div>
          <div style={{ fontSize: 13 }}>{inv.rows.length} items recorded{inv.mixed.length + inv.unstated.length ? <span style={{ color: "#9C5700" }}> · {inv.mixed.length + inv.unstated.length} payments need item detail</span> : ""}</div>
          {priceMoves.length > 0 && <div style={{ fontSize: 12.5 }}>{priceMoves.slice(0, 2).map((p) => <div key={p.name}>{p.name}: <span style={{ color: p.last.change > 0 ? "var(--red)" : "var(--green)" }}>{ksh(p.prev.unitCost)} → {ksh(p.last.unitCost)}</span></div>)}</div>}
        </Tile>
        <Tile onClick={() => go("fuel")} title="Fuel & vehicles" icon="fuel">
          {(() => { const fr = cur.filter((r) => r.category === "Fuel & Transport" && FUEL_SUBS.includes(r.subcategory)); const ln = fr.flatMap((r) => fuelParts(r).map((p) => ({ ...p, msg: fuelCheck(p) }))); const bad = ln.filter((l) => l.msg).length; return <>
            <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{ksh(sum(fr, (r) => r.amount))}</div>
            <div style={{ fontSize: 13 }}>{fr.length} fuel payment{fr.length === 1 ? "" : "s"} · {bad ? <span style={{ color: "var(--red)" }}>{bad} above usual</span> : <span style={{ color: "var(--green)" }}>all within usual</span>}</div></>; })()}
        </Tile>
        <Tile onClick={() => goDrill([])} title="Running costs" icon="chart">
          <div className="num" style={{ fontSize: 20, fontWeight: 600 }}>{ksh(sum(ops, (r) => r.amount))}</div>
          <div style={{ fontSize: 12.5, width: "100%" }}>{opsCats.slice(0, 4).map((c) => <div key={c.key} className="flex justify-between" style={{ gap: 12, padding: "2px 0" }}><span><CatDot c={c.key} />{c.key}</span><span className="num">{ksh(c.total)}</span></div>)}</div>
        </Tile>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))", gap: 16, marginBottom: 16 }}>
        <Section title="Needs attention" right={urgent.length ? <button className="btn small" onClick={openAlerts}>All alerts</button> : null}>
          {urgent.slice(0, 5).map((x) => (
            <div className="att" key={x.key}><span className="bar" style={{ background: x.level === "overdue" ? "var(--red)" : "var(--amber)" }} />
              <div style={{ flex: 1 }}><div className="flex justify-between" style={{ gap: 8 }}><b style={{ fontWeight: 600 }}>{x.row.name}</b><span className="num" style={{ fontWeight: 600 }}>{ksh(x.row.remaining)}</span></div>
                <div className="muted" style={{ fontSize: 12.5 }}>{x.level === "overdue" ? `${alerts.mode === "past" ? "Still unpaid" : `${x.daysLate} day${x.daysLate === 1 ? "" : "s"} overdue`} · due ${fmtDay(x.row.due)}` : "Due today"}</div></div></div>
          ))}
          {urgent.length > 5 && <div className="muted" style={{ fontSize: 12.5, paddingTop: 6 }}>+{urgent.length - 5} more in alerts</div>}
          {att.filter((a) => !/payment calendar/.test(a.text)).slice(0, 5).map((a, i) => (
            <div className="att" key={i}><span className="bar" style={{ background: a.level === "review" ? "var(--amber)" : a.level === "watch" ? "var(--red)" : "var(--line)" }} /><div style={{ fontSize: 13 }}>{a.text}</div></div>
          ))}
          {!urgent.length && !att.length && <Empty>Nothing needs attention right now.</Empty>}
        </Section>
        <Section title={`Coming up — next ${alerts.ahead} days`}>
          {alerts.mode !== "current" ? <div className="muted">Switch to the current month to see what's coming up.</div>
            : upcoming.length ? upcoming.map((x) => (
              <div className="att" key={x.key}><span className="bar" style={{ background: "var(--indigo)" }} />
                <div style={{ flex: 1 }}><div className="flex justify-between" style={{ gap: 8 }}><span>{x.row.name}</span><span className="num" style={{ fontWeight: 600 }}>{ksh(x.row.remaining)}</span></div>
                  <div className="muted" style={{ fontSize: 12.5 }}>{fmtDay(x.row.due)} · in {x.daysToDue} day{x.daysToDue === 1 ? "" : "s"} · {x.row.payeeLabel}</div></div></div>
            )) : <Empty>No fixed payments fall due in the next {alerts.ahead} days.</Empty>}
        </Section>
      </div>

      {cur.length > 0 && (
        <Section title="Where the money went" right={<button className="btn small" onClick={() => goDrill([])}>Drill down</button>}>
          <div className="ribbon" role="list" aria-label="Spending by category">
            {cats.map((c) => <button key={c.key} role="listitem" title={`${c.key}: ${ksh(c.total)}`} aria-label={`${c.key} ${ksh(c.total)}`} onClick={() => goDrill([c.key])} style={{ width: `${(c.total / total) * 100}%`, background: CAT_COLORS[c.key] }} />)}
          </div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: "6px 24px", marginTop: 12 }}>
            {cats.map((c) => {
              const p = prev ? sum(prev.filter((r) => r.category === c.key), (r) => r.amount) : null; const x = change(c.total, p);
              return (
                <button key={c.key} className="catrow" onClick={() => goDrill([c.key])}>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><CatDot c={c.key} />{c.key}</span>
                  <span className="num" style={{ whiteSpace: "nowrap" }}><b style={{ fontWeight: 600 }}>{ksh(c.total)}</b> <span className="muted">{((c.total / total) * 100).toFixed(0)}%</span>{p !== null && x.pct !== null && Math.abs(x.pct) >= 0.5 && <span style={{ marginLeft: 6, fontSize: 12, color: x.diff > 0 ? "var(--red)" : "var(--green)" }}>{pctTxt(x.pct)}</span>}</span>
                </button>);
            })}
          </div>
        </Section>
      )}
      {!cur.length && <Section title="No spending in this period"><Empty>No Tende payments fall in {per.label}. Move the period or import a newer Tende export.</Empty></Section>}
      {!monthMode && <div className="muted" style={{ fontSize: 12.5 }}>Fixed payments and payroll follow the month of the latest data ({fmtMonth(alerts.view)}).</div>}
    </div>
  );
}

/* ======================================================================
   EXPENSE REGISTER
   ====================================================================== */
const EMPTY_FILTER = { q: "", cat: "", wallet: "", initiator: "", min: "", max: "", recurring: false, flagged: false, scope: "expense" };
function Register({ an, win, filter, setFilter, openTxn }) {
  const [sort, setSort] = useState({ k: "ts", dir: -1 });
  const [show, setShow] = useState(150);
  const base = filter.scope === "all" ? an.recs.filter((r) => !r.day || inWin(r, win.cur)) : an.expenses.filter((r) => inWin(r, win.cur));
  const lc = (s) => String(s || "").toLowerCase();
  const rows = base.filter((r) =>
    (!filter.cat || r.category === filter.cat) && (!filter.wallet || r.wallet === filter.wallet) &&
    (!filter.initiator || (r.initiator || "(not recorded)") === filter.initiator) &&
    (!filter.min || r.amount >= +filter.min) && (!filter.max || r.amount <= +filter.max) &&
    (!filter.recurring || r.recurring) && (!filter.flagged || (r.flags && r.flags.length && r.review !== "cleared")) &&
    (!filter.q || [r.remark, r.payee, r.receiverId, r.id, r.subcategory, r.txnRef].some((x) => lc(x).includes(lc(filter.q))))
  ).sort((a, b) => (sort.k === "amount" ? (a.amount - b.amount) : String(a[sort.k]).localeCompare(String(b[sort.k]))) * sort.dir);
  const wallets = [...new Set(an.recs.map((r) => r.wallet))];
  const inits = [...new Set(an.expenses.map((r) => r.initiator || "(not recorded)"))];
  const set = (k, v) => { setFilter({ ...filter, [k]: v }); setShow(150); };
  const th = (k, label, right) => <th className={right ? "r" : ""}><button style={{ border: 0, background: "none", padding: 0, color: "inherit", font: "inherit" }} onClick={() => setSort({ k, dir: sort.k === k ? -sort.dir : -1 })}>{label}{sort.k === k ? (sort.dir < 0 ? " ↓" : " ↑") : ""}</button></th>;
  const exportRows = () => downloadCSV(`happynet-expenses-${win.cur.from}-to-${win.cur.to}.csv`, rows.map((r) => ({
    Date: r.date, TransactionID: r.id, MpesaRef: r.txnRef, Wallet: r.wallet, Class: r.cls, Category: r.category || "", Subcategory: r.subcategory || "", Description: r.remark, Amount: r.amount, Charge: r.charge,
    Recipient: r.payee, ReceiverNo: r.receiverId, InitiatedBy: r.initiator, ApprovedBy: r.approver, Status: r.statusRaw, Recurring: r.recurring ? "Yes" : "", Flags: (r.flags || []).map((f) => f.label).join("; "), Review: r.review || "", Confidence: r.confidence || "", Basis: r.basis || "", Note: r.note || "",
  })));

  return (
    <Section title={`Expenses · ${rows.length} ${filter.scope === "all" ? "rows" : "payments"} · ${ksh(sum(rows.filter((r) => r.cls === "EXPENSE"), (r) => r.amount))}`}
      right={<div className="flex" style={{ gap: 8 }}><button className="btn small" onClick={() => setFilter({ ...EMPTY_FILTER })}>Clear filters</button><button className="btn small" onClick={exportRows}>Export CSV</button></div>} pad={false}>
      <div className="flex flex-wrap items-center" style={{ gap: 8, padding: 12, borderBottom: "1px solid var(--line)" }}>
        <input aria-label="Search" placeholder="Search remark, recipient, ID…" value={filter.q} onChange={(e) => set("q", e.target.value)} style={{ minWidth: 220, flex: "1 1 220px" }} />
        <select aria-label="Category" value={filter.cat} onChange={(e) => set("cat", e.target.value)}><option value="">All categories</option>{CATEGORY_ORDER.map((c) => <option key={c}>{c}</option>)}</select>
        <select aria-label="Wallet" value={filter.wallet} onChange={(e) => set("wallet", e.target.value)}><option value="">All wallets</option>{wallets.map((w) => <option key={w}>{w}</option>)}</select>
        <select aria-label="Initiated by" value={filter.initiator} onChange={(e) => set("initiator", e.target.value)}><option value="">Anyone</option>{inits.map((w) => <option key={w}>{w}</option>)}</select>
        <input aria-label="Minimum amount" placeholder="Min KSh" value={filter.min} onChange={(e) => set("min", e.target.value.replace(/[^\d]/g, ""))} style={{ width: 90 }} />
        <input aria-label="Maximum amount" placeholder="Max KSh" value={filter.max} onChange={(e) => set("max", e.target.value.replace(/[^\d]/g, ""))} style={{ width: 90 }} />
        <button className="pill" aria-pressed={filter.recurring} onClick={() => set("recurring", !filter.recurring)}>Recurring</button>
        <button className="pill" aria-pressed={filter.flagged} onClick={() => set("flagged", !filter.flagged)}>Needs review</button>
        <button className="pill" aria-pressed={filter.scope === "all"} onClick={() => set("scope", filter.scope === "all" ? "expense" : "all")}>Show excluded rows</button>
      </div>
      <div className="scroll" style={{ maxHeight: "68vh" }}>
        <table className="t">
          <thead><tr>{th("ts", "Date")}<th>Wallet</th>{filter.scope === "all" && <th>Type</th>}{th("category", "Category")}<th>Description</th>{th("amount", "Amount", true)}{th("payee", "Recipient")}<th>Initiated by</th><th>Approved by</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.slice(0, show).map((r) => (
              <tr key={r.id} className="click" onClick={() => openTxn(r.id)}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{r.date.slice(0, 16)}<div className="muted" style={{ fontSize: 11.5 }}>{r.id}</div></td>
                <td style={{ whiteSpace: "nowrap" }}>{r.wallet}</td>
                {filter.scope === "all" && <td><ClsChip cls={r.cls} /></td>}
                <td style={{ minWidth: 160 }}>{r.category ? <><CatDot c={r.category} />{r.category}<div className="muted" style={{ fontSize: 12 }}>{r.subcategory}{r.confidence && r.confidence !== "High" ? ` · ${r.confidence}` : ""}</div></> : <span className="muted">—</span>}</td>
                <td style={{ minWidth: 200, maxWidth: 320 }}>{r.remark || <span className="muted">(no remark)</span>}
                  {r.category === "Staff & Payroll" && <div className="muted" style={{ fontSize: 12 }}>{r.payType} · {r.employee || "employee not in source"} · relates to {relText(r)}</div>}
                  {r.category === "Inventory & Equipment" && <div className="muted" style={{ fontSize: 12 }}>{itemsText(r) || "item not identified"}{r.unitCost ? ` · ${ksh(r.unitCost)} each (calc.)` : ""}</div>}</td>
                <td className="r num" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{ksh(r.amount)}</td>
                <td style={{ minWidth: 150 }}>{titleCase(r.payee)}</td>
                <td style={{ whiteSpace: "nowrap" }}>{r.initiator || <span className="muted">—</span>}</td>
                <td>{r.approver || <span className="muted">—</span>}</td>
                <td>{r.statusNorm === "SUCCESS" ? <span className="muted">Success</span> : <ClsChip cls={r.cls} />}</td>
                <td style={{ whiteSpace: "nowrap" }}>{r.recurring && <span className="chip ex" style={{ marginRight: 4 }}>Recurring</span>}<ReviewChip r={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty>No payments match these filters in this period.</Empty>}
        {rows.length > show && <div style={{ padding: 12, textAlign: "center" }}><button className="btn" onClick={() => setShow(show + 300)}>Show {Math.min(300, rows.length - show)} more</button></div>}
      </div>
    </Section>
  );
}

/* ---------- transaction detail drawer (audit + classification + review) ---------- */
function TxnDrawer({ rec, override, onSave, onClose, reviewer, setReviewer }) {
  const o = override || {};
  const [cat, setCat] = useState(o.category || "");
  const [subc, setSubc] = useState(o.subcategory || "");
  const [cls, setCls] = useState(o.cls || "");
  const [note, setNote] = useState(o.note || "");
  const [employee, setEmployee] = useState(o.employee || "");
  const [payType, setPayType] = useState(o.payType || "");
  const [relatesTo, setRelatesTo] = useState(o.relatesTo || "");
  const initLines = () => (o.itemLines ? o.itemLines.map((l) => ({ ...l }))
    : o.item ? [{ name: LEGACY_ITEM[o.item] || o.item, qty: o.qty || "", unit: o.unit || "units", amount: "" }]
    : (rec.items || []).map((i) => ({ name: i.name, qty: i.qty || "", unit: i.unit || "units", amount: i.amount ?? "", fromSource: i.qtySource === "source" })));
  const [lines, setLines] = useState(initLines);
  const [linesTouched, setLinesTouched] = useState(false);
  const setLine = (i, f) => { const a = lines.map((l) => ({ ...l })); a[i] = { ...a[i], ...f }; if ("qty" in f) a[i].fromSource = false; setLines(a); setLinesTouched(true); };
  const [reason, setReason] = useState("");
  const [rnote, setRnote] = useState(o.reviewNote || "");
  const [err, setErr] = useState("");
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  if (!rec) return null;
  const subs = [...new Set(RULES.filter((r) => r.cat === cat).map((r) => r.sub))];
  const effCat = cat || rec.category;
  const fields = () => ({
    category: cat || undefined, subcategory: cat ? (subc || subs[0] || "General") : undefined, cls: cls || undefined, note: note || undefined,
    employee: employee || undefined, payType: payType || undefined, relatesTo: relatesTo || undefined, itemLines: linesTouched || o.itemLines ? lines.filter((l) => String(l.name || "").trim()).map((l) => ({ name: l.name.trim(), qty: l.qty, unit: l.unit || "units", amount: l.amount, fromSource: !!l.fromSource })) : undefined,
  });
  const save = (extra = {}, why) => {
    const r = (why ?? reason).trim();
    if (!reviewer.trim()) { setErr("Enter your name so the change can be traced."); return; }
    if (!r) { setErr("Give a short reason for the change."); return; }
    setErr(""); onSave(rec.id, { ...o, ...fields(), reviewNote: rnote || undefined, ...extra }, { by: reviewer.trim(), reason: r }); setReason("");
  };
  const D = ({ k, children }) => <><dt>{k}</dt><dd>{children}</dd></>;
  const NA = () => <span className="muted">Not available in source</span>;
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Transaction detail">
        <div className="flex items-start justify-between" style={{ padding: 16, borderBottom: "1px solid var(--line)", gap: 12 }}>
          <div>
            <div className="num cond" style={{ fontSize: 24, fontWeight: 600 }}>{ksh(rec.amount)}</div>
            <div>{rec.remark || "(no remark)"}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>{titleCase(rec.payee)} · {rec.date} · {rec.wallet}</div>
          </div>
          <button className="btn small" onClick={onClose} aria-label="Close">Close</button>
        </div>
        <div style={{ padding: 16, overflow: "auto", flex: 1 }}>
          <div className="flex flex-wrap" style={{ gap: 6, marginBottom: 14 }}><ClsChip cls={rec.cls} />{rec.recurring && <span className="chip ex">Recurring</span>}<ReviewChip r={rec} />{rec.purchaseDetail && <span className={`chip ${rec.purchaseDetail === "Complete" ? "ok" : rec.purchaseDetail === "Quantities only" ? "ex" : "review"}`}>{rec.purchaseDetail}</span>}</div>

          {rec.flags && rec.flags.length > 0 && (
            <div style={{ background: "var(--amberbg)", borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Detected for review</div>
              {rec.flags.map((f, i) => <div key={i} style={{ marginBottom: 4 }}><b>{f.label}.</b> {f.detail}</div>)}
              <div className="muted" style={{ fontSize: 12, margin: "6px 0 8px" }}>A detected anomaly is not a confirmed problem. Record the outcome once checked.</div>
              <textarea rows={2} placeholder="Review note (what was checked)" value={rnote} onChange={(e) => setRnote(e.target.value)} style={{ width: "100%" }} />
              <div className="flex flex-wrap" style={{ gap: 8, marginTop: 8 }}>
                <button className="btn small" onClick={() => save({ review: "cleared" }, rnote || "Reviewed — no issue")}>Clear — no issue</button>
                <button className="btn small" onClick={() => save({ review: "confirmed" }, rnote || "Confirmed as a problem")}>Confirm problem</button>
                {rec.review !== "open" && <button className="btn small" onClick={() => save({ review: undefined }, rnote || "Reopened for review")}>Reopen</button>}
              </div>
            </div>
          )}

          <h3 className="h2" style={{ marginBottom: 8 }}>Expense detail</h3>
          <dl className="kv" style={{ marginBottom: 16 }}>
            <D k="Transaction type">{rec.cls} — {rec.clsReason}</D>
            {rec.category && <><D k="Category"><CatDot c={rec.category} />{rec.category}</D><D k="Subcategory">{rec.subcategory}</D><D k="Confidence">{rec.confidence} — {rec.basis}</D></>}
            <D k="Amount"><span className="num">{ksh(rec.amount)}</span> <span className="muted">+ {ksh(rec.charge)} charge</span></D>
            <D k="Payment date">{fmtDay(rec.day)}</D>
            <D k="Relates to">{rec.relatesTo ? fmtMonth(rec.relatesTo) : rec.payType === "Salary advance" ? "Future period not specified" : <NA />} <span className="muted">· {rec.relatesHow}</span></D>
            {rec.category === "Staff & Payroll" && <>
              <D k="Employee">{rec.employee || <NA />}{rec.employeeManual && <span className="muted"> · set by reviewer</span>}</D>
              <D k="Payment type">{rec.payType}{rec.payTypeManual && <span className="muted"> · set by reviewer</span>}</D>
            </>}
            {rec.category === "Inventory & Equipment" && <>
              <D k="Items">{rec.items.length ? rec.items.map((i, n) => <div key={n}><b style={{ fontWeight: 600 }}>{i.name}</b>{i.specMissing && <span className="chip review" style={{ marginLeft: 4 }}>type/size not stated</span>} — {i.qty ? <>{i.qty} {i.unit} <span className="muted">({i.qtySource === "manual" ? "reviewer" : "source"})</span></> : <span className="muted">quantity not in source</span>}{i.lineCost !== null && i.lineCost !== undefined && rec.items.length > 1 ? <span className="num"> · {ksh(i.lineCost)}</span> : null}{i.unitCost ? <span className="muted num"> · {ksh(i.unitCost)} each</span> : null}</div>) : <span className="muted">Item not identified in remark</span>}{rec.itemsManual && <div className="muted" style={{ fontSize: 12 }}>Itemised by a reviewer</div>}</D>
              <D k="Unit cost">{rec.unitCost ? <><span className="num">{ksh(rec.unitCost)}</span> <span className="muted">· {rec.unitCostSource}</span></> : <span className="muted">{rec.unitCostSource}</span>}</D>
              <D k="Supplier">{titleCase(rec.payee)}</D>
            </>}
            {rec.category !== "Inventory & Equipment" && <D k="Paid to">{titleCase(rec.payee)}</D>}
            <D k="Reference">{rec.txnRef || <NA />} <span className="muted">· Tende {rec.id}</span></D>
            <D k="Payment status">{rec.statusRaw}</D>
            <D k="Initiated / approved">{rec.initiator || "—"} / {rec.approver || <span className="muted">not recorded</span>}</D>
          </dl>

          <h3 className="h2" style={{ marginBottom: 8 }}>Correct the classification</h3>
          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label style={{ fontSize: 12.5 }}>Category<select value={cat} onChange={(e) => { setCat(e.target.value); setSubc(""); }} style={{ width: "100%" }}><option value="">Automatic</option>{CATEGORY_ORDER.map((c) => <option key={c}>{c}</option>)}</select></label>
            <label style={{ fontSize: 12.5 }}>Subcategory<input list="hx-subs" value={subc} onChange={(e) => setSubc(e.target.value)} disabled={!cat} style={{ width: "100%" }} /><datalist id="hx-subs">{subs.map((s) => <option key={s} value={s} />)}</datalist></label>
            <label style={{ fontSize: 12.5 }}>Treat as<select value={cls} onChange={(e) => setCls(e.target.value)} style={{ width: "100%" }}><option value="">Automatic</option><option value="EXPENSE">Actual expense</option><option value="INTERNAL">Internal transfer</option><option value="FUNDING">Funding in</option><option value="OWNER_REPAYMENT">Owner loan repayment</option><option value="UNVERIFIED">Unverified</option></select></label>
            <label style={{ fontSize: 12.5 }}>Relates to month<input type="month" value={relatesTo} onChange={(e) => setRelatesTo(e.target.value)} style={{ width: "100%" }} /></label>
            {effCat === "Staff & Payroll" && <>
              <label style={{ fontSize: 12.5 }}>Employee<input value={employee} placeholder={rec.employee || "Name"} onChange={(e) => setEmployee(e.target.value)} style={{ width: "100%" }} /></label>
              <label style={{ fontSize: 12.5 }}>Payment type<select value={payType} onChange={(e) => setPayType(e.target.value)} style={{ width: "100%" }}><option value="">Automatic</option>{PAY_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
            </>}
            {effCat === "Inventory & Equipment" && (
              <div style={{ gridColumn: "1 / -1", background: "#F7F9F8", borderRadius: 8, padding: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>What exactly was bought</div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>One line per item, with type or size in the name (e.g. "Router — Tenda", "FAT box — 1:16", "Patch cord — SC-SC"). Amounts are optional; if they add up to {ksh(rec.amount)}, each item's cost is known.</div>
                <datalist id="hx-items">{[...new Set([...ITEM_SUGGESTIONS, ...(rec.items || []).map((i) => i.name)])].map((n) => <option key={n} value={n} />)}</datalist>
                {lines.map((l, i) => (
                  <div key={i} className="flex items-center" style={{ gap: 4, marginBottom: 4 }}>
                    <input list="hx-items" value={l.name} onChange={(e) => setLine(i, { name: e.target.value })} placeholder="Item — type/size" style={{ flex: "2 1 160px" }} />
                    <input inputMode="numeric" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value.replace(/[^\d]/g, "") })} placeholder="Qty" style={{ width: 52 }} />
                    <select value={UNIT_WORDS[l.unit] || l.unit || "pcs"} onChange={(e) => setLine(i, { unit: e.target.value })} style={{ width: 82 }}>{["pcs", "packets", "rolls", "drums", "km", "m"].map((u) => <option key={u}>{u}</option>)}</select>
                    <input inputMode="numeric" value={l.amount ?? ""} onChange={(e) => setLine(i, { amount: e.target.value.replace(/[^\d.]/g, "") })} placeholder="KSh" style={{ width: 80 }} />
                    <button className="btn small" aria-label="Remove line" onClick={() => { setLines(lines.filter((_, j) => j !== i)); setLinesTouched(true); }}>×</button>
                  </div>))}
                <div className="flex items-center justify-between" style={{ gap: 8, marginTop: 4 }}>
                  <button className="btn small" onClick={() => { setLines([...lines, { name: "", qty: "", unit: "pcs", amount: "" }]); setLinesTouched(true); }}>Add item line</button>
                  {lines.some((l) => l.amount !== "" && l.amount !== undefined && l.amount !== null) && (() => { const t = sum(lines, (l) => +l.amount || 0); return <span className="num" style={{ fontSize: 12.5, color: Math.abs(t - rec.amount) <= 1 ? "var(--green)" : "var(--amber)" }}>Lines total {ksh(t)} of {ksh(rec.amount)}</span>; })()}
                </div>
              </div>
            )}
            <label style={{ fontSize: 12.5, gridColumn: "1 / -1" }}>Note<input value={note} onChange={(e) => setNote(e.target.value)} style={{ width: "100%" }} /></label>
            <label style={{ fontSize: 12.5 }}>Your name<input value={reviewer} onChange={(e) => setReviewer(e.target.value)} style={{ width: "100%" }} /></label>
            <label style={{ fontSize: 12.5 }}>Reason for change<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. confirmed with the accountant" style={{ width: "100%" }} /></label>
          </div>
          {err && <div style={{ color: "var(--red)", fontSize: 13, marginTop: 6 }}>{err}</div>}
          <div className="flex" style={{ gap: 8, margin: "10px 0 6px" }}><button className="btn primary small" onClick={() => save()}>Save changes</button><span className="muted" style={{ fontSize: 12 }}>Saved separately — the original Tende row never changes.</span></div>

          {rec.history && rec.history.length > 0 && <>
            <h3 className="h2" style={{ margin: "16px 0 8px" }}>Change history</h3>
            {[...rec.history].reverse().map((h, i) => <div key={i} style={{ fontSize: 13, padding: "6px 0", borderBottom: "1px solid #EDF0EE" }}><b style={{ fontWeight: 600 }}>{h.by}</b> <span className="muted">· {h.at}</span><div>{h.changes}</div><div className="muted">Reason: {h.reason}</div></div>)}
          </>}

          <h3 className="h2" style={{ margin: "18px 0 8px" }}>Original Tende record</h3>
          <dl className="kv">{Object.entries(rec.raw).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd className="num">{String(v ?? "") || <span className="muted">(empty)</span>}</dd></React.Fragment>)}</dl>
        </div>
      </aside>
    </>
  );
}

/* ======================================================================
   ANALYSIS
   ====================================================================== */
function Analysis({ an, win, period, goRegister, openTxn, view, setView, path, setPath }) {
  const views = [["drill", "Where it went"], ["payroll", "Payroll"], ["inventory", "Inventory record"], ["purchases", "Purchases"], ["advanta", "Advanta & connectivity"], ["compare", "Month comparison"], ["recipients", "Recipients"], ["trend", "Trend"]];
  return (
    <div>
      <div className="flex flex-wrap" style={{ gap: 6, marginBottom: 14 }}>{views.map(([k, l]) => <button key={k} className="pill" aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}</div>
      {view === "drill" && <DrillDown an={an} win={win} path={path} setPath={setPath} openTxn={openTxn} />}
      {view === "payroll" && <PayrollView an={an} win={win} period={period} openTxn={openTxn} />}
      {view === "purchases" && <PurchasesView an={an} win={win} openTxn={openTxn} />}
      {view === "advanta" && <AdvantaView an={an} win={win} openTxn={openTxn} goDrill={(p) => { setPath(p); setView("drill"); }} />}
      {view === "compare" && <MonthCompare an={an} win={win} period={period} openTxn={openTxn} />}
      {view === "recipients" && <RecipientsView an={an} win={win} openTxn={openTxn} />}
      {view === "trend" && <TrendView an={an} win={win} period={period} />}
      {view === "inventory" && <InventoryRecordView an={an} win={win} period={period} openTxn={openTxn} />}
    </div>
  );
}

const SourceNote = () => (
  <div className="muted" style={{ fontSize: 12.5, padding: "10px 16px", borderBottom: "1px solid var(--line)" }}>
    <b style={{ fontWeight: 600, color: "var(--ink2)" }}>Source</b> = stated in the Tende remark. <b style={{ fontWeight: 600, color: "var(--ink2)" }}>Calculated</b> = worked out from source figures. <b style={{ fontWeight: 600, color: "var(--ink2)" }}>Not available in source</b> = the remark doesn't say, so nothing is assumed.
  </div>
);

function TxnTable({ rows, openTxn, cat }) {
  return (
    <div className="scroll" style={{ maxHeight: "60vh" }}>
      <table className="t"><thead><tr><th>Date</th><th>Description</th><th>{cat === "Staff & Payroll" ? "Payment type · relates to" : cat === "Inventory & Equipment" ? "Items · quantity" : "Subcategory"}</th><th className="r">Amount</th><th>Paid to</th><th>Reference</th><th></th></tr></thead>
        <tbody>{[...rows].sort((a, b) => b.ts.localeCompare(a.ts)).map((r) => (
          <tr key={r.id} className="click" onClick={() => openTxn(r.id)}>
            <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.day)}</td>
            <td style={{ minWidth: 180 }}>{r.remark}</td>
            <td style={{ minWidth: 160 }}>{r.category === "Staff & Payroll" ? <>{r.payType}<div className="muted" style={{ fontSize: 12 }}>{relText(r)}</div></> : r.category === "Inventory & Equipment" ? <>{itemsText(r) || <span className="muted">Item not identified</span>}{r.unitCost && <div className="muted" style={{ fontSize: 12 }}>{ksh(r.unitCost)} each (calculated)</div>}</> : r.subcategory}</td>
            <td className="r num" style={{ fontWeight: 600 }}>{ksh(r.amount)}</td>
            <td>{titleCase(r.payee)}</td>
            <td className="num" style={{ fontSize: 12.5 }}>{r.txnRef}<div className="muted">{r.id}</div></td>
            <td><ReviewChip r={r} /></td>
          </tr>))}</tbody></table>
    </div>
  );
}

/* ---------- drill-down: total → category → subcategory → item / person / payee → transactions ---------- */
function DrillDown({ an, win, path, setPath, openTxn }) {
  const cur = an.expenses.filter((r) => inWin(r, win.cur));
  const prev = win.prev ? an.expenses.filter((r) => inWin(r, win.prev)) : null;
  const [cat, sub, det] = path;
  const keyFns = [(r) => r.category, (r) => r.subcategory, detailKey];
  const match = (r) => (!cat || r.category === cat) && (!sub || r.subcategory === sub) && (!det || detailKey(r) === det);
  const scoped = cur.filter(match);
  const total = sum(scoped, (r) => r.amount);
  const level = path.length;
  const crumbs = [["All expenses", []], ...path.map((p, i) => [p, path.slice(0, i + 1)])];

  let body;
  if (level >= 3) body = <TxnTable rows={scoped} openTxn={openTxn} cat={cat} />;
  else {
    const kf = keyFns[level];
    const groups = groupTotals(scoped, kf);
    if (level === 0) groups.sort((a, b) => CATEGORY_ORDER.indexOf(a.key) - CATEGORY_ORDER.indexOf(b.key) || b.total - a.total);
    const histScope = an.expenses.filter((r) => (!cat || r.category === cat) && (!sub || r.subcategory === sub));
    const showUnits = cat === "Inventory & Equipment" && level === 2;
    body = (
      <div className="scroll">
        <table className="t"><thead><tr>
          <th>{level === 0 ? "Category" : level === 1 ? "Subcategory" : detailLabel(cat)}</th><th className="r">Payments</th><th className="r">Total</th><th className="r">Share</th>
          {showUnits && <><th className="r">Quantity (from remarks)</th><th className="r">Unit cost</th></>}
          <th>Frequency</th>{prev && <><th className="r">Previous period</th><th className="r">Change</th></>}<th></th>
        </tr></thead>
          <tbody>{groups.map((g) => {
            const hist = histScope.filter((r) => kf(r) === g.key);
            const p = prev ? sum(prev.filter((r) => match(r) && kf(r) === g.key), (r) => r.amount) : null;
            const x = change(g.total, p);
            const single = g.list.filter((r) => r.items && r.items.length === 1 && r.items[0].qty);
            const q = sum(single, (r) => r.items[0].qty), qs = sum(single, (r) => r.amount);
            return (
              <tr key={g.key} className="click" onClick={() => setPath([...path, g.key])}>
                <td style={{ fontWeight: level === 0 ? 600 : 400, minWidth: 200 }}>{level === 0 && <CatDot c={g.key} />}{g.key}</td>
                <td className="r num">{g.count}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(g.total)}</td><td className="r num muted">{total ? ((g.total / total) * 100).toFixed(1) + "%" : "—"}</td>
                {showUnits && <><td className="r num">{q ? `${q} ${single[0].items[0].unit}` : <span className="muted">Not available in source</span>}{q && single.length < g.count ? <div className="muted" style={{ fontSize: 11.5 }}>stated in {single.length} of {g.count} payments</div> : null}</td>
                  <td className="r num">{q ? <>{ksh(qs / q)}<div className="muted" style={{ fontSize: 11.5 }}>calculated</div></> : <span className="muted">—</span>}</td></>}
                <td style={{ whiteSpace: "nowrap" }}>{frequencyOf(hist)}</td>
                {prev && <><td className="r num muted">{ksh(p)}</td><td className="r"><ChangeTxt d={x.diff} p={x.pct} /></td></>}
                <td className="muted">›</td>
              </tr>);
          })}</tbody></table>
        {!groups.length && <Empty>No payments here in this period.</Empty>}
      </div>
    );
  }
  return (
    <Section title={<span>{crumbs.map(([label, pth], i) => <React.Fragment key={i}>{i > 0 && <span className="muted"> › </span>}{i < crumbs.length - 1 ? <button onClick={() => setPath(pth)} style={{ border: 0, background: "none", padding: 0, color: "var(--teal)", font: "inherit", fontWeight: 600 }}>{label}</button> : label}</React.Fragment>)}</span>}
      right={<span className="num" style={{ fontWeight: 600 }}>{ksh(total)} · {scoped.length} payments</span>} pad={false}>
      {cat === "Inventory & Equipment" && level >= 1 && <SourceNote />}
      {body}
      <div className="muted" style={{ fontSize: 12, padding: "8px 16px" }}>Frequency uses all imported history ({an.firstDay ? `${fmtDay(an.firstDay)} – ${fmtDay(an.lastDay)}` : "none"}). "Once" or "Irregular" can change as more months are imported.</div>
    </Section>
  );
}

/* ---------- payroll: person by person, cash paid vs period expense ---------- */
function PayrollView({ an, win, period, openTxn }) {
  const [open, setOpen] = useState(null);
  const month = period.mode === "month" ? monthKey(win.cur.from) : null;
  const cur = an.expenses.filter((r) => inWin(r, win.cur));
  const ps = payrollSummary(an, cur, month);
  const cv = ps.cashVsPeriod;
  const cols = PAY_TYPES.filter((t) => ps.byType[t] > 0);
  if (!ps.staff.length) return <Section title="Payroll"><Empty>No staff payments in this period.</Empty></Section>;
  return (
    <div>
      <section className="panel grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", marginBottom: 16 }}>
        {PAY_TYPES.map((t) => <div className="stat" key={t}><div className="lbl">{{ "Salary": "Salary payments", "Salary advance": "Salary advances", "Commission": "Commissions", "Allowance": "Allowances", "Bonus": "Bonuses", "Other staff payment": "Other staff payments" }[t]}</div><div className="val num" style={{ fontSize: 18 }}>{ksh(ps.byType[t])}</div></div>)}
        <div className="stat"><div className="lbl">Total employee cash paid</div><div className="val num" style={{ fontSize: 18 }}>{ksh(ps.total)}</div><div className="note">{ps.staff.length} payments</div></div>
      </section>

      {cv ? (
        <Section title={`Cash paid vs expense for ${fmtMonth(month)}`}>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 16 }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Cash paid to staff in {fmtMonth(month)}: <span className="num">{ksh(cv.cash)}</span></div>
              <dl className="kv">
                <dt>Relates to {fmtMonth(month)}</dt><dd className="num">{ksh(cv.current)}</dd>
                <dt>Relates to earlier months</dt><dd className="num">{ksh(sum(cv.earlier, (r) => r.amount))} {cv.earlier.length > 0 && <span className="muted">({[...new Set(cv.earlier.map((r) => fmtMonth(r.relatesTo)))].join(", ")})</span>}</dd>
                <dt>Advances for future months</dt><dd className="num">{ksh(sum(cv.future, (r) => r.amount))}</dd>
                <dt>Advances, future month not stated</dt><dd className="num" style={{ color: cv.advUnspecified.length ? "var(--amber)" : "inherit" }}>{ksh(sum(cv.advUnspecified, (r) => r.amount))} {cv.advUnspecified.length > 0 && <span className="muted">({cv.advUnspecified.length}, flagged for review)</span>}</dd>
                <dt>Month not stated in remark</dt><dd className="num">{ksh(sum(cv.unstated, (r) => r.amount))} {cv.unstated.length > 0 && <span className="muted">({groupTotals(cv.unstated, (r) => r.payType).map((g) => `${g.key.toLowerCase()} ${ksh(g.total)}`).join(", ")})</span>}</dd>
              </dl>
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>Staff expense relating to {fmtMonth(month)}</div>
              <dl className="kv">
                <dt>Confirmed by remark</dt><dd className="num">{ksh(sum(cv.expenseForMonth, (r) => r.amount))} <span className="muted">({cv.expenseForMonth.length} payments, any payment date)</span></dd>
                <dt>If unstated payments belong to the month paid</dt><dd className="num">{ksh(sum(cv.expenseForMonth, (r) => r.amount) + sum(cv.unstated, (r) => r.amount))} <span className="muted">(assumption, not confirmed)</span></dd>
              </dl>
              {an.lastDay && an.lastDay < addDays(monthEnd(month), 45) && <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{fmtMonth(month)} salaries are often paid the following month. Data ends {fmtDay(an.lastDay)}, so payments for {fmtMonth(month)} made after that are not included yet.</div>}
            </div>
          </div>
        </Section>
      ) : <Section title="Cash paid vs period expense"><div className="muted">Switch the period to a month to compare cash paid with the salary expense for that month.</div></Section>}

      <Section title={`Payroll by person · ${ps.employees.length}`} pad={false}>
        <div className="muted" style={{ padding: "10px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>The person shown is the Tende recipient. Where a payment went to a bank or business, the employee is not available in source. Remarks sometimes name someone other than the recipient (e.g. one person's salary paid to a relative) — open the payment and set the employee if needed.</div>
        <div className="scroll">
          <table className="t"><thead><tr><th>Employee / recipient</th>{cols.map((t) => <th key={t} className="r">{t}</th>)}<th className="r">Total paid</th><th></th></tr></thead>
            <tbody>{ps.employees.map((e) => (
              <React.Fragment key={e.name}>
                <tr className="click" onClick={() => setOpen(open === e.name ? null : e.name)}>
                  <td style={{ minWidth: 200 }}>{e.person ? e.name : <span className="muted">{e.name}</span>}</td>
                  {cols.map((t) => <td key={t} className="r num">{e[t] ? ksh(e[t]) : <span className="muted">—</span>}</td>)}
                  <td className="r num" style={{ fontWeight: 600 }}>{ksh(e.total)}</td><td className="muted">{open === e.name ? "▾" : "▸"}</td>
                </tr>
                {open === e.name && <tr><td colSpan={cols.length + 3} style={{ background: "#F7F9F8", padding: 0 }}>
                  <table className="t"><thead><tr><th>Payment type</th><th className="r">Amount</th><th>Payment date</th><th>Month relating to</th><th>Status</th><th>Reference</th><th>Remark</th></tr></thead>
                    <tbody>{e.rows.map((r) => <tr key={r.id} className="click" onClick={() => openTxn(r.id)}><td>{r.payType}</td><td className="r num">{ksh(r.amount)}</td><td className="num">{fmtDay(r.day)}</td><td>{relText(r)}{r.advanceUnspecified && <span className="chip review" style={{ marginLeft: 6 }}>Review</span>}</td><td>{r.statusRaw}</td><td className="num">{r.txnRef}</td><td>{r.remark}</td></tr>)}</tbody></table>
                </td></tr>}
              </React.Fragment>))}
              <tr><td style={{ fontWeight: 600 }}>Total</td>{cols.map((t) => <td key={t} className="r num" style={{ fontWeight: 600 }}>{ksh(ps.byType[t])}</td>)}<td className="r num" style={{ fontWeight: 600 }}>{ksh(ps.total)}</td><td></td></tr>
            </tbody></table>
        </div>
      </Section>

      <Section title="Payroll register" right={<button className="btn small" onClick={() => downloadCSV(`happynet-payroll-${win.cur.from}-to-${win.cur.to}.csv`, ps.staff.map((r) => ({ Employee: r.employee || "Not available in source", PaidTo: r.payee, PaymentType: r.payType, Amount: r.amount, PaymentDate: r.day, MonthRelatingTo: r.relatesTo || "", RelatesBasis: r.relatesHow, Status: r.statusRaw, MpesaRef: r.txnRef, TendeID: r.id, Remark: r.remark })))}>Export CSV</button>} pad={false}>
        <TxnTable rows={ps.staff} openTxn={openTxn} cat="Staff & Payroll" />
      </Section>
    </div>
  );
}

/* ---------- purchases: what did we buy? ---------- */
/* ---------- inventory record (month-end master) and price tracking ---------- */
function inventoryRecord(list) {
  const items = {}, mixed = [], unstated = [];
  for (const r of list) {
    const its = r.items || [];
    if (!its.length) { unstated.push(r); continue; }
    const costed = its.length === 1 || r.itemsCosted;
    if (!costed) mixed.push(r);
    for (const it of its) {
      const x = (items[it.name] ||= { name: it.name, base: it.base || it.name, variant: it.variant || null, sub: it.sub, qty: {}, spend: 0, pricedSpend: 0, pricedQty: 0, pricedUnit: null, noQty: 0, inMixed: 0, rows: [], specMissing: !!it.specMissing, suppliers: new Set() });
      x.rows.push(r); x.suppliers.add(titleCase(r.payee));
      if (it.qty) x.qty[it.unit] = (x.qty[it.unit] || 0) + it.qty; else x.noQty++;
      if (costed) {
        const lc = it.lineCost ?? r.amount;
        x.spend += lc;
        if (it.qty && (!x.pricedUnit || x.pricedUnit === it.unit)) { x.pricedSpend += lc; x.pricedQty += it.qty; x.pricedUnit = it.unit; }
      } else x.inMixed++;
    }
  }
  const rows = Object.values(items).map((x) => ({ ...x, suppliers: [...x.suppliers], qtyText: Object.entries(x.qty).map(([u, q]) => `${q} ${u}`).join(" + "), unitCost: x.pricedQty ? x.pricedSpend / x.pricedQty : null }))
    .sort((a, b) => a.base.localeCompare(b.base) || String(a.variant || "").localeCompare(String(b.variant || "")));
  return { rows, mixed, unstated, known: sum(rows, (x) => x.spend), mixedT: sum(mixed, (r) => r.amount), unstatedT: sum(unstated, (r) => r.amount), total: sum(list, (r) => r.amount), charges: sum(list, (r) => r.charge), count: list.length };
}

// Unit price of every item purchase where the price can be known (quantity stated, item bought alone or itemised)
function priceHistory(an) {
  const m = {};
  for (const r of an.expenses) {
    if (r.category !== "Inventory & Equipment") continue;
    for (const it of r.items || []) {
      if (!it.unitCost) continue;
      const key = `${it.name}|${it.unit}`;
      (m[key] ||= { name: it.name, unit: it.unit, history: [] }).history.push({ day: r.day, unitCost: it.unitCost, qty: it.qty, supplier: titleCase(r.payee), id: r.id, ref: r.txnRef, remark: r.remark, src: it.manual ? "itemised by you" : "from remark" });
    }
  }
  return Object.values(m).map((g) => {
    const h = g.history.sort((a, b) => a.day.localeCompare(b.day));
    h.forEach((p, i) => { if (i) { p.prev = h[i - 1].unitCost; p.change = p.unitCost - p.prev; p.pct = (p.change / p.prev) * 100; } });
    return { ...g, last: h[h.length - 1], prev: h.length > 1 ? h[h.length - 2] : null, min: Math.min(...h.map((p) => p.unitCost)), max: Math.max(...h.map((p) => p.unitCost)) };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
const perUnit = (u) => (u === "units" || u === "pcs" ? "each" : `per ${u === "pcs" ? "pc" : u.replace(/s$/, "")}`);
const recordLabel = (r) => `${titleCase(String(r.remark || "No remark").replace(/\s+/g, " ").slice(0, 60))} — items not stated`;

function PriceListView({ an }) {
  const paid = Object.fromEntries(priceHistory(an).map((h) => [h.name.replace(/ — type not stated$/, ""), h.last]));
  const rows = PRICE_LIST.filter((p) => !p.hidden);
  return (
    <Section title="Price list" pad={false}>
      <div className="muted" style={{ padding: "8px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>Current supplier prices. The app uses them to split a payment that covers several items and to flag a price well above usual. "Last paid in Tende" comes from imported payments whose remark gives the quantity.</div>
      <div className="scroll">
        <table className="t"><thead><tr><th>Item</th><th className="r">Price now</th><th>Per</th><th>Earlier prices</th><th>Last paid in Tende</th><th>From</th><th>Note</th></tr></thead>
          <tbody>{rows.map((p) => { const l = paid[p.name]; const diff = l && Math.abs(l.unitCost - p.now) >= 1; return (
            <tr key={p.name}>
              <td style={{ fontWeight: 600 }}>{p.name}</td>
              <td className="r num" style={{ fontWeight: 600 }}>{ksh(p.now)}</td>
              <td className="muted">{p.unit}</td>
              <td className="num muted" style={{ whiteSpace: "nowrap" }}>{p.also.length ? p.also.map((x) => ksh(x)).join(", ") : "—"}</td>
              <td className="num" style={{ color: diff ? "#9C5700" : undefined }}>{l ? `${ksh(l.unitCost)} · ${fmtDay(l.day)}` : <span className="muted">—</span>}</td>
              <td className="muted" style={{ fontSize: 12.5 }}>{p.source} · {fmtDay(p.date)}</td>
              <td className="muted" style={{ fontSize: 12.5 }}>{p.note || ""}</td>
            </tr>); })}</tbody></table>
      </div>
    </Section>
  );
}

function inventoryRecordText(rec, label) {
  const L = [`HAPPYNET — INVENTORY RECORD`, label, ``];
  for (const x of rec.rows) L.push(`• ${x.name}: ${x.qtyText || "qty not stated"}${x.spend ? ` — ${ksh(x.spend)}` : ""}${x.unitCost ? ` (${ksh(x.unitCost)} ${perUnit(x.pricedUnit)})` : ""}${x.inMixed ? ` + in ${x.inMixed} mixed purchase${x.inMixed > 1 ? "s" : ""}` : ""}`);
  if (rec.mixed.length) { L.push("", `Bought together, cost not split — ${ksh(rec.mixedT)}`); rec.mixed.forEach((r) => L.push(`• ${fmtDay(r.day)} ${titleCase(r.payee)}: ${itemsText(r)} — ${ksh(r.amount)}`)); }
  if (rec.unstated.length) { L.push("", `Items not stated in remark — ${ksh(rec.unstatedT)}`); rec.unstated.forEach((r) => L.push(`• ${fmtDay(r.day)} ${titleCase(r.payee)}: "${r.remark}" — ${ksh(r.amount)}`)); }
  L.push("", `TOTAL INVENTORY SPENT: ${ksh(rec.total)} (${rec.count} payments) + ${ksh(rec.charges)} charges`);
  return L.join("\n");
}

function InventoryRecordView({ an, win, period, openTxn }) {
  const [wallet, setWallet] = useState("");
  const [open, setOpen] = useState(null);
  const [openPrice, setOpenPrice] = useState(null);
  const [copied, setCopied] = useState(false);
  const all = an.expenses.filter((r) => inWin(r, win.cur) && r.category === "Inventory & Equipment");
  const wallets = [...new Set(all.map((r) => r.wallet))];
  const list = all.filter((r) => !wallet || r.wallet === wallet);
  const rec = inventoryRecord(list);
  const prices = priceHistory(an);
  const label = `${period.label}${wallet ? ` · ${wallet} wallet` : ""}`;
  const changed = prices.filter((p) => p.prev && Math.abs(p.last.pct) >= 0.5);
  const exportCsv = () => downloadCSV(`happynet-inventory-record-${win.cur.from}-to-${win.cur.to}${wallet ? "-" + wallet.replace(/\W+/g, "_") : ""}.csv`, [
    ...rec.rows.map((x) => ({ Item: x.base, TypeOrSize: x.variant || "", Quantity: x.qtyText || "Not stated", TotalSpentKES: x.spend || "", UnitCostKES: x.unitCost ? Math.round(x.unitCost * 100) / 100 : "", Note: [x.inMixed ? `also in ${x.inMixed} mixed purchase(s)` : "", x.noQty && x.qtyText ? `${x.noQty} purchase(s) without quantity` : "", x.specMissing ? "type/size not stated" : ""].filter(Boolean).join("; "), Suppliers: x.suppliers.join(", ") })),
    ...rec.mixed.map((r) => ({ Item: "Bought together (cost not split)", TypeOrSize: "", Quantity: itemsText(r), TotalSpentKES: r.amount, UnitCostKES: "", Note: `${fmtDay(r.day)} · ref ${r.txnRef || r.id}`, Suppliers: titleCase(r.payee) })),
    ...rec.unstated.map((r) => ({ Item: recordLabel(r), TypeOrSize: "", Quantity: "Not stated", TotalSpentKES: r.amount, UnitCostKES: "", Note: `${fmtDay(r.day)} · ref ${r.txnRef || r.id}`, Suppliers: titleCase(r.payee) })),
    { Item: "GRAND TOTAL", TypeOrSize: "", Quantity: "", TotalSpentKES: rec.total, UnitCostKES: "", Note: `${rec.count} payments; charges ${Math.round(rec.charges)}`, Suppliers: "" },
  ]);
  const copy = async () => { try { await navigator.clipboard.writeText(inventoryRecordText(rec, label)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  const lastChange = (x) => prices.find((p) => p.name === x.name && p.unit === x.pricedUnit);
  const todo = [
    ...rec.mixed.map((r) => ({ r, what: itemsText(r), why: "Several items, one payment — split the cost" })),
    ...rec.unstated.map((r) => ({ r, what: `"${r.remark}"`, why: "Items not stated — add what was bought" })),
  ].sort((a, b) => a.r.day.localeCompare(b.r.day));
  const todoT = rec.mixedT + rec.unstatedT;
  return (
    <div>
      <section className="panel grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", marginBottom: 16 }}>
        <div className="stat"><div className="lbl">Inventory spent</div><div className="val num">{ksh(rec.total)}</div><div className="note">{rec.count} payments · plus {ksh(rec.charges)} Tende charges</div></div>
        <div className="stat"><div className="lbl">Clearly itemised</div><div className="val num" style={{ color: "var(--green)" }}>{ksh(rec.total - todoT)}</div><div className="note">{rec.rows.filter((x) => x.spend || x.qtyText).length} items in the list below</div></div>
        <div className="stat"><div className="lbl">Needs details</div><div className="val num" style={{ color: todo.length ? "var(--amber)" : "inherit" }}>{ksh(todoT)}</div><div className="note">{todo.length} payment{todo.length === 1 ? "" : "s"} — see the list further down</div></div>
      </section>

      <Section title={`What we bought · ${label}`} right={
        <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
          <select aria-label="Wallet" value={wallet} onChange={(e) => setWallet(e.target.value)}><option value="">All wallets</option>{wallets.map((w) => <option key={w}>{w}</option>)}</select>
          <button className="btn small" onClick={copy}>{copied ? "Copied" : "Copy as text"}</button>
          <button className="btn small" onClick={exportCsv}>Export (Excel CSV)</button>
        </div>} pad={false}>
        <div className="scroll">
          <table className="t"><thead><tr><th>Item</th><th className="r">Quantity</th><th className="r">Spent</th><th className="r">Price each</th></tr></thead>
            <tbody>
              {rec.rows.filter((x) => x.spend || x.qtyText).map((x) => {
                const pc = lastChange(x);
                const up = pc && pc.prev && Math.abs(pc.last.pct) >= 0.5;
                return (
                  <React.Fragment key={x.name}>
                    <tr className="click" onClick={() => setOpen(open === x.name ? null : x.name)}>
                      <td style={{ minWidth: 180 }}><b style={{ fontWeight: 600 }}>{x.base}</b>{x.variant ? <span> · {x.variant}</span> : null}{x.specMissing && !x.variant ? <span className="muted"> · type not stated</span> : null}</td>
                      <td className="r num">{x.qtyText || <span className="muted">—</span>}</td>
                      <td className="r num" style={{ fontWeight: 600 }}>{x.spend ? ksh(x.spend) : <span className="muted">—</span>}</td>
                      <td className="r num">{x.unitCost ? ksh(x.unitCost) : <span className="muted">—</span>}{up && <div style={{ fontSize: 11.5, color: pc.last.change > 0 ? "var(--red)" : "var(--green)" }}>{pc.last.change > 0 ? "▲" : "▼"} was {ksh(pc.prev.unitCost)}</div>}</td>
                    </tr>
                    {open === x.name && <tr><td colSpan={4} style={{ background: "#F7F9F8", padding: 0 }}>
                      <table className="t"><thead><tr><th>Date</th><th className="r">Qty</th><th className="r">Cost</th><th>Supplier</th><th>Remark</th></tr></thead>
                        <tbody>{x.rows.map((r) => { const it = r.items.find((i2) => i2.name === x.name); return <tr key={r.id} className="click" onClick={() => openTxn(r.id)}><td className="num">{fmtDay(r.day)}</td><td className="r num">{it && it.qty ? `${it.qty} ${it.unit}` : "—"}</td><td className="r num">{it && it.lineCost != null ? ksh(it.lineCost) : <span className="muted">in {ksh(r.amount)} payment</span>}</td><td>{titleCase(r.payee)}</td><td>{r.remark}</td></tr>; })}</tbody></table>
                    </td></tr>}
                  </React.Fragment>
                );
              })}
            </tbody></table>
          {!rec.count && <Empty>No inventory payments in this period.</Empty>}
        </div>
        <div className="muted" style={{ padding: "8px 16px", fontSize: 12.5 }}>Click an item to see the payments behind it. Items bought together in one payment are listed under "Needs details" until you split the cost.</div>
      </Section>

      {todo.length > 0 && (
        <Section title={`Needs details · ${todo.length} payment${todo.length === 1 ? "" : "s"} · ${ksh(todoT)}`} pad={false}>
          <div className="muted" style={{ padding: "8px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>Click a payment, then use "What exactly was bought" to add the items, quantities or split the cost.</div>
          <div className="scroll">
            <table className="t"><thead><tr><th>Date</th><th>Paid to</th><th>What the payment says</th><th className="r">Amount</th><th>What is missing</th></tr></thead>
              <tbody>{todo.map(({ r, what, why }) => <tr key={r.id} className="click" onClick={() => openTxn(r.id)}><td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.day)}</td><td>{titleCase(r.payee)}</td><td style={{ minWidth: 200 }}>{what}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(r.amount)}</td><td style={{ fontSize: 12.5, color: "#9C5700" }}>{why}</td></tr>)}</tbody></table>
          </div>
        </Section>
      )}

      <details>
        <summary className="muted" style={{ cursor: "pointer", fontSize: 13, padding: "6px 2px" }}>Price tracking — {changed.length ? `${changed.length} price change${changed.length === 1 ? "" : "s"}` : "no price changes"} · click to open</summary>
        <Section title="Price tracking" pad={false}>
        <div className="muted" style={{ padding: "8px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>Unit prices worked out from every purchase where the price can be known. All imported history is used, so changes show across months.</div>
        <div className="scroll">
          <table className="t"><thead><tr><th>Item</th><th className="r">Latest price</th><th>Latest purchase</th><th className="r">Previous price</th><th className="r">Change</th><th className="r">Lowest – highest</th><th className="r">Priced purchases</th></tr></thead>
            <tbody>{prices.map((p) => (
              <React.Fragment key={p.name + p.unit}>
                <tr className="click" onClick={() => setOpenPrice(openPrice === p.name + p.unit ? null : p.name + p.unit)}>
                  <td style={{ fontWeight: 600 }}>{p.name}</td>
                  <td className="r num" style={{ fontWeight: 600 }}>{ksh(p.last.unitCost)}<div className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}>{perUnit(p.unit)}</div></td>
                  <td style={{ fontSize: 12.5 }}>{fmtDay(p.last.day)} · {p.last.supplier}</td>
                  <td className="r num">{p.prev ? ksh(p.prev.unitCost) : <span className="muted">—</span>}</td>
                  <td className="r num">{p.prev ? <span style={{ color: p.last.change > 0 ? "var(--red)" : p.last.change < 0 ? "var(--green)" : "inherit" }}>{diffTxt(p.last.change)} ({pctTxt(p.last.pct)})</span> : <span className="muted">first price</span>}</td>
                  <td className="r num">{p.min === p.max ? ksh(p.min) : `${ksh(p.min)} – ${ksh(p.max)}`}</td>
                  <td className="r num">{p.history.length}</td>
                </tr>
                {openPrice === p.name + p.unit && <tr><td colSpan={7} style={{ background: "#F7F9F8", padding: 0 }}>
                  <table className="t"><thead><tr><th>Date</th><th className="r">Qty</th><th className="r">Unit price</th><th className="r">Change</th><th>Supplier</th><th>Source</th></tr></thead>
                    <tbody>{[...p.history].reverse().map((h) => <tr key={h.id + h.day} className="click" onClick={() => openTxn(h.id)}><td className="num">{fmtDay(h.day)}</td><td className="r num">{h.qty}</td><td className="r num">{ksh(h.unitCost)}</td><td className="r num">{h.prev ? <span style={{ color: h.change > 0 ? "var(--red)" : h.change < 0 ? "var(--green)" : "inherit" }}>{diffTxt(h.change)} ({pctTxt(h.pct)})</span> : "—"}</td><td>{h.supplier}</td><td className="muted" style={{ fontSize: 12.5 }}>{h.src} · "{h.remark}"</td></tr>)}</tbody></table>
                </td></tr>}
              </React.Fragment>))}</tbody></table>
          {!prices.length && <Empty>No purchase yet states a quantity for a single item, so no unit prices can be worked out. Remarks like "6 Tenda routers" or itemising a payment add prices here.</Empty>}
        </div>
      </Section>
      </details>
    </div>
  );
}

/* ---------- fuel & vehicles: one car (KBS) and two motorbikes ---------- */
function FuelView({ an, win, period, openTxn }) {
  const L = FUEL_LIMITS;
  const cur = an.expenses.filter((r) => inWin(r, win.cur) && r.category === "Fuel & Transport");
  const fuelRows = cur.filter((r) => FUEL_SUBS.includes(r.subcategory)).sort((a, b) => b.ts.localeCompare(a.ts));
  const lines = [];
  for (const r of fuelRows) for (const p of fuelParts(r)) lines.push({ r, ...p, msg: fuelCheck(p) });
  const gen = cur.filter((r) => r.subcategory === "Generator fuel");
  const other = cur.filter((r) => !FUEL_SUBS.includes(r.subcategory) && r.subcategory !== "Generator fuel" && r.subcategory !== "Bike rent");
  const tot = (who) => sum(lines.filter((l) => l.who === who), (l) => l.amount);
  const cnt = (who) => lines.filter((l) => l.who === who).length;
  const car = tot("Car"), bikes = tot("Bikes"), both = tot("Car + bikes");
  const over = lines.filter((l) => l.msg);
  const days = new Set(lines.map((l) => l.r.day)).size;
  return (
    <div>
      <section className="panel grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", marginBottom: 16 }}>
        <div className="stat"><div className="lbl">Car (KBS) fuel</div><div className="val num">{ksh(car)}</div><div className="note">{cnt("Car")} fill{cnt("Car") === 1 ? "" : "s"} · usual {ksh(L.carMin)}–{ksh(L.carMax)} each</div></div>
        <div className="stat"><div className="lbl">Motorbikes fuel</div><div className="val num">{ksh(bikes)}</div><div className="note">{cnt("Bikes")} payment{cnt("Bikes") === 1 ? "" : "s"} · usual {ksh(L.bikeMin)}–{ksh(L.bikeMax)} per bike</div></div>
        {both > 0 && <div className="stat"><div className="lbl">Car and bikes together</div><div className="val num">{ksh(both)}</div><div className="note">one payment, not split in the remark</div></div>}
        <div className="stat"><div className="lbl">All vehicle fuel</div><div className="val num">{ksh(car + bikes + both)}</div><div className="note">{days ? `about ${ksh((car + bikes + both) / days)} on each day fuel was bought` : "nothing yet"}</div></div>
        <div className="stat"><div className="lbl">Above the usual amount</div><div className="val num" style={{ color: over.length ? "var(--red)" : "var(--green)" }}>{over.length ? over.length : "None"}</div><div className="note">{over.length ? "see the rows marked below" : "all within the usual range"}</div></div>
      </section>

      <Section title={`Fuel payments · ${period.label}`} pad={false}>
        <div className="muted" style={{ padding: "8px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>Car: {ksh(L.carMin)}–{ksh(L.carMax)} a fill. Each motorbike: {ksh(L.bikeMin)}–{ksh(L.bikeMax)}, so up to {ksh(L.bikeMax * L.bikes)} when both are filled. A payment whose remark names both (e.g. "Fuel KBS 2000. Bikes 600") is split for you. "Assumed" means the remark did not say whose fuel it was.</div>
        <div className="scroll">
          <table className="t"><thead><tr><th>Date</th><th>For</th><th className="r">Amount</th><th>Check</th><th>Remark</th></tr></thead>
            <tbody>{lines.map((l, i) => (
              <tr key={l.r.id + i} className="click" onClick={() => openTxn(l.r.id)}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(l.r.day)}</td>
                <td>{l.who}{!l.sure && <span className="muted"> · assumed</span>}</td>
                <td className="r num" style={{ fontWeight: 600 }}>{ksh(l.amount)}</td>
                <td style={{ fontSize: 12.5, color: l.msg ? "var(--red)" : "var(--green)" }}>{l.msg || "Within usual"}</td>
                <td className="muted" style={{ fontSize: 12.5 }}>{l.r.remark}</td>
              </tr>))}</tbody></table>
          {!lines.length && <Empty>No fuel payments in this period.</Empty>}
        </div>
      </Section>

      {(gen.length > 0 || other.length > 0) && (
        <Section title="Other running costs on the road" pad={true}>
          {gen.length > 0 && <div className="flex justify-between" style={{ padding: "3px 0" }}><span>Generator fuel ({gen.length} payment{gen.length === 1 ? "" : "s"})</span><b className="num" style={{ fontWeight: 600 }}>{ksh(sum(gen, (r) => r.amount))}</b></div>}
          {other.length > 0 && <div className="flex justify-between" style={{ padding: "3px 0" }}><span>Transport, delivery and vehicle repairs ({other.length} payment{other.length === 1 ? "" : "s"})</span><b className="num" style={{ fontWeight: 600 }}>{ksh(sum(other, (r) => r.amount))}</b></div>}
        </Section>
      )}
    </div>
  );
}

function PurchasesView({ an, win, openTxn }) {
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const cur = an.expenses.filter((r) => inWin(r, win.cur) && r.category === "Inventory & Equipment");
  const items = itemSummary(cur);
  const lc = (x) => String(x || "").toLowerCase();
  const lines = [];
  for (const r of cur) {
    const its = r.items.length ? r.items : [null];
    its.forEach((it, i) => lines.push({ r, it, i, n: its.length }));
  }
  const shown = lines.filter(({ r, it }) => !q || [r.remark, r.payee, r.subcategory, it && it.name].some((x) => lc(x).includes(lc(q)))).sort((a, b) => b.r.ts.localeCompare(a.r.ts) || a.i - b.i);
  const incomplete = cur.filter((r) => r.detailMissing && r.detailMissing.length).sort((a, b) => b.amount - a.amount);
  const exportLines = () => downloadCSV(`happynet-purchases-${win.cur.from}-to-${win.cur.to}.csv`, shown.map(({ r, it, n }) => ({
    Date: r.day, Subcategory: r.subcategory, Item: it ? it.base : "Not identified in remark", TypeOrSize: it ? it.variant || "" : "", Quantity: it && it.qty ? it.qty : "Not available in source", Unit: it && it.qty ? it.unit : "", QuantitySource: it ? (it.qtySource === "source" ? "Source" : it.qtySource === "manual" ? "Reviewer" : "Not available") : "",
    ItemCost: it && it.lineCost !== null && it.lineCost !== undefined ? it.lineCost : "", UnitCost: it && it.unitCost ? Math.round(it.unitCost * 100) / 100 : "", PaymentTotal: r.amount, ItemsInPayment: n,
    Supplier: r.payee, ReceiverNo: r.receiverId, MpesaRef: r.txnRef, TendeID: r.id, Detail: r.purchaseDetail, SourceRemark: r.remark,
  })));
  // group items under their base name: Router → Tenda / XPON / type not stated
  const bases = [];
  for (const x of items) { let g = bases.find((b) => b.base === x.base); if (!g) bases.push((g = { base: x.base, sub: x.sub, rows: [] })); g.rows.push(x); }
  bases.forEach((g) => { g.payments = new Set(g.rows.flatMap((x) => x.rows.map((r) => r.id))).size; g.known = sum(g.rows, (x) => x.soloSpend); });
  bases.sort((a, b) => (a.base === "Item not identified") - (b.base === "Item not identified") || b.payments - a.payments);
  const variantText = (x) => `${x.variant ? x.variant + ": " : ""}${x.unitsText ? x.unitsText : "quantity not stated"}${x.qtyMissing && x.unitsText ? ` (+${x.qtyMissing} payment${x.qtyMissing > 1 ? "s" : ""} with no quantity)` : ""}${x.avgUnitCost ? ` · ~${ksh(x.avgUnitCost)} each` : ""}`;
  return (
    <div>
      <section className="panel grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", marginBottom: 16 }}>
        <div className="stat"><div className="lbl">Inventory & equipment spend</div><div className="val num">{ksh(sum(cur, (r) => r.amount))}</div><div className="note">{cur.length} payments</div></div>
        <div className="stat"><div className="lbl">Payments fully itemised</div><div className="val num">{cur.filter((r) => !r.detailMissing.length).length}</div><div className="note">item, type/size and quantity known</div></div>
        <div className="stat"><div className="lbl">Payments missing detail</div><div className="val num" style={{ color: incomplete.length ? "var(--amber)" : "inherit" }}>{incomplete.length}</div><div className="note">{ksh(sum(incomplete, (r) => r.amount))} — see list below</div></div>
      </section>

      <Section title="What was bought" pad={false}>
        <SourceNote />
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 0 }}>
          {bases.map((g) => (
            <div key={g.base} style={{ padding: "10px 16px", borderBottom: "1px solid #EDF0EE", borderRight: "1px solid #EDF0EE" }}>
              <div className="flex justify-between" style={{ gap: 8 }}><b style={{ fontWeight: 600 }}>{g.base}</b><span className="muted" style={{ fontSize: 12.5 }}>{g.payments} payment{g.payments > 1 ? "s" : ""}</span></div>
              {g.rows.map((x) => (
                <button key={x.name} onClick={() => setQ(x.name)} style={{ display: "block", width: "100%", textAlign: "left", border: 0, background: "none", padding: "2px 0", font: "inherit", fontSize: 13, color: x.specMissing || x.base === "Item not identified" ? "var(--amber)" : "var(--ink)" }}>
                  {g.base === "Item not identified" ? `${x.payments} payment${x.payments > 1 ? "s" : ""} — ${ksh(x.soloSpend)}; remark names no item` : variantText(x)}
                </button>))}
            </div>))}
        </div>
        <div className="muted" style={{ fontSize: 12, padding: "8px 16px" }}>Amber = the remark doesn't say which type or size. Click a line to see its purchases below.</div>
      </Section>

      {incomplete.length > 0 && (
        <Section title={`Needs item detail · ${incomplete.length}`} pad={false}>
          <div className="muted" style={{ padding: "8px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>These remarks don't say exactly what was bought. Open one and fill in "What exactly was bought" — e.g. "Xpon Routers KSh 37,500" → 25 × Router — XPON. Ask whoever made the payment, or check the supplier's receipt.</div>
          <div className="scroll" style={{ maxHeight: 360 }}>
            <table className="t"><thead><tr><th>Date</th><th>Remark</th><th className="r">Amount</th><th>Supplier</th><th>Read as</th><th>Missing</th><th></th></tr></thead>
              <tbody>{(showAll ? incomplete : incomplete.slice(0, 12)).map((r) => (
                <tr key={r.id} className="click" onClick={() => openTxn(r.id)}>
                  <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.day)}</td><td style={{ minWidth: 180 }}>{r.remark}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(r.amount)}</td><td>{titleCase(r.payee)}</td>
                  <td style={{ fontSize: 12.5 }}>{itemsText(r) || <span className="muted">nothing recognised</span>}</td>
                  <td>{r.detailMissing.map((m) => <span key={m} className="chip review" style={{ marginRight: 4 }}>{m}</span>)}</td>
                  <td><span className="btn small">Add detail</span></td>
                </tr>))}</tbody></table>
            {incomplete.length > 12 && !showAll && <div style={{ padding: 10, textAlign: "center" }}><button className="btn small" onClick={() => setShowAll(true)}>Show all {incomplete.length}</button></div>}
          </div>
        </Section>
      )}

      <Section title="Items — quantities and costs" pad={false}>
        <div className="scroll">
          <table className="t"><thead><tr><th>Item</th><th>Type / size</th><th className="r">Payments</th><th className="r">Quantity stated</th><th className="r">Known cost</th><th className="r">Avg unit cost</th><th className="r">Cost not separable</th><th>Suppliers</th><th>Frequency</th></tr></thead>
            <tbody>{items.map((x, i) => (
              <tr key={x.name} className="click" onClick={() => setQ(x.name)}>
                <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{i === 0 || items[i - 1].base !== x.base ? x.base : ""}</td>
                <td style={{ whiteSpace: "nowrap", color: x.specMissing ? "var(--amber)" : "inherit" }}>{x.variant || <span className="muted">—</span>}</td>
                <td className="r num">{x.payments}</td>
                <td className="r num">{x.unitsText || <span className="muted">Not available in source</span>}{x.unitsText && x.qtyMissing ? <div className="muted" style={{ fontSize: 11.5 }}>+{x.qtyMissing} with no quantity</div> : null}</td>
                <td className="r num">{x.soloPayments ? ksh(x.soloSpend) : <span className="muted">—</span>}</td>
                <td className="r num">{x.avgUnitCost ? <>{ksh(x.avgUnitCost)}<div className="muted" style={{ fontSize: 11.5 }}>calculated per {x.unitCostUnit === "units" ? "unit" : x.unitCostUnit}</div></> : <span className="muted">Not available</span>}</td>
                <td className="r num">{x.mixedPayments ? <>{x.mixedPayments} <span className="muted">({ksh(x.mixedValue)} payments)</span></> : <span className="muted">—</span>}</td>
                <td style={{ minWidth: 150 }}>{x.suppliers.slice(0, 3).join(", ")}{x.suppliers.length > 3 ? ` +${x.suppliers.length - 3}` : ""}</td>
                <td style={{ whiteSpace: "nowrap" }}>{frequencyOf(x.rows)}</td>
              </tr>))}</tbody></table>
        </div>
      </Section>
      <Section title={`Purchase register · ${shown.length} lines`} right={<div className="flex" style={{ gap: 8 }}><input placeholder="Filter by item, supplier, remark…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} /><button className="btn small" onClick={exportLines}>Export CSV</button></div>} pad={false}>
        <div className="scroll" style={{ maxHeight: "65vh" }}>
          <table className="t"><thead><tr><th>Date</th><th>Item</th><th className="r">Quantity</th><th className="r">Unit cost</th><th className="r">Payment total</th><th>Supplier</th><th>Reference</th><th>Detail</th><th>Source remark</th></tr></thead>
            <tbody>{shown.map(({ r, it, i, n }) => (
              <tr key={r.id + i} className="click" onClick={() => openTxn(r.id)}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{i === 0 ? fmtDay(r.day) : ""}</td>
                <td>{it ? <>{it.base}{it.variant && <span style={{ color: it.specMissing ? "var(--amber)" : "inherit" }}> — {it.variant}</span>}</> : <span className="muted">Not identified in remark</span>}<div className="muted" style={{ fontSize: 12 }}>{it ? it.sub : r.subcategory}</div></td>
                <td className="r num">{it && it.qty ? <>{it.qty}{!["units", "pcs"].includes(it.unit) ? " " + it.unit : ""}<div className="muted" style={{ fontSize: 11.5 }}>{it.qtySource === "manual" ? "reviewer" : "source"}</div></> : <span className="muted">Not available in source</span>}</td>
                <td className="r num">{it && it.unitCost ? <>{ksh(it.unitCost)}<div className="muted" style={{ fontSize: 11.5 }}>calculated</div></> : it && it.lineCost !== null && it.lineCost !== undefined && n > 1 ? <>{ksh(it.lineCost)}<div className="muted" style={{ fontSize: 11.5 }}>line total</div></> : <span className="muted">{n > 1 ? "Not separable" : "Not available"}</span>}</td>
                <td className="r num" style={{ fontWeight: i === 0 ? 600 : 400 }}>{i === 0 ? ksh(r.amount) : <span className="muted">same payment</span>}{i === 0 && n > 1 && <div className="muted" style={{ fontSize: 11.5 }}>{n} items</div>}</td>
                <td>{i === 0 ? titleCase(r.payee) : ""}</td>
                <td className="num" style={{ fontSize: 12.5 }}>{i === 0 ? <>{r.txnRef}<div className="muted">{r.id}</div></> : ""}</td>
                <td>{i === 0 && <span className={`chip ${r.purchaseDetail === "Complete" ? "ok" : r.purchaseDetail === "Quantities only" ? "ex" : "review"}`}>{r.purchaseDetail}</span>}</td>
                <td style={{ minWidth: 180 }}>{i === 0 ? r.remark : ""}</td>
              </tr>))}</tbody></table>
          {!shown.length && <Empty>No inventory purchases match.</Empty>}
        </div>
      </Section>
    </div>
  );
}

/* ---------- Advanta & connectivity ---------- */
function AdvantaView({ an, win, openTxn, goDrill }) {
  const cur = an.expenses.filter((r) => inWin(r, win.cur) && r.category === "Connectivity");
  const adv = cur.filter((r) => r.subcategory === "Advanta bundles").sort((a, b) => b.ts.localeCompare(a.ts));
  const allAdv = an.expenses.filter((r) => r.subcategory === "Advanta bundles");
  const byMonth = groupTotals(allAdv, (r) => monthKey(r.day)).sort((a, b) => a.key.localeCompare(b.key));
  const subs = groupTotals(cur, (r) => r.subcategory);
  return (
    <div>
      <section className="panel grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", marginBottom: 16 }}>
        <div className="stat"><div className="lbl">Advanta spending</div><div className="val num">{ksh(sum(adv, (r) => r.amount))}</div><div className="note">{adv.length} identifiable purchases</div></div>
        <div className="stat"><div className="lbl">Average per purchase</div><div className="val num">{adv.length ? ksh(sum(adv, (r) => r.amount) / adv.length) : "—"}</div></div>
        <div className="stat"><div className="lbl">Frequency</div><div className="val" style={{ fontSize: 17 }}>{frequencyOf(allAdv)}</div><div className="note">all imported history</div></div>
        <div className="stat"><div className="lbl">Bundle quantity</div><div className="val muted" style={{ fontSize: 15 }}>Not available in source</div><div className="note">remarks don't state bundle size or count</div></div>
      </section>
      <Section title="Advanta bundle purchases" pad={false}>
        <div className="scroll">
          <table className="t"><thead><tr><th>Date</th><th>Bundle / description</th><th className="r">Quantity</th><th className="r">Unit cost</th><th className="r">Total</th><th>Supplier</th><th>Service · wallet</th><th>Reference</th></tr></thead>
            <tbody>{adv.map((r) => <tr key={r.id} className="click" onClick={() => openTxn(r.id)}>
              <td className="num" style={{ whiteSpace: "nowrap" }}>{r.date.slice(0, 16)}</td><td>{r.remark}{r.relatesTo && <div className="muted" style={{ fontSize: 12 }}>relates to {fmtMonth(r.relatesTo)}</div>}</td>
              <td className="r muted">Not available</td><td className="r muted">Not available</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(r.amount)}</td>
              <td>{titleCase(r.payee)}</td><td>{r.service} · {r.wallet}</td><td className="num" style={{ fontSize: 12.5 }}>{r.txnRef}<div className="muted">{r.id}</div></td></tr>)}</tbody></table>
          {!adv.length && <Empty>No Advanta purchases identified in this period.</Empty>}
        </div>
        {byMonth.length > 1 && <div style={{ padding: "10px 16px" }}>{byMonth.map((m) => <span key={m.key} style={{ marginRight: 18 }}>{fmtMonth(m.key)}: <b className="num">{ksh(m.total)}</b> ({m.count})</span>)}</div>}
      </Section>
      <Section title={`All connectivity · ${ksh(sum(cur, (r) => r.amount))}`} pad={false}>
        <table className="t"><thead><tr><th>Subcategory</th><th className="r">Payments</th><th className="r">Total</th><th>Frequency</th><th>Paid to</th></tr></thead>
          <tbody>{subs.map((g) => <tr key={g.key} className="click" onClick={() => goDrill(["Connectivity", g.key])}><td>{g.key}</td><td className="r num">{g.count}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(g.total)}</td><td>{frequencyOf(an.expenses.filter((r) => r.subcategory === g.key))}</td><td>{[...new Set(g.list.map((r) => titleCase(r.payee)))].slice(0, 3).join(", ")}</td></tr>)}</tbody></table>
      </Section>
    </div>
  );
}

/* ---------- month-to-month comparison with evidence ---------- */
function MonthCompare({ an, win, period, openTxn }) {
  const [by, setBy] = useState("subcategory");
  const [open, setOpen] = useState(null);
  const end = period.mode === "all" ? monthKey(an.lastDay) : monthKey(win.cur.to);
  const months = monthsEnding(an, end, 6);
  const keyOf = by === "category" ? (r) => r.category : by === "item" ? null : (r) => `${r.category}|${r.subcategory}`;
  const inMonth = (r, m) => monthKey(r.day) === m;
  let rows;
  if (by === "item") {
    const names = new Set(); const sums = {};
    for (const m of months) for (const x of itemSummary(an.expenses.filter((r) => inMonth(r, m)))) { names.add(x.name); sums[x.name + m] = x; }
    rows = [...names].map((n) => ({ key: n, label: n, vals: months.map((m) => sums[n + m] ? sums[n + m].soloSpend : 0), units: months.map((m) => sums[n + m] ? sums[n + m].unitsText : null), rowsFor: (m) => sums[n + m] ? sums[n + m].rows : [] }));
  } else {
    const keys = [...new Set(an.expenses.filter((r) => months.includes(monthKey(r.day))).map(keyOf))];
    rows = keys.map((k) => ({ key: k, label: by === "category" ? k : k.split("|")[1], cat: by === "category" ? k : k.split("|")[0], vals: months.map((m) => sum(an.expenses.filter((r) => inMonth(r, m) && keyOf(r) === k), (r) => r.amount)), rowsFor: (m) => an.expenses.filter((r) => inMonth(r, m) && keyOf(r) === k) }));
  }
  const n = months.length;
  rows.forEach((r) => { r.ch = n > 1 ? change(r.vals[n - 1], r.vals[n - 2]) : { diff: null, pct: null }; });
  rows.sort((a, b) => (n > 1 ? Math.abs(b.ch.diff) - Math.abs(a.ch.diff) : b.vals[n - 1] - a.vals[n - 1]));
  const evidence = (row) => {
    if (n < 2) return null;
    const [a, b] = [months[n - 2], months[n - 1]];
    const ra = row.rowsFor(a), rb = row.rowsFor(b);
    const ta = sum(ra, (r) => r.amount), tb = sum(rb, (r) => r.amount);
    const dir = tb > ta ? "increased" : tb < ta ? "decreased" : "did not change";
    return `${row.label} ${dir}${tb !== ta ? ` by ${ksh(Math.abs(tb - ta))}` : ""}: ${fmtMonth(b)} had ${rb.length} payment${rb.length === 1 ? "" : "s"} totalling ${ksh(tb)}, compared with ${ra.length} totalling ${ksh(ta)} in ${fmtMonth(a)}. The transactions below are the evidence; the data does not show why.`;
  };
  return (
    <Section title="Month-to-month comparison" right={<div className="seg">{[["subcategory", "Subcategory"], ["category", "Category"], ["item", "Inventory item"]].map(([k, l]) => <button key={k} aria-pressed={by === k} onClick={() => { setBy(k); setOpen(null); }}>{l}</button>)}</div>} pad={false}>
      {n < 2 && <div style={{ padding: "10px 16px", background: "var(--amberbg)" }}>Only {months.length ? fmtMonth(months[0]) : "no month"} is imported up to this period, so there is nothing to compare yet. Import earlier or later Tende exports and the comparison fills in automatically.</div>}
      {by === "item" && <div className="muted" style={{ padding: "8px 16px", fontSize: 12.5 }}>Item spend counts only payments that bought that item alone; items bought together in one payment can't be costed separately.</div>}
      <div className="scroll">
        <table className="t"><thead><tr><th>Expense</th>{months.map((m) => <th key={m} className="r">{fmtMonth(m)}</th>)}{n > 1 && <><th className="r">Change</th><th className="r">Change %</th></>}</tr></thead>
          <tbody>{rows.map((row) => (
            <React.Fragment key={row.key}>
              <tr className="click" onClick={() => setOpen(open === row.key ? null : row.key)}>
                <td style={{ minWidth: 200 }}>{row.cat && <CatDot c={row.cat} />}{row.label}{row.cat && by === "subcategory" && <div className="muted" style={{ fontSize: 12 }}>{row.cat}</div>}</td>
                {row.vals.map((v, i) => <td key={i} className="r num">{v ? ksh(v) : <span className="muted">—</span>}{row.units && row.units[i] && <div className="muted" style={{ fontSize: 11.5 }}>{row.units[i]}</div>}</td>)}
                {n > 1 && <><td className="r"><ChangeTxt d={row.ch.diff} p={null} /></td><td className="r num">{pctTxt(row.ch.pct)}</td></>}
              </tr>
              {open === row.key && <tr><td colSpan={months.length + 3} style={{ background: "#F7F9F8" }}>
                {evidence(row) && <div style={{ marginBottom: 8 }}>{evidence(row)}</div>}
                <TxnTable rows={n > 1 ? [...row.rowsFor(months[n - 2]), ...row.rowsFor(months[n - 1])] : row.rowsFor(months[0])} openTxn={openTxn} cat={row.cat} />
              </td></tr>}
            </React.Fragment>))}</tbody></table>
      </div>
    </Section>
  );
}

/* ---------- recipients ---------- */
function RecipientsView({ an, win, openTxn }) {
  const [smallOnly, setSmallOnly] = useState(false);
  const [open, setOpen] = useState(null);
  const cur = an.expenses.filter((r) => inWin(r, win.cur));
  const recips = groupTotals(cur, (r) => r.payee).map((g) => {
    const s = [...g.list].sort((a, b) => a.ts.localeCompare(b.ts));
    return { name: g.key, list: g.list, count: g.count, total: g.total, avg: g.total / g.count, max: g.max, first: s[0].day, last: s[s.length - 1].day, cats: groupTotals(g.list, (r) => r.category + " / " + r.subcategory) };
  }).filter((r) => !smallOnly || (r.count >= 3 && r.avg < 1000));
  return (
    <Section title={`Recipients · ${recips.length}`} right={<button className="pill" aria-pressed={smallOnly} onClick={() => setSmallOnly(!smallOnly)}>Repeated small payments only</button>} pad={false}>
      <div className="muted" style={{ padding: "10px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>Each payment keeps its own classification — a recipient paid for several things shows each separately.</div>
      <div className="scroll" style={{ maxHeight: "70vh" }}>
        <table className="t"><thead><tr><th>Recipient</th><th className="r">Payments</th><th className="r">Total paid</th><th className="r">Average</th><th className="r">Largest</th><th>First</th><th>Last</th><th>What for</th></tr></thead>
          <tbody>{recips.map((r) => (
            <React.Fragment key={r.name}>
              <tr className="click" onClick={() => setOpen(open === r.name ? null : r.name)}>
                <td style={{ fontWeight: 600 }}>{titleCase(r.name)}</td><td className="r num">{r.count}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(r.total)}</td><td className="r num">{ksh(r.avg)}</td><td className="r num">{ksh(r.max)}</td><td className="num">{fmtDay(r.first)}</td><td className="num">{fmtDay(r.last)}</td>
                <td style={{ minWidth: 220 }}>{r.cats.slice(0, 3).map((c) => <div key={c.key} style={{ fontSize: 12.5 }}>{c.key.split(" / ")[1]} <span className="muted num">{ksh(c.total)}</span></div>)}{r.cats.length > 3 && <div className="muted" style={{ fontSize: 12 }}>+{r.cats.length - 3} more</div>}</td>
              </tr>
              {open === r.name && <tr><td colSpan={8} style={{ background: "#F7F9F8", padding: 0 }}><TxnTable rows={r.list} openTxn={openTxn} cat={r.list.every((x) => x.category === r.list[0].category) ? r.list[0].category : null} /></td></tr>}
            </React.Fragment>))}</tbody></table>
        {smallOnly && !recips.length && <Empty>No recipient received three or more payments averaging under KSh 1,000.</Empty>}
      </div>
    </Section>
  );
}

/* ---------- trend ---------- */
function TrendView({ an, win, period }) {
  const [gran, setGran] = useState(period.mode === "year" || period.mode === "all" ? "month" : period.mode === "month" ? "week" : "day");
  const cur = an.expenses.filter((r) => inWin(r, win.cur));
  const buckets = trendBuckets(cur, gran, win.cur, an);
  return (
    <Section title="Spending trend" right={<div className="seg">{["day", "week", "month"].map((g) => <button key={g} aria-pressed={gran === g} onClick={() => setGran(g)}>{g === "day" ? "Daily" : g === "week" ? "Weekly" : "Monthly"}</button>)}</div>}>
      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={buckets} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="#E6EAE8" />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#4A5A66" }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11, fill: "#4A5A66" }} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} width={40} />
            <Tooltip formatter={(v) => ksh(v)} labelStyle={{ color: "#17242E" }} />
            <Bar dataKey="total" fill="#0F6E6A" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="scroll" style={{ maxHeight: 300, marginTop: 12 }}>
        <table className="t"><thead><tr><th>Period</th><th className="r">Total</th><th className="r">Transactions</th><th className="r">Average</th><th className="r">Change from previous</th></tr></thead>
          <tbody>{buckets.map((b) => <tr key={b.key}><td>{b.label}</td><td className="r num">{ksh(b.total)}</td><td className="r num">{b.count}</td><td className="r num">{b.count ? ksh(b.avg) : "—"}</td><td className="r"><ChangeTxt d={b.diff} p={b.pct} /></td></tr>)}</tbody></table>
      </div>
    </Section>
  );
}

/* ======================================================================
   CONTROL
   ====================================================================== */
function Control({ an, win, period, ctx, setBudgets, setPending, openTxn, rawCount, importLog, clearAll }) {
  const [sub, setSub] = useState("review");
  const tabs = [["review", "Review queue"], ["recurring", "Recurring"], ["budget", "Budget vs actual"], ["pending", "Pending obligations"], ["payments", "Payment control"], ["health", "Data health"]];
  return (
    <div>
      <div className="flex flex-wrap" style={{ gap: 6, marginBottom: 14 }}>{tabs.map(([k, l]) => <button key={k} className="pill" aria-pressed={sub === k} onClick={() => setSub(k)}>{l}</button>)}</div>
      {sub === "review" && <ReviewQueue an={an} win={win} openTxn={openTxn} />}
      {sub === "recurring" && <RecurringView an={an} win={win} />}
      {sub === "budget" && <BudgetView an={an} win={win} period={period} budgets={ctx.budgets} setBudgets={setBudgets} calState={ctx.calState} />}
      {sub === "pending" && <PendingView an={an} win={win} pending={ctx.pending} setPending={setPending} cal={ctx.calendar} />}
      {sub === "payments" && <PaymentControl an={an} win={win} />}
      {sub === "health" && <DataHealth an={an} rawCount={rawCount} importLog={importLog} clearAll={clearAll} />}
    </div>
  );
}

function ReviewQueue({ an, win, openTxn }) {
  const [state, setState] = useState("open");
  const list = an.expenses.filter((r) => inWin(r, win.cur) && r.flags.length && (state === "all" || r.review === state)).sort((a, b) => b.amount - a.amount);
  return (
    <Section title={`Unusual expenses · ${list.length}`} right={<div className="seg">{[["open", "Open"], ["cleared", "Cleared"], ["confirmed", "Confirmed"], ["all", "All"]].map(([k, l]) => <button key={k} aria-pressed={state === k} onClick={() => setState(k)}>{l}</button>)}</div>} pad={false}>
      <div className="muted" style={{ padding: "10px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>These are detected patterns that need a human check. None of them is a confirmed problem until a reviewer marks it so.</div>
      <div className="scroll" style={{ maxHeight: "62vh" }}>
        <table className="t"><thead><tr><th>Date</th><th>Flag</th><th>Description</th><th className="r">Amount</th><th>Recipient</th><th>Status</th></tr></thead>
          <tbody>{list.map((r) => <tr key={r.id} className="click" onClick={() => openTxn(r.id)}>
            <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.day)}</td>
            <td style={{ minWidth: 220 }}>{r.flags.map((f, i) => <div key={i}><b style={{ fontWeight: 600 }}>{f.label}</b><div className="muted" style={{ fontSize: 12 }}>{f.detail}</div></div>)}</td>
            <td>{r.remark}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(r.amount)}</td><td>{titleCase(r.payee)}</td><td><ReviewChip r={r} />{r.reviewNote && <div className="muted" style={{ fontSize: 12 }}>{r.reviewNote}</div>}</td></tr>)}</tbody></table>
        {!list.length && <Empty>No {state === "all" ? "" : state} items in this period.</Empty>}
      </div>
    </Section>
  );
}

function RecurringView({ an, win }) {
  const cur = an.expenses.filter((r) => inWin(r, win.cur));
  const prev = win.prev ? an.expenses.filter((r) => inWin(r, win.prev)) : null;
  const rows = recurringTable(an, cur, prev && prev.length ? prev : null);
  return (
    <Section title={`Recurring expenses · ${ksh(sum(rows, (r) => r.total))}`} pad={false}>
      <div className="muted" style={{ padding: "10px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>A pattern counts as recurring when it has at least four payments spread over two or more weeks with a regular gap, or appears in consecutive months. A repeated keyword alone is not enough.</div>
      <div className="scroll">
        <table className="t"><thead><tr><th>Expense</th><th>Pattern</th><th className="r">Payments</th><th className="r">Per week</th><th className="r">Total</th><th className="r">Average</th><th className="r">Min</th><th className="r">Max</th><th>Last</th><th>Previous</th><th>Trend</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.category + r.subcategory}>
            <td style={{ minWidth: 180 }}><CatDot c={r.category} /><b style={{ fontWeight: 600 }}>{r.subcategory}</b><div className="muted" style={{ fontSize: 12 }}>{r.category} · {r.recipients} recipient{r.recipients > 1 ? "s" : ""}</div></td>
            <td>{r.pattern}</td><td className="r num">{r.count}</td><td className="r num">{r.perWeek.toFixed(1)}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(r.total)}</td><td className="r num">{ksh(r.avg)}</td><td className="r num">{ksh(r.min)}</td><td className="r num">{ksh(r.max)}</td>
            <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.last)}</td><td className="num" style={{ whiteSpace: "nowrap" }}>{r.previous ? fmtDay(r.previous) : "—"}</td>
            <td style={{ minWidth: 140 }}><span style={{ color: r.trend === "Increasing" ? "var(--red)" : r.trend === "Decreasing" ? "var(--green)" : "inherit" }}>{r.trend}</span><div className="muted" style={{ fontSize: 11.5 }}>{r.trendBasis}</div></td></tr>)}</tbody></table>
        {!rows.length && <Empty>No recurring patterns have payments in this period.</Empty>}
      </div>
    </Section>
  );
}

function BudgetView({ an, win, period, budgets, setBudgets, calState }) {
  const mk = monthKey(period.mode === "all" ? an.lastDay : win.cur.from);
  const mb = budgets[mk] || {};
  const setVal = (c, v) => setBudgets({ ...budgets, [mk]: { ...mb, [c]: v === "" ? undefined : +v } });
  const prevMk = monthKey(shiftAnchor("month", mk + "-01", -1));
  const monthWin = { from: mk + "-01", to: an.lastDay && an.lastDay >= mk + "-01" && an.lastDay < monthEnd(mk) ? an.lastDay : monthEnd(mk) };
  const rows = CATEGORY_ORDER.map((c) => {
    const actual = sum(an.expenses.filter((r) => inWin(r, monthWin) && r.category === c), (r) => r.amount);
    const b = budgetForWindow(budgets, monthWin, c);
    return { c, actual, b: b ? b.budget : null, prorated: b && b.prorated };
  });
  const tb = rows.filter((r) => r.b !== null);
  const fillFromCalendar = () => {
    if (!calState) return;
    const cal = buildCalendar(an, calState, mk);
    const byCat = groupTotals(cal.rows.filter((r) => r.status !== "Not due this month").map((r) => ({ ...r, amount: r.expected })), (r) => r.category);
    const next = { ...mb }; for (const g of byCat) next[g.key] = Math.round(g.total);
    setBudgets({ ...budgets, [mk]: next });
  };
  return (
    <Section title={`Budget vs actual · ${fmtMonth(mk)}`} right={<div className="flex" style={{ gap: 8 }}><button className="btn small" onClick={fillFromCalendar}>Fill fixed costs from payment calendar</button><button className="btn small" disabled={!budgets[prevMk]} onClick={() => setBudgets({ ...budgets, [mk]: { ...budgets[prevMk] } })}>Copy {fmtMonth(prevMk)} budget</button></div>} pad={false}>
      <div className="muted" style={{ padding: "10px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>
        Enter the month's budget per category (for example from the Profit First allocation). Budgets are stored separately and never replace Tende actuals.{monthWin.to !== monthEnd(mk) ? ` Data runs to ${fmtDay(monthWin.to)}, so budgets are pro-rated to that date.` : ""}
      </div>
      <div className="scroll">
        <table className="t"><thead><tr><th>Category</th><th className="r">Monthly budget</th><th className="r">Actual</th><th className="r">Budget for span</th><th className="r">Variance</th><th className="r">Variance %</th><th>Position</th></tr></thead>
          <tbody>{rows.map((r) => {
            const v = r.b !== null ? r.actual - r.b : null;
            return <tr key={r.c}><td><CatDot c={r.c} />{r.c}</td>
              <td className="r"><input aria-label={`${r.c} budget`} inputMode="numeric" value={mb[r.c] ?? ""} onChange={(e) => setVal(r.c, e.target.value.replace(/[^\d]/g, ""))} style={{ width: 120, textAlign: "right" }} placeholder="—" /></td>
              <td className="r num">{ksh(r.actual)}</td><td className="r num muted">{r.b === null ? "—" : ksh(r.b)}{r.prorated ? "*" : ""}</td>
              <td className="r"><ChangeTxt d={v} p={r.b ? (v / r.b) * 100 : null} /></td><td className="r num">{r.b ? pctTxt((v / r.b) * 100) : "—"}</td>
              <td>{v === null ? <span className="muted">No budget</span> : v > 0 ? "Above budget" : v < 0 ? "Within budget" : "On budget"}</td></tr>;
          })}
            {tb.length > 0 && <tr><td style={{ fontWeight: 600 }}>Budgeted categories</td><td></td><td className="r num" style={{ fontWeight: 600 }}>{ksh(sum(tb, (r) => r.actual))}</td><td className="r num">{ksh(sum(tb, (r) => r.b))}</td><td className="r"><ChangeTxt d={sum(tb, (r) => r.actual) - sum(tb, (r) => r.b)} p={((sum(tb, (r) => r.actual) - sum(tb, (r) => r.b)) / sum(tb, (r) => r.b)) * 100} /></td><td></td><td></td></tr>}
          </tbody></table>
      </div>
    </Section>
  );
}

function PendingView({ an, win, pending, setPending, cal }) {
  const blank = { desc: "", category: "", payee: "", amount: "", due: "" };
  const [f, setF] = useState(blank);
  const [linkFor, setLinkFor] = useState(null);
  const [linkRef, setLinkRef] = useState("");
  const ps = pendingSummary(pending, an, win.cur, cal);
  const actual = sum(an.expenses.filter((r) => inWin(r, win.cur)), (r) => r.amount);
  const add = () => { if (!f.desc || !f.amount) return; setPending([...pending, { ...f, amount: +f.amount, id: "P" + Date.now().toString(36), status: "open", created: todayKey() }]); setF(blank); };
  const upd = (id, patch) => setPending(pending.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const t = todayKey();
  return (
    <div>
      <section className="panel grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", marginBottom: 16 }}>
        <div className="stat"><div className="lbl">Actual paid (this period)</div><div className="val num">{ksh(actual)}</div></div>
        <div className="stat"><div className="lbl">Pending obligations (open)</div><div className="val num" style={{ color: "var(--indigo)" }}>{ksh(ps.openTotal)}</div><div className="note">{ps.overdue.length} overdue</div></div>
        <div className="stat"><div className="lbl">Known financial commitment</div><div className="val num">{ksh(actual + ps.openTotal)}</div><div className="note">paid + still owed — not an expense total</div></div>
      </section>
      <Section title="Add an obligation">
        <div className="flex flex-wrap" style={{ gap: 8 }}>
          <input placeholder="What is owed (e.g. August office rent)" value={f.desc} onChange={(e) => setF({ ...f, desc: e.target.value })} style={{ flex: "2 1 240px" }} />
          <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Category</option>{CATEGORY_ORDER.map((c) => <option key={c}>{c}</option>)}</select>
          <input placeholder="Payee" value={f.payee} onChange={(e) => setF({ ...f, payee: e.target.value })} style={{ flex: "1 1 140px" }} />
          <input placeholder="Amount" inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d]/g, "") })} style={{ width: 110 }} />
          <input type="date" aria-label="Due date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} />
          <button className="btn primary" onClick={add} disabled={!f.desc || !f.amount}>Add obligation</button>
        </div>
      </Section>
      <Section title={`Obligations · ${pending.length}`} pad={false}>
        <div className="scroll">
          <table className="t"><thead><tr><th>Due</th><th>Obligation</th><th>Category</th><th>Payee</th><th className="r">Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {ps.calOpen.map((r) => <tr key={r.id}><td className="num" style={{ whiteSpace: "nowrap", color: r.status === "Overdue" ? "var(--red)" : "inherit" }}>{fmtDay(r.due)}</td><td>{r.name} <span className="muted">(payment calendar)</span></td><td><CatDot c={r.category} />{r.category}</td><td>{r.payeeLabel}</td><td className="r num">{ksh(r.remaining)}</td><td><span className={`chip ${r.status === "Overdue" ? "bad" : "pend"}`}>{r.status}</span></td><td className="muted" style={{ fontSize: 12 }}>manage in Payment calendar</td></tr>)}
              {ps.tendePending.map((r) => <tr key={r.id}><td className="num">{fmtDay(r.day)}</td><td>{r.remark} <span className="muted">(Tende status pending)</span></td><td>{r.category}</td><td>{titleCase(r.payee)}</td><td className="r num">{ksh(r.amount)}</td><td><span className="chip pend">Pending in Tende</span></td><td></td></tr>)}
              {[...pending].sort((a, b) => (a.status === b.status ? String(a.due).localeCompare(String(b.due)) : a.status === "open" ? -1 : 1)).map((p) => (
                <tr key={p.id}>
                  <td className="num" style={{ whiteSpace: "nowrap", color: p.status === "open" && p.due && p.due < t ? "var(--red)" : "inherit" }}>{p.due ? fmtDay(p.due) : "—"}</td>
                  <td>{p.desc}{p.paidRef && <div className="muted" style={{ fontSize: 12 }}>Paid via {p.paidRef}</div>}</td><td>{p.category && <><CatDot c={p.category} />{p.category}</>}</td><td>{p.payee}</td><td className="r num">{ksh(p.amount)}</td>
                  <td>{p.status === "open" ? <span className="chip pend">{p.due && p.due < t ? "Overdue" : "Open"}</span> : <span className="chip ok">Paid</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {p.status === "open" && linkFor !== p.id && <button className="btn small" onClick={() => { setLinkFor(p.id); setLinkRef(""); }}>Mark paid</button>}
                    {linkFor === p.id && <span className="flex" style={{ gap: 4 }}><input placeholder="Tende ID (optional)" value={linkRef} onChange={(e) => setLinkRef(e.target.value)} style={{ width: 140 }} /><button className="btn small" onClick={() => { upd(p.id, { status: "paid", paidRef: linkRef.trim() }); setLinkFor(null); }}>Save</button></span>}
                    {p.status === "paid" && <button className="btn small" onClick={() => upd(p.id, { status: "open", paidRef: "" })}>Reopen</button>}
                    <button className="btn small" style={{ marginLeft: 4 }} onClick={() => setPending(pending.filter((x) => x.id !== p.id))}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody></table>
          {!pending.length && !ps.tendePending.length && !ps.calOpen.length && <Empty>No pending obligations recorded. Tende only shows money that moved, so add known unpaid bills (rent, link carrier, salaries due) here.</Empty>}
        </div>
      </Section>
    </div>
  );
}

function PaymentControl({ an, win }) {
  const all = an.recs.filter((r) => r.day && inWin(r, win.cur));
  const exp = an.expenses.filter((r) => inWin(r, win.cur));
  const inits = groupTotals(exp, (r) => r.initiator || "(not recorded)");
  const noApprover = exp.filter((r) => !r.approver).length;
  const apprs = groupTotals(exp.filter((r) => r.approver), (r) => r.approver);
  const statuses = groupTotals(all, (r) => r.statusRaw || "(blank)");
  const wallets = [...new Set(all.map((r) => r.wallet))].map((w) => {
    const l = all.filter((r) => r.wallet === w);
    const inInt = sum(l.filter((r) => r.cls === "INTERNAL" && r.service === "INCOMING"), (r) => r.amount);
    const fund = sum(l.filter((r) => r.cls === "FUNDING"), (r) => r.amount);
    const outInt = sum(l.filter((r) => r.cls === "INTERNAL" && r.service !== "INCOMING"), (r) => r.amount);
    const spent = sum(l.filter((r) => r.cls === "EXPENSE"), (r) => r.amount);
    const charges = sum(l.filter((r) => r.cls === "EXPENSE"), (r) => r.charge);
    return { w, fund, inInt, outInt, spent, charges, net: fund + inInt - outInt - spent - charges };
  });
  const charges = groupTotals(exp.map((r) => ({ ...r, amount: r.charge })), (r) => r.service);
  return (
    <div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 16 }}>
        <Section title="Payments by initiator" pad={false}>
          <table className="t"><thead><tr><th>Initiated by</th><th className="r">Payments</th><th className="r">Total</th><th className="r">Largest</th></tr></thead>
            <tbody>{inits.map((g) => <tr key={g.key}><td>{g.key}</td><td className="r num">{g.count}</td><td className="r num">{ksh(g.total)}</td><td className="r num">{ksh(g.max)}</td></tr>)}</tbody></table>
        </Section>
        <Section title="Approval evidence">
          {noApprover === exp.length && exp.length ? (
            <div><b>Insufficient evidence.</b> The Approved By field is empty on all {exp.length} payments in this period, so approval cannot be confirmed or measured from Tende data. Check whether Tende's approval workflow is switched on or exported.</div>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>{noApprover} of {exp.length} payments have no approver recorded.</div>
              <table className="t"><thead><tr><th>Approved by</th><th className="r">Payments</th><th className="r">Total</th></tr></thead><tbody>{apprs.map((g) => <tr key={g.key}><td>{g.key}</td><td className="r num">{g.count}</td><td className="r num">{ksh(g.total)}</td></tr>)}</tbody></table>
            </>
          )}
        </Section>
      </div>
      <Section title="Wallet movement" pad={false}>
        <div className="muted" style={{ padding: "10px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>How money moved through each Tende wallet in this period. Opening balances are not in the export, so the last column is net movement, not a balance.</div>
        <div className="scroll"><table className="t"><thead><tr><th>Wallet</th><th className="r">Funding in</th><th className="r">From other wallets</th><th className="r">To other wallets</th><th className="r">Expenses paid</th><th className="r">Charges</th><th className="r">Net movement</th></tr></thead>
          <tbody>{wallets.map((x) => <tr key={x.w}><td>{x.w}</td><td className="r num">{ksh(x.fund)}</td><td className="r num">{ksh(x.inInt)}</td><td className="r num">{ksh(x.outInt)}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(x.spent)}</td><td className="r num">{ksh(x.charges)}</td><td className="r num" style={{ color: x.net < 0 ? "var(--red)" : "inherit" }}>{ksh(x.net)}</td></tr>)}</tbody></table></div>
      </Section>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 16 }}>
        <Section title="Transaction status (all rows)" pad={false}>
          <table className="t"><thead><tr><th>Status</th><th className="r">Rows</th><th className="r">Amount</th></tr></thead><tbody>{statuses.map((g) => <tr key={g.key}><td>{g.key}</td><td className="r num">{g.count}</td><td className="r num">{ksh(g.total)}</td></tr>)}</tbody></table>
          <div className="muted" style={{ padding: "8px 16px", fontSize: 12.5 }}>Failed: {all.filter((r) => r.cls === "FAILED").length} · Reversed: {all.filter((r) => r.cls === "REVERSED").length} · Pending: {all.filter((r) => r.cls === "PENDING").length}</div>
        </Section>
        <Section title={`Charges · ${ksh(sum(exp, (r) => r.charge))}`} pad={false}>
          <table className="t"><thead><tr><th>Payment method</th><th className="r">Payments</th><th className="r">Charges</th><th className="r">Avg per payment</th></tr></thead><tbody>{charges.map((g) => <tr key={g.key}><td>{g.key}</td><td className="r num">{g.count}</td><td className="r num">{ksh(g.total)}</td><td className="r num">KSh {(g.total / g.count).toFixed(1)}</td></tr>)}</tbody></table>
        </Section>
      </div>
    </div>
  );
}

function DataHealth({ an, rawCount, importLog, clearAll }) {
  const c = (k) => an.recs.filter((r) => r.cls === k).length;
  const exp = an.expenses;
  const lines = [
    ["Rows stored", rawCount], ["Actual expense transactions", exp.length], ["Internal transfers excluded", c("INTERNAL")], ["Incoming funding excluded", c("FUNDING")],
    ["Failed / reversed", c("FAILED") + c("REVERSED")], ["Pending in Tende", c("PENDING")], ["Unverified rows", c("UNVERIFIED")],
    ["Missing or bad dates", an.recs.filter((r) => !r.day).length], ["Missing or bad amounts", an.recs.filter((r) => r.amount === null).length],
    ["Expenses with no remark", exp.filter((r) => !r.remark).length], ["Expenses with no recipient name", exp.filter((r) => !String(r.raw["NAME"] || "").trim()).length],
    ["Unclassified (needs review)", exp.filter((r) => r.category === "Unclassified").length], ["Medium-confidence classifications", exp.filter((r) => r.confidence === "Medium").length],
    ["Manually classified", exp.filter((r) => r.confidence === "Manual").length], ["Payments with no approver", exp.filter((r) => !r.approver).length],
    ["Low-confidence classifications", exp.filter((r) => r.confidence === "Low").length],
    ["Inventory payments with full detail", exp.filter((r) => r.purchaseDetail === "Complete").length],
    ["Inventory payments missing quantity or item", exp.filter((r) => r.detailMissing && r.detailMissing.length).length],
    ["Salary advances with no future month stated", exp.filter((r) => r.advanceUnspecified).length],
    ["Staff payments with no person named (bank/business)", exp.filter((r) => r.category === "Staff & Payroll" && !r.employee).length],
    ["Payments with a stated month relating to", exp.filter((r) => r.relatesTo).length],
    ["Date range", an.firstDay ? `${fmtDay(an.firstDay)} – ${fmtDay(an.lastDay)}` : "—"], ["Wallets covered", [...new Set(an.recs.map((r) => r.wallet))].join(", ")],
  ];
  const uv = an.recs.filter((r) => r.cls === "UNVERIFIED");
  return (
    <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 16 }}>
      <Section title="Data health" pad={false}>
        <table className="t"><tbody>{lines.map(([k, v]) => <tr key={k}><td>{k}</td><td className="r num" style={{ fontWeight: 600 }}>{v}</td></tr>)}</tbody></table>
        {uv.length > 0 && <div style={{ padding: "10px 16px" }}>{uv.slice(0, 10).map((r) => <div key={r.id} className="muted" style={{ fontSize: 12.5 }}>{r.id}: {r.clsReason}</div>)}</div>}
      </Section>
      <Section title="Import log" right={<span className="flex" style={{ gap: 6 }}><button className="btn small" onClick={clearAll}>Delete all stored data</button></span>} pad={false}>
        <table className="t"><thead><tr><th>When</th><th>File</th><th className="r">Rows</th><th className="r">Added</th><th className="r">Duplicates skipped</th><th className="r">Rejected</th></tr></thead>
          <tbody>{[...importLog].reverse().map((l, i) => <tr key={i}><td className="num" style={{ whiteSpace: "nowrap" }}>{l.at}</td><td>{l.file}</td><td className="r num">{l.rows}</td><td className="r num">{l.added}</td><td className="r num">{l.dups}</td><td className="r num">{l.rejected}</td></tr>)}</tbody></table>
        {!importLog.length && <Empty>No imports yet.</Empty>}
      </Section>
    </div>
  );
}

/* ======================================================================
   REPORTS
   ====================================================================== */
function buildDailyReport(an, day, ctx) {
  const today = an.expenses.filter((r) => r.day === day);
  const yday = an.expenses.filter((r) => r.day === addDays(day, -1));
  const t = sum(today, (r) => r.amount), y = sum(yday, (r) => r.amount);
  const big = [...today].sort((a, b) => b.amount - a.amount)[0];
  const cats = groupTotals(today, (r) => r.category);
  const unusual = today.filter((r) => r.flags.length && r.review !== "cleared");
  const rec = today.filter((r) => r.recurring);
  const norm = normalDailyLevel(an, day);
  const win = { cur: { from: day, to: day }, prev: { from: addDays(day, -1), to: addDays(day, -1), label: fmtDay(addDays(day, -1)) } };
  const ps = pendingSummary(ctx.pending, an, win.cur, ctx.calendar);
  const L = [];
  L.push(`HAPPYNET — DAILY EXPENSE POSITION`, `${fmtDay(day)}`, ``);
  if (!today.length) L.push(`No actual expenses recorded in Tende for this day.`);
  else {
    L.push(`Actual spending: ${ksh(t)} (${today.length} payment${today.length > 1 ? "s" : ""}) + ${ksh(sum(today, (r) => r.charge))} charges`);
    L.push(`Largest expense: ${ksh(big.amount)} — ${titleCase(big.payee)} — "${big.remark}"`);
    L.push(`Top category: ${cats[0].key} ${ksh(cats[0].total)}`);
    for (const c of cats.slice(1, 4)) L.push(`  • ${c.key} ${ksh(c.total)}`);
    L.push(`Recurring expenses: ${ksh(sum(rec, (r) => r.amount))} (${rec.length})`);
    L.push(`Unusual transactions: ${unusual.length}${unusual.length ? " — " + unusual.slice(0, 3).map((r) => `${ksh(r.amount)} ${r.remark} (${r.flags[0].label.toLowerCase()})`).join("; ") : ""}`);
  }
  L.push(`Pending obligations: ${ksh(ps.openTotal)} open${ps.dueInWindow.length ? `, ${ps.dueInWindow.length} due today` : ""}${ps.overdue.length ? `, ${ps.overdue.length} overdue` : ""}`);
  const ch = change(t, y);
  if (addDays(day, -1) < an.firstDay) { win.prev = null; L.push(`Vs previous day: no imported data for ${fmtDay(addDays(day, -1))}`); } else L.push(`Vs previous day: ${ksh(y)} → ${ksh(t)} (${diffTxt(ch.diff)}${ch.pct !== null ? ` / ${pctTxt(ch.pct)}` : ""})`);
  L.push(norm ? `Vs normal daily level: median ${ksh(norm.median)} over previous ${norm.days} days → ${diffTxt(t - norm.median)}` : `Vs normal daily level: not enough history yet (need 7+ days before this date)`);
  const alD = ctx.calState ? paymentAlerts(an, ctx.calState, monthKey(day)) : null;
  if (alD && alD.live.length) L.push(``, `FIXED PAYMENTS — ${fmtMonth(alD.view)} (as of ${fmtDay(alD.today)})`, alertsText(alD, false));
  const att = attentionItems(an, { ...ctx, win });
  L.push(``, `MANAGEMENT ATTENTION`);
  if (!att.length) L.push(`Nothing flagged by the data.`); else att.forEach((a) => L.push(`• ${a.text}`));
  const unc = today.filter((r) => r.category === "Unclassified");
  if (unc.length) L.push(`• ${unc.length} payment${unc.length > 1 ? "s" : ""} could not be classified: ${unc.map((r) => `"${r.remark}" ${ksh(r.amount)}`).join("; ")}.`);
  return L.join("\n");
}

function buildWeeklyReport(an, anchorDay, ctx) {
  const p = makePeriod("week", anchorDay);
  const win = windows(p, an.lastDay);
  const cur = an.expenses.filter((r) => inWin(r, win.cur));
  if (win.prev && an.firstDay > win.prev.to) win.prev = null;
  const prev = win.prev ? an.expenses.filter((r) => inWin(r, win.prev)) : [];
  const t = sum(cur, (r) => r.amount), pt = sum(prev, (r) => r.amount), ch = change(t, pt);
  const cats = groupTotals(cur, (r) => r.category), recips = groupTotals(cur, (r) => r.payee);
  const rec = recurringTable(an, cur, prev.length ? prev : null);
  const unusual = cur.filter((r) => r.flags.length && r.review !== "cleared");
  const ps = pendingSummary(ctx.pending, an, win.cur, ctx.calendar);
  const brows = budgetRows(an, ctx.budgets, win.cur).filter((b) => b.budget !== null);
  const L = [];
  L.push(`HAPPYNET — WEEKLY EXPENSE SUMMARY`, `${fmtDay(win.cur.from)} – ${fmtDay(win.cur.to)}${win.partial ? " (week to date)" : ""}`, ``);
  L.push(`Total actual expenses: ${ksh(t)} (${cur.length} payments) + ${ksh(sum(cur, (r) => r.charge))} charges`);
  if (win.prev) { L.push(`Previous week (same span): ${ksh(pt)}`); L.push(`Change: ${diffTxt(ch.diff)}${ch.pct !== null ? ` / ${pctTxt(ch.pct)}` : ""}`); }
  else L.push(`Previous week: no imported data to compare`);
  if (brows.length) { const bb = sum(brows, (b) => b.budget), ba = sum(brows, (b) => b.actual); L.push(`Budget (pro-rated, budgeted categories): ${ksh(bb)} — actual ${ksh(ba)} — variance ${diffTxt(ba - bb)} / ${pctTxt(((ba - bb) / bb) * 100)}`); }
  else L.push(`Budget: none entered for this period`);
  L.push(``, `Top categories`); cats.slice(0, 5).forEach((c) => { if (!win.prev) { L.push(`  • ${c.key}: ${ksh(c.total)}`); return; } const p2 = sum(prev.filter((r) => r.category === c.key), (r) => r.amount); const x = change(c.total, p2); L.push(`  • ${c.key}: ${ksh(c.total)} (${diffTxt(x.diff)}${x.pct !== null ? ` / ${pctTxt(x.pct)}` : ""})`); });
  L.push(``, `Top recipients`); recips.slice(0, 5).forEach((c) => L.push(`  • ${titleCase(c.key)}: ${ksh(c.total)} in ${c.count} payment${c.count > 1 ? "s" : ""}`));
  L.push(``, `Recurring expenses: ${ksh(sum(rec, (r) => r.total))}`); rec.slice(0, 5).forEach((r) => L.push(`  • ${r.subcategory}: ${r.count} × avg ${ksh(r.avg)} = ${ksh(r.total)} · ${r.trend}`));
  L.push(``, `Unusual expenses: ${unusual.length}`); unusual.sort((a, b) => b.amount - a.amount).slice(0, 5).forEach((r) => L.push(`  • ${fmtDay(r.day)} ${ksh(r.amount)} — ${r.remark} — ${r.flags.map((f) => f.label.toLowerCase()).join(", ")}`));
  L.push(``, `Pending obligations: ${ksh(ps.openTotal)} open (${ps.openCount})${ps.overdue.length ? `, ${ps.overdue.length} overdue` : ""}`);
  const att = attentionItems(an, { ...ctx, win });
  const alW = ctx.calState ? paymentAlerts(an, ctx.calState, monthKey(anchorDay)) : null;
  if (alW && alW.live.length) L.push(``, `FIXED PAYMENTS — ${fmtMonth(alW.view)} (as of ${fmtDay(alW.today)})`, alertsText(alW, false));
  L.push(``, `MANAGEMENT OBSERVATIONS`);
  if (!att.length) L.push(`Nothing flagged by the data.`); else att.forEach((a) => L.push(`• ${a.text}`));
  return L.join("\n");
}


function buildMonthlyOverview(an, day, ctx) {
  const mk = monthKey(day);
  const p = makePeriod("month", day);
  const win = windows(p, an.lastDay);
  const cur = an.expenses.filter((r) => inWin(r, win.cur));
  const total = sum(cur, (r) => r.amount);
  const L = [];
  L.push(`HAPPYNET — WHAT DID WE SPEND MONEY ON?`, `${fmtMonth(mk)}${win.partial ? ` (data to ${fmtDay(win.cur.to)})` : ""}`, ``);
  if (!cur.length) { L.push("No actual expenses recorded for this month."); return L.join("\n"); }
  L.push(`Total actual expenses: ${ksh(total)} in ${cur.length} payments (+ ${ksh(sum(cur, (r) => r.charge))} charges). Internal transfers and incoming funds excluded.`);
  const cats = groupTotals(cur, (r) => r.category).sort((a, b) => CATEGORY_ORDER.indexOf(a.key) - CATEGORY_ORDER.indexOf(b.key));
  for (const c of cats) {
    L.push(``, `${c.key.toUpperCase()} — ${ksh(c.total)} (${((c.total / total) * 100).toFixed(0)}%)`);
    if (c.key === "Staff & Payroll") {
      const ps = payrollSummary(an, c.list, mk);
      for (const e of ps.employees) {
        L.push(`• ${e.name} — ${ksh(e.total)}`);
        for (const r of e.rows) L.push(`    – ${r.payType} ${ksh(r.amount)} on ${fmtDay(r.day)}; relates to ${relText(r)}`);
      }
      const cv = ps.cashVsPeriod;
      L.push(`  Cash paid to staff this month: ${ksh(cv.cash)}. Relating to ${fmtMonth(mk)} by remark: ${ksh(cv.current)}; earlier months: ${ksh(sum(cv.earlier, (r) => r.amount))}; future months: ${ksh(sum(cv.future, (r) => r.amount))}; advances with no month stated: ${ksh(sum(cv.advUnspecified, (r) => r.amount))}; month not stated: ${ksh(sum(cv.unstated, (r) => r.amount))}.`);
    } else if (c.key === "Inventory & Equipment") {
      for (const g of groupTotals(c.list, (r) => r.subcategory)) {
        L.push(`• ${g.key} — ${ksh(g.total)} (${g.count} payment${g.count > 1 ? "s" : ""})`);
        for (const x of itemSummary(g.list)) {
          const parts = [x.unitsText ? `${x.unitsText} stated` : "quantity not available in source"];
          if (x.soloPayments) parts.push(`${ksh(x.soloSpend)} when bought alone`);
          if (x.avgUnitCost) parts.push(`avg ${ksh(x.avgUnitCost)} per ${x.unitCostUnit === "units" ? "unit" : x.unitCostUnit} (calculated)`);
          if (x.mixedPayments) parts.push(`also in ${x.mixedPayments} mixed purchase${x.mixedPayments > 1 ? "s" : ""} (cost not separable)`);
          L.push(`    – ${x.name}: ${parts.join("; ")}`);
        }
      }
    } else if (c.key === "Unclassified") {
      for (const r of c.list) L.push(`• ${fmtDay(r.day)} ${ksh(r.amount)} to ${titleCase(r.payee)} — "${r.remark}" (needs classification)`);
    } else {
      for (const g of groupTotals(c.list, (r) => r.subcategory)) {
        const payees = groupTotals(g.list, (r) => titleCase(r.payee)).slice(0, 3).map((x) => `${x.key} ${ksh(x.total)}`).join(", ");
        L.push(`• ${g.key} — ${ksh(g.total)} (${g.count} payment${g.count > 1 ? "s" : ""}, ${frequencyOf(an.expenses.filter((r) => r.category === c.key && r.subcategory === g.key)).toLowerCase()}) — ${payees}`);
      }
    }
  }
  const inc = cur.filter((r) => r.detailMissing && r.detailMissing.length);
  const adv = cur.filter((r) => r.advanceUnspecified);
  L.push(``, `DATA NOTES`);
  L.push(`• ${inc.length} inventory payment${inc.length === 1 ? "" : "s"} (${ksh(sum(inc, (r) => r.amount))}) do not state a quantity or item, so no quantity is shown for them.`);
  if (adv.length) L.push(`• ${adv.length} salary advance${adv.length === 1 ? "" : "s"} (${ksh(sum(adv, (r) => r.amount))}) do not say which future month they relate to.`);
  const low = cur.filter((r) => r.confidence === "Low" || r.confidence === "Unclassified");
  if (low.length) L.push(`• ${low.length} payment${low.length === 1 ? "" : "s"} could not be classified with confidence (${ksh(sum(low, (r) => r.amount))}).`);
  return L.join("\n");
}

function Reports({ an, ctx, period }) {
  const [kind, setKind] = useState("daily");
  const [day, setDay] = useState(period.mode === "day" ? period.from : an.lastDay);
  const [copied, setCopied] = useState(false);
  const text = kind === "daily" ? buildDailyReport(an, day, ctx) : kind === "weekly" ? buildWeeklyReport(an, day, ctx) : buildMonthlyOverview(an, day, ctx);
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); } };
  return (
    <Section title="Management reports" right={
      <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
        <div className="seg"><button aria-pressed={kind === "daily"} onClick={() => setKind("daily")}>Daily</button><button aria-pressed={kind === "weekly"} onClick={() => setKind("weekly")}>Weekly</button><button aria-pressed={kind === "monthly"} onClick={() => setKind("monthly")}>Monthly detail</button></div>
        <input type="date" aria-label="Report date" value={day || ""} min={an.firstDay || undefined} max={an.lastDay || undefined} onChange={(e) => e.target.value && setDay(e.target.value)} />
        <button className="btn primary small" onClick={copy}>{copied ? "Copied" : "Copy report"}</button>
        <button className="btn small" onClick={() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = `happynet-${kind}-expense-report-${day}.txt`; a.click(); }}>Download .txt</button>
      </div>}>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>{kind === "weekly" ? "Covers the Monday–Sunday week containing the chosen date." : kind === "monthly" ? "Everything the month's money went on — per person, per item, per supplier — for the month containing the chosen date." : "Plain text, ready to paste into WhatsApp or email."}</div>
      <div className="report num">{text}</div>
    </Section>
  );
}

/* ======================================================================
   ASK PANEL (natural-language questions → exact local computation)
   ====================================================================== */
async function callClaude(system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, system, messages }),
  });
  if (!res.ok) throw new Error(`The assistant service returned ${res.status}.`);
  const data = await res.json();
  return (data.content || []).map((c) => (c.type === "text" ? c.text : "")).join("\n").trim();
}
const EXAMPLES = ["Which fixed payments are overdue?", "Break down payroll person by person", "How many routers did we buy and at what unit cost?", "How much did we spend on Advanta?", "Which payments were salary advances?", "How much did we spend on fuel in the latest month?", "Who received the most money?", "Show unusual payments", "Show me recurring expenses", "Compare the latest month with the month before", "What did we spend on the latest day?"];

function AskPanel({ an, ctx, onClose, openTxn }) {
  const [msgs, setMsgs] = useState([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current && endRef.current.scrollIntoView({ block: "end" }); }, [msgs, busy]);
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const ask = async (question) => {
    if (!question.trim() || busy) return;
    setQ(""); setBusy(true);
    const history = msgs.filter((m) => m.role === "user" || m.role === "assistant").slice(-6).map((m) => ({ role: m.role, content: m.text }));
    setMsgs((m) => [...m, { role: "user", text: question }]);
    const convo = [...history, { role: "user", content: question }];
    let rows = [];
    try {
      const system = ASK_SYSTEM(an, ctx);
      let reply = await callClaude(system, convo);
      for (let round = 0; round < 3; round++) {
        const qs = [...reply.matchAll(/<query>([\s\S]*?)<\/query>/g)].map((m) => m[1]);
        if (!qs.length) break;
        const results = qs.map((txt) => { try { const ex = executeQuery(JSON.parse(txt), an, ctx); rows = rows.concat(ex.rows); return ex.result; } catch (e) { return { error: "Could not read query: " + e.message }; } });
        let payload = JSON.stringify(results); if (payload.length > 14000) payload = payload.slice(0, 14000) + "…(truncated)";
        convo.push({ role: "assistant", content: reply }, { role: "user", content: `<results>${payload}</results>` });
        reply = await callClaude(system, convo);
      }
      reply = reply.replace(/<query>[\s\S]*?<\/query>/g, "").trim() || "I couldn't produce an answer from the data for that question. Try naming a period or category.";
      const uniq = [...new Map(rows.map((r) => [r.id, r])).values()].slice(0, 25);
      setMsgs((m) => [...m, { role: "assistant", text: reply, rows: uniq }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "error", text: `${e.message} The figures on the other screens are unaffected; try again in a moment.` }]);
    } finally { setBusy(false); }
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="Ask about expenses">
        <div className="flex items-center justify-between" style={{ padding: 16, borderBottom: "1px solid var(--line)" }}>
          <div><h2 className="h2">Ask about expenses</h2><div className="muted" style={{ fontSize: 12.5 }}>Answers are computed from your imported Tende data.</div></div>
          <button className="btn small" onClick={onClose}>Close</button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {!msgs.length && <div><div className="muted" style={{ marginBottom: 8 }}>Try one of these:</div><div className="flex flex-wrap" style={{ gap: 6 }}>{EXAMPLES.map((e) => <button key={e} className="pill" onClick={() => ask(e)}>{e}</button>)}</div></div>}
          {msgs.map((m, i) => (
            <div key={i}>
              <div className={`msg ${m.role === "user" ? "user" : "bot"}`} style={m.role === "error" ? { background: "var(--redbg)", color: "var(--red)" } : {}}>{m.text}</div>
              {m.rows && m.rows.length > 0 && (
                <div className="panel scroll" style={{ marginTop: 6, maxHeight: 240 }}>
                  <table className="t"><thead><tr><th>Date</th><th>Description</th><th className="r">Amount</th><th>Recipient</th></tr></thead>
                    <tbody>{m.rows.map((r) => <tr key={r.id} className="click" onClick={() => openTxn(r.id)}><td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.day)}</td><td>{r.remark}</td><td className="r num">{ksh(r.amount)}</td><td>{titleCase(r.payee)}</td></tr>)}</tbody></table>
                </div>
              )}
            </div>
          ))}
          {busy && <div className="muted">Working out the figures…</div>}
          <div ref={endRef} />
        </div>
        <div className="flex" style={{ gap: 8, padding: 12, borderTop: "1px solid var(--line)" }}>
          <input aria-label="Your question" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") ask(q); }} placeholder="e.g. How much did we pay Supplier A?" style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy || !q.trim()} onClick={() => ask(q)}>Ask</button>
        </div>
      </aside>
    </>
  );
}

/* ======================================================================
   REVENUE — M-Pesa utility account statements (money in from customers,
   sweeps out to the settlement account). Stored as daily totals.
   ====================================================================== */
const HOTSPOT_MAX = 69; // payments up to KSh 69 are hotspot vouchers; 70+ are PPPoE (same rule as the customer analytics app)
const isUtilityStatement = (text) => /Receipt No\./.test(text) && /Paid In/.test(text) && /Withdrawn/.test(text);
function parseUtilityStatement(text, fileName) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const hi = lines.findIndex((l) => l.startsWith("Receipt No."));
  const meta = { file: fileName };
  for (const l of lines.slice(0, hi)) {
    const c = l.split(",").map((x) => x.trim());
    if (/^Account Holder/.test(c[0])) meta.holder = c[1];
    if (/^Short Code/.test(c[0])) meta.shortCode = c[1];
    if (/^Time Period/.test(c[0])) { meta.fromRaw = c[2]; meta.toRaw = c[4]; }
    if (/^Opening Balance/.test(c[0])) { meta.opening = num(c[1]); meta.closing = num(c[3]); meta.paidIn = num(c[5]); meta.withdrawn = Math.abs(num(c[7]) || 0); }
  }
  const dmy = (s) => { const m = String(s || "").match(/(\d{2})-(\d{2})-(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  meta.from = dmy(meta.fromRaw); meta.to = dmy(meta.toRaw);
  const parsed = Papa.parse(lines.slice(hi).join("\n"), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
  const days = {}; let inSum = 0, outSum = 0, skipped = 0;
  for (const r of parsed.data) {
    const day = dmy(r["Completion Time"]);
    if (!day) { skipped++; continue; }
    if (String(r["Transaction Status"] || "").trim() && !/complete/i.test(r["Transaction Status"])) { skipped++; continue; }
    const d = (days[day] ||= { total: 0, hotspot: 0, pppoe: 0, count: 0, hotspotCount: 0, pppoeCount: 0, swept: 0, otherOut: 0 });
    const pin = num(r["Paid In"]), pout = Math.abs(num(r["Withdrawn"]) || 0);
    if (pin > 0) { d.total += pin; d.count++; inSum += pin; if (pin <= HOTSPOT_MAX) { d.hotspot += pin; d.hotspotCount++; } else { d.pppoe += pin; d.pppoeCount++; } }
    if (pout > 0) { outSum += pout; if (/settlement/i.test(r["Reason Type"] || r["Details"] || "")) d.swept += pout; else d.otherOut += pout; }
  }
  const dayKeys = Object.keys(days).sort();
  if (!meta.from) meta.from = dayKeys[0]; if (!meta.to) meta.to = dayKeys[dayKeys.length - 1];
  return { meta, days, computedIn: inSum, computedOut: outSum, rows: parsed.data.length, skipped,
    reconciles: meta.paidIn == null || (Math.abs(meta.paidIn - inSum) < 1 && Math.abs((meta.withdrawn || 0) - outSum) < 1) };
}

function revenueFor(revDays, from, to) {
  const ks = Object.keys(revDays || {}).filter((k) => k >= from && k <= to).sort();
  const t = { total: 0, hotspot: 0, pppoe: 0, count: 0, swept: 0, days: ks.length, firstDay: ks[0] || null, lastDay: ks[ks.length - 1] || null };
  for (const k of ks) { const d = revDays[k]; t.total += d.total; t.hotspot += d.hotspot; t.pppoe += d.pppoe; t.count += d.count; t.swept += d.swept; }
  return t;
}

// Money into Tende from the business vs from the owner, and money spent out of Tende
function tendeFlows(an, from, to) {
  const inWinD = (r) => r.day && r.day >= from && r.day <= to;
  const funding = an.recs.filter((r) => r.cls === "FUNDING" && inWinD(r));
  const owner = funding.filter((r) => /^OWNER\b/i.test(r.payee));
  const business = funding.filter((r) => !/^OWNER\b/i.test(r.payee));
  const spent = an.expenses.filter(inWinD);
  return { business: sum(business, (r) => r.amount), owner: sum(owner, (r) => r.amount), spent: sum(spent, (r) => r.amount + r.charge), covered: !!(an.firstDay && an.lastDay && an.firstDay <= to && an.lastDay >= from), tendeTo: an.lastDay };
}

function RevenueView({ an, cs, setCs, mk, revenue }) {
  const revDays = (revenue && revenue.days) || {};
  const from = mk + "-01", to = monthEnd(mk), dim = +to.slice(8);
  const rv = revenueFor(revDays, from, to);
  const target = (cs.targets || {})[mk];
  const pct = (+cs.opexPct || 60) / 100;
  const tf = tendeFlows(an, from, to);
  const tendeOverlap = tf.covered;
  const revSpanTo = rv.lastDay || from;
  const tfSame = tendeOverlap ? tendeFlows(an, from, revSpanTo < (an.lastDay || from) ? revSpanTo : an.lastDay) : null;
  const revSame = tendeOverlap ? revenueFor(revDays, from, an.lastDay < revSpanTo ? an.lastDay : revSpanTo) : null;
  const entitlement = rv.total * pct;
  const projected = rv.days ? (rv.total / rv.days) * dim : null;
  const daysList = Array.from({ length: dim }, (_, i) => dueOn(mk, i + 1));
  let cumEnt = 0, cumSpent = 0;
  const stmt = (revenue && revenue.statements || []).filter((s) => s.from <= to && s.to >= from);
  const setTarget = (v) => setCs({ ...cs, targets: { ...(cs.targets || {}), [mk]: v === "" ? undefined : +v } });
  return (
    <div>
      {!rv.days && <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 14, background: "var(--amberbg)" }}>No utility account statement covers {fmtMonth(mk)}. Import the M-Pesa utility account CSV for this month with the Import button — it is recognised automatically.</div>}
      <section className="panel grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", marginBottom: 16 }}>
        <div className="stat"><div className="lbl">Revenue {rv.days && rv.days < dim ? `(${rv.days} days)` : ""}</div><div className="val num">{ksh(rv.total)}</div><div className="note">Hotspot {ksh(rv.hotspot)} · PPPoE {ksh(rv.pppoe)}</div></div>
        <div className="stat"><div className="lbl">Monthly target</div><div className="val"><input inputMode="numeric" value={target ?? ""} placeholder="set target" onChange={(e) => setTarget(e.target.value.replace(/[^\d]/g, ""))} style={{ width: 140, fontSize: 16, textAlign: "right" }} /></div><div className="note">{target ? `${((rv.total / target) * 100).toFixed(1)}% achieved${projected && rv.days < dim ? ` · on pace for ${ksh(projected)}` : ""}` : "entered manually"}</div></div>
        <div className="stat"><div className="lbl">OpEx share</div><div className="val"><input inputMode="numeric" value={cs.opexPct ?? 60} onChange={(e) => setCs({ ...cs, opexPct: e.target.value.replace(/[^\d.]/g, "") })} style={{ width: 60, fontSize: 16, textAlign: "right" }} /> %</div><div className="note">of revenue may be spent on operations</div></div>
        <div className="stat"><div className="lbl">OpEx allowed this month</div><div className="val num">{ksh(entitlement)}</div><div className="note">{(100 - pct * 100).toFixed(0)}% set aside: {ksh(rv.total - entitlement)}</div></div>
      </section>

      <Section title="Allocation check — what was allowed vs what moved and was spent">
        {!tendeOverlap ? <div className="muted">No Tende data for {fmtMonth(mk)} yet, so actual transfers and spending can't be compared. Import this month's Tende CSV.</div> : (
          <>
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>Compared over the days both sources cover: {fmtDay(from)} – {fmtDay(an.lastDay < revSpanTo ? an.lastDay : revSpanTo)}.</div>
            <table className="t"><tbody>
              <tr><td>Revenue</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(revSame.total)}</td><td></td></tr>
              <tr><td>OpEx allowed ({cs.opexPct || 60}%)</td><td className="r num">{ksh(revSame.total * pct)}</td><td></td></tr>
              <tr><td>Business money moved into Tende</td><td className="r num">{ksh(tfSame.business)}</td><td className="num" style={{ color: tfSame.business > revSame.total * pct ? "var(--red)" : "var(--green)" }}>{revSame.total ? `${((tfSame.business / revSame.total) * 100).toFixed(1)}% of revenue · ${diffTxt(tfSame.business - revSame.total * pct)} vs allowed` : ""}</td></tr>
              <tr><td>Owner money put into Tende</td><td className="r num">{ksh(tfSame.owner)}</td><td className="muted">loan — recorded in the owner loan ledger</td></tr>
              <tr><td>Spent from Tende (incl. charges)</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(tfSame.spent)}</td><td className="num" style={{ color: tfSame.spent > revSame.total * pct ? "var(--red)" : "var(--green)" }}>{revSame.total ? `${((tfSame.spent / revSame.total) * 100).toFixed(1)}% of revenue · ${diffTxt(tfSame.spent - revSame.total * pct)} vs allowed` : ""}</td></tr>
            </tbody></table>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>The utility statement only shows money swept to the settlement account, not how it was then split between accounts, so "set aside" is worked out as revenue minus what reached Tende.</div>
          </>
        )}
      </Section>

      {rv.days > 0 && (
        <Section title="Daily revenue">
          <div style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={daysList.map((k) => ({ label: String(+k.slice(8)), hotspot: (revDays[k] || {}).hotspot || 0, pppoe: (revDays[k] || {}).pppoe || 0 }))} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="#E6EAE8" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#4A5A66" }} />
                <YAxis tick={{ fontSize: 11, fill: "#4A5A66" }} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)} width={40} />
                <Tooltip formatter={(v) => ksh(v)} labelFormatter={(l) => `Day ${l}`} />
                <Bar dataKey="hotspot" stackId="a" name="Hotspot" fill="#0F6E6A" />
                <Bar dataKey="pppoe" stackId="a" name="PPPoE" fill="#6A4C9C" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="scroll" style={{ maxHeight: 420, marginTop: 10 }}>
            <table className="t"><thead><tr><th>Date</th><th className="r">Hotspot</th><th className="r">PPPoE</th><th className="r">Revenue</th><th className="r">Payments</th><th className="r">OpEx allowed</th><th className="r">Spent from Tende</th><th className="r">Allowed − spent (running)</th></tr></thead>
              <tbody>{daysList.map((k) => {
                const d = revDays[k]; const sp = an.lastDay && k <= an.lastDay && k >= an.firstDay ? sum(an.expenses.filter((r) => r.day === k), (r) => r.amount + r.charge) : null;
                if (d) cumEnt += d.total * pct; if (sp !== null) cumSpent += sp;
                return <tr key={k}><td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(k).slice(0, -5)}</td><td className="r num">{d ? ksh(d.hotspot) : "—"}</td><td className="r num">{d ? ksh(d.pppoe) : "—"}</td><td className="r num" style={{ fontWeight: 600 }}>{d ? ksh(d.total) : <span className="muted">no data</span>}</td><td className="r num">{d ? d.count.toLocaleString() : ""}</td><td className="r num">{d ? ksh(d.total * pct) : ""}</td><td className="r num">{sp === null ? <span className="muted">—</span> : ksh(sp)}</td><td className="r num" style={{ color: d && sp !== null ? (cumEnt - cumSpent < 0 ? "var(--red)" : "inherit") : "var(--mute)" }}>{d && sp !== null ? ksh(cumEnt - cumSpent) : ""}</td></tr>;
              })}</tbody></table>
          </div>
        </Section>
      )}

      <Section title="Statements imported" pad={false}>
        <table className="t"><thead><tr><th>Period</th><th>File</th><th className="r">Paid in</th><th className="r">Withdrawn</th><th className="r">Opening → closing</th><th>Check</th></tr></thead>
          <tbody>{(revenue && revenue.statements || []).slice().sort((a, b) => b.from.localeCompare(a.from)).map((s, i) => <tr key={i}><td className="num">{fmtDay(s.from)} – {fmtDay(s.to)}</td><td style={{ fontSize: 12.5 }}>{s.file}</td><td className="r num">{ksh(s.computedIn)}</td><td className="r num">{ksh(s.computedOut)}</td><td className="r num">{s.opening != null ? `${ksh(s.opening)} → ${ksh(s.closing)}` : "—"}</td><td>{s.reconciles ? <span className="chip ok">Matches statement totals</span> : <span className="chip review">Totals differ from header</span>}</td></tr>)}</tbody></table>
        {!stmt.length && <Empty>No statement covers {fmtMonth(mk)}.</Empty>}
      </Section>
    </div>
  );
}

/* ======================================================================
   PAYMENT CALENDAR — fixed obligations, payroll schedule, Profit First cash plan
   In this public demo the defaults below are invented (see "PUBLIC DEMO DEFAULTS").
   ====================================================================== */
// PUBLIC DEMO DEFAULTS
// The original app ships with the company's real October 2026 payment calendar and payroll.
// Those (staff names, salaries, payees, phone numbers, account numbers and revenue) are not
// published. Everything below is invented, and the months follow today's date so the demo
// calendar, alerts and payroll are always current.
const DEMO_MONTH = todayKey().slice(0, 7);
const demoShiftMonth = (mk, n) => { const [y, m] = mk.split("-").map(Number); const t = y * 12 + (m - 1) + n; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`; };
const DEMO_PREV = demoShiftMonth(DEMO_MONTH, -1);
const DEMO_START = demoShiftMonth(DEMO_MONTH, -3);
const OBL_DEFAULTS = { active: true, freq: "monthly", every: 1, anchor: DEMO_MONTH, startMonth: DEMO_START, amountType: "fixed", tier: 3, payees: [], keywords: [], keywordRequired: false, group: "", note: "" };
const DEFAULT_OBLIGATIONS = [
  { id: "main-link", name: "Main Internet Link", category: "Connectivity", subcategory: "Internet link", payee: "Upstream Fibre Ltd (paybill 400200)", day: 1, amount: 60000, tier: 1, payees: ["400200", "UPSTREAM FIBRE"], keywords: ["internet link", "bandwidth"], note: "Upstream bandwidth for the whole network." },
  { id: "office-rent", name: "Head Office Rent", category: "Premises", subcategory: "Rent", payee: "Greenview Properties", day: 5, amount: 15000, tier: 2, payees: ["GREENVIEW"], keywords: ["office rent"], keywordRequired: true },
  { id: "north-rent", name: "North Site Rent & Server Room", category: "Premises", subcategory: "Rent", payee: "Peter Otieno Ouma", day: 5, amountType: "lateFee", amount: 6000, lateFeePerDay: 30, tier: 2, payees: ["PETER OTIENO"], keywords: ["north site rent", "north server room(?! token)"], note: "6,000 if paid by the 5th, plus 30 per day late." },
  { id: "office-power", name: "Electricity — Head Office", category: "Premises", subcategory: "Electricity", payee: "Kenya Power (KPLC)", day: 7, amount: 900, tier: 4, payees: [], keywords: ["office electricity", "kplc"], keywordRequired: true },
  { id: "bike-a", name: "Bike Rent — Rider A", category: "Fuel & Transport", subcategory: "Bike rent", payee: "Brian Kiprono Lagat", day: 9, amount: 8000, tier: 4, payees: ["BRIAN KIPRONO"], keywords: ["bike"], keywordRequired: true, group: "Bike rent (2 riders)" },
  { id: "bike-b", name: "Bike Rent — Rider B", category: "Fuel & Transport", subcategory: "Bike rent", payee: "Kevin Mutua Mwangangi", day: 9, amount: 8000, tier: 4, payees: ["KEVIN MUTUA"], keywords: ["bike"], keywordRequired: true, group: "Bike rent (2 riders)" },
  { id: "ct-sunrise", name: "Caretaker — Sunrise Court", category: "Staff & Payroll", subcategory: "Commission", payee: "Grace Achieng Odhiambo", day: 10, amount: 4000, tier: 4, payees: ["GRACE ACHIENG"], keywords: ["sunrise court"], group: "Caretaker batch (day 10)" },
  { id: "ct-hillview", name: "Caretaker — Hillview Apartments", category: "Staff & Payroll", subcategory: "Commission", payee: "Joseph Wekesa Simiyu", day: 10, amountType: "alternating", amounts: [4000, 2000], amount: 4000, tier: 4, payees: ["JOSEPH WEKESA"], keywords: ["hillview"], group: "Caretaker batch (day 10)", note: "Alternates 4,000 / 2,000." },
  { id: "ct-riverside", name: "Caretaker — Riverside Flats", category: "Staff & Payroll", subcategory: "Commission", payee: "Mercy Nduta Kamau", day: 10, amount: 1500, tier: 4, payees: ["MERCY NDUTA"], keywords: ["riverside"], group: "Caretaker batch (day 10)" },
  { id: "carrier-east", name: "Link Carrier — East route", category: "Connectivity", subcategory: "Internet link", payee: "Samuel Kiptoo Rotich", day: 13, amount: 3500, tier: 1, payees: ["SAMUEL KIPTOO"], keywords: ["east route"] },
  { id: "isp-licence", name: "ISP Billing System Licence", category: "Connectivity", subcategory: "ISP system (OneISP)", payee: "NetBill Systems", day: 19, amountType: "lastActual", amount: 8000, tier: 5, payees: ["NETBILL"], keywords: ["oneisp", "billing system"], note: "Uses last month's actual payment." },
  { id: "monitoring", name: "Network Monitoring Tool", category: "Connectivity", subcategory: "ISP system (OneISP)", payee: "", day: 20, amount: 12000, freq: "every", every: 4, anchor: DEMO_MONTH, tier: 3, keywords: ["monitoring tool"], note: "Every 4 months." },
].map((o) => ({ ...OBL_DEFAULTS, ...o }));

const DEFAULT_PAYROLL = {
  [DEMO_MONTH]: {
    ver: 2, payDay: 5, relatesTo: DEMO_PREV, note: "Demo payroll (invented staff and amounts). Net pay = gross + additions (commissions, top-ups) − advances − other deductions.",
    employees: [
      // name, gross, advance, other deduction, label, note, addition, addition label, phone
      ["Alice Wanjiru Kariuki", 32000, 0, 0, "", "", 0, "", ""],
      ["Daniel Omondi Okoth", 28000, 3000, 0, "", "Advance mid-month deducted", 0, "", ""],
      ["Esther Chebet Koech", 24000, 0, 2000, "Equipment loan", "Laptop loan, month 3 of 6", 0, "", ""],
      ["Hassan Abdi Ali", 20000, 0, 0, "", "", 2500, "Sales commission", ""],
      ["Lucy Nyambura Kinyua", 18000, 0, 0, "", "", 0, "", ""],
      ["Martin Kiprop Cheruiyot", 16000, 2000, 0, "", "Advance mid-month deducted", 0, "", ""],
      ["Naomi Akinyi Otieno", 15000, 0, 0, "", "", 0, "", ""],
      ["Victor Musyoka Mutiso", 12000, 0, 0, "", "Casual technician, paid monthly", 0, "", ""],
    ].map(([name, gross, advance, other, otherLabel, note, addition, additionLabel, phone], i) => ({ id: "e" + i, name, phone, gross, advance, other, otherLabel, note, addition, additionLabel })),
  },
};
const DEFAULT_CASHPLAN = {
  [DEMO_MONTH]: {
    opening: 30000, dailyRevenue: 8200, opexPct: 60, float: 5000,
    revenue: {},
    planned: [{ id: "t1", day: 5, label: "Hotspot token batch (week 1)", amount: 3000 }, { id: "t2", day: 12, label: "Hotspot token batch (week 2)", amount: 1500 }, { id: "t3", day: 19, label: "Hotspot token batch (week 3)", amount: 1500 }, { id: "t4", day: 26, label: "Hotspot token batch (week 4)", amount: 2500 }],
    note: "Demo cash plan with invented figures.",
  },
};
const CAL_VER = 3; // 3: new match words from the defaults are added to saved obligations; // 2: fixed-payment calendar starts in Sep 2026 (July/August ran on the old system, so those months are never judged against today's rules)
const DEFAULT_CAL_STATE = { calVer: CAL_VER, obligations: DEFAULT_OBLIGATIONS, payroll: DEFAULT_PAYROLL, settlements: {}, cashplan: DEFAULT_CASHPLAN, targets: {}, opexPct: 60 };

const prevMonthKey = (mk) => shiftAnchor("month", mk + "-01", -1).slice(0, 7);
const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
const dueOn = (mk, day) => `${mk}-${pad(Math.min(Math.max(1, +day || 1), +monthEnd(mk).slice(8)))}`;
const digitsOf = (s) => String(s || "").replace(/\D/g, "");
function oblActiveIn(o, mk) {
  if (!o.active) return false;
  if (o.startMonth && mk < o.startMonth) return false;
  if (o.endMonth && mk > o.endMonth) return false;
  if (o.freq === "every" && +o.every > 1) { const d = monthsBetween(o.anchor || mk, mk); return ((d % o.every) + o.every) % o.every === 0; }
  return true;
}
const payeeHit = (pats, r) => (pats || []).some((p) => {
  const s = String(p).trim(); if (!s) return false;
  const d = digitsOf(s);
  if (d.length >= 5 && d.length === s.replace(/\s/g, "").length) return digitsOf(r.receiverId).includes(d) || digitsOf(r.raw["ACCOUNT REF"]).includes(d);
  return r.payee.toUpperCase().includes(s.toUpperCase());
});
const kwHit = (kws, r) => (kws || []).some((k) => { try { const re = new RegExp(k, "i"); return re.test(r.remark) || re.test(r.norm); } catch { return false; } });
const nameTokens = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").split(/\s+/).filter((t) => t.length > 2);
function employeeHit(e, r) {
  if (e.phone && digitsOf(e.phone).length >= 9 && digitsOf(r.receiverId).endsWith(digitsOf(e.phone).slice(-9))) return true;
  const et = nameTokens(e.name), pt = new Set(nameTokens(r.payee));
  const hits = et.filter((t) => pt.has(t)).length;
  return et.length >= 2 ? hits >= 2 : hits === 1;
}
// Paid from the Payroll wallet to someone on the payroll schedule, remark unclear ("Staff Payments"):
// the rule-based classifier leaves it Unclassified, but the wallet plus a named employee is enough to count it as salary.
const payrollWalletSalary = (r) => r.wallet === "Payroll" && r.category === "Unclassified";
const empNet = (e) => (+e.gross || 0) + (+e.addition || 0) - (+e.advance || 0) - (+e.other || 0);

function expectedFor(o, mk, prevActual, payDay) {
  if (o.amountType === "lastActual") return prevActual ? { amount: prevActual, basis: `Last month's actual (${ksh(prevActual)})` } : { amount: +o.amount || 0, basis: "No previous payment found — standing amount" };
  if (o.amountType === "alternating") {
    const [a, b] = (o.amounts || [o.amount, o.amount]).map(Number);
    if (prevActual && Math.abs(prevActual - a) < 1) return { amount: b, basis: `Alternates — last month was ${ksh(a)}` };
    if (prevActual && Math.abs(prevActual - b) < 1) return { amount: a, basis: `Alternates — last month was ${ksh(b)}` };
    const idx = ((monthsBetween(o.anchor || mk, mk) % 2) + 2) % 2;
    return { amount: idx === 0 ? a : b, basis: `Alternates ${ksh(a)} / ${ksh(b)} (by month)` };
  }
  if (o.amountType === "lateFee") {
    const due = dueOn(mk, o.day);
    const late = payDay && payDay > due ? dayDiff(due, payDay) : 0;
    return { amount: (+o.amount || 0) + late * (+o.lateFeePerDay || 0), basis: late ? `${ksh(o.amount)} + ${late} day${late > 1 ? "s" : ""} × ${ksh(o.lateFeePerDay)} late fee` : `${ksh(o.amount)} if paid by day ${o.day}` };
  }
  return { amount: +o.amount || 0, basis: +o.amount ? "Standing amount" : "Amount not set" };
}

// Build one month's calendar: every scheduled obligation and payroll line, matched against Tende payments
function buildCalendar(an, cs, mk, depth = 0) {
  const prev = depth === 0 ? buildCalendar(an, cs, prevMonthKey(mk), 1) : null;
  const prevPaid = (id) => (prev ? (prev.rows.find((r) => r.id === id) || {}).paid || 0 : 0);
  const sched = (cs.payroll || {})[mk];
  const relPay = sched ? sched.relatesTo || prevMonthKey(mk) : null;
  const inst = [];
  for (const o of cs.obligations || []) if (oblActiveIn(o, mk)) inst.push({ kind: "obl", id: "o:" + o.id, o, name: o.name, category: o.category, subcategory: o.subcategory, payeeLabel: o.payee, tier: +o.tier || 3, group: o.group || "", due: dueOn(mk, o.day), rel: mk, note: o.note });
  if (sched) for (const e of sched.employees || []) inst.push({ kind: "pay", id: "p:" + e.id, e, name: `Salary — ${e.name}`, category: "Staff & Payroll", subcategory: "Salary", payeeLabel: e.name, tier: 1, group: "Payroll (net)", due: dueOn(mk, sched.payDay || 5), rel: relPay, note: e.note });
  inst.sort((a, b) => a.tier - b.tier || a.due.localeCompare(b.due));
  const settle = (cs.settlements || {})[mk] || {};
  const claimed = new Set(Object.values(settle).flatMap((s) => s.link || []));
  const today = todayKey();
  const rows = inst.map((it) => {
    const st = settle[it.id] || {};
    const exp0 = it.kind === "pay" ? empNet(it.e) : expectedFor(it.o, mk, prevPaid(it.id), null).amount;
    // right payee and exactly the expected amount (allowing for a late fee) is strong evidence even when the remark is vague
    const amountFits = (r) => it.kind === "obl" && exp0 > 0 && (Math.abs(r.amount - exp0) <= 1 || (it.o.amountType === "lateFee" && r.amount >= +it.o.amount && r.amount <= +it.o.amount + 31 * (+it.o.lateFeePerDay || 0)));
    const ok = (r) => it.kind === "obl"
      ? (it.o.keywordRequired
        ? (kwHit(it.o.keywords, r) && (!(it.o.payees || []).length || payeeHit(it.o.payees, r))) || (payeeHit(it.o.payees, r) && amountFits(r))
        : kwHit(it.o.keywords, r) || payeeHit(it.o.payees, r))
      : (employeeHit(it.e, r) && (isSalaryPayment(r) || payrollWalletSalary(r)));
    const basisOf = (r) => it.kind === "pay" ? (isSalaryPayment(r) ? "Payee is on the payroll and the remark says salary" : "Payee is on the payroll and was paid from the Payroll wallet (remark unclear)")
      : kwHit(it.o.keywords, r) && payeeHit(it.o.payees, r) ? "Remark and payee match"
      : kwHit(it.o.keywords, r) ? "Remark matches" : amountFits(r) ? "Payee and exact amount match" : "Payee matches";
    // a salary run counts payments for the work month or labelled with the pay month itself
    const relOk = (r) => r.relatesTo === it.rel || (it.kind === "pay" && r.relatesTo === mk);
    let matches = [], arrears = [];
    if (st.link && st.link.length) matches = an.expenses.filter((r) => st.link.includes(r.id));
    else if (st.mode !== "skip") {
      const unl = st.unlink || [];
      const near = an.expenses.filter((r) => !claimed.has(r.id) && !unl.includes(r.id) && r.day >= addDays(it.due, -45) && r.day <= addDays(it.due, 60) && ok(r));
      // an unlabelled payment for a monthly bill must fall in that bill's own month (or within 5 days before / 15 days after the due date),
    // so last month's late payment is never credited to this month's bill
    const monthlyObl = it.kind === "obl" && (it.o.freq || "monthly") === "monthly";
    const elig = near.filter((r) => relOk(r) || (!r.relatesTo && r.day >= addDays(it.due, -15) && r.day <= addDays(it.due, 15) && (!monthlyObl || monthKey(r.day) === mk || r.day >= addDays(it.due, -5))));
    // late payment inside the bill's own month but more than 15 days after the due date
    if (monthlyObl) for (const r of near) if (!elig.includes(r) && !r.relatesTo && monthKey(r.day) === mk && r.day > addDays(it.due, 15)) elig.push(r);
      arrears = near.filter((r) => r.relatesTo && !relOk(r) && r.day >= addDays(it.due, -15) && r.day <= addDays(it.due, 15));
      const score = (r) => (it.kind === "obl" && kwHit(it.o.keywords, r) ? 3 : 0) + (it.kind === "obl" && payeeHit(it.o.payees, r) ? 2 : 0) + (relOk(r) ? 3 : 0) - Math.abs(dayDiff(it.due, r.day)) / 10 - (exp0 ? Math.min(2, Math.abs(r.amount - exp0) / exp0) : 0);
      const ranked = elig.sort((a, b) => score(b) - score(a));
      let paid = 0;
      for (const r of ranked) {
        if (!matches.length) { matches.push(r); paid += r.amount; if (exp0 && paid >= exp0 * 0.95) break; continue; }
        if (!exp0 || paid >= exp0 * 0.95) break;
        if (r.amount <= (exp0 - paid) * 1.15) { matches.push(r); paid += r.amount; }
      }
      for (const r of matches) claimed.add(r.id);
    }
    const matchBasis = st.link && st.link.length ? "Linked by you" : matches.length ? [...new Set(matches.map(basisOf))].join("; ") : "";
    const paid = sum(matches, (r) => r.amount);
    const first = matches.length ? matches.map((r) => r.day).sort()[0] : null;
    const lastPay = matches.length ? matches.map((r) => r.day).sort().slice(-1)[0] : null;
    let exp;
    if (it.kind === "pay") exp = { amount: empNet(it.e), basis: `Gross ${ksh(it.e.gross)}${+it.e.addition ? ` + ${it.e.additionLabel || "additions"} ${ksh(it.e.addition)}` : ""} − advance ${ksh(it.e.advance || 0)} − ${it.e.otherLabel || "other"} ${ksh(it.e.other || 0)}` };
    else exp = expectedFor(it.o, mk, prevPaid(it.id), lastPay || (today > it.due && an.lastDay && an.lastDay >= it.due ? (today < an.lastDay ? today : an.lastDay) : null));
    let status, detail = "";
    const manualPaid = st.mode === "settled";
    if (st.mode === "skip") status = "Not due this month";
    else if (manualPaid) { status = "Settled manually"; detail = `${st.amount ? ksh(st.amount) + " " : ""}${st.date ? "on " + fmtDay(st.date) + " " : ""}${st.note ? "— " + st.note : ""}${st.by ? ` (by ${st.by})` : ""}`; }
    else if (!matches.length && !exp.amount) status = "Amount not set";
    else if (matches.length && exp.amount && paid < exp.amount * 0.95) status = "Part paid";
    else if (matches.length) status = first > it.due ? "Paid late" : "Paid";
    else if (!an.lastDay || an.lastDay <= it.due || an.firstDay > it.due) status = today > it.due ? "Not in imported data" : dayDiff(today, it.due) <= 3 ? "Due soon" : "Upcoming";
    else status = "Overdue";
    if (status === "Part paid") detail = an.lastDay && an.lastDay <= it.due ? `Tende data ends ${fmtDay(an.lastDay)}` : "Balance unpaid";
    if (status === "Paid late") detail = `${dayDiff(it.due, first)} day${dayDiff(it.due, first) > 1 ? "s" : ""} after due date`;
    if (status === "Overdue") detail = `No matching Tende payment by ${fmtDay(an.lastDay < today ? an.lastDay : today)}`;
    if (status === "Not in imported data") detail = an.firstDay && an.firstDay > it.due ? `Tende data starts ${fmtDay(an.firstDay)}, after this due date` : an.lastDay === it.due ? `Tende data ends on the due date (${fmtDay(an.lastDay)})` : `Tende data ends ${an.lastDay ? fmtDay(an.lastDay) : "—"}`;
    const settledAmt = manualPaid ? (+st.amount || exp.amount) : paid;
    const remaining = ["Not due this month", "Settled manually", "Paid", "Paid late", "Amount not set"].includes(status) ? 0 : Math.max(0, exp.amount - paid);
    if (status === "Amount not set") detail = "Enter the amount in the register so it is reserved";
    return { ...it, expected: exp.amount, expectedBasis: exp.basis, paid: settledAmt, matches, matchBasis, arrears, status, detail, remaining, variance: matches.length ? paid - exp.amount : null, firstPaid: first, settlement: st };
  });
  // Payments that look related but weren't counted — shown with the reason so they can be counted with one click
  const usedBy = new Map();
  for (const r of rows) for (const m of r.matches) usedBy.set(m.id, r.name);
  for (const r of rows) {
    r.candidates = [];
    if (r.remaining <= 0 && r.status !== "Part paid") continue;
    const from = addDays(r.due, -20), to = addDays(r.due, 25);
    const mine = new Set(r.matches.map((m) => m.id));
    // remark names the employee: full name, or a first name no other employee on the schedule shares
    const namedInRemark = (x) => {
      if (r.kind !== "pay" || x.category !== "Staff & Payroll") return false;
      const tk = nameTokens(r.e.name); const hits = tk.filter((t) => new RegExp(`\\b${t}\\b`).test(x.norm));
      if (tk.length && hits.length === tk.length) return true;
      return hits.includes(tk[0]) && ((sched && sched.employees) || []).filter((o) => nameTokens(o.name)[0] === tk[0]).length === 1;
    };
    const dismissed = new Set((r.settlement && r.settlement.unlink) || []);
    const pool = an.expenses.filter((x) => !mine.has(x.id) && !dismissed.has(x.id) && x.day >= from && x.day <= to && (r.kind === "pay"
      ? (employeeHit(r.e, x) && (x.category === "Staff & Payroll" || x.wallet === "Payroll")) || namedInRemark(x)
      : payeeHit(r.o.payees, x) || kwHit(r.o.keywords, x)));
    for (const x of pool) {
      let reason;
      if (usedBy.has(x.id)) reason = `Already counted for "${usedBy.get(x.id)}"`;
      else if (r.kind === "pay" && !employeeHit(r.e, x)) reason = `Paid to ${titleCase(x.payee)}, but the remark names ${r.e.name}`;
      else if (r.kind === "pay" && x.category !== "Staff & Payroll") reason = "Paid from the Payroll wallet, but the remark doesn't say it is salary";
      else if (r.kind === "pay" && x.payType === "Salary advance") reason = "Remark says advance, not salary";
      else if (r.kind === "pay" && x.payType === "Commission") reason = "Remark says commission, not salary";
      else if (r.kind === "pay" && x.payType !== "Salary") reason = `Remark doesn't say it is salary (read as ${x.payType || x.subcategory})`;
      else if (r.kind === "pay" && x.confidence === "Low") reason = "Remark doesn't say it is salary";
      else if (r.kind === "obl" && r.o.keywordRequired && !kwHit(r.o.keywords, x)) reason = `Right payee, but the remark ("${x.remark}") doesn't mention ${r.o.keywords.slice(0, 2).join(" / ")}`;
      else if (x.relatesTo && x.relatesTo !== r.rel && !(r.kind === "pay" && x.relatesTo === mk)) reason = `Remark says it is for ${fmtMonth(x.relatesTo)}`;
      else if (x.day < addDays(r.due, -15) || x.day > addDays(r.due, 15)) reason = "Paid more than 15 days from the due date";
      else reason = "Would take the total above the expected amount";
      r.candidates.push({ txn: x, reason });
    }
  }
  // staff salary payments this month that the payroll schedule doesn't cover
  const payClaimed = new Set(rows.filter((r) => r.kind === "pay").flatMap((r) => r.matches.map((m) => m.id)));
  const unscheduledPay = sched ? an.expenses.filter((r) => ((r.category === "Staff & Payroll" && r.payType === "Salary") || payrollWalletSalary(r)) && monthKey(r.day) === mk && !payClaimed.has(r.id)) : [];
  const live = rows.filter((r) => r.status !== "Not due this month");
  const summary = {
    scheduled: sum(live, (r) => r.expected), paid: sum(live, (r) => Math.min(r.paid, Math.max(r.expected, r.paid))), remaining: sum(live, (r) => r.remaining),
    overdue: live.filter((r) => r.status === "Overdue" || (r.status === "Part paid" && an.lastDay && an.lastDay > r.due)),
    unknown: live.filter((r) => r.status === "Not in imported data"),
    next7: live.filter((r) => r.remaining > 0 && r.due >= today && r.due <= addDays(today, 7)),
    noAmount: live.filter((r) => r.status === "Amount not set"),
    over: live.filter((r) => r.kind === "pay" && r.variance > 0),
    short: live.filter((r) => r.kind === "pay" && r.variance < 0),
    overpaid: sum(live.filter((r) => r.variance > 0), (r) => r.variance),
  };
  return { mk, rows, summary, sched, unscheduledPay };
}

function advancesFor(an, mk, sched, e) {
  const day = sched.payDay || 5;
  const from = addDays(dueOn(prevMonthKey(mk), day), 1), to = dueOn(mk, day);
  return an.expenses.filter((r) => r.category === "Staff & Payroll" && r.payType === "Salary advance" && r.day >= from && r.day <= to && employeeHit(e, r));
}

// Profit First cash plan: OpEx share of revenue in, scheduled + variable spending out, day by day
function cashPlan(an, cal, plan, mk, revDays = {}) {
  const dim = +monthEnd(mk).slice(8);
  const pct = (+plan.opexPct || 60) / 100;
  const covered = (k) => an.firstDay && an.lastDay && k >= an.firstDay && k <= an.lastDay;
  const firstOpen = (() => { for (let d = 1; d <= dim; d++) if (!covered(dueOn(mk, d))) return d; return dim + 1; })();
  const committed = Array(dim + 2).fill(0), dueNames = Array(dim + 2).fill(null).map(() => []);
  for (const r of cal.rows) {
    if (r.remaining <= 0) continue;
    let d = +r.due.slice(8); if (d < firstOpen) d = firstOpen;
    if (d <= dim) { committed[d] += r.remaining; dueNames[d].push(r.name); }
  }
  for (const p of plan.planned || []) { const d = Math.max(+p.day || 1, firstOpen); if (d <= dim) { committed[d] += +p.amount || 0; dueNames[d].push(p.label); } }
  for (let d = firstOpen; d <= dim; d++) committed[d] += +plan.float || 0;
  const remainingFrom = (d) => { let s = 0; for (let i = Math.max(d, firstOpen); i <= dim; i++) s += committed[i]; return s; };
  let bal = +plan.opening || 0; const days = [];
  for (let d = 1; d <= dim; d++) {
    const k = dueOn(mk, d), isCov = covered(k);
    const actual = isCov ? sum(an.expenses.filter((r) => r.day === k), (r) => r.amount + r.charge) : null;
    const imp = revDays[k];
    const manual = plan.revenue && plan.revenue[d] !== undefined && plan.revenue[d] !== "";
    const revSource = imp ? "statement" : manual ? "manual" : "projected";
    const revActual = revSource !== "projected";
    const revenue = imp ? imp.total : manual ? +plan.revenue[d] : +plan.dailyRevenue || 0;
    const inflow = revenue * pct;
    const available = bal + inflow;
    const out = isCov ? actual : committed[d];
    const safe = Math.max(0, available - (isCov ? out + remainingFrom(d + 1) : remainingFrom(d)));
    bal = available - out;
    days.push({ d, key: k, isCov, revenue, revActual, revSource, inflow, out, actual, scheduledNames: dueNames[d], safe, balance: bal });
  }
  const revTotal = sum(days, (x) => x.revenue);
  const outTotal = sum(days, (x) => x.out);
  const inflowTotal = sum(days, (x) => x.inflow);
  const low = days.reduce((m, x) => (x.balance < m.balance ? x : m), days[0]);
  const shortfall = outTotal - (+plan.opening || 0) - inflowTotal;
  return {
    days, firstOpen, revTotal, outTotal, inflowTotal, low, shortfall,
    neededDaily: Math.max(0, (outTotal - (+plan.opening || 0)) / pct / dim),
    alloc: { opex: revTotal * pct, aside: revTotal * (1 - pct) },
  };
}

/* ---------------- screens ---------------- */
const STATUS_STYLE = {
  "Paid": ["ok", "#2E7D4F"], "Paid late": ["review", "#B7791F"], "Part paid": ["review", "#B7791F"], "Overdue": ["bad", "#A83F37"],
  "Due soon": ["pend", "#4F56B8"], "Upcoming": ["ex", "#7C8A94"], "Not in imported data": ["pend", "#4F56B8"], "Settled manually": ["ok", "#2E7D4F"], "Amount not set": ["review", "#D9A441"], "Not due this month": ["ex", "#B5BDC3"],
};
const StatusChip = ({ s }) => <span className={`chip ${(STATUS_STYLE[s] || ["ex"])[0]}`}>{s}</span>;
const TIER_LABEL = { 1: "1 · revenue-critical", 2: "2 · premises & compliance", 3: "3 · systems", 4: "4 · field operations", 5: "5 · administrative" };

function PaymentCalendar({ an, cs, setCs, reviewer, openTxn, revenue, focus, mk, setMk }) {
  const [view, setView] = useState("month");
  useEffect(() => { if (focus) setView("month"); }, [focus && focus.n]);
  const cal = useMemo(() => buildCalendar(an, cs, mk), [an, cs, mk]);
  const views = [["month", "This month"], ["revenue", "Revenue & allocation"], ["cash", "Cash plan"], ["payroll", "Payroll schedule"], ["register", "Obligations register"]];
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between" style={{ gap: 10, marginBottom: 14 }}>
        <div className="flex items-center" style={{ gap: 8 }}>
          <button className="btn small" aria-label="Previous month" onClick={() => setMk(prevMonthKey(mk))}>‹</button>
          <div style={{ minWidth: 150 }}><div style={{ fontWeight: 600, fontSize: 16 }}>{fmtMonth(mk)}</div><div className="muted" style={{ fontSize: 12 }}>{an.lastDay ? `Tende data to ${fmtDay(an.lastDay)}` : "No Tende data yet"}</div></div>
          <button className="btn small" aria-label="Next month" onClick={() => setMk(shiftAnchor("month", mk + "-01", 1).slice(0, 7))}>›</button>
          <button className="btn small" onClick={() => setMk(monthKey(todayKey()))}>This month</button>
        </div>
        <div className="flex flex-wrap" style={{ gap: 6 }}>{views.map(([k, l]) => <button key={k} className="pill" aria-pressed={view === k} onClick={() => setView(k)}>{l}</button>)}</div>
      </div>
      {an.lastDay && an.lastDay < monthEnd(mk) && mk >= monthKey(an.lastDay) && <div style={{ padding: "9px 14px", borderRadius: 8, marginBottom: 14, background: "var(--indigobg)" }}>Statuses use Tende data up to {fmtDay(an.lastDay)}. Items due after that show as "not in imported data" or "upcoming" until the next Tende export is imported.</div>}
      {view === "month" && <MonthSchedule an={an} cal={cal} cs={cs} setCs={setCs} mk={mk} reviewer={reviewer} openTxn={openTxn} focus={focus && focus.mk === mk ? focus : null} />}
      {view === "cash" && <CashPlanView an={an} cal={cal} cs={cs} setCs={setCs} mk={mk} revenue={revenue} />}
      {view === "revenue" && <RevenueView an={an} cs={cs} setCs={setCs} mk={mk} revenue={revenue} />}
      {view === "payroll" && <PayrollSchedule an={an} cal={cal} cs={cs} setCs={setCs} mk={mk} openTxn={openTxn} />}
      {view === "register" && <ObligationRegister cs={cs} setCs={setCs} mk={mk} cal={cal} />}
    </div>
  );
}

function MonthSchedule({ an, cal, cs, setCs, mk, reviewer, openTxn, focus }) {
  const [sel, setSel] = useState(focus ? focus.id : null);
  const detailRef = useRef(null);
  useEffect(() => { if (focus) setSel(focus.id); }, [focus && focus.n]);
  useEffect(() => { if (sel && detailRef.current) detailRef.current.scrollIntoView({ block: "start", behavior: "smooth" }); }, [sel]);
  const s = cal.summary;
  const row = sel ? cal.rows.find((r) => r.id === sel) : null;
  const first = fromKey(mk + "-01"), dim = +monthEnd(mk).slice(8), lead = (first.getUTCDay() + 6) % 7;
  const cells = [...Array(lead).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const today = todayKey();
  const PAID_ST = ["Paid", "Paid late", "Settled manually"];
  const isDone = (r) => PAID_ST.includes(r.status);
  const priority = cal.rows.filter((r) => r.remaining > 0).sort((a, b) => a.tier - b.tier || a.due.localeCompare(b.due));
  return (
    <div>
      <section className="panel grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", marginBottom: 16 }}>
        <div className="stat"><div className="lbl">Scheduled this month</div><div className="val num">{ksh(s.scheduled)}</div><div className="note">{cal.rows.filter((r) => r.status !== "Not due this month").length} payments</div></div>
        <div className="stat"><div className="lbl">Paid so far</div><div className="val num" style={{ color: "var(--green)" }}>{ksh(s.paid)}</div><div className="note">matched to Tende or settled</div></div>
        <div className="stat"><div className="lbl">Still to pay</div><div className="val num">{ksh(s.remaining)}</div></div>
        <div className="stat"><div className="lbl">Overdue</div><div className="val num" style={{ color: s.overdue.length ? "var(--red)" : "inherit" }}>{ksh(sum(s.overdue, (r) => r.remaining))}</div><div className="note">{s.overdue.length} item{s.overdue.length === 1 ? "" : "s"}</div></div>
        <div className="stat"><div className="lbl">Due in the next 7 days</div><div className="val num" style={{ color: "var(--indigo)" }}>{ksh(sum(s.next7, (r) => r.remaining))}</div><div className="note">{s.next7.length} item{s.next7.length === 1 ? "" : "s"}</div></div>
      </section>

      <Section title="Calendar" pad={false}>
        <div className="scroll">
          <div className="grid" style={{ gridTemplateColumns: "repeat(7, minmax(120px, 1fr))", minWidth: 840 }}>
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="muted" style={{ fontSize: 12, padding: "6px 8px", borderBottom: "1px solid var(--line)" }}>{d}</div>)}
            {cells.map((d, i) => {
              const k = d ? dueOn(mk, d) : null;
              const items = d ? cal.rows.filter((r) => r.due === k) : [];
              return (
                <div key={i} style={{ minHeight: 92, padding: 6, borderRight: (i % 7) < 6 ? "1px solid #EDF0EE" : 0, borderBottom: "1px solid #EDF0EE", background: k === today ? "#F1F8F7" : d ? "#fff" : "#F7F9F8" }}>
                  {d && <div className="num" style={{ fontSize: 12, fontWeight: k === today ? 700 : 500, color: k === today ? "var(--teal)" : "var(--ink2)" }}>{d}</div>}
                  {items.map((r) => (
                    <button key={r.id} onClick={() => setSel(r.id)} title={`${r.name} — ${r.status}`}
                      style={{ display: "block", width: "100%", textAlign: "left", border: 0, borderLeft: `3px solid ${isDone(r) ? "#2E7D4F" : (STATUS_STYLE[r.status] || [0, "#999"])[1]}`, background: sel === r.id ? "#E7EEEC" : isDone(r) ? "#DDF3E4" : "#F5F7F6", borderRadius: 4, padding: "2px 5px", marginTop: 3, fontSize: 11.5, lineHeight: 1.3 }}>
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name.replace("Salary — ", "")}</span>
                      <span className="num muted">{isDone(r) ? "✓ " + ksh(r.paid || r.expected) : ksh(r.expected)}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap" style={{ gap: "4px 14px", padding: "8px 14px", fontSize: 12 }}>{Object.entries(STATUS_STYLE).map(([k, [, c]]) => <span key={k}><span className="dot" style={{ background: c }} />{k}</span>)}</div>
      </Section>

      <div ref={detailRef} style={{ scrollMarginTop: 12 }}>{row && <ObligationDetail an={an} row={row} cs={cs} setCs={setCs} mk={mk} reviewer={reviewer} openTxn={openTxn} onClose={() => setSel(null)} />}</div>

      {(() => {
        const done = cal.rows.filter((r) => ["Paid", "Paid late", "Settled manually"].includes(r.status)).sort((a, b) => (a.firstPaid || a.due).localeCompare(b.firstPaid || b.due));
        return (
          <details style={{ marginBottom: 16 }}><summary className="muted" style={{ cursor: "pointer", fontSize: 13, padding: "6px 2px" }}>{done.length} confirmed paid and checked against Tende · {ksh(sum(done, (r) => r.paid))} — removed from the list below (click to view the proof)</summary>
          <Section title={`Already paid · ${done.length} of ${cal.rows.filter((r) => r.status !== "Not due this month").length} · ${ksh(sum(done, (r) => r.paid))}`} pad={false}>
            <div className="muted" style={{ padding: "8px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>Checked against every imported Tende payment{an.lastDay ? ` up to ${fmtDay(an.lastDay)}` : ""}. Each line shows the payment that settled it and how it was recognised.</div>
            <div className="scroll">
              <table className="t"><thead><tr><th>Obligation</th><th>Due</th><th>Paid on</th><th className="r">Paid</th><th>Tende payment</th><th>Recognised by</th><th>Status</th></tr></thead>
                <tbody>{done.map((r) => (
                  <tr key={r.id} className="click" onClick={() => setSel(r.id)}>
                    <td style={{ minWidth: 180 }}>{r.name}</td>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.due)}</td>
                    <td className="num" style={{ whiteSpace: "nowrap" }}>{r.firstPaid ? fmtDay(r.firstPaid) : r.settlement.date ? fmtDay(r.settlement.date) : "—"}</td>
                    <td className="r num" style={{ fontWeight: 600 }}>{ksh(r.paid)}</td>
                    <td style={{ fontSize: 12.5, minWidth: 180 }}>{r.matches.length ? r.matches.map((m) => <div key={m.id}><span className="num">{m.txnRef || m.id}</span> · "{m.remark}"</div>) : <span className="muted">Outside Tende{r.settlement.note ? ` — ${r.settlement.note}` : ""}</span>}</td>
                    <td style={{ fontSize: 12.5 }}>{r.status === "Settled manually" ? `Marked paid${r.settlement.by ? ` by ${r.settlement.by}` : ""}` : r.matchBasis}</td>
                    <td><StatusChip s={r.status} />{r.status === "Paid late" && <div className="muted" style={{ fontSize: 11.5 }}>{r.detail}</div>}</td>
                  </tr>))}</tbody></table>
              {!done.length && <Empty>Nothing scheduled for {fmtMonth(mk)} has been paid yet{an.lastDay && an.lastDay < mk + "-01" ? ` — the Tende data ends ${fmtDay(an.lastDay)}` : ""}.</Empty>}
            </div>
          </Section></details>
        );
      })()}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(360px,1fr))", gap: 16 }}>
        <Section title={`Unsettled — by priority · ${ksh(sum(priority, (r) => r.remaining))}`} pad={false}>
          <div className="muted" style={{ padding: "8px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>Ranked by priority tier (1 = revenue-critical, 5 = administrative), then due date. Pay from the top when cash is short.</div>
          <table className="t"><thead><tr><th>Tier</th><th>Obligation</th><th>Due</th><th className="r">Still to pay</th><th>Status</th></tr></thead>
            <tbody>{priority.map((r) => <tr key={r.id} className="click" onClick={() => setSel(r.id)}><td className="num">{r.tier}</td><td>{r.name}</td><td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.due)}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(r.remaining)}</td><td><StatusChip s={r.status} /></td></tr>)}</tbody></table>
          {!priority.length && <Empty>Everything scheduled this month is settled.</Empty>}
        </Section>
        <Section title="Checks" pad={true}>
          {s.noAmount.length > 0 && <div className="att"><span className="bar" style={{ background: "var(--amber)" }} /><div>{s.noAmount.length} scheduled item{s.noAmount.length > 1 ? "s have" : " has"} no amount set: {s.noAmount.map((r) => r.name).join(", ")}. Enter the amount in the register so the cash plan reserves for it.</div></div>}
          {cal.rows.filter((r) => r.arrears.length).map((r) => <div className="att" key={r.id}><span className="bar" style={{ background: "var(--line)" }} /><div>{r.name}: a payment in this window relates to {r.arrears.map((a) => fmtMonth(a.relatesTo)).join(", ")} ({r.arrears.map((a) => `${ksh(a.amount)} on ${fmtDay(a.day)}`).join("; ")}), so it is not counted for {fmtMonth(mk)}.</div></div>)}
          {cal.rows.filter((r) => r.variance !== null && Math.abs(r.variance) >= 50 && r.status !== "Part paid").map((r) => <div className="att" key={r.id + "v"}><span className="bar" style={{ background: r.variance > 0 ? "var(--red)" : "var(--line)" }} /><div>{r.name} paid {ksh(r.paid)} against {ksh(r.expected)} expected ({diffTxt(r.variance)}).</div></div>)}
          {cal.unscheduledPay.length > 0 && <div className="att"><span className="bar" style={{ background: "var(--amber)" }} /><div>{cal.unscheduledPay.length} salary payment{cal.unscheduledPay.length > 1 ? "s" : ""} in {fmtMonth(mk)} not on the payroll schedule: {cal.unscheduledPay.map((r) => `${titleCase(r.payee)} ${ksh(r.amount)}`).join(", ")}.</div></div>}
          {!cal.sched && <div className="att"><span className="bar" style={{ background: "var(--line)" }} /><div>No payroll schedule for {fmtMonth(mk)} — salaries aren't reserved in this month's plan. Add one under Payroll schedule.</div></div>}
        </Section>
      </div>

      <Section title="Fixed payments still to pay" pad={false} right={<button className="btn small" onClick={() => downloadCSV(`happynet-payment-calendar-${mk}.csv`, cal.rows.map((r) => ({ Due: r.due, Obligation: r.name, Group: r.group, Category: r.category, Payee: r.payeeLabel, Tier: r.tier, Expected: r.expected, ExpectedBasis: r.expectedBasis, Paid: r.paid, StillToPay: r.remaining, Status: r.status, Detail: r.detail, TendeRefs: r.matches.map((m) => m.txnRef || m.id).join(" ") })))}>Export CSV</button>}>
        <div className="scroll">
          <table className="t"><thead><tr><th>Due</th><th>Obligation</th><th>Payee</th><th className="r">Expected</th><th className="r">Paid</th><th className="r">Still to pay</th><th>Status</th><th>Tende evidence</th></tr></thead>
            <tbody>{[...cal.rows].filter((r) => !isDone(r)).sort((a, b) => a.due.localeCompare(b.due) || a.tier - b.tier).map((r) => (
              <tr key={r.id} className="click" onClick={() => setSel(r.id)}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(r.due)}</td>
                <td style={{ minWidth: 200 }}>{r.name}<div className="muted" style={{ fontSize: 12 }}>{r.group || r.category} · tier {r.tier}</div></td>
                <td style={{ minWidth: 140 }}>{r.payeeLabel}</td>
                <td className="r num">{ksh(r.expected)}<div className="muted" style={{ fontSize: 11.5, whiteSpace: "normal", maxWidth: 200 }}>{r.expectedBasis}</div></td>
                <td className="r num">{r.paid ? ksh(r.paid) : <span className="muted">—</span>}</td>
                <td className="r num" style={{ fontWeight: r.remaining ? 600 : 400 }}>{r.remaining ? ksh(r.remaining) : <span className="muted">—</span>}</td>
                <td><StatusChip s={r.status} />{r.detail && <div className="muted" style={{ fontSize: 11.5, maxWidth: 220 }}>{r.detail}</div>}</td>
                <td className="num" style={{ fontSize: 12.5 }}>{r.matches.map((m) => <div key={m.id}>{fmtDay(m.day)} · {ksh(m.amount)} · {m.txnRef || m.id}</div>)}</td>
              </tr>))}</tbody></table>
        </div>
      </Section>
    </div>
  );
}

function ObligationDetail({ an, row, cs, setCs, mk, reviewer, openTxn, onClose }) {
  const [amt, setAmt] = useState(""), [date, setDate] = useState(""), [note, setNote] = useState(""), [link, setLink] = useState("");
  const st = row.settlement || {};
  const setSettle = (v) => {
    const all = { ...(cs.settlements || {}) }; const m = { ...(all[mk] || {}) };
    if (v === null) delete m[row.id]; else m[row.id] = { ...v, by: reviewer || "", at: new Date().toLocaleString("en-KE") };
    all[mk] = m; setCs({ ...cs, settlements: all });
  };
  return (
    <Section title={<span>{row.name} <StatusChip s={row.status} /></span>} right={<button className="btn small" onClick={onClose}>Close</button>}>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16 }}>
        <dl className="kv">
          <dt>Due</dt><dd>{fmtDay(row.due)}</dd>
          <dt>Payee</dt><dd>{row.payeeLabel || "—"}</dd>
          <dt>Category</dt><dd><CatDot c={row.category} />{row.category} / {row.subcategory}</dd>
          <dt>Priority</dt><dd>{TIER_LABEL[row.tier] || row.tier}</dd>
          <dt>Expected</dt><dd className="num">{ksh(row.expected)} <span className="muted">· {row.expectedBasis}</span></dd>
          <dt>Paid</dt><dd className="num">{ksh(row.paid)}{row.variance !== null && row.variance !== 0 && <span className="muted"> · {diffTxt(row.variance)} vs expected</span>}</dd>
          <dt>Still to pay</dt><dd className="num" style={{ fontWeight: 600 }}>{ksh(row.remaining)}</dd>
          {row.detail && <><dt>Note</dt><dd>{row.detail}</dd></>}
          {row.note && <><dt>Register note</dt><dd>{row.note}</dd></>}
        </dl>
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Matched Tende payments</div>
          {row.matches.length ? row.matches.map((m) => (
            <div key={m.id} className="flex items-center justify-between" style={{ gap: 8, padding: "5px 0", borderBottom: "1px solid #EDF0EE" }}>
              <button onClick={() => openTxn(m.id)} style={{ border: 0, background: "none", padding: 0, textAlign: "left", font: "inherit", color: "var(--teal)" }}>{fmtDay(m.day)} · {ksh(m.amount)} · {m.remark}</button>
              {!st.link && <button className="btn small" onClick={() => setSettle({ ...st, unlink: [...(st.unlink || []), m.id] })}>Not this payment</button>}
            </div>)) : <div className="muted">None matched.</div>}
          {row.candidates && row.candidates.length > 0 && <>
            <div style={{ fontWeight: 600, margin: "12px 0 4px" }}>Found in Tende but not counted</div>
            {row.candidates.map((c) => (
              <div key={c.txn.id} className="flex items-center justify-between" style={{ gap: 8, padding: "5px 0", borderBottom: "1px solid #EDF0EE", fontSize: 13 }}>
                <div><button onClick={() => openTxn(c.txn.id)} style={{ border: 0, background: "none", padding: 0, textAlign: "left", font: "inherit", color: "var(--teal)" }}>{fmtDay(c.txn.day)} · {ksh(c.txn.amount)} · {titleCase(c.txn.payee)} · {c.txn.remark}</button><div className="muted" style={{ fontSize: 12 }}>Why not counted: {c.reason}</div><div style={{ fontSize: 12 }}>{candidateAdvice(c, row)}</div></div>
                <span className="flex" style={{ gap: 4, flex: "none" }}><button className="btn small" onClick={() => setSettle({ link: [...row.matches.map((t) => t.id), c.txn.id] })}>Count it</button><button className="btn small" onClick={() => setSettle({ ...st, unlink: [...(st.unlink || []), c.txn.id] })}>Not this one</button></span>
              </div>))}
          </>}
          <div style={{ fontWeight: 600, margin: "14px 0 6px" }}>Correct the match</div>
          <div className="flex flex-wrap" style={{ gap: 6 }}>
            <input placeholder="Tende ID(s), e.g. KC10000001" value={link} onChange={(e) => setLink(e.target.value)} style={{ flex: "1 1 200px" }} />
            <button className="btn small" disabled={!link.trim()} onClick={() => { setSettle({ link: link.split(/[\s,]+/).filter(Boolean) }); setLink(""); }}>Link payment</button>
          </div>
          <div className="flex flex-wrap" style={{ gap: 6, marginTop: 8 }}>
            <input placeholder="Amount" inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))} style={{ width: 100 }} />
            <input type="date" aria-label="Date paid" value={date} onChange={(e) => setDate(e.target.value)} />
            <input placeholder="How it was paid (e.g. bank, cash)" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: "1 1 160px" }} />
            <button className="btn small" onClick={() => setSettle({ mode: "settled", amount: amt, date, note })}>Mark settled outside Tende</button>
          </div>
          <div className="flex flex-wrap" style={{ gap: 6, marginTop: 8 }}>
            <button className="btn small" onClick={() => setSettle({ mode: "skip", note })}>Not due this month</button>
            {(st.mode || st.link || st.unlink) && <button className="btn small" onClick={() => setSettle(null)}>Clear manual changes</button>}
          </div>
        </div>
      </div>
    </Section>
  );
}

function CashPlanView({ an, cal, cs, setCs, mk, revenue }) {
  const plan = (cs.cashplan || {})[mk] || { opening: 0, dailyRevenue: 0, opexPct: 60, float: 0, revenue: {}, planned: [] };
  const setPlan = (p) => setCs({ ...cs, cashplan: { ...(cs.cashplan || {}), [mk]: { ...plan, ...p } } });
  const cp = cashPlan(an, cal, plan, mk, (revenue && revenue.days) || {});
  const today = todayKey();
  const todayRow = cp.days.find((x) => x.key === today);
  const numIn = (v, f, w = 110) => <input inputMode="decimal" value={v ?? ""} onChange={(e) => f(e.target.value.replace(/[^\d.-]/g, ""))} style={{ width: w, textAlign: "right" }} />;
  return (
    <div>
      <section className="panel grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", marginBottom: 16 }}>
        <div className="stat"><div className="lbl">Safe to spend today</div><div className="val num" style={{ color: todayRow && todayRow.safe <= 0 ? "var(--red)" : "var(--teal)" }}>{todayRow ? ksh(todayRow.safe) : "—"}</div><div className="note">{todayRow ? "after reserving every payment still due this month" : "today is outside this month"}</div></div>
        <div className="stat"><div className="lbl">Lowest OpEx balance</div><div className="val num" style={{ color: cp.low.balance < 0 ? "var(--red)" : "inherit" }}>{ksh(cp.low.balance)}</div><div className="note">on {fmtDay(cp.low.key)}</div></div>
        <div className="stat"><div className="lbl">{cp.shortfall > 0 ? "Month shortfall" : "Room left for inventory & unplanned buys"}</div><div className="val num" style={{ color: cp.shortfall > 0 ? "var(--red)" : "var(--green)" }}>{ksh(Math.abs(cp.shortfall))}</div><div className="note">opening + OpEx inflow minus scheduled, float and planned outflows{(plan.planned || []).some((x) => /inventory/i.test(x.label)) ? "" : " — no inventory budget planned yet"}</div></div>
        <div className="stat"><div className="lbl">Revenue needed per day</div><div className="val num">{ksh(cp.neededDaily)}</div><div className="note">to cover the month at {plan.opexPct || 60}% OpEx</div></div>
      </section>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 16 }}>
        <Section title="Plan assumptions">
          <dl className="kv">
            <dt>Opening OpEx balance</dt><dd>{numIn(plan.opening, (v) => setPlan({ opening: v }))}</dd>
            <dt>Projected daily revenue</dt><dd>{numIn(plan.dailyRevenue, (v) => setPlan({ dailyRevenue: v }))}</dd>
            <dt>OpEx share (Profit First)</dt><dd>{numIn(plan.opexPct, (v) => setPlan({ opexPct: v }), 70)} %</dd>
            <dt>Daily variable float</dt><dd>{numIn(plan.float, (v) => setPlan({ float: v }))} <span className="muted" style={{ fontSize: 12 }}>fuel, transport, small items</span></dd>
          </dl>
          {plan.note && <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{plan.note}</div>}
          <div style={{ fontWeight: 600, margin: "14px 0 6px" }}>Other planned outflows</div>
          {(plan.planned || []).map((p, i) => (
            <div key={p.id} className="flex items-center" style={{ gap: 6, marginBottom: 4 }}>
              <span className="muted" style={{ fontSize: 12 }}>Day</span>{numIn(p.day, (v) => { const a = [...plan.planned]; a[i] = { ...p, day: v }; setPlan({ planned: a }); }, 50)}
              <input value={p.label} onChange={(e) => { const a = [...plan.planned]; a[i] = { ...p, label: e.target.value }; setPlan({ planned: a }); }} style={{ flex: 1 }} />
              {numIn(p.amount, (v) => { const a = [...plan.planned]; a[i] = { ...p, amount: v }; setPlan({ planned: a }); }, 90)}
              <button className="btn small" aria-label="Remove" onClick={() => setPlan({ planned: plan.planned.filter((x) => x.id !== p.id) })}>×</button>
            </div>))}
          <button className="btn small" onClick={() => setPlan({ planned: [...(plan.planned || []), { id: "pl" + Date.now().toString(36), day: 1, label: "Inventory pre-invoice", amount: 0 }] })}>Add planned outflow</button>
          {!(cs.cashplan || {})[mk] && <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>No plan saved for {fmtMonth(mk)} yet. <button className="btn small" onClick={() => { const pm = (cs.cashplan || {})[prevMonthKey(mk)]; setPlan(pm ? { ...pm, revenue: {}, note: `Copied from ${fmtMonth(prevMonthKey(mk))}` } : {}); }}>Copy last month's assumptions</button></div>}
        </Section>
        <Section title="Profit First allocation (projected month)">
          <table className="t"><tbody>
            <tr><td>Revenue {cp.days.some((x) => x.revSource === "statement") ? `(statement for ${cp.days.filter((x) => x.revSource === "statement").length} days, projected for the rest)` : "(projected)"}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(cp.revTotal)}</td></tr>
            <tr><td style={{ fontWeight: 600 }}>OpEx {plan.opexPct || 60}% — Tende</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(cp.alloc.opex)}</td></tr>
            <tr><td>Set aside {100 - (+plan.opexPct || 60)}% — profit, owner pay and reserves</td><td className="r num">{ksh(cp.alloc.aside)}</td></tr>
            <tr><td>{an.lastDay && an.lastDay >= mk + "-01" ? `Outflows: actual Tende spending to ${fmtDay(an.lastDay < monthEnd(mk) ? an.lastDay : monthEnd(mk))}, then scheduled + planned + float` : "Outflows: scheduled + planned + float (no Tende data for this month yet)"}</td><td className="r num">{ksh(cp.outTotal)}</td></tr>
            {(cs.targets || {})[mk] ? <tr><td>Revenue target (set manually)</td><td className="r num">{ksh(cs.targets[mk])} <span className="muted">· {((cp.revTotal / cs.targets[mk]) * 100).toFixed(0)}% projected</span></td></tr> : null}
          </tbody></table>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Only the OpEx share is available for expenses; the rest is set aside first.</div>
        </Section>
      </div>

      <Section title="OpEx balance by day">
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={cp.days.map((x) => ({ ...x, label: String(x.d) }))} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="#E6EAE8" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#4A5A66" }} />
              <YAxis tick={{ fontSize: 11, fill: "#4A5A66" }} tickFormatter={(v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v)} width={44} />
              <Tooltip formatter={(v) => ksh(v)} labelFormatter={(l) => `Day ${l}`} />
              <Bar dataKey="balance" name="Closing balance">{cp.days.map((x) => <Cell key={x.d} fill={x.balance < 0 ? "#A83F37" : x.isCov ? "#0F6E6A" : "#7FB8B3"} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>Dark bars use actual Tende spending; light bars are projected. Red means the OpEx account would be overdrawn.</div>
      </Section>

      <Section title="Daily plan" pad={false}>
        <div className="scroll" style={{ maxHeight: "70vh" }}>
          <table className="t"><thead><tr><th>Date</th><th>Scheduled / planned</th><th className="r">Revenue</th><th className="r">OpEx in</th><th className="r">Out</th><th className="r">Closing balance</th><th className="r">Safe to spend</th></tr></thead>
            <tbody>{cp.days.map((x) => (
              <tr key={x.d} style={x.key === today ? { background: "#F1F8F7" } : {}}>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{fmtDay(x.key).slice(0, -5)} <span className="muted">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][fromKey(x.key).getUTCDay()]}</span></td>
                <td style={{ minWidth: 200, fontSize: 12.5 }}>{x.isCov ? <span className="muted">Actual Tende spending</span> : x.scheduledNames.join(", ") || <span className="muted">Float only</span>}</td>
                <td className="r">{x.revSource === "statement" ? <span className="num">{ksh(x.revenue)}<div className="muted" style={{ fontSize: 11 }}>from statement</div></span> : numIn(plan.revenue && plan.revenue[x.d] !== undefined ? plan.revenue[x.d] : "", (v) => { const rv = { ...(plan.revenue || {}) }; if (v === "") delete rv[x.d]; else rv[x.d] = v; setPlan({ revenue: rv }); }, 90)}{x.revSource !== "statement" && !x.revActual ? <div className="muted" style={{ fontSize: 11 }}>proj. {ksh(x.revenue)}</div> : null}</td>
                <td className="r num">{ksh(x.inflow)}</td>
                <td className="r num">{ksh(x.out)}{x.isCov && <div className="muted" style={{ fontSize: 11 }}>actual</div>}</td>
                <td className="r num" style={{ fontWeight: 600, color: x.balance < 0 ? "var(--red)" : "inherit" }}>{ksh(x.balance)}</td>
                <td className="r num" style={{ color: x.safe > 0 ? "var(--teal)" : "var(--mute)" }}>{ksh(x.safe)}</td>
              </tr>))}</tbody></table>
        </div>
        <div className="muted" style={{ fontSize: 12, padding: "8px 16px" }}>Revenue comes from the imported M-Pesa utility statement where available; type a figure only for days the statement doesn't cover yet. Safe to spend = balance available today minus every payment still due from today to month end, the same rule as the Profit First budget calendar.</div>
      </Section>
    </div>
  );
}

function PayrollSchedule({ an, cal, cs, setCs, mk, openTxn }) {
  const sched = (cs.payroll || {})[mk];
  const setSched = (s) => { const all = { ...(cs.payroll || {}) }; if (s === null) delete all[mk]; else all[mk] = s; setCs({ ...cs, payroll: all }); };
  const months = Object.keys(cs.payroll || {}).sort();
  const latest = months.filter((m) => m !== mk).slice(-1)[0];
  if (!sched) return (
    <Section title={`Payroll schedule · ${fmtMonth(mk)}`}>
      <Empty>No payroll schedule for {fmtMonth(mk)}.</Empty>
      <div className="flex" style={{ gap: 8, justifyContent: "center" }}>
        {latest && <button className="btn primary" onClick={() => setSched({ ...cs.payroll[latest], relatesTo: prevMonthKey(mk), note: `Copied from ${fmtMonth(latest)} — update advances and deductions`, employees: cs.payroll[latest].employees.map((e) => ({ ...e, advance: 0, addition: 0, additionLabel: "", note: "" })) })}>Copy staff list from {fmtMonth(latest)}</button>}
        <button className="btn" onClick={() => setSched({ payDay: 5, relatesTo: prevMonthKey(mk), employees: [] })}>Start an empty schedule</button>
      </div>
    </Section>
  );
  const upd = (i, f) => { const em = [...sched.employees]; em[i] = { ...em[i], ...f }; setSched({ ...sched, employees: em }); };
  const tot = (f) => sum(sched.employees, (e) => +f(e) || 0);
  const num = (v, f, w = 90) => <input inputMode="numeric" value={v ?? ""} onChange={(e) => f(e.target.value.replace(/[^\d]/g, ""))} style={{ width: w, textAlign: "right" }} />;
  return (
    <div>
      <Section title={`Payroll schedule · ${fmtMonth(mk)}`} right={<button className="btn small" onClick={() => window.confirm(`Delete the ${fmtMonth(mk)} payroll schedule?`) && setSched(null)}>Delete schedule</button>}>
        <div className="flex flex-wrap items-center" style={{ gap: 14 }}>
          <label style={{ fontSize: 13 }}>Pay day {num(sched.payDay, (v) => setSched({ ...sched, payDay: v }), 50)}</label>
          <label style={{ fontSize: 13 }}>Salary for work in <input type="month" value={sched.relatesTo || ""} onChange={(e) => setSched({ ...sched, relatesTo: e.target.value })} /></label>
          <span className="muted" style={{ fontSize: 12.5 }}>Payments whose remark names that month (e.g. "September payment") match this run even if paid late.</span>
        </div>
        {sched.note && <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{sched.note}</div>}
      </Section>
      <Section title={`Staff · net ${ksh(tot(empNet))}`} pad={false}>
        <div className="scroll">
          <table className="t"><thead><tr><th>Employee</th><th>Phone</th><th className="r">Gross</th><th className="r">Additions</th><th className="r">Advance deducted</th><th className="r">Other deduction</th><th className="r">Net pay</th><th>Advances found in Tende</th><th>Paid this month</th><th>Note</th><th></th></tr></thead>
            <tbody>{sched.employees.map((e, i) => {
              const adv = advancesFor(an, mk, sched, e), advT = sum(adv, (r) => r.amount);
              const row = cal.rows.find((r) => r.id === "p:" + e.id);
              const mismatch = advT && advT !== (+e.advance || 0);
              return (
                <tr key={e.id}>
                  <td><input value={e.name} onChange={(ev) => upd(i, { name: ev.target.value })} style={{ width: 150 }} /></td>
                  <td><input value={e.phone || ""} placeholder="optional" onChange={(ev) => upd(i, { phone: ev.target.value })} style={{ width: 120 }} /></td>
                  <td className="r">{num(e.gross, (v) => upd(i, { gross: v }))}</td>
                  <td className="r">{num(e.addition, (v) => upd(i, { addition: v }), 70)}<input value={e.additionLabel || ""} placeholder="label" onChange={(ev) => upd(i, { additionLabel: ev.target.value })} style={{ width: 90, marginLeft: 4 }} /></td>
                  <td className="r">{num(e.advance, (v) => upd(i, { advance: v }))}</td>
                  <td className="r">{num(e.other, (v) => upd(i, { other: v }), 70)}<input value={e.otherLabel || ""} placeholder="label" onChange={(ev) => upd(i, { otherLabel: ev.target.value })} style={{ width: 90, marginLeft: 4 }} /></td>
                  <td className="r num" style={{ fontWeight: 600 }}>{ksh(empNet(e))}</td>
                  <td style={{ minWidth: 150 }}>{adv.length ? adv.map((a) => <div key={a.id}><button onClick={() => openTxn(a.id)} style={{ border: 0, background: "none", padding: 0, color: "var(--teal)", font: "inherit" }}>{ksh(a.amount)} · {fmtDay(a.day)}</button></div>) : <span className="muted">{an.lastDay && an.lastDay >= dueOn(prevMonthKey(mk), 1) ? "none" : "no data for the period"}</span>}{mismatch ? <div className="chip review" style={{ marginTop: 2 }}>{ksh(advT)} found, {ksh(e.advance || 0)} deducted</div> : null}</td>
                  <td>{row ? <><StatusChip s={row.status} />{row.paid ? <div className="num muted" style={{ fontSize: 12 }}>{ksh(row.paid)}</div> : null}{row.variance ? <div style={{ fontSize: 12, fontWeight: 600, color: row.variance > 0 ? "var(--amber, #b45309)" : "var(--red, #b91c1c)" }}>{row.variance > 0 ? `${ksh(row.variance)} over` : `${ksh(-row.variance)} short`}</div> : null}</> : null}</td>
                  <td><input value={e.note || ""} onChange={(ev) => upd(i, { note: ev.target.value })} style={{ width: 180 }} /></td>
                  <td><button className="btn small" aria-label={`Remove ${e.name}`} onClick={() => setSched({ ...sched, employees: sched.employees.filter((x) => x.id !== e.id) })}>×</button></td>
                </tr>);
            })}
              <tr><td style={{ fontWeight: 600 }}>Total</td><td></td><td className="r num" style={{ fontWeight: 600 }}>{ksh(tot((e) => e.gross))}</td><td className="r num">{ksh(tot((e) => e.addition))}</td><td className="r num">{ksh(tot((e) => e.advance))}</td><td className="r num">{ksh(tot((e) => e.other))}</td><td className="r num" style={{ fontWeight: 600 }}>{ksh(tot(empNet))}</td><td colSpan={4}></td></tr>
            </tbody></table>
        </div>
        <div style={{ padding: 12 }}><button className="btn small" onClick={() => setSched({ ...sched, employees: [...sched.employees, { id: "e" + Date.now().toString(36), name: "", phone: "", gross: 0, addition: 0, additionLabel: "", advance: 0, other: 0, otherLabel: "", note: "" }] })}>Add employee</button></div>
        <div className="muted" style={{ fontSize: 12, padding: "0 16px 12px" }}>Advances found = salary advances in Tende between the previous pay day and this one, matched by name or phone. A mismatch means an advance was paid but not deducted (or the other way round).</div>
      </Section>
    </div>
  );
}

function ObligationRegister({ cs, setCs, mk, cal }) {
  const obs = cs.obligations || [];
  const upd = (i, f) => { const a = [...obs]; a[i] = { ...a[i], ...f }; setCs({ ...cs, obligations: a }); };
  const list = (v) => (v || []).join(", ");
  const split = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const subsFor = (c) => [...new Set(RULES.filter((r) => r.cat === c).map((r) => r.sub))];
  return (
    <Section title={`Obligations register · ${obs.filter((o) => o.active).length} active · ${ksh(sum(cal.rows.filter((r) => r.kind === "obl"), (r) => r.expected))} in ${fmtMonth(mk)}`}
      right={<div className="flex" style={{ gap: 8 }}>
        <button className="btn small" onClick={() => setCs({ ...cs, obligations: [...obs, { ...OBL_DEFAULTS, id: "ob" + Date.now().toString(36), name: "New obligation", category: "Premises", subcategory: "Rent", day: 1, amount: 0, startMonth: mk }] })}>Add obligation</button>
        <button className="btn small" onClick={() => window.confirm("Replace the register with the October 2026 defaults?") && setCs({ ...cs, obligations: DEFAULT_OBLIGATIONS })}>Reset to defaults</button>
      </div>} pad={false}>
      <div className="muted" style={{ padding: "10px 16px", fontSize: 12.5, borderBottom: "1px solid var(--line)" }}>Each line generates a payment every month it applies to. "Match payees" (names or phone/till/paybill numbers) and "Match words" (words or patterns in the Tende remark) tell the calendar which Tende payment settles it. When "words required" is ticked, a payee match alone isn't enough — use it for people who are also paid for other things.</div>
      <div className="scroll" style={{ maxHeight: "72vh" }}>
        <table className="t"><thead><tr><th>Active</th><th>Obligation</th><th>Category</th><th className="r">Due day</th><th>Amount rule</th><th>Frequency</th><th>Tier</th><th>Payee</th><th>Match payees</th><th>Match words</th><th></th></tr></thead>
          <tbody>{obs.map((o, i) => (
            <tr key={o.id}>
              <td><input type="checkbox" checked={!!o.active} onChange={(e) => upd(i, { active: e.target.checked })} aria-label="Active" /></td>
              <td><input value={o.name} onChange={(e) => upd(i, { name: e.target.value })} style={{ width: 200 }} /><input value={o.group || ""} placeholder="group (optional)" onChange={(e) => upd(i, { group: e.target.value })} style={{ width: 200, marginTop: 4, fontSize: 12 }} /></td>
              <td><select value={o.category} onChange={(e) => upd(i, { category: e.target.value, subcategory: subsFor(e.target.value)[0] || "" })}>{CATEGORY_ORDER.filter((c) => c !== "Unclassified").map((c) => <option key={c}>{c}</option>)}</select>
                <select value={o.subcategory} onChange={(e) => upd(i, { subcategory: e.target.value })} style={{ display: "block", marginTop: 4, maxWidth: 170 }}>{[...new Set([o.subcategory, ...subsFor(o.category)])].map((s) => <option key={s}>{s}</option>)}</select></td>
              <td className="r"><input inputMode="numeric" value={o.day} onChange={(e) => upd(i, { day: e.target.value.replace(/[^\d]/g, "") })} style={{ width: 46, textAlign: "right" }} /></td>
              <td style={{ minWidth: 200 }}>
                <select value={o.amountType} onChange={(e) => upd(i, { amountType: e.target.value })}><option value="fixed">Fixed</option><option value="lastActual">Last month's actual</option><option value="alternating">Alternating</option><option value="lateFee">Fixed + late fee</option></select>
                <div className="flex" style={{ gap: 4, marginTop: 4 }}>
                  {o.amountType === "alternating"
                    ? <><input inputMode="numeric" value={(o.amounts || [])[0] ?? ""} onChange={(e) => upd(i, { amounts: [+e.target.value.replace(/[^\d]/g, ""), (o.amounts || [])[1] || 0] })} style={{ width: 80 }} /><input inputMode="numeric" value={(o.amounts || [])[1] ?? ""} onChange={(e) => upd(i, { amounts: [(o.amounts || [])[0] || 0, +e.target.value.replace(/[^\d]/g, "")] })} style={{ width: 80 }} /></>
                    : <input inputMode="numeric" value={o.amount} onChange={(e) => upd(i, { amount: +e.target.value.replace(/[^\d]/g, "") })} style={{ width: 90 }} placeholder={o.amountType === "lastActual" ? "fallback" : ""} />}
                  {o.amountType === "lateFee" && <><span className="muted" style={{ fontSize: 12 }}>+/day</span><input inputMode="numeric" value={o.lateFeePerDay || ""} onChange={(e) => upd(i, { lateFeePerDay: +e.target.value.replace(/[^\d]/g, "") })} style={{ width: 50 }} /></>}
                </div>
              </td>
              <td style={{ minWidth: 150 }}><select value={o.freq} onChange={(e) => upd(i, { freq: e.target.value })}><option value="monthly">Monthly</option><option value="every">Every N months</option></select>
                {o.freq === "every" && <div className="flex items-center" style={{ gap: 4, marginTop: 4 }}><input inputMode="numeric" value={o.every} onChange={(e) => upd(i, { every: +e.target.value.replace(/[^\d]/g, "") || 1 })} style={{ width: 40 }} /><span className="muted" style={{ fontSize: 12 }}>from</span><input type="month" value={o.anchor || ""} onChange={(e) => upd(i, { anchor: e.target.value })} style={{ width: 130 }} /></div>}
                <div className="flex items-center" style={{ gap: 4, marginTop: 4 }}><span className="muted" style={{ fontSize: 12 }}>start</span><input type="month" value={o.startMonth || ""} onChange={(e) => upd(i, { startMonth: e.target.value })} style={{ width: 130 }} /></div></td>
              <td><select value={o.tier} onChange={(e) => upd(i, { tier: +e.target.value })}>{[1, 2, 3, 4, 5].map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}</select></td>
              <td><input value={o.payee || ""} onChange={(e) => upd(i, { payee: e.target.value })} style={{ width: 170 }} /></td>
              <td><input value={list(o.payees)} onChange={(e) => upd(i, { payees: split(e.target.value) })} style={{ width: 170 }} /></td>
              <td><input value={list(o.keywords)} onChange={(e) => upd(i, { keywords: split(e.target.value) })} style={{ width: 170 }} /><label style={{ display: "block", fontSize: 12, marginTop: 4 }}><input type="checkbox" checked={!!o.keywordRequired} onChange={(e) => upd(i, { keywordRequired: e.target.checked })} /> words required</label></td>
              <td><button className="btn small" aria-label={`Remove ${o.name}`} onClick={() => window.confirm(`Remove ${o.name}?`) && setCs({ ...cs, obligations: obs.filter((x) => x.id !== o.id) })}>×</button></td>
            </tr>))}</tbody></table>
      </div>
    </Section>
  );
}

/* ======================================================================
   APP
   ====================================================================== */
/* ======================================================================
   PAYMENT ALERTS — unpaid / pending fixed payments for the month being viewed,
   worked out from the payment calendar and Tende data. Each alert says what to
   do next and offers the matching actions.
   ====================================================================== */
const ALERT_LEVELS = {
  overdue: { label: "Overdue", color: "var(--red)", bg: "var(--redbg)" },
  today: { label: "Due today", color: "var(--amber)", bg: "var(--amberbg)" },
  soon: { label: "Due soon", color: "var(--indigo)", bg: "var(--indigobg)" },
  unverified: { label: "Can't confirm yet", color: "var(--ink2)", bg: "#EEF0F1" },
  noamount: { label: "Amount not set", color: "var(--amber)", bg: "var(--amberbg)" },
  upcoming: { label: "Scheduled", color: "var(--ink2)", bg: "#EEF0F1" },
};
const ALERT_ORDER = ["overdue", "today", "soon", "unverified", "noamount", "upcoming"];
const nextMonthKey = (mk) => shiftAnchor("month", mk + "-01", 1).slice(0, 7);

// viewMk: the month being looked at. The current month also carries unpaid items from the previous 3 months.
function paymentAlerts(an, cs, viewMk) {
  const today = todayKey();
  const thisM = monthKey(today);
  const view = viewMk || thisM;
  const mode = view < thisM ? "past" : view > thisM ? "future" : "current";
  const ahead = Math.max(0, +(cs.alertDays ?? 3));
  const endAhead = addDays(today, ahead);
  const months = [];
  if (mode === "current") {
    let m = shiftAnchor("month", thisM + "-01", -3).slice(0, 7);
    const firstM = an.firstDay ? monthKey(an.firstDay) : thisM;
    if (m < firstM) m = firstM;
    while (m <= monthKey(endAhead)) { months.push(m); m = nextMonthKey(m); }
  } else months.push(view);
  const snooze = cs.alertSnooze || {};
  const dataTo = an.lastDay;
  const items = [];
  let monthCal = null;
  for (const mk of months) {
    const cal = buildCalendar(an, cs, mk);
    if (mk === view) monthCal = cal;
    for (const r of cal.rows) {
      if (["Not due this month", "Settled manually", "Paid", "Paid late"].includes(r.status)) continue;
      let level = null;
      if (r.status === "Amount not set") { if (r.due >= today && (r.due <= endAhead || mode === "future")) level = "noamount"; }
      else if (r.remaining <= 0) continue;
      else if (r.status === "Overdue" || (r.status === "Part paid" && dataTo && dataTo > r.due)) level = "overdue";
      else if (r.due < today) level = "unverified";
      else if (r.due === today) level = "today";
      else if (r.due <= endAhead) level = "soon";
      else if (mode === "future") level = "upcoming";
      if (!level) continue;
      const key = `${mk}|${r.id}`;
      items.push({
        key, mk, level, row: r,
        snoozed: !!(snooze[key] && snooze[key] >= today), snoozedUntil: snooze[key] || null,
        daysLate: r.due < today ? dayDiff(r.due, today) : 0,
        daysToDue: r.due >= today ? dayDiff(today, r.due) : 0,
        checkedTo: dataTo && dataTo < today ? dataTo : today,
        hint: r.arrears && r.arrears.length ? `A payment for ${[...new Set(r.arrears.map((a) => fmtMonth(a.relatesTo)))].join(", ")} was found near this due date — this obligation may be paid a month in arrears.` : "",
      });
    }
  }
  items.sort((a, b) => ALERT_ORDER.indexOf(a.level) - ALERT_ORDER.indexOf(b.level) || a.row.tier - b.row.tier || a.row.due.localeCompare(b.row.due));
  const live = items.filter((x) => !x.snoozed);
  const groups = Object.fromEntries(ALERT_ORDER.map((l) => [l, live.filter((x) => x.level === l)]));
  const mrows = monthCal ? monthCal.rows.filter((r) => r.status !== "Not due this month") : [];
  const settledSt = ["Paid", "Paid late", "Settled manually"];
  return {
    today, ahead, dataTo, view, mode, items, live, groups,
    snoozed: items.filter((x) => x.snoozed),
    counts: Object.fromEntries(ALERT_ORDER.map((l) => [l, groups[l].length])),
    totals: Object.fromEntries(ALERT_ORDER.map((l) => [l, sum(groups[l], (x) => x.row.remaining)])),
    urgent: groups.overdue.length + groups.today.length,
    actionable: live.filter((x) => !["unverified", "upcoming"].includes(x.level)).length,
    month: { scheduled: mrows.length, settled: mrows.filter((r) => settledSt.includes(r.status)).length, late: mrows.filter((r) => r.status === "Paid late").length, unpaid: sum(mrows, (r) => r.remaining), expected: sum(mrows, (r) => r.expected) },
    signature: view + "|" + ALERT_ORDER.map((l) => `${l}:${groups[l].map((x) => x.key).join(",")}`).join("|"),
  };
}

// What to do next, in plain words
function alertAdvice(x, al) {
  const r = x.row, who = r.payeeLabel || "the payee", amt = ksh(r.remaining);
  const where = r.kind === "pay" ? "the payroll schedule" : "the obligations register";
  if (x.level === "noamount") return `Enter the amount in ${where} so it is reserved in the cash plan.`;
  if (x.level === "upcoming") return `Scheduled: pay ${who} ${amt} by ${fmtDay(r.due)}.`;
  if (x.level === "today") return `Pay ${who} ${amt} today. Use a remark that names it (e.g. "${r.kind === "pay" ? fmtMonth(r.rel) + " salary" : r.name}") so the system matches it.`;
  if (x.level === "soon") return `Pay ${who} ${amt} by ${fmtDay(r.due)}. Use a remark that names it so the system matches it.`;
  if (x.level === "unverified") return `The Tende data doesn't cover ${fmtDay(r.due)}. Import the Tende export for that period — if it was paid there, this clears by itself. If it was paid outside Tende, use Mark paid.`;
  if (r.status === "Part paid") return `${ksh(r.paid)} of ${ksh(r.expected)} is paid. Pay the balance of ${amt}, or if the expected amount is wrong, correct it in ${where}.`;
  if (r.candidates && r.candidates.length) return `A payment found in Tende may be this one — check it below and choose Count it or Not this one. If it was paid some other way, use Mark paid.`;
  return `No payment found. Pay ${who} ${amt}. If it was already paid outside Tende, use Mark paid; if it was paid in Tende under another name, use Link a payment; if it isn't due this month, use Not due this month.`;
}

// What to do about a payment that looks related but wasn't counted
function candidateAdvice(c, r) {
  const reason = c.reason;
  if (/^Already counted for/.test(reason)) return "It is already settling another line. Count it here only if it was linked to the wrong line — it will move here.";
  if (/^Paid to/.test(reason)) return `Count it if ${titleCase(c.txn.payee)} collected this on ${r.payeeLabel}'s behalf.`;
  if (/advance/.test(reason)) return "Count it if this was the salary paid early. If it really was an advance, leave it and record it as a deduction in the payroll schedule.";
  if (/commission/.test(reason)) return "Count it only if this was actually salary.";
  if (/doesn't say it is salary/.test(reason)) return "Count it only if this was salary. If it was money for something else (supplies, transport, tokens), choose Not this one.";
  if (/^Remark says it is for/.test(reason)) return "This looks like pay for a different month. Count it only if it belongs to this month's payment.";
  if (/more than 15 days/.test(reason)) return "Count it if this was this month's payment made early or late.";
  if (/above the expected/.test(reason)) return "Count it if the expected amount is wrong — then correct the amount too.";
  if (/doesn't mention/.test(reason)) return "Count it if this is the payment; otherwise choose Not this one.";
  return "Count it if this is the payment; otherwise choose Not this one.";
}

const alertLine = (x) => {
  const r = x.row;
  const part = r.status === "Part paid" ? ` (part paid ${ksh(r.paid)} of ${ksh(r.expected)})` : "";
  if (x.level === "overdue") return `${r.name} — ${ksh(r.remaining)} to ${r.payeeLabel || "payee"}, due ${fmtDay(r.due)}${part}. ${r.status === "Part paid" ? "Balance unpaid" : "No matching Tende payment"} up to ${fmtDay(x.checkedTo)}.`;
  if (x.level === "today") return `${r.name} — ${ksh(r.remaining)} to ${r.payeeLabel || "payee"}${part}.`;
  if (x.level === "soon") return `${r.name} — ${ksh(r.remaining)}, due ${fmtDay(r.due)} (in ${x.daysToDue} day${x.daysToDue > 1 ? "s" : ""})${part}.`;
  if (x.level === "unverified" || x.level === "upcoming") return `${r.name} — ${ksh(r.remaining)}, due ${fmtDay(r.due)}${part}.`;
  return `${r.name} — due ${fmtDay(r.due)}, amount not set in the register.`;
};

function alertsText(al, heading = true) {
  const L = [];
  if (heading) L.push(`HAPPYNET — FIXED PAYMENT ALERTS — ${fmtMonth(al.view)}`, `As of ${fmtDay(al.today)}${al.dataTo ? ` · Tende data to ${fmtDay(al.dataTo)}` : ""}`, ``);
  if (al.month.scheduled) L.push(`${fmtMonth(al.view)}: ${al.month.settled} of ${al.month.scheduled} fixed payments settled${al.month.late ? ` (${al.month.late} late)` : ""}.`, "");
  if (!al.live.length) { L.push("No fixed payments need attention."); return L.join("\n").trim(); }
  const sec = (l, title) => {
    if (!al.groups[l].length) return;
    L.push(`${title} — ${al.groups[l].length}${al.totals[l] ? ` · ${ksh(al.totals[l])}` : ""}`);
    al.groups[l].forEach((x) => L.push(`• ${alertLine(x)}`));
    L.push("");
  };
  sec("overdue", al.mode === "past" ? "STILL UNPAID" : "OVERDUE");
  sec("today", "DUE TODAY");
  sec("soon", `DUE IN THE NEXT ${al.ahead} DAYS`);
  if (al.groups.unverified.length) L.push(`CAN'T CONFIRM — ${al.groups.unverified.length} payment${al.groups.unverified.length > 1 ? "s" : ""} (${ksh(al.totals.unverified)}) fell due outside the imported Tende data${al.dataTo ? ` (data ends ${fmtDay(al.dataTo)})` : ""}. Import the Tende export covering them to check.`, "");
  sec("noamount", "AMOUNT NOT SET");
  sec("upcoming", "SCHEDULED");
  return L.join("\n").trim();
}

function AlertBanner({ al, onOpen, onHide }) {
  const c = al.counts, t = al.totals;
  if (!al.live.length || (al.mode === "future" && !c.soon && !c.today)) return null;
  const parts = [];
  if (c.overdue) parts.push(`${c.overdue} ${al.mode === "past" ? "still unpaid" : "overdue"} (${ksh(t.overdue)})`);
  if (c.today) parts.push(`${c.today} due today (${ksh(t.today)})`);
  if (c.soon) parts.push(`${c.soon} due in the next ${al.ahead} day${al.ahead === 1 ? "" : "s"} (${ksh(t.soon)})`);
  if (c.unverified) parts.push(`${c.unverified} can't be confirmed from the imported Tende data`);
  if (c.noamount) parts.push(`${c.noamount} with no amount set`);
  if (!parts.length) return null;
  const lvl = c.overdue ? "overdue" : c.today ? "today" : c.soon ? "soon" : "unverified";
  const S = ALERT_LEVELS[lvl];
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between" style={{ gap: 10, padding: "10px 14px", borderRadius: 8, marginBottom: 14, background: S.bg, borderLeft: `4px solid ${S.color}` }}>
      <div><b style={{ fontWeight: 600 }}>Fixed payments{al.mode !== "current" ? ` — ${fmtMonth(al.view)}` : ""}:</b> {parts.join(" · ")}.</div>
      <div className="flex" style={{ gap: 6 }}><button className="btn small" onClick={onOpen}>View alerts</button><button className="btn small" onClick={onHide}>Hide</button></div>
    </div>
  );
}

function AlertsPanel({ al, an, cs, setCs, reviewer, onClose, openInCalendar, openTxn, setViewMonth, inline = false }) {
  const [open, setOpen] = useState(null); // { key, kind: "paid" | "link" | "skip" }
  const [amt, setAmt] = useState(""), [date, setDate] = useState(todayKey()), [how, setHow] = useState(""), [ref, setRef] = useState(""), [err, setErr] = useState("");
  const [showUnverified, setShowUnverified] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => { const k = (e) => e.key === "Escape" && onClose(); window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const stamp = () => ({ by: reviewer || "", at: new Date().toLocaleString("en-KE") });
  const settle = (x, v) => {
    const all = { ...(cs.settlements || {}) }; const m = { ...(all[x.mk] || {}) };
    m[x.row.id] = v === null ? undefined : { ...v, ...stamp() };
    if (v === null) delete m[x.row.id];
    all[x.mk] = m; setCs({ ...cs, settlements: all }); setOpen(null); setErr("");
  };
  const snoozeFor = (x, days) => {
    const s = { ...(cs.alertSnooze || {}) };
    if (days === null) delete s[x.key]; else s[x.key] = addDays(todayKey(), days);
    setCs({ ...cs, alertSnooze: s });
  };
  const curSettle = (x) => ((cs.settlements || {})[x.mk] || {})[x.row.id] || {};
  const countIt = (x, c) => settle(x, { link: [...x.row.matches.map((t) => t.id), c.txn.id], note: `Counted from alerts (${c.reason})` });
  const notThis = (x, c) => { const st = curSettle(x); settle(x, { ...st, unlink: [...(st.unlink || []), c.txn.id] }); };
  const linkRef = (x) => {
    const q = ref.trim().toUpperCase();
    const t = an.expenses.find((e) => e.id.toUpperCase() === q || String(e.txnRef).toUpperCase() === q);
    if (!t) { setErr(`No imported Tende payment has the ID or M-Pesa reference "${ref.trim()}".`); return; }
    settle(x, { link: [...x.row.matches.map((m) => m.id), t.id], note: "Linked from alerts" });
  };
  const copy = async () => { try { await navigator.clipboard.writeText(alertsText(al)); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ } };
  const begin = (x, kind) => { setOpen({ key: x.key, kind }); setAmt(""); setDate(todayKey()); setHow(""); setRef(""); setErr(""); };

  const renderItem = (x) => {
    const r = x.row, S = ALERT_LEVELS[x.level];
    const isOpen = (k) => open && open.key === x.key && open.kind === k;
    return (
      <div key={x.key} style={{ padding: "12px 0", borderBottom: "1px solid #EDF0EE" }}>
        <div className="flex justify-between items-start" style={{ gap: 10 }}>
          <div>
            <div style={{ fontWeight: 600 }}>{r.name}{x.mk !== al.view && <span className="muted" style={{ fontWeight: 400 }}> · from {fmtMonth(x.mk)}</span>}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>{r.payeeLabel || "—"} · priority {r.tier} · due {fmtDay(r.due)}</div>
          </div>
          <div className="num" style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{x.level === "noamount" ? <span className="muted">—</span> : ksh(r.remaining)}</div>
        </div>
        <div style={{ fontSize: 13, color: S.color, marginTop: 3 }}>
          {x.level === "overdue" && `${x.daysLate} day${x.daysLate === 1 ? "" : "s"} overdue — ${r.status === "Part paid" ? "balance unpaid" : r.candidates && r.candidates.length ? "no payment counted yet" : "no matching Tende payment"} up to ${fmtDay(x.checkedTo)}`}
          {x.level === "today" && "Due today"}
          {x.level === "soon" && `Due in ${x.daysToDue} day${x.daysToDue === 1 ? "" : "s"}`}
          {x.level === "upcoming" && `Due in ${x.daysToDue} days`}
          {x.level === "unverified" && `Due ${x.daysLate} day${x.daysLate === 1 ? "" : "s"} ago — ${r.detail || "outside the imported Tende data"}`}
          {x.level === "noamount" && "Amount not set"}
          {r.status === "Part paid" && <span> · part paid {ksh(r.paid)} of {ksh(r.expected)}</span>}
        </div>
        <div style={{ fontSize: 13, marginTop: 6, padding: "6px 8px", background: "#F3F7F6", borderRadius: 6 }}><b style={{ fontWeight: 600 }}>What to do: </b>{alertAdvice(x, al)}</div>
        {x.hint && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>{x.hint}</div>}
        {x.snoozed && <div className="muted" style={{ fontSize: 12.5 }}>Snoozed until {fmtDay(x.snoozedUntil)}</div>}

        {r.candidates && r.candidates.length > 0 && (
          <div style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "6px 8px", marginTop: 8 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>Found in Tende but not counted</div>
            {r.candidates.map((c) => (
              <div key={c.txn.id} style={{ padding: "6px 0", borderTop: "1px solid #EDF0EE", fontSize: 12.5 }}>
                <div><span className="num">{fmtDay(c.txn.day)} · {ksh(c.txn.amount)}</span> · {titleCase(c.txn.payee)} · "{c.txn.remark}"</div>
                <div className="muted">Why not counted: {c.reason}</div>
                <div style={{ marginTop: 2 }}>{candidateAdvice(c, r)}</div>
                <div className="flex flex-wrap" style={{ gap: 6, marginTop: 4 }}>
                  <button className="btn small" onClick={() => countIt(x, c)}>Count it</button>
                  <button className="btn small" onClick={() => notThis(x, c)}>Not this one</button>
                  <button className="btn small" onClick={() => openTxn(c.txn.id)}>Open payment</button>
                </div>
              </div>))}
          </div>
        )}

        {isOpen("paid") && (
          <div className="flex flex-wrap items-center" style={{ gap: 6, marginTop: 8 }}>
            <span style={{ fontSize: 12.5 }}>Paid outside Tende:</span>
            <input inputMode="numeric" value={amt} placeholder={String(Math.round(r.remaining))} onChange={(e) => setAmt(e.target.value.replace(/[^\d.]/g, ""))} style={{ width: 90 }} aria-label="Amount paid" />
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date paid" />
            <input value={how} placeholder="How (bank, cash…)" onChange={(e) => setHow(e.target.value)} style={{ flex: "1 1 120px" }} />
            <button className="btn primary small" onClick={() => settle(x, { mode: "settled", amount: amt || r.remaining, date, note: how || "Marked paid from alerts" })}>Save</button>
            <button className="btn small" onClick={() => setOpen(null)}>Cancel</button>
          </div>
        )}
        {isOpen("link") && (
          <div style={{ marginTop: 8 }}>
            <div className="flex flex-wrap items-center" style={{ gap: 6 }}>
              <input value={ref} placeholder="Tende ID or M-Pesa ref (e.g. KC10000002 / UAB1C2D3EF)" onChange={(e) => setRef(e.target.value)} style={{ flex: "1 1 220px" }} />
              <button className="btn primary small" onClick={() => linkRef(x)}>Link</button>
              <button className="btn small" onClick={() => setOpen(null)}>Cancel</button>
            </div>
            {err && <div style={{ color: "var(--red)", fontSize: 12.5, marginTop: 4 }}>{err}</div>}
          </div>
        )}
        {isOpen("skip") && (
          <div className="flex flex-wrap items-center" style={{ gap: 6, marginTop: 8 }}>
            <input value={how} placeholder="Why (e.g. paid quarterly, site closed)" onChange={(e) => setHow(e.target.value)} style={{ flex: "1 1 200px" }} />
            <button className="btn primary small" onClick={() => settle(x, { mode: "skip", note: how })}>Confirm not due</button>
            <button className="btn small" onClick={() => setOpen(null)}>Cancel</button>
          </div>
        )}
        {!open || open.key !== x.key ? (
          <div className="flex flex-wrap" style={{ gap: 6, marginTop: 8 }}>
            {x.level !== "noamount" && <button className="btn small" title="Record a payment made by bank, cash or another route" onClick={() => begin(x, "paid")}>Mark paid</button>}
            {x.level !== "noamount" && <button className="btn small" title="Attach a Tende payment the system didn't match" onClick={() => begin(x, "link")}>Link a payment</button>}
            <button className="btn small" title="This obligation doesn't apply this month" onClick={() => begin(x, "skip")}>Not due this month</button>
            {x.snoozed ? <button className="btn small" onClick={() => snoozeFor(x, null)}>Unsnooze</button> : <button className="btn small" title="Hide for 3 days" onClick={() => snoozeFor(x, 3)}>Snooze 3 days</button>}
            <button className="btn small" onClick={() => openInCalendar(x)}>Open in calendar</button>
          </div>
        ) : null}
      </div>
    );
  };
  const renderGroup = (l, title) => al.groups[l].length ? (
    <div key={l} style={{ marginBottom: 14 }}>
      <div className="flex justify-between" style={{ borderBottom: `2px solid ${ALERT_LEVELS[l].color}`, paddingBottom: 4 }}>
        <b style={{ fontWeight: 600, color: ALERT_LEVELS[l].color }}>{title} · {al.groups[l].length}</b>
        {al.totals[l] > 0 && <span className="num" style={{ fontWeight: 600 }}>{ksh(al.totals[l])}</span>}
      </div>
      {al.groups[l].map((x) => renderItem(x))}
    </div>
  ) : null;
  const ms = al.month;
  const inner = (
    <>
        <div style={{ padding: 16, borderBottom: "1px solid var(--line)" }}>
          <div className="flex items-start justify-between" style={{ gap: 12 }}>
            <div>
              <h2 className="h2">Fixed payment alerts</h2>
              <div className="muted" style={{ fontSize: 12.5 }}>As of {fmtDay(al.today)}{al.dataTo ? ` · Tende data to ${fmtDay(al.dataTo)}` : " · no Tende data yet"}</div>
            </div>
            <div className="flex" style={{ gap: 6 }}><button className="btn small" onClick={copy}>{copied ? "Copied" : "Copy as text"}</button>{!inline && <button className="btn small" onClick={onClose}>Close</button>}</div>
          </div>
          {!inline && <div className="flex items-center" style={{ gap: 6, marginTop: 10 }}>
            <button className="btn small" aria-label="Previous month" onClick={() => setViewMonth(prevMonthKey(al.view))}>‹</button>
            <b style={{ fontWeight: 600, minWidth: 90, textAlign: "center" }}>{fmtMonth(al.view)}</b>
            <button className="btn small" aria-label="Next month" onClick={() => setViewMonth(nextMonthKey(al.view))}>›</button>
            {al.mode !== "current" && <button className="btn small" onClick={() => setViewMonth(monthKey(todayKey()))}>This month</button>}
          </div>}
          {ms.scheduled > 0 && (
            <div style={{ fontSize: 13, marginTop: 8 }}>
              {ms.settled} of {ms.scheduled} fixed payments settled{ms.late ? ` (${ms.late} paid late)` : ""}{ms.unpaid ? ` · ${ksh(ms.unpaid)} not yet settled` : ""}.
              {al.mode === "current" && <span className="muted"> Includes anything still unpaid from the last 3 months.</span>}
              {al.mode === "past" && <span className="muted"> Statuses as of today — settle what's left here and it stops following you into later months.</span>}
            </div>
          )}
        </div>
        <div style={inline ? { padding: 16 } : { padding: 16, overflow: "auto", flex: 1 }}>
          {!al.live.length && <Empty>{al.mode === "past" ? `Every fixed payment for ${fmtMonth(al.view)} is settled or accounted for.` : "No fixed payments need attention right now."}</Empty>}
          {renderGroup("overdue", al.mode === "past" ? "Still unpaid" : "Overdue")}
          {renderGroup("today", "Due today")}
          {renderGroup("soon", `Due in the next ${al.ahead} day${al.ahead === 1 ? "" : "s"}`)}
          {al.groups.unverified.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div className="flex justify-between" style={{ borderBottom: "2px solid var(--line)", paddingBottom: 4 }}>
                <b style={{ fontWeight: 600, color: "var(--ink2)" }}>Can't confirm yet · {al.groups.unverified.length}</b>
                <span className="num" style={{ fontWeight: 600 }}>{ksh(al.totals.unverified)}</span>
              </div>
              <div style={{ fontSize: 13, padding: "8px 0" }}><b style={{ fontWeight: 600 }}>What to do: </b>these fell due on dates the imported Tende data doesn't cover{al.dataTo ? ` (data ends ${fmtDay(al.dataTo)})` : ""}. Import the Tende export for those dates and any that were paid clear themselves. For anything paid outside Tende, open it and use Mark paid.</div>
              {showUnverified ? al.groups.unverified.map((x) => renderItem(x)) : <button className="btn small" onClick={() => setShowUnverified(true)}>Show the {al.groups.unverified.length} payments</button>}
            </div>
          )}
          {renderGroup("noamount", "Amount not set")}
          {renderGroup("upcoming", "Scheduled")}
          {al.snoozed.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <button className="btn small" onClick={() => setShowSnoozed(!showSnoozed)}>{showSnoozed ? "Hide" : "Show"} snoozed ({al.snoozed.length})</button>
              {showSnoozed && al.snoozed.map((x) => renderItem(x))}
            </div>
          )}
        </div>
        <div className="flex items-center" style={{ gap: 8, padding: 12, borderTop: "1px solid var(--line)", fontSize: 13 }}>
          Warn me
          <input inputMode="numeric" value={cs.alertDays ?? 3} onChange={(e) => setCs({ ...cs, alertDays: e.target.value.replace(/[^\d]/g, "") })} style={{ width: 46, textAlign: "right" }} aria-label="Days of warning" />
          days before a fixed payment is due.
        </div>
    </>
  );
  // plain JSX (no wrapper component) so inputs keep focus while typing
  return inline
    ? <section className="panel" aria-label="Payment alerts">{inner}</section>
    : <><div className="scrim" onClick={onClose} /><aside className="drawer" role="dialog" aria-label="Payment alerts">{inner}</aside></>;
}

export default function ExpenseControlRoom() {
  const [raw, setRaw] = useState([]);
  const [overrides, setOverrides] = useState({});
  const [budgets, setBudgetsS] = useState({});
  const [pending, setPendingS] = useState([]);
  const [importLog, setImportLog] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState("overview");
  const [subs, setSubs] = useState({});
  const mainRef = useRef(null);
  const [period, setPeriod] = useState({ mode: "month", anchor: null });
  const [filter, setFilter] = useState({ ...EMPTY_FILTER });
  const [txnId, setTxnId] = useState(null);
  const [askOpen, setAskOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [aView, setAView] = useState("drill");
  const [drillPath, setDrillPath] = useState([]);
  const [reviewer, setReviewerS] = useState("");
  const [calState, setCalStateS] = useState(DEFAULT_CAL_STATE);
  const [revenue, setRevenueS] = useState({ days: {}, statements: [] });
  const [notice, setNotice] = useState(null);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [bannerHiddenSig, setBannerHiddenSig] = useState(null);
  const [calFocus, setCalFocus] = useState(null);
  const fileRef = useRef(null);

  const loadAll = async () => {
      if (!store.ok()) { setLoaded(true); setNotice({ kind: "warn", text: "Storage isn't available here, so data will only last for this session." }); return; }
      const idx = await store.get(K.index, []);
      const parts = await Promise.all(idx.map((m) => store.get(K.raw(m), [])));
      setRaw(parts.flat());
      setOverrides(await store.get(K.overrides, {}));
      setBudgetsS(await store.get(K.budgets, {}));
      setPendingS(await store.get(K.pending, []));
      setImportLog(await store.get(K.log, []));
      setReviewerS(await store.get(K.reviewer, ""));
      const savedCal = await store.get(K.calendar, null);
      if (savedCal) setCalStateS({ ...DEFAULT_CAL_STATE, ...savedCal,
        // a payroll saved before the confirmed figures (ver 2) is replaced once; later edits are kept
        payroll: { ...(savedCal.payroll || {}), ...(((savedCal.payroll || {})[DEMO_MONTH] || {}).ver >= 2 ? {} : { [DEMO_MONTH]: DEFAULT_PAYROLL[DEMO_MONTH] }) },
        calVer: CAL_VER,
        obligations: (savedCal.obligations || DEFAULT_OBLIGATIONS).filter((o) => !String(o.id).startsWith("statutory-")).map((o) => ((savedCal.calVer || 0) < 2 && (!o.startMonth || o.startMonth < "2026-09") ? { ...o, startMonth: "2026-09" } : o))
          .map((o) => { const d = (savedCal.calVer || 0) < 3 && DEFAULT_OBLIGATIONS.find((x) => x.id === o.id); return d ? { ...o, keywords: [...new Set([...(o.keywords || []), ...(d.keywords || [])])] } : o; }) });
      setRevenueS(await store.get(K.revenue, { days: {}, statements: [] }));
      setLoaded(true);
  };
  useEffect(() => { loadAll(); }, []);

  const an = useMemo(() => analyse(raw, overrides), [raw, overrides]);
  const anchor = period.anchor || an.lastDay || todayKey();
  const per = makePeriod(period.mode, anchor);
  const win = windows(per, an.lastDay);
  if (win.prev && (!an.firstDay || an.firstDay > win.prev.to)) win.prev = null;
  else if (win.prev && an.firstDay > win.prev.from) win.prev.label += " (partly covered)";
  // one month drives the whole app: dashboard period, payment calendar and alerts
  const calMonth = ["day", "week", "month"].includes(per.mode) ? monthKey(per.from) : monthKey(an.lastDay || todayKey());
  const setViewMonth = (m) => setPeriod({ mode: ["day", "week", "month"].includes(period.mode) ? period.mode : "month", anchor: m === monthKey(todayKey()) ? todayKey() : an.lastDay && m === monthKey(an.lastDay) ? an.lastDay : m + "-01" });
  const calendar = useMemo(() => buildCalendar(an, calState, calMonth), [an, calState, calMonth]);
  const setCalState = (v) => { setCalStateS(v); store.set(K.calendar, v); };
  const alerts = useMemo(() => paymentAlerts(an, calState, calMonth), [an, calState, calMonth]);
  const ctx = { budgets, pending, overrides, calendar, calState, revenue, alerts };
  const openInCalendar = (x) => { setViewMonth(x.mk); setCalFocus({ mk: x.mk, id: x.row.id, n: Date.now() }); setPage("fixed"); setSubs((v) => ({ ...v, fixed: "schedule" })); };

  const setBudgets = (b) => { setBudgetsS(b); store.set(K.budgets, b); };
  const setPending = (p) => { setPendingS(p); store.set(K.pending, p); };
  const setReviewer = (v) => { setReviewerS(v); store.set(K.reviewer, v); };
  const FIELD_LABELS = { category: "Category", subcategory: "Subcategory", cls: "Treat as", note: "Note", employee: "Employee", payType: "Payment type", relatesTo: "Relates to", item: "Item", qty: "Quantity", unit: "Unit", itemLines: "Items bought", review: "Review status", reviewNote: "Review note" };
  const saveOverride = (id, o, meta) => {
    const prev = overrides[id] || {};
    const clean = Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => k !== "history" && v !== undefined && v !== "" && FIELD_LABELS[k]));
    if (!clean.qty && !clean.item) delete clean.unit;
    if (clean.itemLines && !clean.itemLines.length) delete clean.itemLines;
    const fmtV = (k, v) => (v === undefined || v === null ? "automatic" : k === "itemLines" ? v.map((l) => `${l.qty ? l.qty + " × " : ""}${l.name}${l.amount ? " (" + ksh(+l.amount) + ")" : ""}`).join(", ") : v);
    const changes = Object.keys(FIELD_LABELS).filter((k) => JSON.stringify(prev[k] ?? "") !== JSON.stringify(clean[k] ?? "")).map((k) => `${FIELD_LABELS[k]}: ${fmtV(k, prev[k])} → ${fmtV(k, clean[k])}`);
    if (!changes.length) return;
    const history = [...(prev.history || []), { at: new Date().toLocaleString("en-KE"), by: (meta && meta.by) || "Unknown", reason: (meta && meta.reason) || "", changes: changes.join("; ") }];
    const next = { ...overrides, [id]: { ...clean, history } };
    setOverrides(next); store.set(K.overrides, next);
  };

  const importFiles = async (files) => {
    const existing = new Set(raw.map(rowId));
    let added = [], log = [];
    const stmts = [];
    for (const file of files) {
      const text = await file.text();
      if (isUtilityStatement(text)) {
        try { stmts.push(parseUtilityStatement(text, file.name)); } catch (e) { setNotice({ kind: "error", text: `${file.name} looks like an M-Pesa utility statement but couldn't be read: ${e.message}` }); }
        continue;
      }
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim() });
      const cols = parsed.meta.fields || [];
      const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));
      if (missing.length) { setNotice({ kind: "error", text: `${file.name} wasn't imported: it is missing the column${missing.length > 1 ? "s" : ""} ${missing.join(", ")}. Export the payments report from Tende as CSV and try again.` }); continue; }
      let dups = 0, rejected = 0, add = 0;
      for (const row of parsed.data) {
        if (!Object.values(row).some((v) => String(v || "").trim())) { rejected++; continue; }
        const id = rowId(row);
        if (existing.has(id)) { dups++; continue; }
        existing.add(id); added.push(row); add++;
      }
      log.push({ at: new Date().toLocaleString("en-KE"), file: file.name, rows: parsed.data.length, added: add, dups, rejected });
    }
    if (stmts.length) {
      const days = { ...(revenue.days || {}) };
      let statements = [...(revenue.statements || [])];
      for (const st of stmts) {
        for (const k of Object.keys(days)) if (k >= st.meta.from && k <= st.meta.to) delete days[k];
        Object.assign(days, st.days);
        statements = statements.filter((x) => !(x.from === st.meta.from && x.to === st.meta.to));
        statements.push({ ...st.meta, computedIn: st.computedIn, computedOut: st.computedOut, reconciles: st.reconciles, rows: st.rows, importedAt: new Date().toLocaleString("en-KE") });
      }
      const next = { days, statements };
      setRevenueS(next); const ok = await store.set(K.revenue, next);
      const bad = stmts.filter((x) => !x.reconciles);
      setNotice({ kind: ok && !bad.length ? "ok" : "warn", text: `Imported revenue from ${stmts.length} utility statement${stmts.length > 1 ? "s" : ""}: ${stmts.map((x) => `${fmtDay(x.meta.from)} – ${fmtDay(x.meta.to)} (${ksh(x.computedIn)})`).join("; ")}.${bad.length ? ` ${bad.length} statement${bad.length > 1 ? "s don't" : " doesn't"} match the header totals — check the file.` : " Totals match the statement headers."}${ok ? "" : " Could not save; data will be lost on reload."}` });
    }
    if (!log.length) return;
    const nextRaw = [...raw, ...added];
    setRaw(nextRaw);
    const months = [...new Set(added.map(rowMonth))];
    const allMonths = [...new Set(nextRaw.map(rowMonth))].sort();
    let okAll = true;
    for (const m of months) okAll = (await store.set(K.raw(m), nextRaw.filter((r) => rowMonth(r) === m))) && okAll;
    await store.set(K.index, allMonths);
    const nextLog = [...importLog, ...log].slice(-100); setImportLog(nextLog); store.set(K.log, nextLog);
    const tot = log.reduce((a, l) => ({ added: a.added + l.added, dups: a.dups + l.dups }), { added: 0, dups: 0 });
    setNotice({ kind: okAll ? "ok" : "warn", text: `Imported ${tot.added} new row${tot.added === 1 ? "" : "s"}; ${tot.dups} already stored and skipped.${okAll ? "" : " Some months could not be saved and will be lost on reload."}` });
    setPeriod({ mode: period.mode, anchor: null });
  };


  const clearAll = async () => {
    if (!window.confirm("Delete all imported Tende rows, classifications, budgets and obligations stored by this app?")) return;
    const idx = await store.get(K.index, []);
    await Promise.all([...idx.map((m) => store.del(K.raw(m))), store.del(K.index), store.del(K.overrides), store.del(K.budgets), store.del(K.pending), store.del(K.log), store.del(K.calendar), store.del(K.revenue)]);
    setRaw([]); setOverrides({}); setBudgetsS({}); setPendingS([]); setImportLog([]); setCalStateS(DEFAULT_CAL_STATE); setRevenueS({ days: {}, statements: [] }); setNotice({ kind: "ok", text: "All stored data deleted." });
  };

  const go = (k, s) => { setPage(k); if (s) setSubs((x) => ({ ...x, [k]: s })); if (mainRef.current) mainRef.current.scrollTop = 0; window.scrollTo && window.scrollTo(0, 0); };
  const goRegister = (f) => { setFilter({ ...EMPTY_FILTER, ...f }); go("expenses"); };
  const goDrill = (path) => { setDrillPath(path); go("analysis", "drill"); };
  const openAlerts = () => go("fixed", "alerts");
  const txn = txnId ? an.recs.find((r) => r.id === txnId) : null;
  const hasData = an.recs.length > 0;
  const P = pageOf(page);
  const sub = P.subs ? (subs[page] && P.subs.some((x) => x[0] === subs[page]) ? subs[page] : P.subs[0][0]) : null;
  const monthOnly = P.month || (page === "payroll" && sub === "schedule");
  const reviewOpen = an.expenses.filter((r) => inWin(r, win.cur) && r.review === "open").length;
  const invNeedsDetail = (() => { const rc = inventoryRecord(an.expenses.filter((r) => inWin(r, win.cur) && r.category === "Inventory & Equipment")); return rc.mixed.length + rc.unstated.length; })();
  const badges = { fixed: alerts.actionable ? { n: alerts.actionable, hot: alerts.urgent > 0 } : null, review: reviewOpen ? { n: reviewOpen } : null, inventory: invNeedsDetail ? { n: invNeedsDetail } : null };
  const dataNote = an.lastDay && an.lastDay < monthEnd(calMonth) && calMonth >= monthKey(an.lastDay) ? `Tende data runs to ${fmtDay(an.lastDay)} — later payments show once the next export is imported.` : null;
  const modeSeg = (
    <div className="seg" role="group" aria-label="Period length">
      {[["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["all", "All"]].map(([k, l]) => <button key={k} aria-pressed={per.mode === k} onClick={() => setPeriod({ mode: k, anchor: period.anchor })}>{l}</button>)}
    </div>
  );
  const periodCtl = monthOnly ? (
    <div className="flex items-center" style={{ gap: 6 }}>
      <button className="btn small" aria-label="Previous month" onClick={() => setViewMonth(prevMonthKey(calMonth))}>‹</button>
      <div style={{ minWidth: 92, textAlign: "center", fontWeight: 600 }}>{fmtMonth(calMonth)}</div>
      <button className="btn small" aria-label="Next month" onClick={() => setViewMonth(nextMonthKey(calMonth))}>›</button>
      {calMonth !== monthKey(todayKey()) && <button className="btn small" onClick={() => setViewMonth(monthKey(todayKey()))}>This month</button>}
    </div>
  ) : page === "reports" ? null : (
    <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
      <div className="flex items-center" style={{ gap: 6 }}>
        <button className="btn small" aria-label="Previous period" disabled={per.mode === "all"} onClick={() => setPeriod({ ...period, anchor: shiftAnchor(per.mode, anchor, -1) })}>‹</button>
        <div style={{ minWidth: 120, textAlign: "center" }}><div style={{ fontWeight: 600 }}>{per.label}</div><div className="muted" style={{ fontSize: 11.5 }}>{per.mode === "all" ? `${fmtDay(an.firstDay)} – ${fmtDay(an.lastDay)}` : `${fmtDay(win.cur.from)} – ${fmtDay(win.cur.to)}${win.partial ? " · to date" : ""}`}</div></div>
        <button className="btn small" aria-label="Next period" disabled={per.mode === "all"} onClick={() => setPeriod({ ...period, anchor: shiftAnchor(per.mode, anchor, 1) })}>›</button>
        <button className="btn small" onClick={() => setPeriod({ ...period, anchor: null })}>Latest</button>
      </div>
      {modeSeg}
    </div>
  );

  return (
    <div className="hx">
      <style>{CSS}</style>
      <input ref={fileRef} type="file" accept=".csv,text/csv" multiple hidden onChange={(e) => { importFiles([...e.target.files]); e.target.value = ""; }} />
      <div className="shell">
        <aside className="side" aria-label="Sections">
          <div className="brand"><div className="cond" style={{ fontSize: 18, fontWeight: 600, color: "#fff", lineHeight: 1.15 }}>Happynet</div><div style={{ fontSize: 12.5, color: "#9FB0BA" }}>Expense Control Room</div></div>
          <nav className="nav">
            {PAGES.filter((p) => !p.more || moreOpen || pageOf(page).more).map((p, i, arr) => (
              <React.Fragment key={p.k}>
                {p.group && p.group !== (arr[i - 1] || {}).group && (p.more ? <button className="grp" style={{ background: "none", border: 0, textAlign: "left", cursor: "pointer", width: "100%" }} onClick={() => setMoreOpen(false)}>More ▾</button> : <div className="grp">{p.group}</div>)}
                <button aria-current={page === p.k ? "page" : undefined} onClick={() => go(p.k)} disabled={!hasData && p.k !== "overview"}>
                  <Icon name={p.icon} /><span>{p.label}</span>
                  {hasData && badges[p.k] && <span className={`nbadge${badges[p.k].hot ? " hot" : ""}`}>{badges[p.k].n}</span>}
                </button>
              </React.Fragment>
            ))}
            {!moreOpen && !pageOf(page).more && hasData && <button onClick={() => setMoreOpen(true)}><Icon name="list" /><span>More</span>{badges.review && <span className="nbadge">{badges.review.n}</span>}</button>}
          </nav>
          <div className="sidefoot">
            <button className="sidebtn primary" onClick={() => fileRef.current && fileRef.current.click()}><Icon name="upload" size={16} />Import CSV</button>
            {hasData && <button className="sidebtn" onClick={() => setAskOpen(true)}><Icon name="ask" size={16} />Ask a question</button>}
            <div style={{ fontSize: 11.5, color: "#7F909B", marginTop: 8 }}>{hasData ? `Tende data ${fmtDay(an.firstDay)} – ${fmtDay(an.lastDay)}` : "No Tende data yet"}</div>
          </div>
        </aside>

        <div className="content" ref={mainRef}>
          <header className="pagehead">
            <div className="flex flex-wrap items-center justify-between" style={{ gap: 12 }}>
              <div>
                <h1 className="cond" style={{ margin: 0, fontSize: 24, fontWeight: 600 }}>{P.label}</h1>
                <div className="muted" style={{ fontSize: 13 }}>{P.desc}</div>
              </div>
              <div className="flex flex-wrap items-center" style={{ gap: 8 }}>
                {hasData && periodCtl}
                {hasData && <button className="btn bell" onClick={openAlerts} aria-label={`Fixed payment alerts: ${alerts.actionable}`}><Icon name="bell" size={16} />{alerts.actionable > 0 && <span className={`nbadge${alerts.urgent ? " hot" : ""}`}>{alerts.actionable}</span>}</button>}
                <span className="mob"><button className="btn small primary" onClick={() => fileRef.current && fileRef.current.click()}>Import</button>{hasData && <button className="btn small" onClick={() => setAskOpen(true)}>Ask</button>}</span>
              </div>
            </div>
            {P.subs && hasData && (
              <div className="subtabs" role="tablist">
                {P.subs.map(([k, l]) => <button key={k} role="tab" aria-selected={sub === k} onClick={() => setSubs((x) => ({ ...x, [page]: k }))}>{l}{k === "alerts" && alerts.actionable > 0 && <span className={`nbadge${alerts.urgent ? " hot" : ""}`} style={{ marginLeft: 6 }}>{alerts.actionable}</span>}</button>)}
              </div>
            )}
          </header>

          <main className="page">
            {notice && (
              <div role="status" className="flex items-start justify-between" style={{ gap: 12, padding: "10px 14px", borderRadius: 8, marginBottom: 14, background: notice.kind === "error" ? "var(--redbg)" : notice.kind === "warn" ? "var(--amberbg)" : "#E5F2EA", color: notice.kind === "error" ? "var(--red)" : "inherit" }}>
                <span>{notice.text}</span><button className="btn small" onClick={() => setNotice(null)}>Dismiss</button>
              </div>
            )}
            {loaded && hasData && page === "overview" && bannerHiddenSig !== alerts.signature && <AlertBanner al={alerts} onOpen={openAlerts} onHide={() => setBannerHiddenSig(alerts.signature)} />}
            {loaded && hasData && monthOnly && dataNote && <div className="note-strip">{dataNote}</div>}

            {!loaded ? <Empty>Loading stored data…</Empty> : !hasData ? (
              <section className="panel" style={{ padding: "48px 24px", textAlign: "center" }}>
                <div className="cond" style={{ fontSize: 24, fontWeight: 600 }}>Import a Tende payments report to begin</div>
                <p className="muted" style={{ maxWidth: 560, margin: "8px auto 18px" }}>Export the payments report from Tende as CSV. M-Pesa utility account statements can be imported the same way for revenue. Each import is added to history; rows already stored are skipped, so overlapping exports are safe.</p>
                <div className="flex" style={{ gap: 8, justifyContent: "center" }}>
                  <button className="btn primary" onClick={() => fileRef.current && fileRef.current.click()}>Import CSV</button>
                </div>
              </section>
            ) : (
              <>
                {page === "overview" && <Overview an={an} win={win} per={per} ctx={ctx} alerts={alerts} calendar={calendar} go={go} goDrill={goDrill} openAlerts={openAlerts} />}

                {page === "fixed" && sub === "schedule" && <MonthSchedule an={an} cal={calendar} cs={calState} setCs={setCalState} mk={calMonth} reviewer={reviewer} openTxn={setTxnId} focus={calFocus && calFocus.mk === calMonth ? calFocus : null} />}
                {page === "fixed" && sub === "alerts" && <AlertsPanel inline al={alerts} an={an} cs={calState} setCs={setCalState} reviewer={reviewer} onClose={() => {}} openInCalendar={openInCalendar} openTxn={setTxnId} setViewMonth={setViewMonth} />}
                {page === "fixed" && sub === "register" && <ObligationRegister cs={calState} setCs={setCalState} mk={calMonth} cal={calendar} />}
                {page === "fixed" && sub === "other" && <PendingView an={an} win={win} pending={pending} setPending={setPending} cal={calendar} />}

                {page === "payroll" && sub === "schedule" && <PayrollSchedule an={an} cal={calendar} cs={calState} setCs={setCalState} mk={calMonth} openTxn={setTxnId} />}
                {page === "payroll" && sub === "people" && <PayrollView an={an} win={win} period={per} openTxn={setTxnId} />}

                {page === "inventory" && <><InventoryRecordView an={an} win={win} period={per} openTxn={setTxnId} /><div style={{ height: 16 }} /><PriceListView an={an} /></>}
                {page === "fuel" && <FuelView an={an} win={win} period={per} openTxn={setTxnId} />}

                {page === "expenses" && <Register an={an} win={win} filter={filter} setFilter={setFilter} openTxn={setTxnId} />}

                {page === "money" && sub === "revenue" && <RevenueView an={an} cs={calState} setCs={setCalState} mk={calMonth} revenue={revenue} />}
                {page === "money" && sub === "cash" && <CashPlanView an={an} cal={calendar} cs={calState} setCs={setCalState} mk={calMonth} revenue={revenue} />}
                {page === "money" && sub === "budget" && <BudgetView an={an} win={win} period={per} budgets={budgets} setBudgets={setBudgets} calState={calState} />}

                {page === "analysis" && sub === "drill" && <DrillDown an={an} win={win} path={drillPath} setPath={setDrillPath} openTxn={setTxnId} />}
                {page === "analysis" && sub === "compare" && <MonthCompare an={an} win={win} period={per} openTxn={setTxnId} />}
                {page === "analysis" && sub === "recipients" && <RecipientsView an={an} win={win} openTxn={setTxnId} />}
                {page === "analysis" && sub === "trend" && <TrendView an={an} win={win} period={per} />}
                {page === "analysis" && sub === "connectivity" && <AdvantaView an={an} win={win} openTxn={setTxnId} goDrill={goDrill} />}
                {page === "analysis" && sub === "recurring" && <RecurringView an={an} win={win} />}

                {page === "reports" && <Reports an={an} ctx={ctx} period={per} />}

                {page === "review" && sub === "review" && <ReviewQueue an={an} win={win} openTxn={setTxnId} />}
                {page === "review" && sub === "control" && <PaymentControl an={an} win={win} />}
                {page === "review" && sub === "health" && <DataHealth an={an} rawCount={raw.length} importLog={importLog} clearAll={clearAll} />}
              </>
            )}
          </main>
        </div>
      </div>

      {txn && <TxnDrawer key={txn.id} rec={txn} override={overrides[txn.id]} onSave={saveOverride} onClose={() => setTxnId(null)} reviewer={reviewer} setReviewer={setReviewer} />}
      {askOpen && <AskPanel an={an} ctx={ctx} onClose={() => setAskOpen(false)} openTxn={(id) => { setAskOpen(false); setTxnId(id); }} />}
    </div>
  );
}

// Exported for the public demo wrapper (main.jsx) so it can load sample data the way the import does.
export { K, rowMonth, isUtilityStatement, parseUtilityStatement };
