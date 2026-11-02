/**
 * LINE 智慧課堂筆記與待辦小秘書（期中專題整合版）
 * 核心特色：
 *   1. 「筆記 …」或拍照片：自動利用 Gemini 萃取整理課程重點，雙軌寫入試算表並自動同步存入本機筆記庫。
 *   2. 「複習 …」或「查 …」：透由 Cloudflare 通道呼叫本機端轉接站，由本地模型 (Gemma 4) 檢索上課筆記並附出處回覆。
 *   3. 一般待辦行程：自動分析日期時間，排入 Google 日曆與試算表。
 */

const PROPS = PropertiesService.getScriptProperties();
const GEMINI_API_KEY = PROPS.getProperty("GEMINI_API_KEY") || "";
const LINE_ACCESS_TOKEN = PROPS.getProperty("LINE_CHANNEL_ACCESS_TOKEN") || "";
const SHEET_ID = PROPS.getProperty("SHEET_ID") || "";
const GEMINI_MODEL = PROPS.getProperty("GEMINI_MODEL") || "gemini-3.5-flash-lite";
const SEARCH_RELAY_URL = (PROPS.getProperty("SEARCH_RELAY_URL") || "").trim().replace(/\/+$/, "");
const SEARCH_RELAY_KEY = (PROPS.getProperty("SEARCH_RELAY_KEY") || "").trim();

const REVIEW_PREFIX = /^(?:複習|查|搜尋)[\s:：]+([\s\S]+)$/;
const NOTE_PREFIX = /^(?:筆記|記筆記|重點)[\s:：]+([\s\S]+)$/;

const TZ = "Asia/Taipei";
const GREETING = /^(hi|hello|hey|你好|嗨|哈囉|安安|早安|午安|晚安|謝謝|感謝|ok|好的|掰|bye|test|測試)$/i;
const HELP_TEXT = "你好！我是你的【智慧課堂筆記與待辦小秘書】🎓\n\n你可以這樣使用：\n1. 存筆記：輸入「筆記 機器學習三要素是...」或拍黑板簡報，我會幫你整理歸檔！\n2. 考前複習：輸入「複習 什麼是機器學習三要素？」，我會翻出你的筆記重點回答你！\n3. 記待辦：輸入「明天下午三點要開會」，自動記進試算表與 Google 日曆。";

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    (body.events || []).forEach(handleEvent);
  } catch (err) {
    console.error("解析訊息失敗：", err);
  }
  return ContentService.createTextOutput("OK");
}

function doGet() {
  return ContentService.createTextOutput("智慧課堂筆記與待辦小秘書服務運作中（期中專題版）");
}

function handleEvent(event) {
  if (event.type !== "message" || !event.replyToken) return;
  try {
    const msg = event.message;
    if (msg.type === "text") {
      const text = msg.text.trim();
      if (GREETING.test(text)) return replyLine(event.replyToken, HELP_TEXT);

      // 分支 1：考前複習 / 知識庫檢索（轉交本機轉接站）
      const reviewMatch = text.match(REVIEW_PREFIX);
      if (reviewMatch) {
        showLoading(event.source, 60);
        return replyLine(event.replyToken, askLocalRelay(reviewMatch[1].trim()));
      }

      // 分支 2：新增筆記重點
      const noteMatch = text.match(NOTE_PREFIX);
      if (noteMatch) {
        showLoading(event.source);
        return saveNoteAndReply(event.replyToken, noteMatch[1].trim(), "手動輸入");
      }

      // 分支 3：一般文字待辦事項
      showLoading(event.source);
      return saveAndReply(event.replyToken, askGeminiAboutText(text), "文字");
    }

    if (msg.type === "image") {
      showLoading(event.source);
      const image = downloadLineImage(msg.id);
      const photoUrl = savePhotoToDrive(image);
      // AI 智慧判斷圖片是否為課堂簡報/筆記
      const analysis = askGeminiAboutImage(image);
      if (analysis.isNote) {
        return saveNoteAndReply(event.replyToken, analysis.noteContent, "拍照識別", photoUrl, analysis.summary);
      }
      return saveAndReply(event.replyToken, analysis, "照片", photoUrl);
    }

    replyLine(event.replyToken, "目前我支援文字訊息與筆記照片喔！");
  } catch (err) {
    console.error("處理異常：", err);
    try {
      replyLine(event.replyToken, "⚠️ 處理出錯：" + err.message);
    } catch (e) {}
  }
}

// 儲存筆記至試算表與本機轉接站
function saveNoteAndReply(replyToken, content, source, photoUrl, summary) {
  const ss = getSheet("課堂筆記本");
  const now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  const title = summary || content.slice(0, 20).replace(/[\r\n]/g, " ");
  ss.appendRow([now, title, content, source, photoUrl || ""]);

  // 同步推送至本地電腦轉接站備份
  syncNoteToLocal(title, content);

  let reply = `📝 筆記已成功儲存！\n\n📌 摘要：${title}\n📖 內容：${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`;
  if (photoUrl) reply += "\n📷 筆記照片已同步備份至 Google Drive";
  reply += "\n\n💡 提示：輸入「複習 " + title.slice(0, 6) + "」隨時考考小秘書！";
  replyLine(replyToken, reply);
}

// 同步筆記至本機轉接站
function syncNoteToLocal(title, content) {
  if (!SEARCH_RELAY_URL || !SEARCH_RELAY_KEY) return;
  try {
    UrlFetchApp.fetch(SEARCH_RELAY_URL + "/save-note", {
      method: "post",
      contentType: "application/json",
      headers: { "x-relay-key": SEARCH_RELAY_KEY },
      payload: JSON.stringify({ title, content }),
      muteHttpExceptions: true,
      timeoutSeconds: 15
    });
  } catch (e) {
    console.warn("同步至本地筆記庫失敗（本機可能未開機）：", e.message);
  }
}

// 呼叫本機轉接站問答
function askLocalRelay(question) {
  if (!SEARCH_RELAY_URL || !SEARCH_RELAY_KEY) {
    return "💡 尚未設定本地問答通道（請確認指令碼屬性 SEARCH_RELAY_URL 與 KEY）。";
  }
  let res;
  try {
    res = UrlFetchApp.fetch(SEARCH_RELAY_URL + "/ask", {
      method: "post",
      contentType: "application/json",
      headers: { "x-relay-key": SEARCH_RELAY_KEY },
      payload: JSON.stringify({ question }),
      muteHttpExceptions: true,
      timeoutSeconds: 50
    });
  } catch (err) {
    return "🔌 本機複習助教目前未上線（請確認電腦已啟動轉接站程式）。";
  }

  const code = res.getResponseCode();
  let data = {};
  try { data = JSON.parse(res.getContentText()); } catch (err) {}
  if (code === 401) return "🔒 轉接站通關金鑰不吻合，請檢查設定。";
  if (code !== 200 || !data.answer) {
    return `🔌 助教回答異常（代碼 ${code}）：${data.error || "連線逾時"}`;
  }

  let reply = "🔎 " + data.answer;
  if (data.sources && data.sources.length) {
    reply += "\n\n📚 參考筆記與出處：\n" + data.sources.map(s => "• " + (s.title || s.url)).join("\n");
  }
  return reply + `\n（本地模型推論：${data.seconds} 秒）`;
}

// 試算表存取（支援多頁籤）
function getSheet(sheetName) {
  const ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("找不到試算表");
  let sheet = ss.getSheetByName(sheetName || "待辦事項");
  if (!sheet) {
    sheet = ss.insertSheet(sheetName || "待辦事項");
    if (sheetName === "課堂筆記本") {
      sheet.appendRow(["記錄時間", "筆記主題", "詳細內容", "來源類型", "照片連結"]);
      sheet.getRange(1, 1, 1, 5).setFontWeight("bold").setBackground("#2E7D32").setFontColor("#FFFFFF");
    } else {
      sheet.appendRow(["建立時間", "事項", "分類", "日期", "時間", "來源", "日曆", "照片連結"]);
      sheet.getRange(1, 1, 1, 8).setFontWeight("bold").setBackground("#0E7C7B").setFontColor("#FFFFFF");
    }
  }
  return sheet;
}

function saveAndReply(replyToken, todo, source, photoUrl) {
  if (!todo.isTodo) return replyLine(replyToken, todo.chatReply || HELP_TEXT);
  const sheet = getSheet("待辦事項");
  const now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  sheet.appendRow([now, todo.summary, todo.category, todo.date, todo.time, source, "", photoUrl || ""]);
  const row = sheet.getLastRow();
  const wantsCalendar = todo.date !== "未指定" && todo.time !== "未指定";

  let reply = `✅ 待辦已記好（試算表第 ${row} 列）\n\n📌 ${todo.summary}\n🏷️ ${todo.category}\n📅 ${todo.date}　⏰ ${todo.time}`;
  if (wantsCalendar) {
    reply += "\n🗓️ 行程提醒已同步排入 Google 日曆";
    createCalendarEvent(todo);
  }
  replyLine(replyToken, reply);
}

function savePhotoToDrive(blob) {
  const folderName = "LINE筆記與待辦照片";
  const found = DriveApp.getFoldersByName(folderName);
  const folder = found.hasNext() ? found.next() : DriveApp.createFolder(folderName);
  const stamp = Utilities.formatDate(new Date(), TZ, "yyyyMMdd-HHmmss");
  const file = folder.createFile(blob.setName("note-" + stamp + ".jpg"));
  return file.getUrl();
}

function createCalendarEvent(todo) {
  try {
    const start = new Date(`${todo.date}T${todo.time}:00+08:00`);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    CalendarApp.getDefaultCalendar().createEvent(`【${todo.category}】${todo.summary}`, start, end, {
      description: "由 LINE 智慧課堂筆記與待辦小秘書建立"
    });
  } catch (err) {}
}

function askGeminiAboutText(text) {
  const prompt = `你是待辦事項助理。現在是台北時間 ${Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm")}。
判斷這句話是否為待辦事項或行程。只輸出單一 JSON 物件：
{"isTodo": true或false, "summary": "簡短摘要", "category": "課業/生活/會議/繳費/其他", "date": "YYYY-MM-DD或未指定", "time": "HH:mm或未指定", "chatReply": "非待辦時回覆"}
內容：${text}`;
  return callGemini([{ text: prompt }]);
}

function askGeminiAboutImage(blob) {
  const prompt = `你是課堂助理。請分析這張照片是一般待辦便條紙，還是上課簡報/課堂筆記？
只輸出單一 JSON 物件：
{
  "isNote": true或false,
  "summary": "主題簡述",
  "noteContent": "如果是筆記，詳細條列萃取關鍵內容與重點；非筆記填空字串",
  "isTodo": true或false,
  "category": "課業",
  "date": "YYYY-MM-DD或未指定",
  "time": "HH:mm或未指定",
  "chatReply": "簡短說明"
}`;
  return callGemini([
    { text: prompt },
    { inlineData: { mimeType: blob.getContentType() || "image/jpeg", data: Utilities.base64Encode(blob.getBytes()) } }
  ]);
}

function callGemini(parts) {
  if (!GEMINI_API_KEY) throw new Error("尚未設定 GEMINI_API_KEY");
  const res = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": GEMINI_API_KEY },
    payload: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json" }
    }),
    muteHttpExceptions: true
  });
  const data = JSON.parse(res.getContentText());
  const cand = (data.candidates || [])[0];
  const text = cand && cand.content && (cand.content.parts || []).map(p => p.text || "").join("");
  return JSON.parse(text.replace(/^```(json)?\s*|\s*```$/g, ""));
}

function lineApi(path, payload, host) {
  const options = {
    method: payload ? "post" : "get",
    headers: { Authorization: "Bearer " + LINE_ACCESS_TOKEN },
    muteHttpExceptions: true
  };
  if (payload) {
    options.contentType = "application/json";
    options.payload = JSON.stringify(payload);
  }
  return UrlFetchApp.fetch((host || "https://api.line.me") + path, options);
}

function replyLine(replyToken, text) {
  lineApi("/v2/bot/message/reply", {
    replyToken,
    messages: [{ type: "text", text: text.slice(0, 5000) }]
  });
}

function showLoading(source, seconds) {
  if (!source || source.type !== "user") return;
  try {
    lineApi("/v2/bot/chat/loading/start", { chatId: source.userId, loadingSeconds: seconds || 20 });
  } catch (err) {}
}

function downloadLineImage(messageId) {
  const res = lineApi(`/v2/bot/message/${messageId}/content`, null, "https://api-data.line.me");
  return res.getBlob();
}
