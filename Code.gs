/**
 * LINE 智慧大學生活與課堂全能助理（期中專題完整版）
 * 核心特色：
 *   1. 【課堂筆記本】分頁：
 *      - 存筆記：輸入「筆記 ...」或拍簡報照片，自動萃取重點存入試算表並備份本機。
 *      - 查筆記：輸入「查詢筆記 機器學習」或「筆記清單」，秒列符合的筆記列表與照片連結！
 *      - 刪筆記：輸入「刪除上一筆筆記」或「刪除筆記 關鍵字」，直接秒刪不廢話！
 *   2. 【考前秒複習】：輸入「複習 ...」，透由安全通道呼叫本機小模型 (Gemma 4) 全文檢索本地筆記並標註出處回答。
 *   3. 【收支記帳簿】分頁：
 *      - 記帳：輸入「記帳 午餐 100」或拍發票明細，自動歸類寫入同試算表。
 *      - 查帳：輸入「查帳」或「今天花了多少」秒算今日花費。
 *      - 刪記帳：輸入「刪除上一筆記帳」即刻撤回誤記。
 *   4. 【待辦事項】分頁：自然語言排程，自動分析日期時間寫入試算表並同步 Google 日曆。
 */

const PROPS = PropertiesService.getScriptProperties();
const GEMINI_API_KEY = PROPS.getProperty("GEMINI_API_KEY") || "";
const LINE_ACCESS_TOKEN = PROPS.getProperty("LINE_CHANNEL_ACCESS_TOKEN") || "";
const SHEET_ID = PROPS.getProperty("SHEET_ID") || "";
const GEMINI_MODEL = PROPS.getProperty("GEMINI_MODEL") || "gemini-3.5-flash-lite";
const SEARCH_RELAY_URL = (PROPS.getProperty("SEARCH_RELAY_URL") || "").trim().replace(/\/+$/, "");
const SEARCH_RELAY_KEY = (PROPS.getProperty("SEARCH_RELAY_KEY") || "").trim();

const REVIEW_PREFIX = /^(?:複習|考考我)[\s:：]+([\s\S]+)$/;
const SEARCH_NOTE_PREFIX = /^(?:查詢筆記|找筆記|搜尋筆記|筆記查詢|所有筆記|筆記清單|看筆記)[\s:：]*([\s\S]*)$/;
const NOTE_PREFIX = /^(?:筆記|記筆記|重點)[\s:：]+([\s\S]+)$/;
const EXPENSE_PREFIX = /^(?:記帳|花費|支出|買了|吃|喝)[\s:：]+([\s\S]+)$/;
const CHECK_EXPENSE = /^(?:查帳|今天花了多少|今日花費|總花費|記帳查詢)$/;

const TZ = "Asia/Taipei";
const GREETING = /^(hi|hello|hey|你好|嗨|哈囉|安安|早安|午安|晚安|謝謝|感謝|ok|好的|掰|bye|test|測試)$/i;
const HELP_TEXT = "你好！我是你的【智慧生活與課堂全能助理】🎓💰\n\n同一個試算表幫你管好四大生活需求：\n\n1. 📖 存筆記：「筆記 機器學習三要素是...」或拍簡報照片\n2. 📑 查筆記：「查詢筆記 機器學習」或「筆記清單」列出摘要與照片\n3. 🗑️ 刪筆記：「刪除上一筆筆記」或「刪除筆記 [關鍵字]」\n4. 🔍 考前複習：「複習 機器學習三要素是什麼？」本機模型秒回答\n5. 💸 記帳：「記帳 午餐 100」或拍發票明細（支援「刪除上一筆記帳」）\n6. 📊 查帳：「查帳」或「今天花了多少」\n7. 🗓️ 待辦：「明天下午三點要開會」自動排日曆";

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
  return ContentService.createTextOutput("全能助理運作中（筆記 ✕ 記帳 ✕ 待辦 ✕ 刪除 完整版）");
}

function handleEvent(event) {
  if (event.type !== "message" || !event.replyToken) return;
  try {
    const msg = event.message;
    if (msg.type === "text") {
      const text = msg.text.trim();
      if (GREETING.test(text)) return replyLine(event.replyToken, HELP_TEXT);

      // 分支 1：刪除筆記功能 (精準刪除，不卡死問答)
      if (/^(?:刪除最後一筆筆記|刪除上一筆筆記|刪除這則筆記|刪除筆記)$/.test(text)) {
        showLoading(event.source);
        return replyLine(event.replyToken, deleteLastRowFromSheet("課堂筆記本"));
      }
      const delNoteMatch = text.match(/^(?:刪除筆記|刪筆記)[\s:：]+([\s\S]+)$/);
      if (delNoteMatch) {
        showLoading(event.source);
        return replyLine(event.replyToken, deleteNoteByKeyword(delNoteMatch[1].trim()));
      }

      // 分支 2：刪除記帳功能
      if (/^(?:刪除最後一筆記帳|刪除上一筆記帳|刪除記帳)$/.test(text)) {
        showLoading(event.source);
        return replyLine(event.replyToken, deleteLastRowFromSheet("收支記帳簿"));
      }

      // 分支 3：考前複習 / 本機問答 (由本機 Gemma 4 推論)
      const reviewMatch = text.match(REVIEW_PREFIX);
      if (reviewMatch) {
        showLoading(event.source, 60);
        return replyLine(event.replyToken, askLocalRelay(reviewMatch[1].trim()));
      }

      // 分支 4：查詢筆記清單 (直接檢索試算表筆記本)
      const searchNoteMatch = text.match(SEARCH_NOTE_PREFIX);
      if (searchNoteMatch) {
        showLoading(event.source);
        return replyLine(event.replyToken, queryNotesFromSheet(searchNoteMatch[1].trim()));
      }

      // 分支 5：新增課堂筆記
      const noteMatch = text.match(NOTE_PREFIX);
      if (noteMatch) {
        showLoading(event.source);
        return saveNoteAndReply(event.replyToken, noteMatch[1].trim(), "手動輸入");
      }

      // 分支 6：查帳（今日消費統計）
      if (CHECK_EXPENSE.test(text)) {
        showLoading(event.source);
        return replyLine(event.replyToken, calculateTodayExpenses());
      }

      // 分支 7：記帳（支出記錄）
      const expenseMatch = text.match(EXPENSE_PREFIX);
      if (expenseMatch || /\d+元?$/.test(text)) {
        showLoading(event.source);
        const expenseContent = expenseMatch ? expenseMatch[1].trim() : text;
        const parsedExpense = askGeminiAboutExpense(expenseContent);
        if (parsedExpense.isExpense) {
          return saveExpenseAndReply(event.replyToken, parsedExpense);
        }
      }

      // 分支 8：一般待辦事項與行程
      showLoading(event.source);
      return saveAndReply(event.replyToken, askGeminiAboutText(text), "文字");
    }

    if (msg.type === "image") {
      showLoading(event.source);
      const image = downloadLineImage(msg.id);
      const photoUrl = savePhotoToDrive(image);
      // AI 智慧分析圖片
      const analysis = askGeminiAboutImage(image);
      if (analysis.type === "expense") {
        return saveExpenseAndReply(event.replyToken, analysis, photoUrl);
      } else if (analysis.type === "note") {
        return saveNoteAndReply(event.replyToken, analysis.noteContent, "拍照識別", photoUrl, analysis.summary);
      }
      return saveAndReply(event.replyToken, analysis, "照片", photoUrl);
    }

    replyLine(event.replyToken, "目前我支援文字訊息、發票照片與筆記照片喔！");
  } catch (err) {
    console.error("處理異常：", err);
    try {
      replyLine(event.replyToken, "⚠️ 處理出錯：" + err.message);
    } catch (e) {}
  }
}

// 取得同一個試算表中的指定分頁
function getSheet(sheetName) {
  const ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("找不到試算表");
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    if (sheetName === "收支記帳簿") {
      sheet.appendRow(["記帳時間", "消費項目", "金額", "分類", "付款備註", "發票照片"]);
      sheet.getRange(1, 1, 1, 6).setFontWeight("bold").setBackground("#D97706").setFontColor("#FFFFFF");
    } else if (sheetName === "課堂筆記本") {
      sheet.appendRow(["記錄時間", "筆記主題", "詳細內容", "來源類型", "照片連結"]);
      sheet.getRange(1, 1, 1, 5).setFontWeight("bold").setBackground("#2E7D32").setFontColor("#FFFFFF");
    } else {
      sheet.appendRow(["建立時間", "事項", "分類", "日期", "時間", "來源", "日曆", "照片連結"]);
      sheet.getRange(1, 1, 1, 8).setFontWeight("bold").setBackground("#0E7C7B").setFontColor("#FFFFFF");
    }
  }
  return sheet;
}

// ===== 刪除功能 =====
function deleteLastRowFromSheet(sheetName) {
  const sheet = getSheet(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return `⚠️「${sheetName}」目前沒有任何資料可供刪除喔！`;
  
  const title = sheet.getRange(lastRow, 2).getValue();
  sheet.deleteRow(lastRow);
  return `🗑️ 已成功刪除「${sheetName}」最後一筆紀錄：【${title}】！`;
}

function deleteNoteByKeyword(keyword) {
  const sheet = getSheet("課堂筆記本");
  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    const title = String(data[i][1]);
    const content = String(data[i][2]);
    if (title.includes(keyword) || content.includes(keyword)) {
      sheet.deleteRow(i + 1);
      return `🗑️ 已找到並成功刪除筆記：【${title}】！`;
    }
  }
  return `🔍 在筆記本中找不到包含「${keyword}」的筆記。`;
}

// ===== 查詢筆記功能 =====
function queryNotesFromSheet(keyword) {
  const sheet = getSheet("課堂筆記本");
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return "📚 目前「課堂筆記本」還沒有任何筆記紀錄喔！可傳「筆記 [重點]」開始記錄。";

  const kw = (keyword || "").toLowerCase().trim();
  const results = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const time = String(row[0]).slice(0, 10);
    const title = String(row[1]);
    const content = String(row[2]);
    const photo = String(row[4]);

    if (!kw || title.toLowerCase().includes(kw) || content.toLowerCase().includes(kw)) {
      results.push({ time, title, content: content.slice(0, 60), photo });
    }
  }

  if (results.length === 0) {
    return `🔍 在筆記本中沒有找到包含「${keyword}」的筆記。\n💡 建議換個關鍵字，或直接輸入「筆記清單」查看全部。`;
  }

  let reply = `📚 ${kw ? `找到 ${results.length} 筆包含「${keyword}」的課堂筆記：` : `為您列出最近的 ${Math.min(results.length, 5)} 筆筆記：`}\n`;
  const showList = results.slice(-5).reverse();
  showList.forEach((r, idx) => {
    reply += `\n${idx + 1}. 📌【${r.title}】(${r.time})\n   📖 ${r.content}${r.content.length >= 60 ? "..." : ""}`;
    if (r.photo) reply += `\n   📷 照片：${r.photo}`;
  });

  reply += `\n\n💡 想要問答複習，可直接傳：「複習 ${kw || showList[0].title.slice(0, 6)}」考考本地助教！`;
  return reply;
}

// ===== 記帳功能處理 =====
function saveExpenseAndReply(replyToken, expense, photoUrl) {
  const sheet = getSheet("收支記帳簿");
  const now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  sheet.appendRow([now, expense.item, expense.amount, expense.category, expense.note || "", photoUrl || ""]);
  const row = sheet.getLastRow();

  let reply = `💸 記帳成功！（記帳簿第 ${row} 列）\n\n🛒 品項：${expense.item}\n💵 金額：$${expense.amount} 元\n🏷️ 分類：${expense.category}`;
  if (photoUrl) reply += "\n🧾 發票照片已存入 Google Drive";
  reply += "\n\n💡 提示：輸入「今天花了多少」隨時查看累計花費！若記錯可打「刪除上一筆記帳」";
  replyLine(replyToken, reply);
}

function calculateTodayExpenses() {
  const sheet = getSheet("收支記帳簿");
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return "📊 目前「收支記帳簿」還沒有任何花費紀錄喔！";

  const todayStr = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd");
  let total = 0;
  const items = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const timeStr = String(row[0]);
    if (timeStr.startsWith(todayStr)) {
      const amount = Number(row[2]) || 0;
      total += amount;
      items.push(`• ${row[1]}：$${amount}`);
    }
  }

  if (items.length === 0) return `📊 今天（${todayStr}）還沒有記帳紀錄喔！`;
  return `📊 今日（${todayStr}）累計花費：$${total} 元\n\n今日明細：\n${items.join("\n")}`;
}

function askGeminiAboutExpense(text) {
  const prompt = `你是記帳助手。請分析使用者的支出描述，只回傳單一 JSON 物件：
{"isExpense": true或false, "item": "品項名稱", "amount": 數字純阿拉伯數字, "category": "飲食/課業/交通/娛樂/日用品/其他", "note": "備註"}
使用者說：${text}`;
  return callGemini([{ text: prompt }]);
}

// ===== 筆記功能處理 =====
function saveNoteAndReply(replyToken, content, source, photoUrl, summary) {
  const ss = getSheet("課堂筆記本");
  const now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  const title = summary || content.slice(0, 20).replace(/[\r\n]/g, " ");
  ss.appendRow([now, title, content, source, photoUrl || ""]);

  syncNoteToLocal(title, content);

  let reply = `📝 筆記已成功儲存至試算表！\n\n📌 摘要：${title}\n📖 內容：${content.slice(0, 100)}${content.length > 100 ? "..." : ""}`;
  if (photoUrl) reply += "\n📷 筆記照片已備份至 Google Drive";
  reply += "\n\n💡 提示：若想刪除可打「刪除上一筆筆記」；輸入「複習 " + title.slice(0, 6) + "」考考小秘書！";
  replyLine(replyToken, reply);
}

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
    console.warn("同步本地失敗：", e.message);
  }
}

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

// ===== 待辦功能處理 =====
function saveAndReply(replyToken, todo, source, photoUrl) {
  if (!todo.isTodo) return replyLine(replyToken, todo.chatReply || HELP_TEXT);
  const sheet = getSheet("待辦事項");
  const now = Utilities.formatDate(new Date(), TZ, "yyyy-MM-dd HH:mm:ss");
  sheet.appendRow([now, todo.summary, todo.category, todo.date, todo.time, source, "", photoUrl || ""]);
  const row = sheet.getLastRow();
  const wantsCalendar = todo.date !== "未指定" && todo.time !== "未指定";

  let reply = `✅ 待辦已記好（待辦表第 ${row} 列）\n\n📌 ${todo.summary}\n🏷️ ${todo.category}\n📅 ${todo.date}　⏰ ${todo.time}`;
  if (wantsCalendar) {
    reply += "\n🗓️ 行程提醒已同步排入 Google 日曆";
    createCalendarEvent(todo);
  }
  replyLine(replyToken, reply);
}

function savePhotoToDrive(blob) {
  const folderName = "LINE大學生活檔案夾";
  const found = DriveApp.getFoldersByName(folderName);
  const folder = found.hasNext() ? found.next() : DriveApp.createFolder(folderName);
  const stamp = Utilities.formatDate(new Date(), TZ, "yyyyMMdd-HHmmss");
  const file = folder.createFile(blob.setName("upload-" + stamp + ".jpg"));
  return file.getUrl();
}

function createCalendarEvent(todo) {
  try {
    const start = new Date(`${todo.date}T${todo.time}:00+08:00`);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    CalendarApp.getDefaultCalendar().createEvent(`【${todo.category}】${todo.summary}`, start, end, {
      description: "由 LINE 智慧大學生活與課堂全能助理建立"
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
  const prompt = `你是大學生多功能助理。分析這張圖片是：發票/收據明細、課堂簡報/黑板筆記、還是行程便條紙？
只輸出單一 JSON 物件：
{
  "type": "expense" 或 "note" 或 "todo",
  "item": "發票上的主要品項，無則空",
  "amount": 發票總金額純阿拉伯數字無則0,
  "category": "飲食/課業/交通/其他",
  "summary": "主題簡述，如果字太模糊填寫照片待補充",
  "noteContent": "如果是筆記，詳細條列核心知識點；若模糊則提示使用者照片已存請補說明",
  "isTodo": true或false,
  "date": "YYYY-MM-DD或未指定",
  "time": "HH:mm或未指定"
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
