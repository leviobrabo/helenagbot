const { MessageModel, ChatModel, UserModel } = require("../database");
const { bot } = require("../bot");
const CronJob = require("cron").CronJob;
const { setTimeout: delay } = require("timers/promises");
const palavrasProibidas = require("./palavrasproibida.json");
const { audioList, photoList } = require("../config/media");
const { adsterra } = require("../config/ads");
const {
  queueLow,
  setGlobal429,
  waitForGlobal429,
  setCampaignRunning,
  clearCampaignRunning,
  touchCampaignRunning,
  isCampaignRunning,
  getCampaignName,
} = require("../queue");

require("./errors.js");

const groupId = process.env.groupId;
const logMsgId = parseInt(process.env.LOG_MSG_ID) || null;
const channelStatusId = process.env.channelStatusId;
const growthLogChatId = process.env.GROWTH_LOG_CHAT_ID || "-1001962261893";
const growthLogThreadId = parseInt(process.env.GROWTH_LOG_THREAD_ID || "112375", 10);

const REPLY_MAX_SIZE = 50;
const PIX_DONATION_KEY = process.env.PIX_DONATION_KEY || "32dc79d2-2868-4ef0-a277-2c10725341d4";
const DONATION_MONTHLY_LIMIT = 800;
const PAID_BROADCAST_ENABLED = process.env.TELEGRAM_PAID_BROADCAST === "true";

let crashCount = 0;
let lastCrashTime = 0;
const CRASH_LIMIT = 5;
const CRASH_WINDOW = 60000;

function checkCrashLoop() {
  const now = Date.now();
  if (now - lastCrashTime > CRASH_WINDOW) crashCount = 0;
  crashCount++;
  lastCrashTime = now;
  if (crashCount >= CRASH_LIMIT) {
    console.error(`[CRASH-LOOP] ${crashCount} crashes em ${CRASH_WINDOW / 1000}s — parando para evitar loop.`);
    process.exit(2);
  }
}

process.on("uncaughtException", (err) => {
  const msg = err?.message ?? String(err);
  if (msg.includes("ETELEGRAM") || msg.includes("polling") || msg.includes("Conflict")) return;
  checkCrashLoop();
});

process.on("unhandledRejection", (reason) => {
  const msg = reason?.message ?? String(reason);
  const code = reason?.response?.body?.error_code;
  if (code === 429 || msg.includes("ETELEGRAM") || msg.includes("polling")) return;
  checkCrashLoop();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

const devSet = new Set(
  (process.env.DEV_USERS || "").split(",").map(s => s.trim()).filter(Boolean)
);

function is_dev(user_id) {
  return devSet.has(user_id.toString());
}

async function loadDevsFromDB() {
  try {
    const dbDevs = await UserModel.find({ is_dev: true }).lean().select("user_id");
    dbDevs.forEach(d => devSet.add(d.user_id.toString()));
    console.log(`[DEVS] ${devSet.size} dev(s) carregados (env + DB).`);
  } catch (err) {
    console.warn("[DEVS] Erro ao carregar devs do banco:", err.message);
  }
}

const forbiddenWords = palavrasProibidas.palavras_proibidas;

function containsUrl(text) {
    if (typeof text !== "string") return false;
    return /\b(?:https?:\/\/|www\.)\S+\.(?:[a-z]{2,})(?:\S*)?\b/gi.test(text);
}

function hasForbiddenWord(text) {
    if (typeof text !== "string") return false;
    const lower = text.toLowerCase();
    return forbiddenWords.some((w) => lower.includes(w.toLowerCase()));
}

function timeFormatter(seconds) {
    const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const s = String(Math.floor(seconds % 60)).padStart(2, "0");
    return `${h}:${m}:${s}`;
}

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function percent(part, total) {
  if (!total) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function normalizeLangCode(langCode = "unknown") {
  const normalized = String(langCode || "unknown")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 16);
  return normalized || "unknown";
}

function interfaceLang(langCode = "unknown") {
  const normalized = normalizeLangCode(langCode);
  if (normalized === "pt-br" || normalized === "pt" || normalized.startsWith("pt-")) return "pt-br";
  if (normalized === "es" || normalized.startsWith("es-")) return "es";
  return "en";
}

const I18N = {
  "pt-br": {
    startDev: (name) => `Ola, <b>${name}</b>! Voce e um dos desenvolvedores.\n\nVoce esta no painel da Helana. Use os comandos com responsabilidade.`,
    startUser: (name) => `Ola, <b>${name}</b>!\n\nEu sou <b>Helana</b>, um bot que responde mensagens, audios e figurinhas da galera.\n\n<b>Novidades do bot:</b> <a href="https://t.me/lbrabo">@lbrabo</a>\n<b>Cursos:</b> <a href="https://t.me/cursobroff">@cursobroff</a>`,
    addGroup: "Adicionar ao grupo",
    channel: "Canal",
    support: "Suporte",
    devCommands: "Comandos do Dev",
    currentLang: (lang) => `Idioma atual: <code>${lang}</code>\nUse: <code>/lang pt-br</code>`,
    currentGroupLang: (lang) => `Idioma do grupo: <code>${lang}</code>\nUse: <code>/lang pt-br</code>`,
    langSet: (lang) => `Idioma definido para <code>${lang}</code>.`,
    groupLangSet: (lang) => `Idioma do grupo definido para <code>${lang}</code>.`,
    groupLangAdminOnly: "Apenas admins do grupo podem alterar o idioma.",
    replyToDelete: "Responda a uma mensagem para deletar do banco.",
    messageNotFound: "Mensagem nao encontrada no banco de dados.",
    deleted: (name, id) => `Deletado por <a href="tg://user?id=${id}">${name}</a>.\n\nTodas as respostas associadas foram apagadas.`,
    devOnly: "Este comando e apenas para desenvolvedores.",
    privateOnly: "Use este comando no PV com o bot.",
    unauthorized: "Voce nao esta autorizado.",
  },
  es: {
    startDev: (name) => `Hola, <b>${name}</b>. Eres uno de los desarrolladores.\n\nEstas en el panel de Helana. Usa los comandos con responsabilidad.`,
    startUser: (name) => `Hola, <b>${name}</b>.\n\nSoy <b>Helana</b>, un bot que responde mensajes, audios y stickers.\n\n<b>Novedades del bot:</b> <a href="https://t.me/lbrabo">@lbrabo</a>\n<b>Cursos:</b> <a href="https://t.me/cursobroff">@cursobroff</a>`,
    addGroup: "Agregar al grupo",
    channel: "Canal",
    support: "Soporte",
    devCommands: "Comandos dev",
    currentLang: (lang) => `Idioma actual: <code>${lang}</code>\nUsa: <code>/lang es</code>`,
    currentGroupLang: (lang) => `Idioma del grupo: <code>${lang}</code>\nUsa: <code>/lang es</code>`,
    langSet: (lang) => `Idioma definido como <code>${lang}</code>.`,
    groupLangSet: (lang) => `Idioma del grupo definido como <code>${lang}</code>.`,
    groupLangAdminOnly: "Solo los admins del grupo pueden cambiar el idioma.",
    replyToDelete: "Responde a un mensaje para borrarlo de la base de datos.",
    messageNotFound: "Mensaje no encontrado en la base de datos.",
    deleted: (name, id) => `Borrado por <a href="tg://user?id=${id}">${name}</a>.\n\nTodas las respuestas asociadas fueron eliminadas.`,
    devOnly: "Este comando es solo para desarrolladores.",
    privateOnly: "Usa este comando en privado con el bot.",
    unauthorized: "No tienes autorizacion.",
  },
  en: {
    startDev: (name) => `Hi, <b>${name}</b>. You are one of the developers.\n\nYou are in Helana's panel. Use the commands responsibly.`,
    startUser: (name) => `Hi, <b>${name}</b>.\n\nI am <b>Helana</b>, a bot that replies to messages, audio and stickers.\n\n<b>Bot updates:</b> <a href="https://t.me/lbrabo">@lbrabo</a>\n<b>Courses:</b> <a href="https://t.me/cursobroff">@cursobroff</a>`,
    addGroup: "Add to group",
    channel: "Channel",
    support: "Support",
    devCommands: "Dev commands",
    currentLang: (lang) => `Current language: <code>${lang}</code>\nUse: <code>/lang en</code>`,
    currentGroupLang: (lang) => `Group language: <code>${lang}</code>\nUse: <code>/lang en</code>`,
    langSet: (lang) => `Language set to <code>${lang}</code>.`,
    groupLangSet: (lang) => `Group language set to <code>${lang}</code>.`,
    groupLangAdminOnly: "Only group admins can change the language.",
    replyToDelete: "Reply to a message to delete it from the database.",
    messageNotFound: "Message not found in the database.",
    deleted: (name, id) => `Deleted by <a href="tg://user?id=${id}">${name}</a>.\n\nAll associated replies were removed.`,
    devOnly: "This command is only for developers.",
    privateOnly: "Use this command in a private chat with the bot.",
    unauthorized: "You are not authorized.",
  },
};

function t(message, key, ...args) {
  const dict = I18N[interfaceLang(message.from?.language_code)] || I18N.en;
  const value = dict[key] ?? I18N.en[key];
  return typeof value === "function" ? value(...args) : value;
}

function isPtBr(langCode) {
  const normalized = normalizeLangCode(langCode);
  return normalized === "pt-br" || normalized === "pt_br" || normalized === "pt" || normalized.startsWith("pt-");
}

function parseStartSource(text = "") {
  const parts = String(text).trim().split(/\s+/);
  const source = parts[1] || "direct";
  return source.replace(/[^\w:.-]/g, "").slice(0, 64) || "direct";
}

function botTag() {
  return BOT_ID ? "#helenagbot" : "#helenagbot";
}

function growthLogOptions() {
  return {
    parse_mode: "HTML",
    ...(growthLogThreadId && { message_thread_id: growthLogThreadId }),
  };
}

function sendGrowthLog(text) {
  if (!growthLogChatId) return;
  bot.sendMessage(growthLogChatId, text, growthLogOptions()).catch((err) => {
    console.warn("[GROWTH-LOG-WARN]", err.message);
  });
}

function extractEmojiEntities(entities) {
  if (!Array.isArray(entities)) return [];
  return entities
    .filter((e) => e.type === "custom_emoji" && e.custom_emoji_id)
    .map((e) => ({
      offset: e.offset,
      length: e.length || 2,
      custom_emoji_id: e.custom_emoji_id,
    }));
}

function buildReplyItem(message) {
  if (message.sticker) {
    return { type: "sticker", value: message.sticker.file_id, emoji_entities: [] };
  }
  const emojiEntities = extractEmojiEntities(message.entities);
  const text = message.text || "";
  if (emojiEntities.length > 0) {
    return { type: "custom_emoji", value: text, emoji_entities: emojiEntities };
  }
  return { type: "text", value: text, emoji_entities: [] };
}

function compactEmojiEntities(emojiEntities) {
  if (!Array.isArray(emojiEntities) || !emojiEntities.length) return undefined;
  return emojiEntities.map((e) => ({
    o: e.offset,
    l: e.length || 2,
    i: e.custom_emoji_id,
  }));
}

function expandEmojiEntities(emojiEntities) {
  if (!Array.isArray(emojiEntities) || !emojiEntities.length) return [];
  return emojiEntities.map((e) => ({
    offset: e.offset ?? e.o,
    length: e.length ?? e.l ?? 2,
    custom_emoji_id: e.custom_emoji_id ?? e.i,
  })).filter((e) => e.custom_emoji_id);
}

function toStoredReplyItem(item) {
  if (!item || !item.value) return null;
  const stored = { v: item.value };
  if (item.type === "sticker") stored.t = 1;
  if (item.type === "custom_emoji") {
    stored.t = 2;
    const compactEntities = compactEmojiEntities(item.emoji_entities);
    if (compactEntities) stored.e = compactEntities;
  }
  return stored;
}

function buildMessageKey(message) {
  if (message.sticker) return message.sticker.file_unique_id;
  return message.text || "";
}

function buildEntitiesFromStored(emojiEntities) {
  if (!emojiEntities || !emojiEntities.length) return undefined;
  return expandEmojiEntities(emojiEntities).map((e) => ({
    offset: e.offset,
    length: e.length,
    type: "custom_emoji",
    custom_emoji_id: e.custom_emoji_id,
  }));
}

function normalizeReplyItem(raw) {
  // Converte subdocument Mongoose para objeto puro (expõe propriedades internas)
  const item = (raw && typeof raw.toObject === "function") ? raw.toObject() : raw;
  if (!item) return null;

  if (typeof item === "string" || item instanceof String) {
    const isStickerFileId = /^[A-Za-z0-9_-]{30,}$/.test(item);
    return { type: isStickerFileId ? "sticker" : "text", value: item, emoji_entities: [] };
  }
  // Formato antigo: string espalhada em índices numéricos {"0":"H","1":"i",...}
  if (!item.value && item["0"] !== undefined) {
    let i = 0, chars = [];
    while (item[String(i)] !== undefined) { chars.push(item[String(i)]); i++; }
    const str = chars.join("");
    const isStickerFileId = /^[A-Za-z0-9_-]{30,}$/.test(str);
    return { type: isStickerFileId ? "sticker" : "text", value: str, emoji_entities: [] };
  }
  if (item.v) {
    const type = item.t === 1 ? "sticker" : item.t === 2 ? "custom_emoji" : "text";
    return { type, value: item.v, emoji_entities: expandEmojiEntities(item.e) };
  }
  if (item.custom_emoji_ids && !item.emoji_entities) {
    item.emoji_entities = [];
  }
  if (!item.emoji_entities) item.emoji_entities = [];
  return item;
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks.length ? chunks : [[]];
}

// ─── retry mechanism ─────────────────────────────────────────────────────────

async function retryWithBackoff(fn, maxRetries = 3, delayMs = 1000) {
  let lastError = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await waitForGlobal429();
      return await fn();
    } catch (error) {
      lastError = error;
      const errorCode = error?.response?.body?.error_code;
      if (errorCode === 429) {
        const retryAfter = error?.response?.body?.parameters?.retry_after || 5;
        setGlobal429(retryAfter);
        await waitForGlobal429();
        if (i === maxRetries - 1) throw error;
        continue;
      }
      if (i === maxRetries - 1) throw error;
      await delay(delayMs * Math.pow(2, i));
    }
  }
  throw lastError || new Error("retryWithBackoff exhausted");
}

function safeSendMessage(chatId, text, options = {}) {
  return retryWithBackoff(async () => {
    return await bot.sendMessage(chatId, text, {
      ...options,
      parse_mode: options.parse_mode || "HTML"
    });
  });
}

function safeSendAudio(chatId, audioUrl, options = {}) {
  return retryWithBackoff(async () => {
    return await bot.sendVoice(chatId, audioUrl, options);
  });
}

function safeSendPhoto(chatId, photoUrl, options = {}) {
  return retryWithBackoff(async () => {
    return await bot.sendPhoto(chatId, photoUrl, options);
  });
}

function safeCopyMessage(chatId, fromChatId, messageId, options = {}) {
  return retryWithBackoff(async () => {
    return await bot.copyMessage(chatId, fromChatId, messageId, options);
  });
}

function campaignSendOptions(options = {}) {
  return PAID_BROADCAST_ENABLED
    ? { ...options, allow_paid_broadcast: true }
    : options;
}

function telegramErrorDescription(err) {
  return err?.response?.body?.description || err?.message || "";
}

function isUnreachableUserError(err) {
  const code = err?.response?.body?.error_code;
  const desc = telegramErrorDescription(err);
  if (code === 403) return true;
  return code === 400 && /chat not found|bot can't initiate|user is deactivated|user not found|blocked by user/i.test(desc);
}

function isInactiveGroupError(err) {
  const code = err?.response?.body?.error_code;
  const desc = telegramErrorDescription(err);
  return code === 403 || (code === 400 && /chat not found|group is deactivated|not enough rights|bot was kicked/i.test(desc));
}

async function removeUnreachableUser(userId, err) {
  if (!isUnreachableUserError(err)) return false;
  await UserModel.deleteOne({ user_id: userId }).catch(() => {});
  console.log(`[USERS] Removido ${userId} - ${telegramErrorDescription(err) || "inalcancavel"}`);
  return true;
}

async function removeInactiveGroup(chatId, err) {
  if (!isInactiveGroupError(err)) return false;
  await bot.leaveChat(chatId).catch(() => {});
  await ChatModel.deleteOne({ chatId }).catch(() => {});
  console.log(`[GROUPS] Removido ${chatId} - ${telegramErrorDescription(err) || "inativo"}`);
  return true;
}

function queuedSendMessage(chatId, text, options = {}) {
  return queueLow(() => safeSendMessage(chatId, text, campaignSendOptions(options)), 1);
}

function queuedCopyMessage(chatId, fromChatId, messageId) {
  return queueLow(() => safeCopyMessage(chatId, fromChatId, messageId, campaignSendOptions()), 1);
}

const CAMPAIGN_USER_BATCH_SIZE = Number(process.env.CAMPAIGN_USER_BATCH_SIZE || 30);
const CAMPAIGN_USER_BATCH_PAUSE_MS = Number(process.env.CAMPAIGN_USER_BATCH_PAUSE_MS || 1100);
const CAMPAIGN_GROUP_DELAY_MS = Number(process.env.CAMPAIGN_GROUP_DELAY_MS || 3300);
const CAMPAIGN_PROGRESS_MIN_MS = Number(process.env.CAMPAIGN_PROGRESS_MIN_MS || 30000);

function formatEta(processed, total, startedAt) {
  if (!processed || !total) return "calculando";
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, total - processed);
  return timeFormatter(Math.round((elapsed / processed) * remaining / 1000));
}

function defaultProgressText(title, stats) {
  const pct = stats.total ? Math.round((stats.processed / stats.total) * 100) : 100;
  return (
    `<b>${title}</b>\n\n` +
    `Progresso: <code>${pct}%</code> (${stats.processed}/${stats.total})\n` +
    `OK: <code>${stats.success}</code>\n` +
    `Removidos: <code>${stats.removed}</code>\n` +
    `Falhas: <code>${stats.failed}</code>\n` +
    `Velocidade: <code>${stats.rate.toFixed(2)}/s</code>\n` +
    `ETA: <code>${stats.eta}</code>`
  );
}

function defaultDoneText(title, stats) {
  return (
    `<b>${title}</b>\n\n` +
    `Total: <code>${stats.total}</code>\n` +
    `OK: <code>${stats.success}</code>\n` +
    `Removidos: <code>${stats.removed}</code>\n` +
    `Falhas: <code>${stats.failed}</code>`
  );
}

async function editCampaignStatus(sentMsg, text) {
  return bot.editMessageText(text, {
    chat_id: sentMsg.chat.id,
    message_id: sentMsg.message_id,
    parse_mode: "HTML",
  }).catch(() => {});
}

async function runCampaign({
  msg,
  name,
  kind,
  startText,
  targets,
  sendTarget,
  cleanupTarget,
  markSuccess,
  progressTitle,
  doneTitle,
  logPrefix,
}) {
  if (isCampaignRunning()) {
    return bot.sendMessage(msg.chat.id, `Campanha "${getCampaignName()}" em andamento. Aguarde terminar.`, { parse_mode: "HTML" });
  }

  if (!setCampaignRunning(name)) {
    return bot.sendMessage(msg.chat.id, "Outra campanha em andamento. Aguarde.", { parse_mode: "HTML" });
  }

  const sentMsg = await bot.sendMessage(msg.chat.id, startText, { parse_mode: "HTML" });
  const total = targets.length;
  const startedAt = Date.now();
  let lastProgressAt = 0;
  const stats = { total, processed: 0, success: 0, removed: 0, failed: 0, rate: 0, eta: "calculando" };

  console.log(`[${logPrefix}] Iniciando campanha para ${total} destino(s)`);

  try {
    if (!total) {
      await editCampaignStatus(sentMsg, defaultDoneText(doneTitle, stats));
      return stats;
    }

    async function processTarget(target) {
      try {
        await sendTarget(target);
        stats.success++;
        if (markSuccess) await markSuccess(target).catch(() => {});
      } catch (err) {
        if (await cleanupTarget(target, err)) {
          stats.removed++;
        } else {
          stats.failed++;
          console.warn(`[${logPrefix}] Falha em ${target.user_id || target.chatId}: ${telegramErrorDescription(err)}`);
        }
      }

      stats.processed++;
      stats.rate = stats.processed / Math.max(1, (Date.now() - startedAt) / 1000);
      stats.eta = formatEta(stats.processed, stats.total, startedAt);
      touchCampaignRunning();
    }

    async function maybeUpdateProgress() {
      const now = Date.now();
      if (stats.processed === stats.total || now - lastProgressAt >= CAMPAIGN_PROGRESS_MIN_MS) {
        lastProgressAt = now;
        await editCampaignStatus(sentMsg, defaultProgressText(progressTitle, stats));
      }
    }

    if (kind === "user") {
      for (let i = 0; i < targets.length; i += CAMPAIGN_USER_BATCH_SIZE) {
        const batch = targets.slice(i, i + CAMPAIGN_USER_BATCH_SIZE);
        await Promise.all(batch.map(processTarget));
        await maybeUpdateProgress();
        if (stats.processed < stats.total) {
          await delay(CAMPAIGN_USER_BATCH_PAUSE_MS);
        }
      }
    } else {
      for (const target of targets) {
        await processTarget(target);
        await maybeUpdateProgress();
        if (stats.processed < stats.total) {
          await delay(CAMPAIGN_GROUP_DELAY_MS);
        }
      }
    }

    console.log(`[${logPrefix}] Concluido: OK ${stats.success}/${total} | removidos ${stats.removed} | falhas ${stats.failed}`);
    await editCampaignStatus(sentMsg, defaultDoneText(doneTitle, stats));
    return stats;
  } finally {
    clearCampaignRunning();
  }
}

let BOT_ID = null;
async function getBotId() {
    if (!BOT_ID) {
        const me = await bot.getMe();
        BOT_ID = me.id;
    }
    return BOT_ID;
}

// ─── pagination ───────────────────────────────────────────────────────────────

// key: `${type}:${userId}` → { pages, currentPage }
const paginationState = new Map();

function cleanPaginationState() {
  const now = Date.now();
  const TTL = 10 * 60 * 1000;
  for (const [key, val] of paginationState) {
    if (now - val.createdAt > TTL) paginationState.delete(key);
  }
}

setInterval(cleanPaginationState, 10 * 60 * 1000).unref();

function buildNavMarkup(type, page, total) {
    const buttons = [];
    if (page > 0) {
        buttons.push({ text: "◀️ Anterior", callback_data: `${type}:${page - 1}` });
    }
    buttons.push({ text: `${page + 1}/${total}`, callback_data: "noop" });
    if (page < total - 1) {
        buttons.push({ text: "Próximo ▶️", callback_data: `${type}:${page + 1}` });
    }
    return { reply_markup: { inline_keyboard: [buttons] }, parse_mode: "HTML" };
}

async function sendPaginated(chatId, userId, type, pages) {
    const sent = await bot.sendMessage(chatId, pages[0], buildNavMarkup(type, 0, pages.length));
    paginationState.set(`${type}:${userId}`, { pages, currentPage: 0, msgId: sent.message_id, createdAt: Date.now() });
}

// ─── learning system ──────────────────────────────────────────────────────────

function isGroupMessage(message) {
  return message.chat.type === "group" || message.chat.type === "supergroup";
}

async function getLearningLang(message, savedGroup = null) {
  if (isGroupMessage(message)) {
    const group = savedGroup || await ensureGroupSaved(message);
    if (!group) return null;
    const groupLang = normalizeLangCode(group.lang_code);
    if (groupLang !== "unknown") return groupLang;
    return normalizeLangCode(inferGroupLangCode(message));
  }
  const user = message.from?.id
    ? await UserModel.findOne({ user_id: message.from.id }).lean().select("lang_code")
    : null;
  return normalizeLangCode(user?.lang_code || message.from?.language_code);
}

async function deleteMessageIfExists(repliedMessage, replyValue, langCode) {
  const lang = normalizeLangCode(langCode);
  const found = await MessageModel.findOne({
    l: lang,
    $or: [{ m: repliedMessage }, { "r.v": replyValue }],
  });
  if (found) await MessageModel.deleteOne({ _id: found._id });
}

async function createMessageAndAddReply(message, langCode) {
  const repliedMessage = message.reply_to_message
    ? buildMessageKey(message.reply_to_message)
    : null;
  const replyItem = buildReplyItem(message);
  const storedReplyItem = toStoredReplyItem(replyItem);
  const lang = normalizeLangCode(langCode);

  if (!repliedMessage || !replyItem.value || !storedReplyItem || !lang) return;
  if (/^[\/.!]/.test(repliedMessage) || (/^[\/.!]/.test(replyItem.value) && replyItem.type === "text")) return;
  if (containsUrl(repliedMessage) || (replyItem.type === "text" && containsUrl(replyItem.value))) {
    await deleteMessageIfExists(repliedMessage, replyItem.value, lang);
    return;
  }
  if (hasForbiddenWord(repliedMessage) || (replyItem.type === "text" && hasForbiddenWord(replyItem.value))) {
    await deleteMessageIfExists(repliedMessage, replyItem.value, lang);
    return;
  }

  await new MessageModel({ l: lang, m: repliedMessage, r: [storedReplyItem] }).save().catch(() => {});
}

async function addReply(message) {
  const group = isGroupMessage(message) ? await ensureGroupSaved(message) : null;
  if (isGroupMessage(message) && !group) return;
  const lang = await getLearningLang(message, group);
  if (!lang) return;
  const repliedMessage = message.reply_to_message
    ? buildMessageKey(message.reply_to_message)
    : null;
  const replyItem = buildReplyItem(message);
  const storedReplyItem = toStoredReplyItem(replyItem);

  if (!repliedMessage || !replyItem.value || !storedReplyItem) return;
  if (/^[\/.!]/.test(repliedMessage)) return;
  if (containsUrl(repliedMessage) || (replyItem.type === "text" && containsUrl(replyItem.value))) {
    await deleteMessageIfExists(repliedMessage, replyItem.value, lang);
    return;
  }
  if (hasForbiddenWord(repliedMessage) || (replyItem.type === "text" && hasForbiddenWord(replyItem.value))) {
    await deleteMessageIfExists(repliedMessage, replyItem.value, lang);
    return;
  }

  const exists = await MessageModel.exists({ l: lang, m: repliedMessage });
  if (exists) {
    await MessageModel.findOneAndUpdate(
      { l: lang, m: repliedMessage },
      { $push: { r: { $each: [storedReplyItem], $slice: REPLY_MAX_SIZE } } }
    );
  } else {
    await createMessageAndAddReply(message, lang);
  }
}

// ─── answer user ──────────────────────────────────────────────────────────────

async function answerUser(message) {
  const received = buildMessageKey(message);
  const chatId = message.chat.id;
  const isGroup = isGroupMessage(message);
  let group = null;

  if (isGroup) {
    group = await ensureGroupSaved(message);
    if (!group) return;
  }
  const lang = await getLearningLang(message, group);
  if (!lang) return;

  try {
    if (/^[\/.!]/.test(received)) return;

    const sendOpts = { reply_to_message_id: message.message_id };

    const audioMatch = audioList.find((a) => received === a.keyword);
    if (audioMatch) {
      await bot.sendChatAction(chatId, "record_audio").catch(() => {});
      await Promise.race([
        safeSendAudio(chatId, audioMatch.audioUrl, sendOpts),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000)),
      ]).catch((e) => console.warn("[AUDIO-WARN]", e.message));
      return;
    }

    const photoMatch = photoList.find((p) => received === p.keyword);
    if (photoMatch) {
      await bot.sendChatAction(chatId, "upload_photo").catch(() => {});
      await Promise.race([
        safeSendPhoto(chatId, photoMatch.photoUrl, sendOpts),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000)),
      ]).catch((e) => console.warn("[PHOTO-WARN]", e.message));
      return;
    }

    const doc = await MessageModel.findOne({ l: lang, m: received });
    const replies = doc?.r || doc?.reply || [];
    if (doc && replies.length) {
      const validReplies = replies
        .map(normalizeReplyItem)
        .filter((r) => r && r.value);
      if (!validReplies.length) {
        return;
      }
      const replyItem = randomItem(validReplies);

      const typingTime = Math.min(Math.max(50 * replyItem.value.length, 200), 6000);
      await bot.sendChatAction(chatId, "typing").catch(() => {});
      await delay(typingTime);

      if (replyItem.type === "sticker") {
        await bot.sendSticker(chatId, replyItem.value, sendOpts).catch((err) => {
          console.warn("[STICKER-WARN]", err.message);
          return bot.sendSticker(chatId, replyItem.value).catch((e) => console.warn("[STICKER-FALLBACK]", e.message));
        });
      } else if (replyItem.type === "custom_emoji" && replyItem.emoji_entities?.length > 0) {
        await bot.sendMessage(chatId, replyItem.value, {
          ...sendOpts,
          disable_web_page_preview: true,
          entities: buildEntitiesFromStored(replyItem.emoji_entities),
        }).catch(async (err) => {
          console.warn("[EMOJI-WARN]", err.message);
          await bot.sendMessage(chatId, replyItem.value, {
            disable_web_page_preview: true,
          }).catch((e) => console.warn("[EMOJI-FALLBACK]", e.message));
        });
      } else {
        await bot.sendMessage(chatId, replyItem.value, {
          ...sendOpts,
          disable_web_page_preview: true,
        }).catch(async (err) => {
          console.warn("[TEXT-WARN]", err.message);
          await bot.sendMessage(chatId, replyItem.value, {
            disable_web_page_preview: true,
          }).catch((e) => console.warn("[TEXT-FALLBACK]", e.message));
        });
      }
    }
  } catch (error) {
    const code = error?.response?.body?.error_code;
    if (error.message?.includes("CHAT_WRITE_FORBIDDEN") || code === 403) {
      await bot.leaveChat(chatId).catch(() => {});
      await ChatModel.deleteOne({ chatId }).catch(() => {});
    }
  }
}

// ─── main message handler ─────────────────────────────────────────────────────

async function main(message) {
    try {
        const replyTo = message?.reply_to_message ?? false;
        const botId = await getBotId();

        if (message.chat.type === "private") {
            await ensureUserSaved(message);
            if (message.sticker || message.text) {
              await trackUserAction(message, replyTo ? "reply" : "message").catch(() => {});
            }
        }

        if (message.sticker || message.text) {
            if (replyTo && replyTo.from?.id !== botId) await addReply(message).catch(() => {});
            if (!replyTo || replyTo.from?.id === botId) await answerUser(message);
        }
    } catch (err) {
        console.error("[MAIN-ERROR]", err.message);
    }
}

// ─── user / group registration ────────────────────────────────────────────────

function saveUserInformation(message) {
  ensureUserSaved(message).catch(() => {});
}

async function trackUserAction(message, actionType) {
  const user = message.from;
  if (!user || user.is_bot) return;

  const now = new Date();
  const setIfFirst = {};
  const existing = await UserModel.findOne({ user_id: user.id })
    .lean()
    .select("first_action_at funnel.first_message_at funnel.first_reply_at");

  if (!existing?.first_action_at) {
    setIfFirst.first_action_at = now;
    setIfFirst.first_action_type = actionType;
  }
  if (!existing?.funnel?.first_message_at) {
    setIfFirst["funnel.first_message_at"] = now;
  }
  if (actionType === "reply" && !existing?.funnel?.first_reply_at) {
    setIfFirst["funnel.first_reply_at"] = now;
  }

  await UserModel.updateOne(
    { user_id: user.id },
    {
      $inc: { message_count: 1 },
      $set: { last_seen_at: now, ...setIfFirst },
      $addToSet: { activity_days: dayKey(now) },
    }
  ).catch(() => {});
}

async function saveNewChatMembers(msg) {
  const chatId = msg.chat.id;
  const chatName = msg.chat.title;
  const chatType = msg.chat.type || "unknown";
  const langCode = inferGroupLangCode(msg);

  try {
    const existing = await ChatModel.exists({ chatId });
    const chat = await ChatModel.findOneAndUpdate(
      { chatId },
      {
        $setOnInsert: {
          is_ban: false,
          lang_code: langCode,
          created_at: new Date(),
          first_seen_at: new Date(),
        },
        $set: {
          chatName: chatName || `Group-${chatId}`,
          chat_type: chatType,
          last_seen_at: new Date(),
        },
        $addToSet: { activity_days: dayKey() },
      },
      { upsert: true, new: true }
    );

    if (chat.is_ban) {
      await bot.leaveChat(chatId);
      return;
    }

    const botId = await getBotId();
    const addedNow = msg.new_chat_members?.some((m) => m.id === botId);
    const chatLink = msg.chat.username ? `@${msg.chat.username}` : "Private Group";

    if (addedNow) {
      const notif =
        `${botTag()} #New_Group\n` +
        `<b>Group:</b> ${escapeHtml(chat.chatName)}\n` +
        `<b>ID:</b> <code>${chatId}</code>\n` +
        `<b>Type:</b> <code>${escapeHtml(chatType)}</code>\n` +
        `<b>Link:</b> ${escapeHtml(chatLink)}`;
      sendGrowthLog(notif);

      bot.sendMessage(
        chatId,
        "Olá, me chamo Toguro! Obrigado por me adicionar ao grupo. Vou responder as mensagens da galera aqui kkkkk.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📣 Canal Oficial", url: "https://t.me/lbrabo" },
                { text: "🐛 Relate Bugs", url: "https://t.me/kylorensbot" },
              ],
            ],
          },
        }
      ).catch(() => {});
    }

    if (!existing && !addedNow) {
      sendGrowthLog(
        `${botTag()} #New_Group\n` +
        `<b>Group:</b> ${escapeHtml(chat.chatName)}\n` +
        `<b>ID:</b> <code>${chatId}</code>\n` +
        `<b>Type:</b> <code>${escapeHtml(chatType)}</code>\n` +
        `<b>Link:</b> ${escapeHtml(chatLink)}`
      );
    }

    const devMembers = msg.new_chat_members?.filter((m) => !m.is_bot && is_dev(m.id));
    if (devMembers?.length) {
      bot.sendMessage(
        chatId,
        `👨‍💻 <b>Um dos meus desenvolvedores entrou no grupo:</b> <a href="tg://user?id=${devMembers[0].id}">${devMembers[0].first_name}</a> 😎`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    }
  } catch (err) {
    console.error(`[CHAT-SAVE-FATAL] Erro fatal ao salvar grupo:`, err.message);
  }
}

async function removeLeftChatMember(msg) {
    if (!msg.left_chat_member) return;
    const botId = await getBotId();
    if (msg.left_chat_member.id !== botId) return;
    const chatId = msg.chat.id;
    const chat = await ChatModel.findOne({ chatId });
    if (!chat || chat.is_ban) return;
    await ChatModel.findOneAndDelete({ chatId }).catch(() => {});
}

// ─── ensure user/group are saved ──────────────────────────────────────────────

async function ensureUserSaved(message, options = {}) {
  const user = message.from;
  if (!user || user.is_bot) return false;

  const langCode = normalizeLangCode(user.language_code);
  const now = new Date();
  const source = options.source || "direct";

  try {
    const existing = await UserModel.findOne({ user_id: user.id }).lean().select("lang_manual");
    const setFields = {
      username: user.username,
      firstname: user.first_name || "unknown",
      lastname: user.last_name,
      last_seen_at: now,
    };
    if (!existing?.lang_manual) setFields.lang_code = langCode;
    if (source !== "direct" && existing) setFields.start_source = source;

    const result = await UserModel.findOneAndUpdate(
      { user_id: user.id },
      {
        $setOnInsert: {
          user_id: user.id,
          is_dev: false,
          created_at: now,
          first_seen_at: now,
          start_source: source,
          "funnel.entered_at": now,
        },
        $set: setFields,
        $addToSet: { activity_days: dayKey(now) },
      },
      { upsert: true, new: true }
    );
    if (!existing) {
      const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ") || "unknown";
      const username = user.username ? `@${user.username}` : "sem username";
      sendGrowthLog(
        `${botTag()} #New_User\n` +
        `<b>User:</b> ${escapeHtml(fullName)}\n` +
        `<b>ID:</b> <code>${user.id}</code>\n` +
        `<b>Username:</b> ${escapeHtml(username)}\n` +
        `<b>Source:</b> <code>${escapeHtml(source)}</code>\n` +
        `<b>Lang:</b> <code>${escapeHtml(langCode)}</code>`
      );
    }
    if (result._id) return true;
    return false;
  } catch (err) {
    console.error(`[ENSURE-USER-ERROR] Falha ao salvar usuário ${user.id}:`, err.message);
    return false;
  }
}

function inferGroupLangCode(msg) {
  if (msg.from && msg.from.language_code) return normalizeLangCode(msg.from.language_code);
  const members = msg.new_chat_members;
  if (Array.isArray(members) && members.length > 0) {
    const codes = members.map(m => m.language_code).filter(Boolean);
    if (codes.length > 0) return normalizeLangCode(codes[0]);
  }
  return "unknown";
}

async function ensureGroupSaved(msg) {
  const chatId = msg.chat.id;
  const chatName = msg.chat.title || msg.chat.username || `Group-${chatId}`;
  const chatType = msg.chat.type || "unknown";
  const langCode = inferGroupLangCode(msg);

  try {
    const existing = await ChatModel.exists({ chatId });
    const result = await ChatModel.findOneAndUpdate(
      { chatId },
      {
        $setOnInsert: {
          is_ban: false,
          lang_code: langCode,
          created_at: new Date(),
          first_seen_at: new Date(),
        },
        $set: { chatName, chat_type: chatType, last_seen_at: new Date() },
        $addToSet: { activity_days: dayKey() },
      },
      { upsert: true, new: true }
    );

    if (result.is_ban) return false;

    if (langCode !== "unknown" && result.lang_code === "unknown") {
      await ChatModel.updateOne({ chatId }, { $set: { lang_code: langCode } }).catch(() => {});
    }

    if (!existing) {
      const chatLink = msg.chat.username ? `@${msg.chat.username}` : "Private Group";
      sendGrowthLog(
        `${botTag()} #New_Group\n` +
        `<b>Group:</b> ${escapeHtml(chatName)}\n` +
        `<b>ID:</b> <code>${chatId}</code>\n` +
        `<b>Type:</b> <code>${escapeHtml(chatType)}</code>\n` +
        `<b>Link:</b> ${escapeHtml(chatLink)}`
      );
    }

    return result;
  } catch (err) {
    console.error(`[ENSURE-GROUP-ERROR] Falha ao salvar grupo ${chatId}:`, err.message);
    return false;
  }
}


// ─── /start ───────────────────────────────────────────────────────────────────

async function start(message) {
    if (message.chat.type !== "private") return;
    
    // Garantir que usuário seja salvo
    await ensureUserSaved(message, { source: parseStartSource(message.text) });
    
    const userId = message.from.id;
    const firstName = escapeHtml(message.from.first_name || "user");
    const devText = t(message, "startDev", firstName);
    const userText = t(message, "startUser", firstName);

    if (is_dev(userId)) {
        await bot.sendMessage(userId, devText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "Github", url: "https://github.com/leviobrabo/helenegbot" }],
                    [
                        { text: t(message, "channel"), url: "https://t.me/lbrabo" },
                        { text: t(message, "support"), url: "https://t.me/kylorensbot" },
                    ],
                    [{ text: t(message, "devCommands"), callback_data: "dev_commands" }],
                ],
            },
        }).catch(() => {});
    } else {
        await bot.sendMessage(message.chat.id, userText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [
                    [{ text: t(message, "addGroup"), url: "https://t.me/helenagbot?startgroup=true" }],
                    [
                        { text: t(message, "channel"), url: "https://t.me/lbrabo" },
                        { text: t(message, "support"), url: "https://t.me/kylorensbot" },
                    ],
                    [{ text: "Github", url: "https://github.com/leviobrabo/helanagbot" }],
                ],
            },
        }).catch(() => {});
    }
}

// ─── /stats ───────────────────────────────────────────────────────────────────

async function stats(message) {
  if (!is_dev(message.from.id)) return;
  await ensureUserSaved(message);

  const [numUsers, numChats, numMessages, usersByLang, groupsByLang, groupsByType] = await Promise.all([
    UserModel.countDocuments(),
    ChatModel.countDocuments({ is_ban: false }),
    MessageModel.countDocuments(),
    UserModel.aggregate([
      { $group: { _id: "$lang_code", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    ChatModel.aggregate([
      { $match: { is_ban: false } },
      { $group: { _id: "$lang_code", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    ChatModel.aggregate([
      { $match: { is_ban: false } },
      { $group: { _id: "$chat_type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);

  const pages = [];

  const typeBreakdown = groupsByType.map(({ _id, count }) => `${_id || "unknown"}: ${count}`).join(" | ");

  pages.push(
    `📊 <b>Estatísticas — Toguro</b>\n\n` +
    `👥 <b>Usuários:</b> <code>${numUsers}</code>\n` +
    `🏘 <b>Grupos ativos:</b> <code>${numChats}</code>\n` +
    `📋 <b>Tipos:</b> <code>${typeBreakdown}</code>\n` +
    `💬 <b>Mensagens aprendidas:</b> <code>${numMessages}</code>\n\n` +
    `📅 <b>Última atualização:</b> <code>${new Date().toLocaleString('pt-BR')}</code>`
  );

  const usersLangText = `👥 <b>Usuários por idioma</b>\n\n`;
  const groupsLangText = `🏘 <b>Grupos por idioma</b>\n\n`;

  let usersLangDetail = usersLangText;
  let groupsLangDetail = groupsLangText;

  for (const { _id, count } of usersByLang) {
    usersLangDetail += `🌐 <code>${_id || "unknown"}</code> — <b>${count}</b> usuário(s)\n`;
  }

  for (const { _id, count } of groupsByLang) {
    groupsLangDetail += `🌐 <code>${_id || "unknown"}</code> — <b>${count}</b> grupo(s)\n`;
  }

  pages.push(usersLangDetail);
  pages.push(groupsLangDetail);

  const memUsage = process.memoryUsage();
  const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const memTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);

  const perfText = `⚡ <b>Performance</b>\n\n` +
    `💾 <b>Memória:</b> <code>${memUsedMB}</code>MB / <code>${memTotalMB}</code>MB\n` +
    `🕒 <b>Uptime:</b> <code>${timeFormatter(process.uptime())}</code>\n` +
    `🔄 <b>Status:</b> <code>Online</code>`;

  pages.push(perfText);

  await sendPaginated(message.chat.id, message.from.id, "stats", pages);
}

// ─── /grupos ──────────────────────────────────────────────────────────────────

async function groups(message) {
    if (!is_dev(message.from.id)) return;
    if (message.chat.type !== "private") return;
    await ensureUserSaved(message);

    const chats = await ChatModel.find({ is_ban: false }).sort({ chatId: 1 });
    if (!chats.length) {
        return bot.sendMessage(message.chat.id, "Nenhum grupo ativo encontrado.");
    }

  const chunks = chunkArray(chats, 20);
  const pages = chunks.map((chunk, i) => {
    let text =
      `🏘 <b>Grupos ativos</b> — Total: <code>${chats.length}</code>\n` +
      `<i>Página ${i + 1}/${chunks.length}</i>\n\n`;
    chunk.forEach((chat, idx) => {
      text += `<b>${i * 20 + idx + 1}.</b> ${chat.chatName}\n`;
      text += ` ├ ID: <code>${chat.chatId}</code>\n`;
      text += ` ├ Tipo: <code>${chat.chat_type || "unknown"}</code>\n`;
      text += ` └ Lang: <code>${chat.lang_code || "unknown"}</code>\n\n`;
    });
    return text;
  });

  await sendPaginated(message.chat.id, message.from.id, "grupos", pages);
}

// ─── /banned ──────────────────────────────────────────────────────────────────

async function banned(message) {
    if (message.chat.type !== "private") {
        return bot.sendMessage(message.chat.id, t(message, "privateOnly"));
    }
    if (!is_dev(message.from.id)) {
        return bot.sendMessage(message.chat.id, t(message, "unauthorized"));
    }
    await ensureUserSaved(message);

    const bannedChats = await ChatModel.find({ is_ban: true });
    if (!bannedChats.length) {
        return bot.sendMessage(message.chat.id, "Nenhum grupo banido encontrado.");
    }

    const chunks = chunkArray(bannedChats, 20);
    const pages = chunks.map((chunk, i) => {
        let text =
            `🚫 <b>Grupos banidos</b> — Total: <code>${bannedChats.length}</code>\n` +
            `<i>Página ${i + 1}/${chunks.length}</i>\n\n`;
        chunk.forEach((chat, idx) => {
            text += `<b>${i * 20 + idx + 1}.</b> ${chat.chatName}\n`;
            text += `    └ ID: <code>${chat.chatId}</code>\n\n`;
        });
        return text;
    });

    await sendPaginated(message.chat.id, message.from.id, "banned", pages);
}

// ─── /ban ─────────────────────────────────────────────────────────────────────

async function ban(message) {
    if (message.chat.type !== "private") {
        return bot.sendMessage(message.chat.id, t(message, "privateOnly"));
    }
    if (!is_dev(message.from.id)) {
        return bot.sendMessage(message.chat.id, t(message, "unauthorized"));
    }

    const rawId = message.text.split(" ")[1];
    if (!rawId || isNaN(rawId)) {
        return bot.sendMessage(message.chat.id, "Uso: /ban <chatId>");
    }

    const chatId = Number(rawId);
    const chat = await ChatModel.findOne({ chatId });
    if (!chat) return bot.sendMessage(message.chat.id, `Grupo não encontrado: ${chatId}`);
    if (chat.is_ban) return bot.sendMessage(message.chat.id, `Grupo <b>${chat.chatName}</b> já está banido.`, { parse_mode: "HTML" });

    await ChatModel.updateOne({ chatId }, { $set: { is_ban: true } });
    await bot.sendMessage(chatId, "Helana saindo do grupo!").catch(() => {});
    await bot.leaveChat(chatId).catch(() => {});
    await bot.sendMessage(message.chat.id, `✅ Grupo <b>${chat.chatName}</b> banido com sucesso.`, { parse_mode: "HTML" });

    bot.sendMessage(
        groupId,
        `#helenagbot #Banned\n<b>Group:</b> ${chat.chatName}\n<b>ID:</b> <code>${chatId}</code>`,
        { parse_mode: "HTML", ...(logMsgId && { reply_to_message_id: logMsgId }) }
    ).catch(() => {});
}

// ─── /unban ───────────────────────────────────────────────────────────────────

async function unban(message) {
    if (message.chat.type !== "private") {
        return bot.sendMessage(message.chat.id, t(message, "privateOnly"));
    }
    if (!is_dev(message.from.id)) {
        return bot.sendMessage(message.chat.id, t(message, "unauthorized"));
    }

    const rawId = message.text.split(" ")[1];
    if (!rawId || isNaN(rawId)) {
        return bot.sendMessage(message.chat.id, "Uso: /unban <chatId>");
    }

    const chatId = Number(rawId);
    const chat = await ChatModel.findOne({ chatId });
    if (!chat) return bot.sendMessage(message.chat.id, `Nenhum grupo encontrado com ID ${chatId}.`);
    if (!chat.is_ban) return bot.sendMessage(message.chat.id, `Grupo <b>${chat.chatName}</b> não está banido.`, { parse_mode: "HTML" });

    await ChatModel.updateOne({ chatId }, { $set: { is_ban: false } });
    await bot.sendMessage(message.chat.id, `✅ Grupo <b>${chat.chatName}</b> desbanido com sucesso.`, { parse_mode: "HTML" });

    bot.sendMessage(
        groupId,
        `#helenagbot #Unban\n<b>Group:</b> ${chat.chatName}\n<b>ID:</b> <code>${chatId}</code>`,
        { parse_mode: "HTML", ...(logMsgId && { reply_to_message_id: logMsgId }) }
    ).catch(() => {});
}

// ─── /delmsg ──────────────────────────────────────────────────────────────────

async function canChangeGroupLang(message) {
  if (is_dev(message.from.id)) return true;
  try {
    const admins = await bot.getChatAdministrators(message.chat.id);
    return admins.some((admin) => admin.user?.id === message.from.id);
  } catch (err) {
    console.warn("[LANG-ADMIN-WARN]", err.message);
    return false;
  }
}

async function lang(message) {
  const rawLang = message.text.split(/\s+/)[1];
  const requestedLang = rawLang ? normalizeLangCode(rawLang) : null;

  if (message.chat.type === "private") {
    await ensureUserSaved(message);
    if (!requestedLang) {
      return bot.sendMessage(message.chat.id, t(message, "currentLang", normalizeLangCode(message.from.language_code)), { parse_mode: "HTML" });
    }
    await updateUserLanguage(message.from.id, requestedLang);
    return bot.sendMessage(message.chat.id, t(message, "langSet", requestedLang), { parse_mode: "HTML" });
  }

  if (!isGroupMessage(message)) return;
  const group = await ensureGroupSaved(message);
  if (!group) return;

  if (!requestedLang) {
    return bot.sendMessage(message.chat.id, t(message, "currentGroupLang", normalizeLangCode(group.lang_code)), { parse_mode: "HTML" });
  }

  if (!await canChangeGroupLang(message)) {
    return bot.sendMessage(message.chat.id, t(message, "groupLangAdminOnly"));
  }

  await updateGroupLanguage(message.chat.id, requestedLang);
  return bot.sendMessage(message.chat.id, t(message, "groupLangSet", requestedLang), { parse_mode: "HTML" });
}

async function removeMessage(message) {
  if (!is_dev(message.from.id)) return;
  const group = isGroupMessage(message) ? await ensureGroupSaved(message) : null;
  if (isGroupMessage(message) && !group) return;
  const lang = await getLearningLang(message, group);

  const repliedMessage = message.reply_to_message
    ? buildMessageKey(message.reply_to_message)
    : null;

  if (!repliedMessage) {
    return bot.sendMessage(message.chat.id, t(message, "replyToDelete"));
  }

  const exists = await MessageModel.exists({ l: lang, m: repliedMessage });
  if (!exists) {
    return bot.sendMessage(message.chat.id, t(message, "messageNotFound"));
  }

  await MessageModel.deleteMany({
    l: lang,
    $or: [
      { m: repliedMessage },
      { "r.v": repliedMessage },
    ],
  });

  bot.sendMessage(
    message.chat.id,
    t(message, "deleted", escapeHtml(message.from.first_name || "user"), message.from.id),
    { parse_mode: "HTML", reply_to_message_id: message.message_id }
  );
}

// ─── /devs ────────────────────────────────────────────────────────────────────

async function devs(message) {
    if (!is_dev(message.from.id)) {
        return bot.sendMessage(message.chat.id, t(message, "devOnly"));
    }
    if (message.chat.type !== "private") {
        return bot.sendMessage(message.chat.id, t(message, "privateOnly"));
    }
    await ensureUserSaved(message);

    const devsData = await UserModel.find({ is_dev: true }).catch(() => []);
    let text = "<b>👨‍💻 Desenvolvedores:</b>\n\n";
    for (const user of devsData) {
        text += `• <a href="tg://user?id=${user.user_id}">${user.firstname}</a> — <code>${user.user_id}</code>\n`;
    }
    if (!devsData.length) text += "Nenhum dev cadastrado no banco.";
    bot.sendMessage(message.chat.id, text, { parse_mode: "HTML" });
}

// ─── /dbstats (diagnóstico) ────────────────────────────────────────────────────

async function dbstats(message) {
    if (!is_dev(message.from.id)) {
        return bot.sendMessage(message.chat.id, t(message, "devOnly"));
    }
    if (message.chat.type !== "private") {
        return bot.sendMessage(message.chat.id, t(message, "privateOnly"));
    }
    await ensureUserSaved(message);

    try {
        const totalUsers = await UserModel.countDocuments();
        const totalChats = await ChatModel.countDocuments();
        const totalChatsBanned = await ChatModel.countDocuments({ is_ban: true });
        const totalChatsActive = await ChatModel.countDocuments({ is_ban: false });
        const totalMessages = await MessageModel.countDocuments();

        const text = 
            `🗄 <b>Diagnóstico do Banco de Dados</b>\n\n` +
            `👥 <b>Usuários Totais:</b> <code>${totalUsers}</code>\n` +
            `🏘 <b>Grupos Totais:</b> <code>${totalChats}</code>\n` +
            `  ├─ Ativos: <code>${totalChatsActive}</code>\n` +
            `  └─ Banidos: <code>${totalChatsBanned}</code>\n` +
            `💬 <b>Mensagens Aprendidas:</b> <code>${totalMessages}</code>\n\n` +
            `📅 <code>${new Date().toLocaleString('pt-BR')}</code>`;

        bot.sendMessage(message.chat.id, text, { parse_mode: "HTML" });
    } catch (err) {
        console.error("[DBSTATS] Erro:", err.message);
        bot.sendMessage(message.chat.id, `❌ Erro ao consultar banco: ${err.message}`);
    }
}

// ─── /syncdb (forçar sincronização de usuários/grupos via Telegram) ───────────

async function syncdb(message) {
    if (!is_dev(message.from.id)) {
        return bot.sendMessage(message.chat.id, t(message, "devOnly"));
    }
    if (message.chat.type !== "private") {
        return bot.sendMessage(message.chat.id, t(message, "privateOnly"));
    }
    await ensureUserSaved(message);

    const sentMsg = await bot.sendMessage(message.chat.id, "🔄 <i>Sincronizando banco de dados...</i>", { parse_mode: "HTML" });

    try {
        const totalUsers = await UserModel.countDocuments();
        const totalGroups = await ChatModel.countDocuments();
        
        await bot.editMessageText(
            `✅ <b>Sincronização Concluída</b>\n\n` +
            `👥 <b>Usuários salvos:</b> <code>${totalUsers}</code>\n` +
            `🏘 <b>Grupos salvos:</b> <code>${totalGroups}</code>\n\n` +
            `<i>ℹ️ Novos usuários são salvos ao enviar mensagens em PV.\n` +
            `Novos grupos são salvos quando o bot recebe mensagens.</i>`,
            { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
        );
    } catch (err) {
        console.error("[SYNCDB] Erro:", err.message);
        await bot.editMessageText(
            `❌ Erro na sincronização: ${err.message}`,
            { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id }
        );
    }
}

// ─── /bc ─────────────────────────────────────────────────────────────────────

async function bc(msg) {
  if (!is_dev(msg.from.id)) return;
  if (msg.chat.type !== "private") return;
  await ensureUserSaved(msg);

  if (isCampaignRunning()) {
    return bot.sendMessage(msg.chat.id, `⚠️ Campanha "${getCampaignName()}" em andamento. Aguarde terminar.`, { parse_mode: "HTML" });
  }

  const query = msg.text.replace(/^\/bc(?:@\w+)?\s*/, "").trim();
  if (!query) {
    return bot.sendMessage(msg.chat.id, "<i>Uso: /bc [-d] &lt;texto&gt;</i>", { parse_mode: "HTML" });
  }

  const webPreview = query.startsWith("-d");
  const text = webPreview ? query.substring(2).trim() : query;
  if (!text) {
    return bot.sendMessage(msg.chat.id, "<i>Uso: /bc [-d] &lt;texto&gt;</i>", { parse_mode: "HTML" });
  }

  if (!setCampaignRunning("BC")) {
    return bot.sendMessage(msg.chat.id, "⚠️ Outra campanha em andamento. Aguarde.", { parse_mode: "HTML" });
  }

  const sentMsg = await bot.sendMessage(msg.chat.id, "<i>⏳ Enviando broadcast...</i>", { parse_mode: "HTML" });
  const ulist = await UserModel.find().lean().select("user_id");
  console.log(`[BC] Iniciando broadcast para ${ulist.length} usuários`);

  let success = 0, blocked = 0, failed = 0;
  const total = ulist.length;

  try {
    for (let i = 0; i < ulist.length; i++) {
      const { user_id } = ulist[i];
      try {
        await queuedSendMessage(user_id, text, { disable_web_page_preview: !webPreview });
        success++;
      } catch (err) {
        if (await removeUnreachableUser(user_id, err)) {
          blocked++;
        } else {
          failed++;
        }
      }
      touchCampaignRunning();

      if (i % 100 === 0 && i > 0) {
        await delay(5000);
      } else {
        await delay(1050);
      }

      if (i % 50 === 0 && i > 0) {
        const pct = Math.round(((i + 1) / total) * 100);
        await bot.editMessageText(
          `╭─❑ 「 <b>Broadcast em Progresso</b> 」 ❑\n` +
          `│ 📤 Progresso: <code>${pct}%</code>\n` +
          `│ ✅ Enviados: <code>${success}</code>\n` +
          `│ 🚫 Bloqueados: <code>${blocked}</code>\n` +
          `│ ❌ Falhas: <code>${failed}</code>\n` +
          `╰❑`,
          { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
        ).catch(() => {});
      }
    }

    console.log(`[BC] Concluído: ${success}/${total} enviados | ${blocked} bloqueados | ${failed} falhas`);

    await bot.editMessageText(
      `╭─❑ 「 <b>Broadcast Concluído</b> 」 ❑\n` +
      `│ 📤 Total: <code>${total}</code>\n` +
      `│ ✅ Enviados: <code>${success}</code>\n` +
      `│ 🚫 Bloqueados (removidos): <code>${blocked}</code>\n` +
      `│ ❌ Falhas: <code>${failed}</code>\n` +
      `╰❑`,
      { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
    );
  } finally {
    clearCampaignRunning();
  }
}

// ─── /broadcast ───────────────────────────────────────────────────────────────

async function broadcast(msg) {
  if (!is_dev(msg.from.id)) return;
  if (msg.chat.type !== "private") return;
  await ensureUserSaved(msg);

  if (isCampaignRunning()) {
    return bot.sendMessage(msg.chat.id, `⚠️ Campanha "${getCampaignName()}" em andamento. Aguarde terminar.`, { parse_mode: "HTML" });
  }

  if (!msg.reply_to_message) {
    return bot.sendMessage(msg.chat.id, "<i>Responda a uma mensagem para fazer broadcast.</i>", {
      parse_mode: "HTML",
    });
  }

  if (!setCampaignRunning("BROADCAST")) {
    return bot.sendMessage(msg.chat.id, "⚠️ Outra campanha em andamento. Aguarde.", { parse_mode: "HTML" });
  }

  const reply = msg.reply_to_message;
  const sentMsg = await bot.sendMessage(msg.chat.id, "<i>⏳ Broadcast iniciando...</i>", { parse_mode: "HTML" });
  const ulist = await UserModel.find().lean().select("user_id");
  console.log(`[BROADCAST] Iniciando broadcast para ${ulist.length} usuários`);

  let success = 0, blocked = 0, failed = 0;
  const total = ulist.length;

  try {
    for (let i = 0; i < ulist.length; i++) {
      const { user_id } = ulist[i];
      try {
        await queuedCopyMessage(user_id, msg.chat.id, reply.message_id);
        success++;
      } catch (err) {
        if (await removeUnreachableUser(user_id, err)) {
          blocked++;
        } else {
          failed++;
        }
      }
      touchCampaignRunning();

      if (i % 100 === 0 && i > 0) {
        await delay(5000);
      } else {
        await delay(1050);
      }

      if (i % 50 === 0 && i > 0) {
        const pct = Math.round(((i + 1) / total) * 100);
        await bot.editMessageText(
          `╭─❑ 「 <b>Broadcast em Progresso</b> 」 ❑\n` +
          `│ 📤 Progresso: <code>${pct}%</code>\n` +
          `│ ✅ Enviados: <code>${success}</code>\n` +
          `│ 🚫 Bloqueados: <code>${blocked}</code>\n` +
          `│ ❌ Falhas: <code>${failed}</code>\n` +
          `╰❑`,
          { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
        ).catch(() => {});
      }
    }

    console.log(`[BROADCAST] Concluído: ${success}/${total} enviados | ${blocked} bloqueados | ${failed} falhas`);

    await bot.editMessageText(
      `╭─❑ 「 <b>Broadcast Concluído</b> 」 ❑\n` +
      `│ 📤 Total: <code>${total}</code>\n` +
      `│ ✅ Enviados: <code>${success}</code>\n` +
      `│ 🚫 Bloqueados (removidos): <code>${blocked}</code>\n` +
      `│ ❌ Falhas: <code>${failed}</code>\n` +
      `╰❑`,
      { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
    );
  } finally {
    clearCampaignRunning();
  }
}

// ─── /sendgp ──────────────────────────────────────────────────────────────────

async function sendgp(msg) {
  if (!is_dev(msg.from.id)) return;
  if (msg.chat.type !== "private") return;
  await ensureUserSaved(msg);

  if (isCampaignRunning()) {
    return bot.sendMessage(msg.chat.id, `⚠️ Campanha "${getCampaignName()}" em andamento. Aguarde terminar.`, { parse_mode: "HTML" });
  }

  if (!setCampaignRunning("SENDGP")) {
    return bot.sendMessage(msg.chat.id, "⚠️ Outra campanha em andamento. Aguarde.", { parse_mode: "HTML" });
  }

  const sentMsg = await bot.sendMessage(msg.chat.id, "<i>⏳ Enviando para grupos...</i>", { parse_mode: "HTML" });
  const ulist = await ChatModel.find({ is_ban: false }).lean().select("chatId");
  console.log(`[SENDGP] Iniciando envio para ${ulist.length} grupos`);

  let success = 0, removed = 0, failed = 0;
  const total = ulist.length;

  try {
    if (msg.reply_to_message) {
      const replyMsg = msg.reply_to_message;

      for (let i = 0; i < ulist.length; i++) {
        const { chatId } = ulist[i];
        try {
          await queuedCopyMessage(chatId, replyMsg.chat.id, replyMsg.message_id);
          success++;
        } catch (err) {
          if (await removeInactiveGroup(chatId, err)) {
            removed++;
          } else {
            failed++;
          }
        }
        touchCampaignRunning();

        if (i % 50 === 0 && i > 0) {
          await delay(10000);
        } else {
          await delay(3100);
        }

        if (i % 25 === 0 && i > 0) {
          const pct = Math.round(((i + 1) / total) * 100);
          await bot.editMessageText(
            `╭─❑ 「 <b>Envio para Grupos em Progresso</b> 」 ❑\n` +
            `│ 📤 Progresso: <code>${pct}%</code>\n` +
            `│ ✅ Enviados: <code>${success}</code>\n` +
            `│ 🗑 Removidos: <code>${removed}</code>\n` +
            `│ ❌ Falhas: <code>${failed}</code>\n` +
            `╰❑`,
            { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
          ).catch(() => {});
        }
      }
    } else {
      const rawText = msg.text.replace(/^\/sendgp(?:@\w+)?\s*/, "").trim();
      const webPreview = rawText.startsWith("-d");
      const text = webPreview ? rawText.substring(2).trim() : rawText;

      if (!text) {
        await bot.editMessageText("Uso: /sendgp [-d] <texto> ou responda uma mensagem.", {
          chat_id: sentMsg.chat.id,
          message_id: sentMsg.message_id,
        });
        return;
      }

      for (let i = 0; i < ulist.length; i++) {
        const { chatId } = ulist[i];
        try {
          await queuedSendMessage(chatId, text, { disable_web_page_preview: !webPreview });
          success++;
        } catch (err) {
          if (await removeInactiveGroup(chatId, err)) {
            removed++;
          } else {
            failed++;
          }
        }
        touchCampaignRunning();

        if (i % 50 === 0 && i > 0) {
          await delay(10000);
        } else {
          await delay(3100);
        }

        if (i % 25 === 0 && i > 0) {
          const pct = Math.round(((i + 1) / total) * 100);
          await bot.editMessageText(
            `╭─❑ 「 <b>Envio para Grupos em Progresso</b> 」 ❑\n` +
            `│ 📤 Progresso: <code>${pct}%</code>\n` +
            `│ ✅ Enviados: <code>${success}</code>\n` +
            `│ 🗑 Removidos: <code>${removed}</code>\n` +
            `│ ❌ Falhas: <code>${failed}</code>\n` +
            `╰❑`,
            { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
          ).catch(() => {});
        }
      }
    }

    console.log(`[SENDGP] Concluído: ${success}/${total} enviados | ${removed} removidos | ${failed} falhas`);

    await bot.editMessageText(
      `╭─❑ 「 <b>Envio para Grupos Concluído</b> 」 ❑\n` +
      `│ 🏘 Total: <code>${total}</code>\n` +
      `│ ✅ Enviados: <code>${success}</code>\n` +
      `│ 🗑 Removidos (inativos): <code>${removed}</code>\n` +
      `│ ❌ Falhas: <code>${failed}</code>\n` +
      `╰❑`,
      { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
    );
  } finally {
    clearCampaignRunning();
  }
}

// ─── Adsterra ads (rate-limit aware) ─────────────────────────────────────────

let adDelay = 1100;
const AD_MIN_DELAY = 1050;
const AD_MAX_DELAY = 4000;

async function sendAdWithRateLimit(chatId, text, replyMarkup, isGroup) {
  await waitForGlobal429();

  try {
    await queueLow(() => safeSendMessage(chatId, text, {
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
      ...(PAID_BROADCAST_ENABLED && { allow_paid_broadcast: true }),
    }), 1);
    adDelay = Math.max(AD_MIN_DELAY, adDelay * 0.95);
    return true;
  } catch (err) {
    const code = err?.response?.body?.error_code;

    if (code === 429) {
      const retryAfter = err?.response?.body?.parameters?.retry_after || 10;
      console.warn(`[ADS] 429 rate limit — aguardando ${retryAfter}s`);
      setGlobal429(retryAfter);
      adDelay = Math.min(AD_MAX_DELAY, adDelay * 2);
      await waitForGlobal429();
      return false;
    }

    if (isGroup) {
      await removeInactiveGroup(chatId, err);
    } else {
      await removeUnreachableUser(chatId, err);
    }
    return false;
  }
}

async function sendAdsToUsers() {
  if (isCampaignRunning()) {
    console.log(`[ADS-USERS] Pulando — campanha "${getCampaignName()}" em andamento`);
    return;
  }

  if (!setCampaignRunning("ADS-USERS")) {
    console.log("[ADS-USERS] Pulando — não conseguiu lock de campanha");
    return;
  }

  try {
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const users = await UserModel.find({
      $or: [{ last_ad_sent: null }, { last_ad_sent: { $lt: cutoff } }],
    })
      .lean()
      .select("user_id")
      .limit(500);

    if (!users.length) return;

    const now = new Date();
    let success = 0, failed = 0;
    const total = users.length;

    for (let i = 0; i < users.length; i++) {
      const { user_id } = users[i];
      const link = randomItem(adsterra.links);
      const tpl = randomItem(adsterra.userTemplates);
      const replyMarkup = { inline_keyboard: [[{ text: tpl.buttonText, url: link }]] };

      const ok = await sendAdWithRateLimit(user_id, tpl.text, replyMarkup, false);
      if (ok) {
        await UserModel.updateOne({ user_id }, { $set: { last_ad_sent: now } });
        success++;
      } else {
        failed++;
      }
      touchCampaignRunning();

      await delay(adDelay);

      if (i % 100 === 0 && i > 0) {
        console.log(`[ADS-USERS] Progresso: ${i}/${total} | OK: ${success} | Fail: ${failed}`);
        await delay(5000);
      }
    }

    console.log(`[ADS-USERS] Concluído: ${success}/${total} | Falhas: ${failed}`);
  } finally {
    clearCampaignRunning();
  }
}

async function bcCampaign(msg) {
  if (!is_dev(msg.from.id)) return;
  if (msg.chat.type !== "private") return;
  await ensureUserSaved(msg);

  const query = msg.text.replace(/^\/bc(?:@\w+)?\s*/, "").trim();
  if (!query) {
    return bot.sendMessage(msg.chat.id, "<i>Uso: /bc [-d] &lt;texto&gt;</i>", { parse_mode: "HTML" });
  }

  const webPreview = query.startsWith("-d");
  const text = webPreview ? query.substring(2).trim() : query;
  if (!text) {
    return bot.sendMessage(msg.chat.id, "<i>Uso: /bc [-d] &lt;texto&gt;</i>", { parse_mode: "HTML" });
  }

  const users = await UserModel.find().lean().select("user_id");
  return runCampaign({
    msg,
    name: "BC",
    kind: "user",
    startText: "<i>Enviando broadcast para usuarios em blocos...</i>",
    targets: users,
    sendTarget: (user) => queuedSendMessage(user.user_id, text, { disable_web_page_preview: !webPreview }),
    cleanupTarget: (user, err) => removeUnreachableUser(user.user_id, err),
    progressTitle: "Broadcast em progresso",
    doneTitle: "Broadcast concluido",
    logPrefix: "BC",
  });
}

async function broadcastCampaign(msg) {
  if (!is_dev(msg.from.id)) return;
  if (msg.chat.type !== "private") return;
  await ensureUserSaved(msg);

  if (!msg.reply_to_message) {
    return bot.sendMessage(msg.chat.id, "<i>Responda a uma mensagem para fazer broadcast.</i>", {
      parse_mode: "HTML",
    });
  }

  const reply = msg.reply_to_message;
  const users = await UserModel.find().lean().select("user_id");
  return runCampaign({
    msg,
    name: "BROADCAST",
    kind: "user",
    startText: "<i>Broadcast iniciando em blocos...</i>",
    targets: users,
    sendTarget: (user) => queuedCopyMessage(user.user_id, msg.chat.id, reply.message_id),
    cleanupTarget: (user, err) => removeUnreachableUser(user.user_id, err),
    progressTitle: "Broadcast em progresso",
    doneTitle: "Broadcast concluido",
    logPrefix: "BROADCAST",
  });
}

async function sendgpCampaign(msg) {
  if (!is_dev(msg.from.id)) return;
  if (msg.chat.type !== "private") return;
  await ensureUserSaved(msg);

  const groups = await ChatModel.find({ is_ban: false }).lean().select("chatId");

  if (msg.reply_to_message) {
    const replyMsg = msg.reply_to_message;
    return runCampaign({
      msg,
      name: "SENDGP",
      kind: "group",
      startText: "<i>Enviando para grupos...</i>",
      targets: groups,
      sendTarget: (group) => queuedCopyMessage(group.chatId, replyMsg.chat.id, replyMsg.message_id),
      cleanupTarget: (group, err) => removeInactiveGroup(group.chatId, err),
      progressTitle: "Envio para grupos em progresso",
      doneTitle: "Envio para grupos concluido",
      logPrefix: "SENDGP",
    });
  }

  const rawText = msg.text.replace(/^\/sendgp(?:@\w+)?\s*/, "").trim();
  const webPreview = rawText.startsWith("-d");
  const text = webPreview ? rawText.substring(2).trim() : rawText;
  if (!text) {
    return bot.sendMessage(msg.chat.id, "Uso: /sendgp [-d] <texto> ou responda uma mensagem.");
  }

  return runCampaign({
    msg,
    name: "SENDGP",
    kind: "group",
    startText: "<i>Enviando para grupos...</i>",
    targets: groups,
    sendTarget: (group) => queuedSendMessage(group.chatId, text, { disable_web_page_preview: !webPreview }),
    cleanupTarget: (group, err) => removeInactiveGroup(group.chatId, err),
    progressTitle: "Envio para grupos em progresso",
    doneTitle: "Envio para grupos concluido",
    logPrefix: "SENDGP",
  });
}

function buildDonationRequest(user) {
  if (isPtBr(user.lang_code)) {
    return {
      text:
        `<b>Ajude a manter a Helana online</b>\n\n` +
        `Se o bot te ajuda ou diverte seu grupo, considere fazer uma doacao para manter o servidor rodando.\n\n` +
        `<b>PIX:</b>\n<code>${PIX_DONATION_KEY}</code>\n\n` +
        `<i>Mensagem enviada no maximo 1 vez por mes.</i>`,
      replyMarkup: undefined,
    };
  }

  return {
    text:
      `<b>Help keep Helana online</b>\n\n` +
      `If this bot helps your chats, please consider sending Telegram Stars to help maintain the server.\n\n` +
      `<i>This message is sent at most once per month.</i>`,
    replyMarkup: undefined,
  };
}

async function sendMonthlyDonationRequests() {
  if (isCampaignRunning()) {
    console.log(`[DONATION] Pulando - campanha "${getCampaignName()}" em andamento`);
    return;
  }

  if (!setCampaignRunning("DONATION")) {
    console.log("[DONATION] Pulando - nao conseguiu lock de campanha");
    return;
  }

  try {
    const currentMonth = monthKey();
    const users = await UserModel.find({
      $or: [
        { last_donation_ask_month: null },
        { last_donation_ask_month: { $ne: currentMonth } },
      ],
    })
      .lean()
      .select("user_id lang_code")
      .limit(DONATION_MONTHLY_LIMIT);

    if (!users.length) return;

    let success = 0;
    let failed = 0;
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      const donation = buildDonationRequest(user);
      const ok = await sendAdWithRateLimit(user.user_id, donation.text, donation.replyMarkup, false);
      if (ok) {
        await UserModel.updateOne(
          { user_id: user.user_id },
          { $set: { last_donation_ask_month: currentMonth } }
        ).catch(() => {});
        success++;
      } else {
        failed++;
      }
      touchCampaignRunning();

      await delay(adDelay);

      if (i % 100 === 0 && i > 0) {
        console.log(`[DONATION] Progresso: ${i}/${users.length} | OK: ${success} | Fail: ${failed}`);
        await delay(5000);
      }
    }

    console.log(`[DONATION] Concluido: ${success}/${users.length} | Falhas: ${failed}`);
  } finally {
    clearCampaignRunning();
  }
}

async function sendAdsToGroups() {
  if (isCampaignRunning()) {
    console.log(`[ADS-GROUPS] Pulando — campanha "${getCampaignName()}" em andamento`);
    return;
  }

  if (!setCampaignRunning("ADS-GROUPS")) {
    console.log("[ADS-GROUPS] Pulando — não conseguiu lock de campanha");
    return;
  }

  try {
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const groups = await ChatModel.find({
      is_ban: false,
      $or: [{ last_ad_sent: null }, { last_ad_sent: { $lt: cutoff } }],
    })
      .lean()
      .select("chatId")
      .limit(300);

    if (!groups.length) return;

    const now = new Date();
    let success = 0, failed = 0;
    const total = groups.length;
    let groupAdDelay = 3100;

    for (let i = 0; i < groups.length; i++) {
      const { chatId } = groups[i];
      const link = randomItem(adsterra.links);
      const tpl = randomItem(adsterra.groupTemplates);
      const replyMarkup = { inline_keyboard: [[{ text: tpl.buttonText, url: link }]] };

      const ok = await sendAdWithRateLimit(chatId, tpl.text, replyMarkup, true);
      if (ok) {
        await ChatModel.updateOne({ chatId }, { $set: { last_ad_sent: now } });
        success++;
      } else {
        failed++;
      }
      touchCampaignRunning();

      await delay(groupAdDelay);

      if (i % 50 === 0 && i > 0) {
        console.log(`[ADS-GROUPS] Progresso: ${i}/${total} | OK: ${success} | Fail: ${failed}`);
        await delay(10000);
      }
    }

    console.log(`[ADS-GROUPS] Concluído: ${success}/${total} | Falhas: ${failed}`);
  } finally {
    clearCampaignRunning();
  }
}

// ─── status cron ──────────────────────────────────────────────────────────────

async function sendStatus() {
    const start = new Date();
    const replied = await bot.sendMessage(channelStatusId, "Bot is ON").catch(() => null);
    if (!replied) return;
    const ping = new Date() - start;
    const numUsers = await UserModel.countDocuments();
    const numChats = await ChatModel.countDocuments({ is_ban: false });
    await bot
        .editMessageText(
            `#helenagbot #Status\n\nStatus: ON\nPing: \`${ping}ms\`\nUptime: \`${timeFormatter(process.uptime())}\`\nUsuários: \`${numUsers}\`\nGrupos: \`${numChats}\``,
            { chat_id: replied.chat.id, message_id: replied.message_id, parse_mode: "Markdown" }
        )
        .catch(() => {});
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

function sendBotOnlineMessage() {
    console.log("Helana iniciado com sucesso...");
    bot.sendMessage(groupId, "#Helana #ONLINE\n\nBot is now playing ...", {
        ...(logMsgId && { reply_to_message_id: logMsgId }),
    }).catch(() => {});
}

function sendBotOfflineMessage() {
  console.log("Helana encerrado...");
  bot.sendMessage(groupId, "#Helana #OFFLINE\n\nBot is now off ...", {
    ...(logMsgId && { reply_to_message_id: logMsgId }),
  }).catch(() => {}).finally(() => {
    setTimeout(() => process.exit(0), 1000);
  });
}

function pollingError(error) {
  const msg = error?.message ?? String(error);
  if (msg.includes("ETELEGRAM") || msg.includes("timeout") || msg.includes("Conflict")) {
    console.warn(`[POLLING-WARN] ${msg}`);
    return;
  }
  console.error("Polling error:", msg);
}

// ─── global callback_query handler ───────────────────────────────────────────

function registerCallbackHandler() {
    bot.on("callback_query", async (q) => {
        await bot.answerCallbackQuery(q.id).catch(() => {});

        const data = q.data;
        const userId = q.from.id;

        if (data === "noop") return;

        if (data === "dev_commands") {
    const commands = [
          "/stats — Estatísticas com paginação e breakdown por idioma",
          "/ban &lt;id&gt; — Bane um grupo e remove o bot",
          "/unban &lt;id&gt; — Desbane um grupo",
          "/banned — Lista de grupos banidos",
          "/grupos — Lista de grupos ativos",
          "/bc — Broadcast de texto para usuários",
          "/broadcast — Copia mensagem para todos usuários",
          "/ping — Latência e uptime",
          "/delmsg — Apaga mensagem do banco (reply)",
          "/devs — Lista de desenvolvedores",
          "/adddev &lt;id&gt; — Adiciona usuário como dev",
          "/rmdev &lt;id&gt; — Remove usuário dos devs",
          "/sendgp — Envia mensagem para todos os grupos",
          "/campaign — Verifica status da campanha atual",
        ];
            await bot
                .editMessageText("<b>🗃 Comandos do Dev:</b>\n\n" + commands.join("\n"), {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                    chat_id: q.message.chat.id,
                    message_id: q.message.message_id,
                    reply_markup: {
                        inline_keyboard: [[{ text: "⬅️ Voltar", callback_data: "back_to_start" }]],
                    },
                })
                .catch(() => {});
            return;
        }

        if (data === "back_to_start") {
            const callbackMessage = { from: q.from };
            const firstName = escapeHtml(q.from.first_name || "user");
            const devText = t(callbackMessage, "startDev", firstName);
            await bot
                .editMessageText(devText, {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                    chat_id: q.message.chat.id,
                    message_id: q.message.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "Github", url: "https://github.com/leviobrabo/helenagbot" }],
                            [
                                { text: t(callbackMessage, "channel"), url: "https://t.me/lbrabo" },
                                { text: t(callbackMessage, "support"), url: "https://t.me/kylorensbot" },
                            ],
                            [{ text: t(callbackMessage, "devCommands"), callback_data: "dev_commands" }],
                        ],
                    },
                })
                .catch(() => {});
            return;
        }

        // pagination: `type:pageNumber`
        const match = data.match(/^(stats|grupos|banned):(\d+)$/);
        if (!match) return;

        const [, type, pageStr] = match;
        const page = parseInt(pageStr, 10);
        const state = paginationState.get(`${type}:${userId}`);
        if (!state || page < 0 || page >= state.pages.length) return;

        state.currentPage = page;
        await bot
            .editMessageText(state.pages[page], {
                chat_id: q.message.chat.id,
                message_id: q.message.message_id,
                ...buildNavMarkup(type, page, state.pages.length),
            })
            .catch(() => {});
    });
}

async function updateUserLanguage(userId, langCode) {
    await UserModel.findOneAndUpdate(
        { user_id: userId },
        { $set: { lang_code: normalizeLangCode(langCode), lang_manual: true } }
    ).catch(() => {});
}

async function updateGroupLanguage(chatId, langCode) {
    await ChatModel.findOneAndUpdate(
        { chatId },
        { $set: { lang_code: normalizeLangCode(langCode), lang_manual: true } }
    ).catch(() => {});
}

async function migrateUsersLangCode() {
    // Verifica se migração está habilitada
    if (process.env.ENABLE_LANG_MIGRATION !== 'true') {
        console.log("⚠️ Migração de lang_code desabilitada. Use ENABLE_LANG_MIGRATION=true para ativar.");
        return;
    }
    
    const usersWithoutLang = await UserModel.find({ lang_code: "unknown" });
    console.log(`Migrando ${usersWithoutLang.length} usuários para adicionar lang_code...`);
    
    for (const user of usersWithoutLang) {
        try {
            const chatInfo = await bot.getChat(user.user_id);
            const langCode = chatInfo?.language_code || "unknown";
            await updateUserLanguage(user.user_id, langCode);
            console.log(`Usuário ${user.user_id} migrado: ${langCode}`);
        } catch (err) {
            console.error(`Erro ao migrar usuário ${user.user_id}:`, err.message);
        }
        await delay(50);
    }
    console.log("✅ Migração de usuários concluída!");
}

async function migrateGroupsLangCode() {
  if (process.env.ENABLE_LANG_MIGRATION !== 'true') {
    console.log("Migração de lang_code desabilitada. Use ENABLE_LANG_MIGRATION=true para ativar.");
    return;
  }

  const groupsWithoutType = await ChatModel.find({ chat_type: { $in: ["unknown", null] } });
  console.log(`Migrando ${groupsWithoutType.length} grupos para adicionar chat_type...`);

  for (const group of groupsWithoutType) {
    try {
      const chatInfo = await bot.getChat(group.chatId);
      const chatType = chatInfo?.type || "unknown";
      await ChatModel.findOneAndUpdate(
        { chatId: group.chatId },
        { $set: { chat_type: chatType } }
      ).catch(() => {});
      console.log(`Grupo ${group.chatId} chat_type: ${chatType}`);
    } catch (err) {
      console.error(`Erro ao migrar grupo ${group.chatId}:`, err.message);
    }
    await delay(50);
  }
  console.log("Migracao de chat_type dos grupos concluida!");
}

async function migrateReplyFormat() {
  console.log("[MIGRATE-REPLY] Iniciando migração (batch com cursor)...");
  let processed = 0;
  let migrated = 0;
  const batchSize = 100;
  let hasMore = true;
  let lastId = null;

  while (hasMore) {
    const query = lastId ? { _id: { $gt: lastId } } : {};
    const docs = await MessageModel.find(query)
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();

    if (!docs.length) { hasMore = false; break; }
    lastId = docs[docs.length - 1]._id;

    for (const doc of docs) {
      processed++;
      if (!Array.isArray(doc.reply) || doc.reply.length === 0) continue;
      const needsMigration = doc.reply.some(
        (item) => typeof item === "string" || item instanceof String || (item.custom_emoji_ids && !item.emoji_entities)
      );
      if (!needsMigration) continue;

      const newReply = doc.reply.map((item) => {
        if (typeof item === "string" || item instanceof String) {
          const isStickerFileId = /^[A-Za-z0-9_-]{30,}$/.test(item);
          return { type: isStickerFileId ? "sticker" : "text", value: item, emoji_entities: [] };
        }
        if (item.custom_emoji_ids && !item.emoji_entities) {
          item.emoji_entities = [];
          delete item.custom_emoji_ids;
        }
        return item;
      });

      await MessageModel.updateOne({ _id: doc._id }, { $set: { reply: newReply } }).catch(() => {});
      migrated++;
    }

    if (processed % 500 === 0) {
      console.log(`[MIGRATE-REPLY] Progresso: ${processed} processados, ${migrated} migrados`);
      await delay(100);
    }
  }

  console.log(`[MIGRATE-REPLY] Concluída: ${migrated} migrados de ${processed} total.`);
}

// ─── /adddev ──────────────────────────────────────────────────────────────────

async function adddev(message) {
  if (!is_dev(message.from.id)) return;
  if (message.chat.type !== "private") {
    return bot.sendMessage(message.chat.id, t(message, "privateOnly"));
  }

  const rawId = message.text.split(" ")[1];
  if (!rawId || isNaN(rawId)) {
    return bot.sendMessage(message.chat.id, "<i>Uso: /adddev &lt;userId&gt;</i>", { parse_mode: "HTML" });
  }

  const userId = rawId.trim();
  if (devSet.has(userId)) {
    return bot.sendMessage(message.chat.id, `Usuário <code>${userId}</code> já é dev.`, { parse_mode: "HTML" });
  }

  devSet.add(userId);
  await UserModel.findOneAndUpdate(
    { user_id: Number(userId) },
    { $set: { is_dev: true } }
  ).catch(() => {});

  bot.sendMessage(message.chat.id, `✅ <code>${userId}</code> adicionado como dev.`, { parse_mode: "HTML" });
}

// ─── /rmdev ───────────────────────────────────────────────────────────────────

async function rmdev(message) {
  if (!is_dev(message.from.id)) return;
  if (message.chat.type !== "private") {
    return bot.sendMessage(message.chat.id, t(message, "privateOnly"));
  }

  const rawId = message.text.split(" ")[1];
  if (!rawId || isNaN(rawId)) {
    return bot.sendMessage(message.chat.id, "<i>Uso: /rmdev &lt;userId&gt;</i>", { parse_mode: "HTML" });
  }

  const userId = rawId.trim();
  const isEnvDev = (process.env.DEV_USERS || "").split(",").map(s => s.trim()).includes(userId);
  if (isEnvDev) {
    return bot.sendMessage(message.chat.id, "❌ Devs definidos no .env não podem ser removidos pelo bot.", { parse_mode: "HTML" });
  }

  if (!devSet.has(userId)) {
    return bot.sendMessage(message.chat.id, `Usuário <code>${userId}</code> não é dev.`, { parse_mode: "HTML" });
  }

  devSet.delete(userId);
  await UserModel.findOneAndUpdate(
    { user_id: Number(userId) },
    { $set: { is_dev: false } }
  ).catch(() => {});

  bot.sendMessage(message.chat.id, `✅ <code>${userId}</code> removido dos devs.`, { parse_mode: "HTML" });
}

// ─── exports ──────────────────────────────────────────────────────────────────

async function productStats(message) {
  if (!is_dev(message.from.id)) return;
  await ensureUserSaved(message);

  const now = new Date();
  const today = dayKey(now);
  const wauCutoff = daysAgo(7);
  const mauCutoff = daysAgo(30);

  const [
    numUsers,
    numChats,
    numMessages,
    usersByLang,
    groupsByLang,
    groupsByType,
    dau,
    wau,
    mau,
    silentUsers,
    payingUsers,
    canceledUsers,
    revenueAgg,
    topSources,
    topUsers,
    recentUsers,
    funnelMessage,
    funnelReply,
  ] = await Promise.all([
    UserModel.countDocuments(),
    ChatModel.countDocuments({ is_ban: false }),
    MessageModel.countDocuments(),
    UserModel.aggregate([{ $group: { _id: "$lang_code", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    ChatModel.aggregate([{ $match: { is_ban: false } }, { $group: { _id: "$lang_code", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    ChatModel.aggregate([{ $match: { is_ban: false } }, { $group: { _id: "$chat_type", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    UserModel.countDocuments({ activity_days: today }),
    UserModel.countDocuments({ last_seen_at: { $gte: wauCutoff } }),
    UserModel.countDocuments({ last_seen_at: { $gte: mauCutoff } }),
    UserModel.countDocuments({ $or: [{ last_seen_at: { $lt: mauCutoff } }, { last_seen_at: null }, { last_seen_at: { $exists: false } }] }),
    UserModel.countDocuments({ is_paying: true }),
    UserModel.countDocuments({ subscription_canceled_at: { $ne: null } }),
    UserModel.aggregate([{ $group: { _id: null, revenue: { $sum: { $ifNull: ["$revenue_total", 0] } }, payments: { $sum: { $ifNull: ["$payment_count", 0] } } } }]),
    UserModel.aggregate([{ $group: { _id: { $ifNull: ["$start_source", "direct"] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 10 }]),
    UserModel.find({ message_count: { $gt: 0 } }).lean().select("user_id firstname username message_count last_seen_at").sort({ message_count: -1 }).limit(10),
    UserModel.find({ created_at: { $gte: daysAgo(35) } }).lean().select("created_at activity_days first_action_at"),
    UserModel.countDocuments({ "funnel.first_message_at": { $ne: null } }),
    UserModel.countDocuments({ "funnel.first_reply_at": { $ne: null } }),
  ]);

  const pages = [];
  const revenue = revenueAgg[0]?.revenue || 0;
  const payments = revenueAgg[0]?.payments || 0;
  const arpu = mau ? revenue / mau : 0;
  const arppu = payingUsers ? revenue / payingUsers : 0;
  const typeBreakdown = groupsByType.map(({ _id, count }) => `${_id || "unknown"}: ${count}`).join(" | ");

  pages.push(
    `<b>Estatisticas - Helana</b>\n\n` +
    `<b>Usuarios totais:</b> <code>${numUsers}</code>\n` +
    `<b>Grupos ativos:</b> <code>${numChats}</code>\n` +
    `<b>Tipos:</b> <code>${escapeHtml(typeBreakdown || "sem dados")}</code>\n` +
    `<b>Mensagens aprendidas:</b> <code>${numMessages}</code>\n\n` +
    `<b>DAU:</b> <code>${dau}</code>\n` +
    `<b>WAU:</b> <code>${wau}</code>\n` +
    `<b>MAU:</b> <code>${mau}</code>\n` +
    `<b>WAU / Total:</b> <code>${percent(wau, numUsers)}</code>\n` +
    `<b>Usuarios silenciosos 30d:</b> <code>${silentUsers}</code>\n\n` +
    `<b>Atualizacao:</b> <code>${now.toLocaleString("pt-BR")}</code>`
  );

  function retention(days) {
    const cohortDay = dayKey(daysAgo(days));
    const returnDay = dayKey(daysAgo(days - 1));
    const cohort = recentUsers.filter((u) => dayKey(new Date(u.created_at)) === cohortDay);
    const retained = cohort.filter((u) => Array.isArray(u.activity_days) && u.activity_days.includes(returnDay)).length;
    return { cohort: cohort.length, retained, rate: percent(retained, cohort.length) };
  }

  const d1 = retention(1);
  const d7 = retention(7);
  const d30 = retention(30);
  const firstActionUsers = recentUsers.filter((u) => u.created_at && u.first_action_at);
  const avgFirstActionMs = firstActionUsers.length ? firstActionUsers.reduce((sum, u) => sum + (new Date(u.first_action_at) - new Date(u.created_at)), 0) / firstActionUsers.length : 0;
  const avgFirstActionSec = Math.max(0, Math.round(avgFirstActionMs / 1000));

  pages.push(
    `<b>Retencao e engajamento</b>\n\n` +
    `<b>D1:</b> <code>${d1.rate}</code> (<code>${d1.retained}/${d1.cohort}</code>)\n` +
    `<b>D7:</b> <code>${d7.rate}</code> (<code>${d7.retained}/${d7.cohort}</code>)\n` +
    `<b>D30:</b> <code>${d30.rate}</code> (<code>${d30.retained}/${d30.cohort}</code>)\n\n` +
    `<b>Tempo medio ate 1a acao:</b> <code>${timeFormatter(avgFirstActionSec)}</code>\n` +
    `<b>Base ativa 30d:</b> <code>${percent(mau, numUsers)}</code>\n` +
    `<b>Churn aprox. 30d:</b> <code>${percent(silentUsers, numUsers)}</code>`
  );

  const sourcesText = topSources.length ? topSources.map((s, i) => `<b>${i + 1}.</b> <code>${escapeHtml(s._id || "direct")}</code> - ${s.count}`).join("\n") : "Sem dados de origem.";
  pages.push(`<b>Origem dos usuarios</b>\n\n${sourcesText}`);
  pages.push(
    `<b>Funil principal</b>\n\n` +
    `<b>Entrou:</b> <code>${numUsers}</code>\n` +
    `<b>Enviou mensagem:</b> <code>${funnelMessage}</code> (${percent(funnelMessage, numUsers)})\n` +
    `<b>Respondeu/aprendeu:</b> <code>${funnelReply}</code> (${percent(funnelReply, funnelMessage)})\n` +
    `<b>Grupos adicionados:</b> <code>${numChats}</code>\n\n` +
    `<i>Pagamentos reais aparecem quando revenue_total/payment_count forem preenchidos.</i>`
  );
  pages.push(
    `<b>Receita</b>\n\n` +
    `<b>Receita total:</b> <code>R$ ${revenue.toFixed(2)}</code>\n` +
    `<b>Pagamentos:</b> <code>${payments}</code>\n` +
    `<b>Pagantes:</b> <code>${payingUsers}</code>\n` +
    `<b>ARPU / MAU:</b> <code>R$ ${arpu.toFixed(4)}</code>\n` +
    `<b>Receita por pagante:</b> <code>R$ ${arppu.toFixed(2)}</code>\n` +
    `<b>Cancelados:</b> <code>${canceledUsers}</code>\n` +
    `<b>Churn pagante:</b> <code>${percent(canceledUsers, payingUsers + canceledUsers)}</code>`
  );

  const topUsersText = topUsers.length ? topUsers.map((u, i) => {
    const name = u.username ? `@${u.username}` : (u.firstname || u.user_id);
    return `<b>${i + 1}.</b> ${escapeHtml(name)} - <code>${u.message_count}</code> msg`;
  }).join("\n") : "Sem usuarios VIP por uso ainda.";
  pages.push(`<b>Usuarios VIP por uso</b>\n\n${topUsersText}`);

  const usersLangDetail = usersByLang.length ? usersByLang.map(({ _id, count }) => `<code>${escapeHtml(_id || "unknown")}</code> - <b>${count}</b>`).join("\n") : "Sem dados.";
  const groupsLangDetail = groupsByLang.length ? groupsByLang.map(({ _id, count }) => `<code>${escapeHtml(_id || "unknown")}</code> - <b>${count}</b>`).join("\n") : "Sem dados.";
  pages.push(`<b>Usuarios por idioma</b>\n\n${usersLangDetail}`);
  pages.push(`<b>Grupos por idioma</b>\n\n${groupsLangDetail}`);

  const memUsage = process.memoryUsage();
  pages.push(`<b>Performance</b>\n\n<b>Memoria:</b> <code>${Math.round(memUsage.heapUsed / 1024 / 1024)}</code>MB / <code>${Math.round(memUsage.heapTotal / 1024 / 1024)}</code>MB\n<b>Uptime:</b> <code>${timeFormatter(process.uptime())}</code>\n<b>Status:</b> <code>Online</code>`);

  await sendPaginated(message.chat.id, message.from.id, "stats", pages);
}

exports.initHandler = () => {
  loadDevsFromDB().catch(() => {});
  registerCallbackHandler();

  bot.on("message", main);
  bot.on("message", saveUserInformation);
  bot.on("polling_error", pollingError);
  bot.on("new_chat_members", saveNewChatMembers);
  bot.on("left_chat_member", removeLeftChatMember);

  bot.onText(/^\/start$/, start);
  bot.onText(/^\/stats$/, productStats);
  bot.onText(/^\/grupos$/, groups);
  bot.onText(/^\/ban/, ban);
  bot.onText(/^\/unban/, unban);
  bot.onText(/^\/banned/, banned);
  bot.onText(/^\/delmsg/, removeMessage);
  bot.onText(/^\/lang(?:@\w+)?(?:\s|$)/, lang);
  bot.onText(/^\/devs/, devs);
  bot.onText(/^\/dbstats/, dbstats);
  bot.onText(/^\/syncdb/, syncdb);
  bot.onText(/^\/adddev/, adddev);
  bot.onText(/^\/rmdev/, rmdev);

    bot.onText(/\/ping/, async (msg) => {
        const start = new Date();
        const replied = await bot.sendMessage(msg.chat.id, "𝚙𝚘𝚗𝚐!");
        const ms = new Date() - start;
        await bot.editMessageText(
            `𝚙𝚒𝚗𝚐: \`${ms}𝚖𝚜\`\n𝚞𝚙𝚝𝚒𝚖𝚎: \`${timeFormatter(process.uptime())}\``,
            { chat_id: replied.chat.id, message_id: replied.message_id, parse_mode: "Markdown" }
        );
    });

  bot.onText(/^\/bc\b/, bcCampaign);
  bot.onText(/^\/broadcast\b/, broadcastCampaign);
  bot.onText(/^\/sendgp/, sendgpCampaign);

  bot.onText(/^\/campaign$/, async (msg) => {
    if (!is_dev(msg.from.id)) return;
    if (isCampaignRunning()) {
      await bot.sendMessage(msg.chat.id, `⚠️ Campanha <b>"${getCampaignName()}"</b> em andamento.`, { parse_mode: "HTML" });
    } else {
      await bot.sendMessage(msg.chat.id, "✅ Nenhuma campanha em andamento.", { parse_mode: "HTML" });
    }
  });

  // Status diário às 12:02
  new CronJob("02 00 12 * * *", sendStatus, null, true, "America/Sao_Paulo");

  // Ads para usuários: 4x por dia (offset de 5min dos grupos)
  new CronJob("0 5 8 * * *", sendAdsToUsers, null, true, "America/Sao_Paulo");
  new CronJob("0 5 12 * * *", sendAdsToUsers, null, true, "America/Sao_Paulo");
  new CronJob("0 5 16 * * *", sendAdsToUsers, null, true, "America/Sao_Paulo");
  new CronJob("0 5 21 * * *", sendAdsToUsers, null, true, "America/Sao_Paulo");

  // Ads para grupos: 3x por dia (offset de 5min dos usuários)
  new CronJob("0 0 10 * * *", sendAdsToGroups, null, true, "America/Sao_Paulo");
  new CronJob("0 0 14 * * *", sendAdsToGroups, null, true, "America/Sao_Paulo");
  new CronJob("0 0 20 * * *", sendAdsToGroups, null, true, "America/Sao_Paulo");
  new CronJob("0 30 11 2 * *", sendMonthlyDonationRequests, null, true, "America/Sao_Paulo");

  // Migração de reply: dia 1 de cada mês às 03:00
  new CronJob("0 0 3 1 * *", migrateReplyFormat, null, true, "America/Sao_Paulo");

  // Monitor de memória: a cada 5min, restart graceful se > 450MB
  new CronJob("0 */5 * * * *", async () => {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    if (heapMB > 450) {
      console.warn(`[MEM] Heap ${heapMB}MB > 450MB — restart graceful...`);
      const { bot } = require("../bot");
      bot.stopPolling();
      await delay(2000);
      process.exit(0);
    }
  }, null, true, "America/Sao_Paulo");

  sendBotOnlineMessage();
};
