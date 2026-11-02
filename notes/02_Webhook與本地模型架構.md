# 課程主題：雲端串接與本地小模型 (SLM) 架構
更新日期：2026-10-25
分類：AI工程應用

## 重點整理
1. Webhook 原理：
   - 不是本地端定期去向 LINE 伺服器輪詢（Polling），而是當使用者傳訊時，LINE 伺服器主動打 HTTP POST 到開發者指定的公開 HTTPS 網址。
   - Google Apps Script 部署為網頁應用程式時所取得的 /exec 網址即為永久開啟的 Webhook 接收端。

2. 本地小語言模型（SLM, Small Language Model）的優勢：
   - 隱私安全：敏感資料與專屬筆記完全保留在本機推論，不需上傳第三方商業雲端。
   - 成本零金鑰：利用 Ollama 搭配開源小模型（如 Google Gemma 4），純靠電腦 CPU 即可運作，無 API 調用費用。

3. 穿透通道（Cloudflare Tunnel）：
   - 本地轉接站運行於 127.0.0.1（內網環境），外部網路無法直接訪問。
   - 透過 Cloudflare Tunnel 建立安全的公網臨時通道，使雲端 Apps Script 能夠回調本地本機的檢索服務。
