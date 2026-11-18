const { MessageModel, ChatModel, UserModel } = require("../database");
const { bot, transport } = require("../bot");
const CronJob = require("cron").CronJob;
const { setTimeout: delay } = require("timers/promises");
const palavrasProibidas = require("./palavrasproibida.json");
const { audioList, photoList } = require("../config/media");

require("./errors.js");

const groupId = process.env.groupId;
const logMsgId = parseInt(process.env.LOG_MSG_ID) || null;
const REPLY_MAX_SIZE = 50;
const BOT_START_TIME = Math.floor(Date.now() / 1000);

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
  if (msg.includes("ETELEGRAM") || msg.includes("polling")) return;
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
    console.log(`[DEVS] ${devSet.size} dev(s) carregados.`);
  } catch (err) {
    console.warn("[DEVS] Erro ao carregar devs:", err.message);
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
    startUser: (name) => `Ola, <b>${name}</b>!\n\nEu sou <b>Helana</b>, um bot que responde mensagens.\n\n<b>Novidades:</b> <a href="https://t.me/lbrabo">@lbrabo</a>\n<b>Cursos:</b> <a href="https://t.me/cursobroff">@cursobroff</a>`,
    replyToDelete: "Responda a uma mensagem para deletar do banco.",
    messageNotFound: "Mensagem nao encontrada no banco de dados.",
    deleted: (name, id) => `Deletado por <a href="tg://user?id=${id}">${name}</a>.`,
    devOnly: "Este comando e apenas para desenvolvedores.",
    privateOnly: "Use este comando no PV com o bot.",
    unauthorized: "Voce nao esta autorizado.",
    currentLang: (lang) => `Idioma atual: <code>${lang}</code>`,
    langSet: (lang) => `Idioma definido para <code>${lang}</code>.`,
    groupLangAdminOnly: "Apenas admins podem alterar o idioma.",
  },
  es: {
    startUser: (name) => `Hola, <b>${name}</b>.\n\nSoy <b>Helana</b>, un bot que responde mensajes.\n\n<b>Novedades:</b> <a href="https://t.me/lbrabo">@lbrabo</a>\n<b>Cursos:</b> <a href="https://t.me/cursobroff">@cursobroff</a>`,
    replyToDelete: "Responde a un mensaje para borrarlo.",
    messageNotFound: "Mensaje no encontrado en la base de datos.",
    deleted: (name, id) => `Borrado por <a href="tg://user?id=${id}">${name}</a>.`,
    devOnly: "Este comando es solo para desarrolladores.",
    privateOnly: "Usa este comando en privado.",
    unauthorized: "No tienes autorizacion.",
    currentLang: (lang) => `Idioma actual: <code>${lang}</code>`,
    langSet: (lang) => `Idioma definido como <code>${lang}</code>.`,
    groupLangAdminOnly: "Solo los admins pueden cambiar el idioma.",
  },
  en: {
    startUser: (name) => `Hi, <b>${name}</b>.\n\nI am <b>Helana</b>, a bot that replies to messages.\n\n<b>Updates:</b> <a href="https://t.me/lbrabo">@lbrabo</a>\n<b>Courses:</b> <a href="https://t.me/cursobroff">@cursobroff</a>`,
    replyToDelete: "Reply to a message to delete it from the database.",
    messageNotFound: "Message not found in the database.",
    deleted: (name, id) => `Deleted by <a href="tg://user?id=${id}">${name}</a>.`,
    devOnly: "This command is only for developers.",
    privateOnly: "Use this command in a private chat with the bot.",
    unauthorized: "You are not authorized.",
    currentLang: (lang) => `Current language: <code>${lang}</code>`,
    langSet: (lang) => `Language set to <code>${lang}</code>.`,
    groupLangAdminOnly: "Only group admins can change the language.",
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
  const item = (raw && typeof raw.toObject === "function") ? raw.toObject() : raw;
  if (!item) return null;

  if (typeof item === "string" || item instanceof String) {
    const isStickerFileId = /^[A-Za-z0-9_-]{30,}$/.test(item);
    return { type: isStickerFileId ? "sticker" : "text", value: item, emoji_entities: [] };
  }

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
  if (!item.emoji_entities) item.emoji_entities = [];
  return item;
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks.length ? chunks : [[]];
}

async function safeSendMessage(chatId, text, options = {}) {
  return bot.sendMessage(chatId, text, {
    ...options,
    parse_mode: options.parse_mode || "HTML"
  });
}

function safeSendAudio(chatId, audioUrl, options = {}) {
  return bot.sendVoice(chatId, audioUrl, options);
}

function safeSendPhoto(chatId, photoUrl, options = {}) {
  return bot.sendPhoto(chatId, photoUrl, options);
}

// ─── pagination ───────────────────────────────────────────────────────────────

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
  return message.chat.type !== "private";
}

async function getLearningLang(message, group) {
  if (message.chat.type === "private") {
    return normalizeLangCode(message.from?.language_code);
  }
  if (group?.lang_code) return normalizeLangCode(group.lang_code);
  const inferredLang = inferGroupLangCode(message);
  return normalizeLangCode(inferredLang);
}

async function deleteMessageIfExists(repliedMessage, replyValue) {
  const found = await MessageModel.findOne({
    $or: [{ m: repliedMessage }, { "r.v": replyValue }],
  });
  if (found) await MessageModel.deleteOne({ _id: found._id });
}

async function createMessageAndAddReply(message, lang) {
  const repliedMessage = buildMessageKey(message.reply_to_message);
  const replyItem = buildReplyItem(message);

  if (!repliedMessage || !replyItem.value) return;
  if (/^[\/.!]/.test(repliedMessage) || (/^[\/.!]/.test(replyItem.value) && replyItem.type === "text")) return;
  if (containsUrl(repliedMessage) || (replyItem.type === "text" && containsUrl(replyItem.value))) {
    await deleteMessageIfExists(repliedMessage, replyItem.value);
    return;
  }
  if (hasForbiddenWord(repliedMessage) || (replyItem.type === "text" && hasForbiddenWord(replyItem.value))) {
    await deleteMessageIfExists(repliedMessage, replyItem.value);
    return;
  }

  const storedReplyItem = toStoredReplyItem(replyItem);
  if (!storedReplyItem) return;

  await new MessageModel({ l: lang, m: repliedMessage, r: [storedReplyItem] }).save().catch(() => {});
}

async function addReply(message) {
  const group = isGroupMessage(message) ? await ensureGroupSaved(message) : null;
  if (isGroupMessage(message) && !group) return;
  const lang = await getLearningLang(message, group);

  const repliedMessage = buildMessageKey(message.reply_to_message);
  const replyItem = buildReplyItem(message);

  if (!repliedMessage || !replyItem.value) return;
  if (/^[\/.!]/.test(repliedMessage)) return;
  if (containsUrl(repliedMessage) || (replyItem.type === "text" && containsUrl(replyItem.value))) {
    await deleteMessageIfExists(repliedMessage, replyItem.value);
    return;
  }
  if (hasForbiddenWord(repliedMessage) || (replyItem.type === "text" && hasForbiddenWord(replyItem.value))) {
    await deleteMessageIfExists(repliedMessage, replyItem.value);
    return;
  }

  const storedReplyItem = toStoredReplyItem(replyItem);
  if (!storedReplyItem) return;

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
    const replies = doc?.r || [];
    if (doc && replies.length) {
      const validReplies = replies
        .map(normalizeReplyItem)
        .filter((r) => r && r.value);
      if (!validReplies.length) return;

      const replyItem = randomItem(validReplies);
      const typingTime = Math.min(Math.max(8 * replyItem.value.length, 40), 250);
      await bot.sendChatAction(chatId, "typing").catch(() => {});
      await delay(typingTime);

      if (replyItem.type === "sticker") {
        await bot.sendSticker(chatId, replyItem.value, sendOpts).catch((err) => {
          console.warn("[STICKER-WARN]", err.message);
        });
      } else if (replyItem.type === "custom_emoji" && replyItem.emoji_entities?.length > 0) {
        await bot.sendMessage(chatId, replyItem.value, {
          ...sendOpts,
          disable_web_page_preview: true,
          entities: buildEntitiesFromStored(replyItem.emoji_entities),
        }).catch((err) => console.warn("[EMOJI-WARN]", err.message));
      } else {
        await bot.sendMessage(chatId, replyItem.value, {
          ...sendOpts,
          disable_web_page_preview: true,
        }).catch((err) => console.warn("[TEXT-WARN]", err.message));
      }
    }
  } catch (error) {
    const code = error?.response?.body?.error_code;
    if (code === 403) {
      transport.markBlocked(chatId);
      await bot.__onBlocked(chatId);
    } else {
      console.warn("[ANSWER-ERROR]", error.message);
    }
  }
}

// ─── main message handler ─────────────────────────────────────────────────────

async function main(message) {
    transport.recordIncoming();
    if (message?.chat?.type === "private" && transport.isBlocked(message.chat.id)) {
      transport.unblock(message.chat.id);
      UserModel.updateOne({ user_id: message.chat.id }, { $set: { telegram_blocked: false } }).catch(() => {});
    }
    if (message.date < BOT_START_TIME) return;
    try {
        const replyTo = message?.reply_to_message ?? false;
        const botId = await getBotId();

        if (message.chat.type === "private") {
            await ensureUserSaved(message);
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
  if (message?.chat?.type !== "private") return;
  ensureUserSaved(message).catch(() => {});
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

    if (addedNow) {
      bot.sendMessage(
        chatId,
        "Ola, me chamo Helana! Obrigado por me adicionar ao grupo.",
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
  } catch (err) {
    console.error(`[CHAT-SAVE-FATAL] Erro fatal ao salvar grupo:`, err.message);
  }
}

async function removeLeftChatMember(msg) {
    if (!msg.left_chat_member) return;
    const botId = await getBotId();
    if (msg.left_chat_member.id !== botId) return;
    await ChatModel.deleteOne({ chatId: msg.chat.id }).catch(() => {});
    console.log(`[LEAVE] Bot removido do grupo ${msg.chat.id}`);
}

// ─── persistence ──────────────────────────────────────────────────────────────

async function ensureUserSaved(message, options = {}) {
  const user = message.from;
  if (!user || user.is_bot) return;

  const upsertData = {
    $setOnInsert: {
      user_id: user.id,
      is_dev: false,
      created_at: new Date(),
      first_action_at: new Date(),
    },
    $set: {
      firstname: user.first_name || "",
      lastname: user.last_name || "",
      username: user.username || "",
      lang_code: normalizeLangCode(user.language_code),
      last_seen_at: new Date(),
    },
  };

  if (options.source) {
    upsertData.$setOnInsert.first_action_source = options.source;
  }

  return await UserModel.findOneAndUpdate({ user_id: user.id }, upsertData, { upsert: true, new: true });
}

function inferGroupLangCode(msg) {
  const chat = msg.chat;
  if (chat?.language_code) return normalizeLangCode(chat.language_code);
  if (msg.from?.language_code) return normalizeLangCode(msg.from.language_code);
  return "en";
}

async function ensureGroupSaved(message) {
  const chat = message.chat;
  const langCode = inferGroupLangCode(message);

  return await ChatModel.findOneAndUpdate(
    { chatId: chat.id },
    {
      $setOnInsert: {
        chatId: chat.id,
        is_ban: false,
        lang_code: langCode,
        created_at: new Date(),
        first_seen_at: new Date(),
      },
      $set: {
        chatName: chat.title || chat.name || `Group-${chat.id}`,
        chat_type: chat.type,
        last_seen_at: new Date(),
      },
      $addToSet: { activity_days: dayKey() },
    },
    { upsert: true, new: true }
  );
}

let BOT_ID = null;
async function getBotId() {
    if (!BOT_ID) {
        const me = await bot.getMe();
        BOT_ID = me.id;
    }
    return BOT_ID;
}

// ─── /start ───────────────────────────────────────────────────────────────────

async function start(message) {
    console.log("[START-DEBUG]", { chatId: message.chat?.id, date: message.date, botStartTime: BOT_START_TIME });
    if (message.date < BOT_START_TIME) return;
    if (message.chat.type !== "private") return;

    await ensureUserSaved(message, { source: parseStartSource(message.text) });

    const firstName = escapeHtml(message.from.first_name || "user");
    const text = t(message, "startUser", firstName);

    await bot.sendMessage(message.chat.id, text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        reply_markup: {
            inline_keyboard: [
                [{ text: "Adicionar ao grupo", url: "https://t.me/helanagbot?startgroup=true" }],
                [
                    { text: "Canal", url: "https://t.me/lbrabo" },
                    { text: "Suporte", url: "https://t.me/kylorensbot" },
                ],
                [{ text: "Github", url: "https://github.com/leviobrabo/helanagbot" }],
            ],
        },
    }).catch(err => console.error("[START-SEND-ERROR]", err.message));
}

// ─── /stats ───────────────────────────────────────────────────────────────────

async function stats(message) {
  if (!is_dev(message.from.id)) return;
  await ensureUserSaved(message);

  const [numUsers, numChats, numMessages, usersByLang, groupsByLang] = await Promise.all([
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
  ]);

  const pages = [];
  pages.push(
    `📊 <b>Estatísticas</b>\n\n` +
    `👥 <b>Usuários:</b> <code>${numUsers}</code>\n` +
    `🏘 <b>Grupos ativos:</b> <code>${numChats}</code>\n` +
    `💬 <b>Mensagens aprendidas:</b> <code>${numMessages}</code>\n\n` +
    `📅 <code>${new Date().toLocaleString('pt-BR')}</code>`
  );

  let usersLangDetail = `👥 <b>Usuários por idioma</b>\n\n`;
  for (const { _id, count } of usersByLang) {
    usersLangDetail += `<code>${_id || "unknown"}</code> — ${count}\n`;
  }
  pages.push(usersLangDetail);

  let groupsLangDetail = `🏘 <b>Grupos por idioma</b>\n\n`;
  for (const { _id, count } of groupsByLang) {
    groupsLangDetail += `<code>${_id || "unknown"}</code> — ${count}\n`;
  }
  pages.push(groupsLangDetail);

  const memUsage = process.memoryUsage();
  pages.push(
    `⚡ <b>Performance</b>\n\n` +
    `💾 <code>${Math.round(memUsage.heapUsed / 1024 / 1024)}</code>MB / ` +
    `<code>${Math.round(memUsage.heapTotal / 1024 / 1024)}</code>MB\n` +
    `🕒 <code>${timeFormatter(process.uptime())}</code>`
  );

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

    const chunks = chunkArray(chats, 15);
    const pages = chunks.map((chunk, i) => {
      let text = `🏘 <b>Grupos</b> — ${chats.length} total\n<i>Página ${i + 1}/${chunks.length}</i>\n\n`;
      chunk.forEach((chat, idx) => {
        text += `${i * 15 + idx + 1}. ${escapeHtml(chat.chatName)}\n`;
        text += `   <code>${chat.chatId}</code>\n`;
      });
      return text;
    });

    await sendPaginated(message.chat.id, message.from.id, "grupos", pages);
}

// ─── /banned ──────────────────────────────────────────────────────────────────

async function banned(message) {
    if (message.chat.type !== "private") return;
    if (!is_dev(message.from.id)) return;
    await ensureUserSaved(message);

    const bannedChats = await ChatModel.find({ is_ban: true });
    if (!bannedChats.length) {
        return bot.sendMessage(message.chat.id, "Nenhum grupo banido.");
    }

    const chunks = chunkArray(bannedChats, 15);
    const pages = chunks.map((chunk, i) => {
        let text = `🚫 <b>Grupos Banidos</b> — ${bannedChats.length} total\n`;
        text += `<i>Página ${i + 1}/${chunks.length}</i>\n\n`;
        chunk.forEach((chat, idx) => {
            text += `${i * 15 + idx + 1}. ${escapeHtml(chat.chatName)}\n`;
        });
        return text;
    });

    await sendPaginated(message.chat.id, message.from.id, "banned", pages);
}

// ─── /ban ─────────────────────────────────────────────────────────────────────

async function ban(message) {
    if (message.chat.type !== "private") return;
    if (!is_dev(message.from.id)) return;

    const rawId = message.text.split(" ")[1];
    if (!rawId || isNaN(rawId)) {
        return bot.sendMessage(message.chat.id, "Uso: /ban <chatId>");
    }

    const chatId = Number(rawId);
    const chat = await ChatModel.findOne({ chatId });
    if (!chat) return bot.sendMessage(message.chat.id, `Grupo não encontrado: ${chatId}`);
    if (chat.is_ban) return bot.sendMessage(message.chat.id, "Já banido.");

    await ChatModel.updateOne({ chatId }, { $set: { is_ban: true } });
    await bot.leaveChat(chatId).catch(() => {});
    await bot.sendMessage(message.chat.id, `✅ ${chat.chatName} banido.`);
}

// ─── /unban ───────────────────────────────────────────────────────────────────

async function unban(message) {
    if (message.chat.type !== "private") return;
    if (!is_dev(message.from.id)) return;

    const rawId = message.text.split(" ")[1];
    if (!rawId || isNaN(rawId)) {
        return bot.sendMessage(message.chat.id, "Uso: /unban <chatId>");
    }

    const chatId = Number(rawId);
    const chat = await ChatModel.findOne({ chatId });
    if (!chat) return bot.sendMessage(message.chat.id, `Grupo não encontrado: ${chatId}`);
    if (!chat.is_ban) return bot.sendMessage(message.chat.id, "Não está banido.");

    await ChatModel.updateOne({ chatId }, { $set: { is_ban: false } });
    await bot.sendMessage(message.chat.id, `✅ ${chat.chatName} desbanido.`);
}

// ─── /lang ────────────────────────────────────────────────────────────────────

async function lang(message) {
  const rawLang = message.text.split(/\s+/)[1];
  const requestedLang = rawLang ? normalizeLangCode(rawLang) : null;

  if (message.chat.type === "private") {
    await ensureUserSaved(message);
    if (!requestedLang) {
      return bot.sendMessage(message.chat.id, t(message, "currentLang", normalizeLangCode(message.from.language_code)), { parse_mode: "HTML" });
    }
    await UserModel.updateOne({ user_id: message.from.id }, { $set: { lang_code: requestedLang } });
    return bot.sendMessage(message.chat.id, t(message, "langSet", requestedLang), { parse_mode: "HTML" });
  }

  if (!isGroupMessage(message)) return;
  const group = await ensureGroupSaved(message);
  if (!group) return;

  if (!requestedLang) {
    return bot.sendMessage(message.chat.id, t(message, "currentLang", normalizeLangCode(group.lang_code)), { parse_mode: "HTML" });
  }

  await ChatModel.updateOne({ chatId: message.chat.id }, { $set: { lang_code: requestedLang } });
  return bot.sendMessage(message.chat.id, t(message, "langSet", requestedLang), { parse_mode: "HTML" });
}

// ─── /delmsg ──────────────────────────────────────────────────────────────────

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
    if (!is_dev(message.from.id)) return;
    if (message.chat.type !== "private") return;
    await ensureUserSaved(message);

    const devsData = await UserModel.find({ is_dev: true }).catch(() => []);
    let text = "<b>👨‍💻 Desenvolvedores:</b>\n\n";
    for (const user of devsData) {
        text += `• <a href="tg://user?id=${user.user_id}">${user.firstname}</a>\n`;
    }
    if (!devsData.length) text += "Nenhum dev cadastrado.";
    bot.sendMessage(message.chat.id, text, { parse_mode: "HTML" });
}

// ─── /dbstats ─────────────────────────────────────────────────────────────────

async function dbstats(message) {
    if (!is_dev(message.from.id)) return;
    if (message.chat.type !== "private") return;
    await ensureUserSaved(message);

    try {
        const [totalUsers, totalChats, totalChatsActive, totalMessages] = await Promise.all([
          UserModel.countDocuments(),
          ChatModel.countDocuments(),
          ChatModel.countDocuments({ is_ban: false }),
          MessageModel.countDocuments(),
        ]);

        const text =
            `🗄 <b>DB Stats</b>\n\n` +
            `👥 Usuários: <code>${totalUsers}</code>\n` +
            `🏘 Grupos: <code>${totalChats}</code> (${totalChatsActive} ativos)\n` +
            `💬 Mensagens: <code>${totalMessages}</code>\n\n` +
            `📅 <code>${new Date().toLocaleString('pt-BR')}</code>`;

        bot.sendMessage(message.chat.id, text, { parse_mode: "HTML" });
    } catch (err) {
        console.error("[DBSTATS]", err.message);
        bot.sendMessage(message.chat.id, `❌ Erro: ${err.message}`);
    }
}

// ─── /syncdb ──────────────────────────────────────────────────────────────────

async function syncdb(message) {
    if (!is_dev(message.from.id)) return;
    if (message.chat.type !== "private") return;
    await ensureUserSaved(message);

    const sent = await bot.sendMessage(message.chat.id, "🔄 Sincronizando...", { parse_mode: "HTML" });
    try {
        const totalUsers = await UserModel.countDocuments();
        const totalGroups = await ChatModel.countDocuments();

        await bot.editMessageText(
            `✅ <b>Sincronização Concluída</b>\n\n` +
            `👥 Usuários: <code>${totalUsers}</code>\n` +
            `🏘 Grupos: <code>${totalGroups}</code>`,
            { chat_id: sent.chat.id, message_id: sent.message_id, parse_mode: "HTML" }
        );
    } catch (err) {
        console.error("[SYNCDB]", err.message);
        await bot.editMessageText(
            `❌ Erro: ${err.message}`,
            { chat_id: sent.chat.id, message_id: sent.message_id }
        );
    }
}

// ─── /adddev ──────────────────────────────────────────────────────────────────

async function adddev(message) {
  if (!is_dev(message.from.id)) return;
  const rawId = message.text.split(" ")[1];
  if (!rawId || isNaN(rawId)) {
    return bot.sendMessage(message.chat.id, "Uso: /adddev <userId>");
  }
  const userId = Number(rawId);
  await UserModel.updateOne({ user_id: userId }, { $set: { is_dev: true } });
  devSet.add(userId.toString());
  bot.sendMessage(message.chat.id, `✅ Dev adicionado: ${userId}`);
}

// ─── /rmdev ───────────────────────────────────────────────────────────────────

async function rmdev(message) {
  if (!is_dev(message.from.id)) return;
  const rawId = message.text.split(" ")[1];
  if (!rawId || isNaN(rawId)) {
    return bot.sendMessage(message.chat.id, "Uso: /rmdev <userId>");
  }
  const userId = Number(rawId);
  await UserModel.updateOne({ user_id: userId }, { $set: { is_dev: false } });
  devSet.delete(userId.toString());
  bot.sendMessage(message.chat.id, `✅ Dev removido: ${userId}`);
}

// ─── status messages ──────────────────────────────────────────────────────────

async function sendBotOnlineMessage() {
  if (!groupId) return;
  setTimeout(async () => {
    try {
      await bot.sendMessage(groupId, "🟢 Bot online e funcionando!", { parse_mode: "HTML" });
    } catch (err) {
      console.warn("[ONLINE-MSG]", err.message);
    }
  }, 2000);
}

async function sendBotOfflineMessage() {
  if (!groupId) return;
  try {
    await bot.sendMessage(groupId, "🔴 Bot offline", { parse_mode: "HTML" });
  } catch (err) {
    console.warn("[OFFLINE-MSG]", err.message);
  }
}

function pollingError(error) {
  const msg = error?.message ?? String(error);
  if (msg.includes("ETELEGRAM") || msg.includes("polling") || msg.includes("Conflict")) {
    console.warn("[POLLING-WARN]", msg);
  } else {
    console.error("[POLLING-ERROR]", msg);
  }
}

// ─── callback handler ─────────────────────────────────────────────────────────

function registerCallbackHandler() {
  bot.on("callback_query", async (query) => {
    const data = query.data || "";
    const [type, pageStr] = data.split(":");
    const page = parseInt(pageStr, 10);

    if (isNaN(page)) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const key = `${type}:${query.from.id}`;
    const state = paginationState.get(key);
    if (!state || state.currentPage === page) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const { pages } = state;
    if (page < 0 || page >= pages.length) {
      await bot.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    state.currentPage = page;
    const pageContent = pages[page];
    await bot.editMessageText(pageContent, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      ...buildNavMarkup(type, page, pages.length),
    }).catch(() => {});

    await bot.answerCallbackQuery(query.id).catch(() => {});
  });
}


async function broadcast(message, groups = false) {
  if (!is_dev(message.from.id) || message.chat.type !== "private") return;
  const text = (message.text || "").replace(/^\/(?:bc|broadcast|sendgp)(?:@\w+)?\s*/i, "").trim();
  if (!text) return bot.sendMessage(message.chat.id, "Uso: /bc texto ou /sendgp texto");
  const recipients = groups
    ? await ChatModel.find({ is_ban: false, telegram_blocked: { $ne: true } }).lean().select("chatId")
    : await UserModel.find({ telegram_blocked: { $ne: true } }).lean().select("user_id");
  const started = Date.now();
  const status = await bot.sendMessage(message.chat.id, "⏳ Iniciando envio para " + recipients.length + " destinos...");
  let success = 0, blocked = 0, failed = 0;
  for (let i = 0; i < recipients.length; i++) {
    const id = groups ? recipients[i].chatId : recipients[i].user_id;
    try {
      await transport.sendBulk(id, text, { disable_web_page_preview: true });
      success++;
    } catch (e) {
      if (e?.response?.body?.error_code === 403 || e?.blocked) {
        blocked++;
        await bot.__onBlocked(id);
      } else { failed++; console.warn("[BROADCAST-ERROR]", id, e.message); }
    }
    if ((i + 1) % 50 === 0) {
      await bot.editMessageText(`📤 ${i + 1}/${recipients.length} | OK ${success} | Bloqueados ${blocked} | Falhas ${failed}`, { chat_id: message.chat.id, message_id: status.message_id }).catch(() => {});
    }
  }
  const elapsed = Date.now() - started;
  transport.recordBroadcast(elapsed);
  await bot.editMessageText(`✅ Envio concluído: ${success}/${recipients.length} | Bloqueados ${blocked} | Falhas ${failed} | ${Math.round(elapsed / 1000)}s`, { chat_id: message.chat.id, message_id: status.message_id }).catch(() => {});
}

// ─── initialization ──────────────────────────────────────────────────────────

exports.initHandler = () => {
  loadDevsFromDB().catch(() => {});
  registerCallbackHandler();

  bot.on("message", main);
  bot.on("message", saveUserInformation);
  bot.on("polling_error", pollingError);
  bot.on("new_chat_members", saveNewChatMembers);
  bot.on("left_chat_member", removeLeftChatMember);

  bot.onText(/^\/start$/, start);
  bot.onText(/^\/stats$/, stats);
  bot.onText(/^\/(?:bc|broadcast)\s+/, msg => broadcast(msg, false));
  bot.onText(/^\/sendgp\s+/, msg => broadcast(msg, true));
  bot.onText(/^\/metrics$/, async (msg) => {
    if (!is_dev(msg.from.id) || msg.chat.type !== "private") return;
    await bot.sendMessage(msg.chat.id, "<pre>" + JSON.stringify(transport.snapshot(), null, 2) + "</pre>", { parse_mode: "HTML" });
  });
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
      `𝚙𝚒𝚗𝚐: \`${ms}𝚖𝚜\` | ⏱️ \`${timeFormatter(process.uptime())}\``,
      { chat_id: replied.chat.id, message_id: replied.message_id, parse_mode: "Markdown" }
    );
  });

  new CronJob("02 00 12 * * *", async () => {
    if (!groupId) return;
    try {
      await bot.sendMessage(groupId, "✅ Bot online e funcionando bem!", { parse_mode: "HTML" });
    } catch (err) {
      console.warn("[STATUS]", err.message);
    }
  }, null, true, "America/Sao_Paulo");

  new CronJob("0 */5 * * * *", async () => {
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    if (heapMB > 450) {
      console.warn(`[MEM] Heap ${heapMB}MB > 450MB — restart graceful...`);
      bot.stopPolling();
      await delay(2000);
      process.exit(0);
    }
  }, null, true, "America/Sao_Paulo");

  sendBotOnlineMessage();
};
