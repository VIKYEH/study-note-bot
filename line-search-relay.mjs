// 智慧課堂筆記問答轉接站 (Study Note Search Relay)
// 功能：提供本地端筆記知識庫全文檢索 (RAG)，並結合 Ollama 本地小模型進行精確問答，亦支援聯網即時查詢。

import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MODEL = process.env.MODEL || "gemma4:e2b";
const PORT = Number(process.env.PORT || 8787);
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const BUDGET_MS = 45000;
const MAX_ROUNDS = 4;
const KEY_FILE = process.env.RELAY_KEY_FILE || join(process.cwd(), ".relay.key");
const WANT_TUNNEL = !process.argv.includes("--no-tunnel");
const NOTES_DIR = join(process.cwd(), "notes");

function loadKey() {
  if (process.env.RELAY_KEY) return process.env.RELAY_KEY;
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, "utf8").trim();
  const key = randomBytes(18).toString("base64url");
  writeFileSync(KEY_FILE, key);
  return key;
}
const KEY = loadKey();

function today() {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "full" }).format(new Date());
}

// 讀取本地筆記資料庫
function searchLocalNotes(query) {
  if (!existsSync(NOTES_DIR)) return [];
  const files = readdirSync(NOTES_DIR).filter(f => f.endsWith(".txt") || f.endsWith(".md"));
  const keywords = query.toLowerCase().split(/\s+/).filter(k => k.length > 0);
  const matched = [];

  for (const file of files) {
    try {
      const content = readFileSync(join(NOTES_DIR, file), "utf8");
      let score = 0;
      for (const kw of keywords) {
        if (content.toLowerCase().includes(kw)) score += 1;
      }
      if (score > 0 || keywords.length === 0) {
        matched.push({ file, content: content.slice(0, 1500), score });
      }
    } catch (e) {}
  }
  matched.sort((a, b) => b.score - a.score);
  return matched.slice(0, 3);
}

// 根據查詢情境切換系統提示詞
function systemPrompt(hasNotes, notesContext) {
  if (hasNotes) {
    return `你是學生的專業「課堂筆記複習助教」。今天是 ${today()}（台北時間）。
請優先根據以下提供的【學生真實課堂筆記】內容回答問題：
=== 筆記內容開始 ===
${notesContext}
=== 筆記內容結束 ===
回答規定：
1. 請以親切清楚、先講結論的口吻回答，150 字以內，繁體中文（台灣用語）。
2. 回答務必註明是根據哪一份筆記（例如「根據《檔案名》筆記...」）。
3. 若筆記內已包含答案，直接整理說明；若筆記未提及，可輔助使用搜尋工具或說明筆記未記載。`;
  }

  return `你是 LINE 上的查詢助理。今天是 ${today()}（台北時間）。
你有 web_search 與 web_fetch 兩個工具。遇到不確定的事實先呼叫工具查詢。
回答用台灣繁體中文、純文字（不用星號或井字號），150 字以內，先講結論。`;
}

const TOOLS = [
  { type: "function", function: { name: "web_search", description: "搜尋網路，回傳前幾筆的標題、網址與內文摘要。",
    parameters: { type: "object", properties: { query: { type: "string", description: "搜尋關鍵字" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_fetch", description: "讀取一個網頁的主要文字。",
    parameters: { type: "object", properties: { url: { type: "string", description: "要讀的網址" } }, required: ["url"] } } }
];

async function ollama(path, body, signal) {
  const res = await fetch(OLLAMA + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ollama ${path} 回應 ${res.status}：${text.slice(0, 150)}`);
  return JSON.parse(text);
}

async function webSearch(query, signal, sources) {
  const data = await ollama("/api/experimental/web_search", { query, max_results: 3 }, signal);
  const rows = (data.results || []).map(r => ({ title: r.title, url: r.url, content: String(r.content || "").slice(0, 1500) }));
  rows.forEach(r => sources.push({ title: r.title, url: r.url }));
  return JSON.stringify(rows);
}

async function webFetch(url, signal, sources) {
  const data = await ollama("/api/experimental/web_fetch", { url }, signal);
  sources.unshift({ title: data.title || url, url });
  return JSON.stringify({ title: data.title, content: String(data.content || "").slice(0, 3000) });
}

async function answer(question) {
  const signal = AbortSignal.timeout(BUDGET_MS);
  const t0 = Date.now();
  
  // 1. 優先檢索本地筆記
  const localNotes = searchLocalNotes(question);
  const hasNotes = localNotes.length > 0;
  let notesContext = "";
  const noteSources = [];

  if (hasNotes) {
    notesContext = localNotes.map(n => `【出處來源：${n.file}】\n${n.content}`).join("\n\n");
    localNotes.forEach(n => noteSources.push({ title: `課堂筆記庫: ${n.file}`, url: `本機筆記://${n.file}` }));
    log(`  📚 在本機筆記中檢索到 ${localNotes.length} 篇相關重點`);
  }

  const messages = [{ role: "system", content: systemPrompt(hasNotes, notesContext) }, { role: "user", content: question }];
  const queries = [], webSources = [];
  let reply = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = await ollama("/api/chat", {
      model: MODEL, messages, tools: TOOLS, stream: false, think: false,
      keep_alive: "1h", options: { num_ctx: 16384 }
    }, signal);
    const msg = data.message || {};
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) { reply = msg.content || ""; break; }
    for (const c of calls) {
      const fn = c.function.name, args = c.function.arguments || {};
      let out;
      try {
        if (fn === "web_search") {
          log(`  🔍 模型決定搜：${args.query}`);
          queries.push(args.query);
          out = await webSearch(args.query, signal, webSources);
        } else if (fn === "web_fetch") {
          log(`  📄 模型決定讀網頁：${args.url}`);
          out = await webFetch(args.url, signal, webSources);
        } else {
          out = `ERROR: 沒有 ${fn} 這個工具`;
        }
      } catch (err) {
        if (signal.aborted) throw err;
        out = `ERROR: ${err.message}`;
      }
      messages.push({ role: "tool", tool_name: fn, content: out });
    }
  }

  if (!reply) reply = "查了幾次還整理不出答案，換個問法再試一次。";
  const allSources = [...noteSources, ...webSources];
  const seen = new Set();
  const unique = allSources.filter(s => s.url && !seen.has(s.url) && seen.add(s.url)).slice(0, 3);

  return {
    answer: reply.replace(/\*\*|__|^#+\s*|`/gm, "").trim().slice(0, 600),
    isFromNotes: hasNotes,
    searched: queries.length > 0 || unique.length > 0,
    queries, sources: unique,
    seconds: Math.round((Date.now() - t0) / 1000)
  };
}

// 接收雲端傳送的新筆記，即時儲存至本地 notes 目錄
function saveNewNote(title, content) {
  if (!existsSync(NOTES_DIR)) writeFileSync(NOTES_DIR, "");
  const safeTitle = (title || "未命名筆記").replace(/[\\/:*?"<>|]/g, "_");
  const fileName = `${new Date().toISOString().slice(0, 10)}_${safeTitle}.txt`;
  const filePath = join(NOTES_DIR, fileName);
  const text = `# 筆記標題：${safeTitle}\n記錄時間：${today()}\n\n${content}`;
  writeFileSync(filePath, text, "utf8");
  return fileName;
}

function log(s) {
  const t = new Date().toLocaleTimeString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" });
  console.log(`[${t}] ${s}`);
}

function keyMatches(given) {
  const a = Buffer.from(String(given || "")), b = Buffer.from(KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

let busy = false;

const server = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return send(res, 200, { ok: true, service: "study-note-relay", model: MODEL });
  }
  const isCheck = req.method === "GET" && path === "/check-key";
  if (!isCheck && req.method !== "POST") return send(res, 404, { error: "Not Found" });

  if (!keyMatches(req.headers["x-relay-key"])) {
    log("⛔ 密碼不正確，拒絕連線");
    return send(res, 401, { error: "密碼不對" });
  }
  if (isCheck) return send(res, 200, { ok: true, model: MODEL });

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 30000) return send(res, 413, { error: "內容過長" });
  }

  // 1. 同步新筆記端點：POST /save-note
  if (path === "/save-note") {
    try {
      const payload = JSON.parse(raw || "{}");
      const savedFile = saveNewNote(payload.title, payload.content);
      log(`📝 已將雲端新筆記存檔至本地：${savedFile}`);
      return send(res, 200, { ok: true, file: savedFile });
    } catch (err) {
      return send(res, 500, { error: err.message });
    }
  }

  // 2. 筆記問答端點：POST /ask
  if (path === "/ask") {
    let question = "";
    try { question = String(JSON.parse(raw || "{}").question || "").trim(); } catch (e) {}
    if (!question) return send(res, 400, { error: "請提供 question 欄位" });
    if (busy) return send(res, 429, { error: "助教正在回答上一題，請稍候再問" });

    busy = true;
    log(`📩 收到問題（${question.length} 字）`);
    try {
      const result = await answer(question);
      log(`✅ 回答完畢（耗時 ${result.seconds} 秒，${result.isFromNotes ? "命中本地筆記" : "一般網路查詢"}）`);
      send(res, 200, result);
    } catch (err) {
      const timeout = err.name === "TimeoutError" || err.name === "AbortError";
      log(`❌ 查詢異常：${err.message}`);
      send(res, timeout ? 504 : 502, { error: timeout ? "模型推論逾時（超過 45 秒）" : err.message });
    } finally {
      busy = false;
    }
    return;
  }

  return send(res, 404, { error: "未知的路徑" });
});

async function warmUp() {
  log(`載入本地模型 ${MODEL}…`);
  const t0 = Date.now();
  try {
    await ollama("/api/chat", { model: MODEL, messages: [], keep_alive: "1h", options: { num_ctx: 16384 } }, AbortSignal.timeout(300000));
    log(`✅ 模型已載入就緒（${Math.round((Date.now() - t0) / 1000)} 秒）`);
    return true;
  } catch (err) {
    log(`⚠️ 模型啟動失敗：${err.message}`);
    return false;
  }
}

function hasCloudflared() {
  try { execFileSync("cloudflared", ["--version"], { stdio: "ignore" }); return true; } catch (e) { return false; }
}

function startTunnel() {
  if (!hasCloudflared()) {
    log("⚠️ 找不到 cloudflared，僅能本機測試。");
    return;
  }
  log("正在開啟 Cloudflare 安全穿透通道…");
  const cf = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  let shown = false, tail = "";
  const watch = buf => {
    tail = (tail + String(buf)).slice(-4000);
    const m = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !shown) {
      shown = true;
      try { execFileSync("clip", { input: KEY }); } catch (e) {}
      console.log("\n==================== 課堂筆記問答轉接站已連線 ====================");
      console.log(`  ① SEARCH_RELAY_KEY ＝ 已複製至剪貼簿（或查閱 ~/.line-search-relay.key）`);
      console.log(`  ② SEARCH_RELAY_URL ＝ ${m[0]}`);
      console.log(`  本地筆記目錄 ＝ ${NOTES_DIR}`);
      console.log("==================================================================\n");
    }
  };
  cf.stdout.on("data", watch);
  cf.stderr.on("data", watch);
  cf.on("error", err => log(`⚠️ 通道開啟錯誤：${err.message}`));
  process.on("exit", () => cf.kill());
  process.on("SIGINT", () => process.exit(0));
}

server.listen(PORT, "127.0.0.1", async () => {
  log(`筆記問答轉接站啟動於 http://127.0.0.1:${PORT}（模型 ${MODEL}）`);
  const ready = await warmUp();
  if (WANT_TUNNEL && ready) startTunnel();
});
