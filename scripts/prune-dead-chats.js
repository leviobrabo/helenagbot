require("dotenv").config();

const mongoose = require("mongoose");
const TelegramBot = require("node-telegram-bot-api");
const { ChatModel, UserModel } = require("../src/database");

const args = new Set(process.argv.slice(2));
const execute = args.has("--execute");
const checkUsers = !args.has("--groups");
const checkGroups = !args.has("--users");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Number(limitArg.split("=")[1]) || 0) : 0;
const delayArg = process.argv.find((arg) => arg.startsWith("--delay="));
const delayMs = delayArg ? Math.max(0, Number(delayArg.split("=")[1]) || 0) : 60;

const bot = new TelegramBot(process.env.TELEGRAM_API, { polling: false });

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDb() {
  if (mongoose.connection.readyState === 1) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout ao conectar no MongoDB")), 20000);
    mongoose.connection.once("connected", () => {
      clearTimeout(timer);
      resolve();
    });
    mongoose.connection.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function telegramErrorDescription(err) {
  return err?.response?.body?.description || err?.message || "";
}

function isDeadUserError(err) {
  const code = err?.response?.body?.error_code;
  const desc = telegramErrorDescription(err);
  if (code === 403) return true;
  return code === 400 && /chat not found|bot can't initiate|user is deactivated|user not found|blocked by user/i.test(desc);
}

function isDeadGroupError(err) {
  const code = err?.response?.body?.error_code;
  const desc = telegramErrorDescription(err);
  if (code === 403) return true;
  return code === 400 && /chat not found|group is deactivated|not enough rights|bot was kicked/i.test(desc);
}

async function pruneUsers() {
  const query = UserModel.find().lean().select("user_id").sort({ user_id: 1 });
  if (limit) query.limit(limit);
  const users = await query;
  const stats = { checked: 0, removed: 0, failed: 0 };

  for (const user of users) {
    try {
      await bot.getChat(user.user_id);
    } catch (err) {
      if (isDeadUserError(err)) {
        stats.removed++;
        console.log(`[USERS] ${execute ? "remove" : "would remove"} ${user.user_id} - ${telegramErrorDescription(err)}`);
        if (execute) await UserModel.deleteOne({ user_id: user.user_id });
      } else {
        stats.failed++;
        console.warn(`[USERS] falha ${user.user_id} - ${telegramErrorDescription(err)}`);
      }
    }
    stats.checked++;
    if (delayMs) await sleep(delayMs);
  }

  return stats;
}

async function pruneGroups() {
  const me = await bot.getMe();
  const query = ChatModel.find({ is_ban: false }).lean().select("chatId").sort({ chatId: 1 });
  if (limit) query.limit(limit);
  const groups = await query;
  const stats = { checked: 0, removed: 0, failed: 0 };

  for (const group of groups) {
    try {
      await bot.getChat(group.chatId);
      const member = await bot.getChatMember(group.chatId, me.id);
      if (["left", "kicked"].includes(member?.status)) {
        throw Object.assign(new Error(`bot status ${member.status}`), {
          response: { body: { error_code: 403, description: `bot status ${member.status}` } },
        });
      }
    } catch (err) {
      if (isDeadGroupError(err)) {
        stats.removed++;
        console.log(`[GROUPS] ${execute ? "remove" : "would remove"} ${group.chatId} - ${telegramErrorDescription(err)}`);
        if (execute) {
          await bot.leaveChat(group.chatId).catch(() => {});
          await ChatModel.deleteOne({ chatId: group.chatId });
        }
      } else {
        stats.failed++;
        console.warn(`[GROUPS] falha ${group.chatId} - ${telegramErrorDescription(err)}`);
      }
    }
    stats.checked++;
    if (delayMs) await sleep(delayMs);
  }

  return stats;
}

async function main() {
  if (!process.env.TELEGRAM_API || !process.env.DB_STRING) {
    throw new Error("Configure TELEGRAM_API e DB_STRING no ambiente.");
  }

  await waitForDb();
  console.log(`[PRUNE] modo=${execute ? "execute" : "dry-run"} limit=${limit || "all"} delay=${delayMs}ms`);

  if (checkUsers) {
    const stats = await pruneUsers();
    console.log(`[PRUNE-USERS] checked=${stats.checked} removed=${stats.removed} failed=${stats.failed}`);
  }

  if (checkGroups) {
    const stats = await pruneGroups();
    console.log(`[PRUNE-GROUPS] checked=${stats.checked} removed=${stats.removed} failed=${stats.failed}`);
  }
}

main()
  .catch((err) => {
    console.error(`[PRUNE] erro: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
