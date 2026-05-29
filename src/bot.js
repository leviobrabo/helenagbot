const TelegramBot = require("node-telegram-bot-api");
const { queueHigh, setGlobal429, isGlobal429Paused, waitForChatThrottle } = require("./queue");

const bot = new TelegramBot(process.env.TELEGRAM_API, {
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10,
    },
  },
  onlyFirstMatch: true,
});

bot.catchGlobal = (err) => {
  const msg = err?.message ?? String(err);
  const code = err?.response?.body?.error_code;
  if (code === 429) {
    const retryAfter = err?.response?.body?.parameters?.retry_after || 5;
    console.warn(`[RATE-LIMIT] 429 — aguardando ${retryAfter}s`);
    setGlobal429(retryAfter);
    return;
  }
  if (msg.includes("ETELEGRAM") || msg.includes("message to be replied not found") || msg.includes("message to delete not found") || msg.includes("message is not modified") || msg.includes("Bad Request")) {
    console.warn(`[TG-WARN] ${msg}`);
    return;
  }
  console.error(`[TG-ERR] ${msg}`);
};

function getChatIdFromArgs(methodName, args) {
  if (methodName === "answerCallbackQuery") return null;
  if (methodName === "getMe") return null;
  if (methodName === "getChatAdministrators") return null;
  const chatId = args[0];
  return typeof chatId === "number" ? chatId : null;
}

function isGroupChatId(chatId) {
  if (!chatId) return false;
  return chatId < 0;
}

function wrapApiMethod(methodName) {
  const original = bot[methodName].bind(bot);

  bot[methodName] = (...args) => {
    return queueHigh(async () => {
      while (isGlobal429Paused()) {
        await new Promise((r) => setTimeout(r, 200));
      }

      const chatId = getChatIdFromArgs(methodName, args);
      if (chatId !== null) {
        await waitForChatThrottle(chatId, isGroupChatId(chatId));
      }

      try {
        return await original(...args);
      } catch (err) {
        const code = err?.response?.body?.error_code;
        if (code === 429) {
          const retryAfter = err?.response?.body?.parameters?.retry_after || 5;
          setGlobal429(retryAfter);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          return await original(...args);
        }
        throw err;
      }
    }, 10);
  };
}

const WRAP_METHODS = [
  "sendMessage",
  "editMessageText",
  "sendSticker",
  "sendVoice",
  "sendPhoto",
  "sendChatAction",
  "copyMessage",
  "answerCallbackQuery",
  "leaveChat",
  "getChat",
  "getMe",
  "getChatAdministrators",
];

for (const m of WRAP_METHODS) {
  if (typeof bot[m] === "function") {
    wrapApiMethod(m);
  }
}

exports.bot = bot;
