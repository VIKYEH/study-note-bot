# 智慧課堂筆記與待辦小秘書 (Study Note Bot)

> **期中專題核心理念**：結合雲端 24 小時接收服務與本機輕量大模型（SLM），打造專屬個人的「上課隨手記、考前秒複習」雙軌學習助理。

---

## 🌟 專題特色與解決問題

在大學日常課堂中，學生經常遇到兩大痛點：
1. **筆記零散難以統整**：隨手拍的簡報照片或草稿常淹沒在相簿中，期末找不到重點。
2. **考前複習缺乏互動檢索**：想不起某個觀念在第幾週教過，翻閱數百頁簡報耗時費力。

**本專題提供「1+2 雙向整合」解決方案**：
- **存筆記（雲端隨手記）**：在手機 LINE 輸入「`筆記 ...`」或直接拍照，雲端 Gemini 自動萃取課程核心概念，同步歸檔至 Google 試算表並備份至電腦本地知識庫。
- **問筆記（本地秒複習）**：考前向機器人發問「`複習 機器學習三要素是什麼？`」，透過 Cloudflare 安全通道呼叫本機輕量模型（Gemma 4），在純 CPU 環境下完成全文檢索（RAG）並標註筆記出處秒回手機！
- **日常行程排程**：自動識別作業繳交或會議時間，自動排入 Google 日曆與待辦試算表。

---

## 🏗️ 系統架構圖

```text
[ 手機 LINE 使用者 ]
       │
       ▼
[ LINE 官方伺服器 (Webhook) ]
       │
       ▼
[ Google Apps Script 雲端處理核心 (/exec) ]
  ├── 1. 待辦事項 / 日曆排程 ──> 寫入試算表 & Google Calendar
  ├── 2. 存筆記 (文字/拍照) ──> 萃取重點 ──> 寫入試算表「課堂筆記本」──(同步推送)──┐
  │                                                                            │
  └── 3. 考前複習 / 問筆記 ──(安全通道轉發)────────────────────────────┐       │
                                                                       │       │
                                                                       ▼       ▼
                                                   [ 個人電腦 本地端轉接站 (Node.js) ]
                                                                       │
                                                   ┌───────────────────┴───────────────────┐
                                                   ▼                                       ▼
                                      [ 本地筆記資料庫 (notes/) ]              [ Ollama 本地模型 (Gemma 4) ]
                                         (純本機檢索、隱私保護)                     (純 CPU 推論、零 API 成本)
```

---

## 🛠️ 環境安裝與準備

### 1. 本地端環境需求
- **Node.js LTS**（執行轉接站小程式）：
  ```powershell
  winget install --id OpenJS.NodeJS.LTS -e --silent
  ```
- **Ollama 本機模型引擎**（下載指定輕量模型）：
  ```powershell
  winget install --id Ollama.Ollama -e --silent
  ollama pull gemma4:e2b
  ```
- **Cloudflare 安全穿透通道**：
  ```powershell
  winget install --id Cloudflare.cloudflared -e
  ```

---

## 🚀 執行與部署指南

### 步驟一：啟動本機筆記轉接站
進到專案資料夾啟動轉接站：
```powershell
node line-search-relay.mjs
```
啟動後終端機會印出：
- 通道網址：`SEARCH_RELAY_URL`（例如 `https://xxxx.trycloudflare.com`）
- 通關金鑰：`SEARCH_RELAY_KEY`（存於 `~/.line-search-relay.key`）
- 本地筆記目錄位置：`notes/`

---

### 步驟二：設定 Google Apps Script
1. 開啟 Google 試算表，進入「擴充功能」→「Apps Script」。
2. 將專案中的 `Code.gs` 與 `appsscript.json` 複製貼上。
3. 進入「專案設定」→「指令碼屬性」，新增以下環境變數：
   - `LINE_CHANNEL_ACCESS_TOKEN`：LINE Developers 發放的長效通行碼
   - `GEMINI_API_KEY`：Google AI Studio API Key
   - `GEMINI_MODEL`：`gemini-3.5-flash-lite`
   - `SEARCH_RELAY_URL`：本機轉接站產生的 Cloudflare 通道網址
   - `SEARCH_RELAY_KEY`：轉接站通關密碼
4. 點選「部署」→「管理部署作業」→ 選擇「新版本」，權限設定為「所有人」，取得 `/exec` 網址。
5. 前往 LINE Developers 後台更新 Webhook URL 並啟用。

---

## 📱 實測示範（90秒 展示流程）

1. **存筆記展示**：
   - 手機傳送：`筆記 機器學習三要素是資料、模型與損失函數`
   - 機器人回覆：`📝 筆記已成功儲存！`，試算表自動新增一列。
2. **問筆記展示**：
   - 手機傳送：`複習 什麼是機器學習三要素？`
   - 本地模型推論並秒回：`🔎 根據《01_機器學習基礎》筆記：機器學習三要素包含資料（Data）、模型（Model）與損失函數（Loss Function）...（本地模型推論：8 秒）`

---

## 🔒 資訊安全說明
- 本專案嚴格遵守資安原則，所有 LINE 通行碼、Gemini 金鑰、轉接站密碼與雲端 `/exec` 網址皆存放於 Google Script Properties，絕不寫死於原始碼中。
- 本地筆記檢索完全於本機 CPU 進行推論，個人隱私資料不外洩。
