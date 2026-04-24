const { MessageModel, ChatModel, UserModel } = require("../database");
const { bot } = require("../bot");
const CronJob = require("cron").CronJob;
const { setTimeout: delay } = require("timers/promises");
const palavrasProibidas = require("./palavrasproibida.json");
const { audioList, photoList } = require("../config/media");
const { adsterra } = require("../config/ads");

require("./errors.js");

const groupId = process.env.groupId;
const logMsgId = parseInt(process.env.LOG_MSG_ID) || null;
const channelStatusId = process.env.channelStatusId;

// ─── helpers ─────────────────────────────────────────────────────────────────

function is_dev(user_id) {
    const devUsers = (process.env.DEV_USERS || "").split(",").map((s) => s.trim());
    return devUsers.includes(user_id.toString());
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

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks.length ? chunks : [[]];
}

// ─── bot id cache ─────────────────────────────────────────────────────────────

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
    paginationState.set(`${type}:${userId}`, { pages, currentPage: 0, msgId: sent.message_id });
}

// ─── learning system ──────────────────────────────────────────────────────────

async function deleteMessageIfExists(repliedMessage, replyMessage) {
    const found = await MessageModel.findOne({
        $or: [{ message: repliedMessage }, { reply: replyMessage }],
    });
    if (found) await MessageModel.deleteOne({ _id: found._id });
}

async function createMessageAndAddReply(message) {
    const repliedMessage =
        message.reply_to_message?.sticker?.file_unique_id ?? message.reply_to_message?.text;
    const replyMessage = message.sticker?.file_id ?? message.text;

    if (!repliedMessage || !replyMessage) return;
    if (/^[\/.!]/.test(repliedMessage) || /^[\/.!]/.test(replyMessage)) return;
    if (containsUrl(repliedMessage) || containsUrl(replyMessage)) {
        await deleteMessageIfExists(repliedMessage, replyMessage);
        return;
    }
    if (hasForbiddenWord(repliedMessage) || hasForbiddenWord(replyMessage)) {
        await deleteMessageIfExists(repliedMessage, replyMessage);
        return;
    }

    await new MessageModel({ message: repliedMessage, reply: replyMessage }).save().catch(() => {});
}

async function addReply(message) {
    const repliedMessage =
        message.reply_to_message?.sticker?.file_unique_id ?? message.reply_to_message?.text;
    const replyMessage = message.sticker?.file_id ?? message.text;

    if (/^[\/.!]/.test(repliedMessage)) return;
    if (containsUrl(repliedMessage) || containsUrl(replyMessage)) {
        await deleteMessageIfExists(repliedMessage, replyMessage);
        return;
    }
    if (hasForbiddenWord(repliedMessage) || hasForbiddenWord(replyMessage)) {
        await deleteMessageIfExists(repliedMessage, replyMessage);
        return;
    }

    const exists = await MessageModel.exists({ message: repliedMessage });
    if (exists) {
        await MessageModel.findOneAndUpdate(
            { message: repliedMessage },
            { $push: { reply: replyMessage } }
        );
    } else {
        await createMessageAndAddReply(message);
    }
}

// ─── answer user ──────────────────────────────────────────────────────────────

async function answerUser(message) {
    const received = message.sticker?.file_unique_id ?? message.text;
    const chatId = message.chat.id;

    try {
        if (/^[\/.!]/.test(received)) return;

        const sendOpts = { reply_to_message_id: message.message_id };

        const audioMatch = audioList.find((a) => received === a.keyword);
        if (audioMatch) {
            await bot.sendChatAction(chatId, "record_audio");
            await Promise.race([
                bot.sendVoice(chatId, audioMatch.audioUrl, sendOpts),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000)),
            ]).catch((e) => console.error("Audio error:", e.message));
            return;
        }

        const photoMatch = photoList.find((p) => received === p.keyword);
        if (photoMatch) {
            await bot.sendChatAction(chatId, "upload_photo");
            await Promise.race([
                bot.sendPhoto(chatId, photoMatch.photoUrl, sendOpts),
                new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 6000)),
            ]).catch((e) => console.error("Photo error:", e.message));
            return;
        }

        const doc = await MessageModel.findOne({ message: received });
        if (doc && doc.reply.length) {
            const replyToSend = randomItem(doc.reply);
            if (!replyToSend) return;
            const typingTime = Math.min(Math.max(50 * replyToSend.length, 200), 6000);
            await bot.sendChatAction(chatId, "typing");
            await delay(typingTime);
            await bot
                .sendSticker(chatId, replyToSend, sendOpts)
                .catch(() => bot.sendMessage(chatId, replyToSend, sendOpts));
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
    const replyTo = message?.reply_to_message ?? false;
    const botId = await getBotId();

    if (message.sticker || message.text) {
        if (replyTo && replyTo.from.id !== botId) addReply(message);
        if (!replyTo || replyTo.from.id === botId) answerUser(message);
    }
}

// ─── user / group registration ────────────────────────────────────────────────

async function saveUserInformation(message) {
    const user = message.from;
    if (!user || user.is_bot) return;

    const langCode = user.language_code || "unknown";
    const isPrivate = message.chat.type === "private";

    const exists = await UserModel.exists({ user_id: user.id });
    if (!exists) {
        await new UserModel({
            user_id: user.id,
            username: user.username,
            firstname: user.first_name,
            lastname: user.last_name,
            lang_code: langCode,
            is_dev: false,
        })
            .save()
            .catch(() => {});

        if (isPrivate) {
            const notif =
                `#Togurosbot #New_User\n` +
                `<b>User:</b> <a href="tg://user?id=${user.id}">${user.first_name}</a>\n` +
                `<b>ID:</b> <code>${user.id}</code>\n` +
                `<b>Username:</b> ${user.username ? `@${user.username}` : "N/A"}\n` +
                `<b>Lang:</b> <code>${langCode}</code>`;
            bot.sendMessage(groupId, notif, {
                parse_mode: "HTML",
                ...(logMsgId && { reply_to_message_id: logMsgId }),
            }).catch(() => {});
        }
    } else {
        await UserModel.findOneAndUpdate(
            { user_id: user.id },
            { username: user.username, firstname: user.first_name, lastname: user.last_name, lang_code: langCode }
        ).catch(() => {});
    }
}

async function saveNewChatMembers(msg) {
    const chatId = msg.chat.id;
    const chatName = msg.chat.title;
    const langCode = msg.from?.language_code || "unknown";

    try {
        const chat = await ChatModel.findOne({ chatId });
        if (chat) {
            if (chat.is_ban) {
                await bot.leaveChat(chatId);
            }
            return;
        }

        await ChatModel.create({ chatId, chatName, lang_code: langCode });

        const botUser = await bot.getMe();
        const addedNow = msg.new_chat_members?.some((m) => m.id === botUser.id);
        const chatLink = msg.chat.username ? `@${msg.chat.username}` : "Private Group";

        if (addedNow) {
            const notif =
                `#Togurosbot #New_Group\n` +
                `<b>Group:</b> ${chatName}\n` +
                `<b>ID:</b> <code>${chatId}</code>\n` +
                `<b>Link:</b> ${chatLink}\n` +
                `<b>Lang:</b> <code>${langCode}</code>`;
            bot.sendMessage(groupId, notif, {
                parse_mode: "HTML",
                ...(logMsgId && { reply_to_message_id: logMsgId }),
            }).catch(() => {});

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

        const devMembers = msg.new_chat_members?.filter((m) => !m.is_bot && is_dev(m.id));
        if (devMembers?.length) {
            bot.sendMessage(
                chatId,
                `👨‍💻 <b>Um dos meus desenvolvedores entrou no grupo:</b> <a href="tg://user?id=${devMembers[0].id}">${devMembers[0].first_name}</a> 😎`,
                { parse_mode: "HTML" }
            ).catch(() => {});
        }
    } catch (err) {
        console.error("saveNewChatMembers error:", err.message);
    }
}

async function removeLeftChatMember(msg) {
    const botId = await getBotId();
    if (msg.left_chat_member.id !== botId) return;
    const chatId = msg.chat.id;
    const chat = await ChatModel.findOne({ chatId });
    if (!chat || chat.is_ban) return;
    await ChatModel.findOneAndDelete({ chatId }).catch(() => {});
}

// ─── /start ───────────────────────────────────────────────────────────────────

async function start(message) {
    if (message.chat.type !== "private") return;
    const userId = message.from.id;
    const firstName = message.from.first_name;

    const devText =
        `Olá, <b>${firstName}</b>! Você é um dos desenvolvedores 🧑‍💻\n\n` +
        `Você está no painel do Toguro. Use os comandos com responsabilidade.`;

    const userText =
        `Olá, <b>${firstName}</b>!\n\n` +
        `Eu sou <b>Toguro</b>, um bot que responde mensagens, áudios e figurinhas da galera 😄\n\n` +
        `📣 <b>Novidades do bot:</b> <a href="https://t.me/lbrabo">@lbrabo</a>\n` +
        `📚 <b>Cursos:</b> <a href="https://t.me/cursobroff">@cursobroff</a>`;

    if (is_dev(userId)) {
        await bot.sendMessage(userId, devText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "📦 Github", url: "https://github.com/leviobrabo/togurosbot" }],
                    [
                        { text: "📣 Canal", url: "https://t.me/lbrabo" },
                        { text: "👨‍💻 Suporte", url: "https://t.me/kylorensbot" },
                    ],
                    [{ text: "🗃 Comandos do Dev", callback_data: "dev_commands" }],
                ],
            },
        });
    } else {
        await bot.sendMessage(message.chat.id, userText, {
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✨ Adicione-me em seu grupo", url: "https://t.me/togurosbot?startgroup=true" }],
                    [
                        { text: "📣 Canal Oficial", url: "https://t.me/lbrabo" },
                        { text: "👨‍💻 Suporte", url: "https://t.me/kylorensbot" },
                    ],
                    [{ text: "📦 Github", url: "https://github.com/leviobrabo/togurosbot" }],
                ],
            },
        });
    }
}

// ─── /stats ───────────────────────────────────────────────────────────────────

async function stats(message) {
    if (!is_dev(message.from.id)) return;

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
        `📊 <b>Estatísticas — Toguro</b>\n\n` +
        `👥 <b>Usuários:</b> <code>${numUsers}</code>\n` +
        `🏘 <b>Grupos ativos:</b> <code>${numChats}</code>\n` +
        `💬 <b>Mensagens aprendidas:</b> <code>${numMessages}</code>`
    );

    for (const chunk of chunkArray(usersByLang, 20)) {
        let text = `👥 <b>Usuários por idioma</b>\n\n`;
        for (const { _id, count } of chunk) {
            text += `🌐 <code>${_id || "unknown"}</code> — <b>${count}</b> usuário(s)\n`;
        }
        pages.push(text);
    }

    for (const chunk of chunkArray(groupsByLang, 20)) {
        let text = `🏘 <b>Grupos por idioma</b>\n\n`;
        for (const { _id, count } of chunk) {
            text += `🌐 <code>${_id || "unknown"}</code> — <b>${count}</b> grupo(s)\n`;
        }
        pages.push(text);
    }

    await sendPaginated(message.chat.id, message.from.id, "stats", pages);
}

// ─── /grupos ──────────────────────────────────────────────────────────────────

async function groups(message) {
    if (!is_dev(message.from.id)) return;
    if (message.chat.type !== "private") return;

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
            text += `    ├ ID: <code>${chat.chatId}</code>\n`;
            text += `    └ Lang: <code>${chat.lang_code || "unknown"}</code>\n\n`;
        });
        return text;
    });

    await sendPaginated(message.chat.id, message.from.id, "grupos", pages);
}

// ─── /banned ──────────────────────────────────────────────────────────────────

async function banned(message) {
    if (message.chat.type !== "private") {
        return bot.sendMessage(message.chat.id, "Use este comando no PV com o bot.");
    }
    if (!is_dev(message.from.id)) {
        return bot.sendMessage(message.chat.id, "Você não está autorizado.");
    }

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
        return bot.sendMessage(message.chat.id, "Use este comando no PV com o bot.");
    }
    if (!is_dev(message.from.id)) {
        return bot.sendMessage(message.chat.id, "Você não está autorizado.");
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
    await bot.sendMessage(chatId, "Toguro saindo do grupo!").catch(() => {});
    await bot.leaveChat(chatId).catch(() => {});
    await bot.sendMessage(message.chat.id, `✅ Grupo <b>${chat.chatName}</b> banido com sucesso.`, { parse_mode: "HTML" });

    bot.sendMessage(
        groupId,
        `#Togurosbot #Banned\n<b>Group:</b> ${chat.chatName}\n<b>ID:</b> <code>${chatId}</code>`,
        { parse_mode: "HTML", ...(logMsgId && { reply_to_message_id: logMsgId }) }
    ).catch(() => {});
}

// ─── /unban ───────────────────────────────────────────────────────────────────

async function unban(message) {
    if (message.chat.type !== "private") {
        return bot.sendMessage(message.chat.id, "Use este comando no PV com o bot.");
    }
    if (!is_dev(message.from.id)) {
        return bot.sendMessage(message.chat.id, "Você não está autorizado.");
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
        `#Togurosbot #Unban\n<b>Group:</b> ${chat.chatName}\n<b>ID:</b> <code>${chatId}</code>`,
        { parse_mode: "HTML", ...(logMsgId && { reply_to_message_id: logMsgId }) }
    ).catch(() => {});
}

// ─── /delmsg ──────────────────────────────────────────────────────────────────

async function removeMessage(message) {
    if (!is_dev(message.from.id)) return;

    const repliedMessage =
        message.reply_to_message &&
        (message.reply_to_message.sticker?.file_unique_id ?? message.reply_to_message.text);

    if (!repliedMessage) {
        return bot.sendMessage(message.chat.id, "Responda a uma mensagem para deletar do banco.");
    }

    const exists = await MessageModel.exists({ message: repliedMessage });
    if (!exists) {
        return bot.sendMessage(message.chat.id, "Mensagem não encontrada no banco de dados.");
    }

    await MessageModel.deleteMany({
        $or: [
            { message: repliedMessage },
            { reply: { $elemMatch: { $eq: repliedMessage } } },
        ],
    });

    bot.sendMessage(
        message.chat.id,
        `✅ Deletado por <a href="tg://user?id=${message.from.id}">${message.from.first_name}</a>.\n\nTodas as respostas associadas foram apagadas.`,
        { parse_mode: "HTML", reply_to_message_id: message.message_id }
    );
}

// ─── /devs ────────────────────────────────────────────────────────────────────

async function devs(message) {
    if (!is_dev(message.from.id)) {
        return bot.sendMessage(message.chat.id, "Este comando é apenas para desenvolvedores!");
    }
    if (message.chat.type !== "private") {
        return bot.sendMessage(message.chat.id, "Use este comando no PV com o bot.");
    }

    const devsData = await UserModel.find({ is_dev: true }).catch(() => []);
    let text = "<b>👨‍💻 Desenvolvedores:</b>\n\n";
    for (const user of devsData) {
        text += `• <a href="tg://user?id=${user.user_id}">${user.firstname}</a> — <code>${user.user_id}</code>\n`;
    }
    if (!devsData.length) text += "Nenhum dev cadastrado no banco.";
    bot.sendMessage(message.chat.id, text, { parse_mode: "HTML" });
}

// ─── /bc ─────────────────────────────────────────────────────────────────────

async function bc(msg) {
    if (!is_dev(msg.from.id)) return;
    if (msg.chat.type !== "private") return;

    const query = msg.text.substring(3).trim();
    if (!query) {
        return bot.sendMessage(msg.chat.id, "<i>Uso: /bc [-d] &lt;texto&gt;</i>", { parse_mode: "HTML" });
    }

    const webPreview = query.startsWith("-d");
    const text = webPreview ? query.substring(2).trim() : query;

    const sentMsg = await bot.sendMessage(msg.chat.id, "<i>⏳ Enviando broadcast...</i>", { parse_mode: "HTML" });
    const ulist = await UserModel.find().lean().select("user_id");

    let success = 0, blocked = 0, failed = 0;

    for (const { user_id } of ulist) {
        try {
            await bot.sendMessage(user_id, text, { disable_web_page_preview: !webPreview, parse_mode: "HTML" });
            success++;
        } catch (err) {
            const code = err?.response?.body?.error_code;
            if (code === 403 || code === 400) {
                blocked++;
                await UserModel.deleteOne({ user_id }).catch(() => {});
            } else {
                failed++;
            }
        }
        await delay(50);
    }

    await bot.editMessageText(
        `╭─❑ 「 <b>Broadcast Concluído</b> 」 ❑\n` +
        `│ 📤 Total: <code>${ulist.length}</code>\n` +
        `│ ✅ Enviados: <code>${success}</code>\n` +
        `│ 🚫 Bloqueados (removidos): <code>${blocked}</code>\n` +
        `│ ❌ Falhas: <code>${failed}</code>\n` +
        `╰❑`,
        { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
    );
}

// ─── /broadcast ───────────────────────────────────────────────────────────────

async function broadcast(msg) {
    if (!is_dev(msg.from.id)) return;
    if (msg.chat.type !== "private") return;

    if (!msg.reply_to_message) {
        return bot.sendMessage(msg.chat.id, "<i>Responda a uma mensagem para fazer broadcast.</i>", {
            parse_mode: "HTML",
        });
    }

    const reply = msg.reply_to_message;
    const sentMsg = await bot.sendMessage(msg.chat.id, "<i>⏳ Broadcast iniciando...</i>", { parse_mode: "HTML" });
    const ulist = await UserModel.find().lean().select("user_id");

    let success = 0, blocked = 0, failed = 0;

    for (const { user_id } of ulist) {
        try {
            await bot.copyMessage(user_id, msg.chat.id, reply.message_id);
            success++;
        } catch (err) {
            const code = err?.response?.body?.error_code;
            if (code === 403 || code === 400) {
                blocked++;
                await UserModel.deleteOne({ user_id }).catch(() => {});
            } else {
                failed++;
            }
        }
        await delay(50);
    }

    await bot.editMessageText(
        `╭─❑ 「 <b>Broadcast Concluído</b> 」 ❑\n` +
        `│ 📤 Total: <code>${ulist.length}</code>\n` +
        `│ ✅ Enviados: <code>${success}</code>\n` +
        `│ 🚫 Bloqueados (removidos): <code>${blocked}</code>\n` +
        `│ ❌ Falhas: <code>${failed}</code>\n` +
        `╰❑`,
        { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
    );
}

// ─── /sendgp ──────────────────────────────────────────────────────────────────

async function sendgp(msg) {
    if (!is_dev(msg.from.id)) return;
    if (msg.chat.type !== "private") return;

    const sentMsg = await bot.sendMessage(msg.chat.id, "<i>⏳ Enviando para grupos...</i>", { parse_mode: "HTML" });
    const ulist = await ChatModel.find({ is_ban: false }).lean().select("chatId");

    let success = 0, removed = 0, failed = 0;

    if (msg.reply_to_message) {
        const replyMsg = msg.reply_to_message;
        for (const { chatId } of ulist) {
            try {
                await bot.copyMessage(chatId, replyMsg.chat.id, replyMsg.message_id);
                success++;
            } catch (err) {
                const code = err?.response?.body?.error_code;
                if (code === 403 || code === 400) {
                    removed++;
                    await ChatModel.deleteOne({ chatId }).catch(() => {});
                } else {
                    failed++;
                }
            }
            await delay(50);
        }
    } else {
        const rawText = msg.text.replace(/^\/sendgp\s*/, "").trim();
        const webPreview = rawText.startsWith("-d");
        const text = webPreview ? rawText.substring(2).trim() : rawText;

        if (!text) {
            await bot.editMessageText("Uso: /sendgp [-d] <texto> ou responda uma mensagem.", {
                chat_id: sentMsg.chat.id,
                message_id: sentMsg.message_id,
            });
            return;
        }

        for (const { chatId } of ulist) {
            try {
                await bot.sendMessage(chatId, text, { disable_web_page_preview: !webPreview, parse_mode: "HTML" });
                success++;
            } catch (err) {
                const code = err?.response?.body?.error_code;
                if (code === 403 || code === 400) {
                    removed++;
                    await ChatModel.deleteOne({ chatId }).catch(() => {});
                } else {
                    failed++;
                }
            }
            await delay(50);
        }
    }

    await bot.editMessageText(
        `╭─❑ 「 <b>Envio para Grupos Concluído</b> 」 ❑\n` +
        `│ 🏘 Total: <code>${ulist.length}</code>\n` +
        `│ ✅ Enviados: <code>${success}</code>\n` +
        `│ 🗑 Removidos (inativos): <code>${removed}</code>\n` +
        `│ ❌ Falhas: <code>${failed}</code>\n` +
        `╰❑`,
        { chat_id: sentMsg.chat.id, message_id: sentMsg.message_id, parse_mode: "HTML" }
    );
}

// ─── Adsterra ads ─────────────────────────────────────────────────────────────

async function sendAdsToUsers() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const users = await UserModel.find({
        $or: [{ last_ad_sent: null }, { last_ad_sent: { $lt: cutoff } }],
    })
        .lean()
        .select("user_id");

    if (!users.length) return;

    const now = new Date();
    let success = 0, failed = 0;

    for (const { user_id } of users) {
        try {
            const link = randomItem(adsterra.links);
            const tpl = randomItem(adsterra.userTemplates);
            await bot.sendMessage(user_id, tpl.text, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                reply_markup: { inline_keyboard: [[{ text: tpl.buttonText, url: link }]] },
            });
            await UserModel.updateOne({ user_id }, { $set: { last_ad_sent: now } });
            success++;
        } catch (err) {
            const code = err?.response?.body?.error_code;
            if (code === 403 || code === 400) {
                await UserModel.deleteOne({ user_id }).catch(() => {});
            } else {
                failed++;
            }
        }
        await delay(100);
    }

    console.log(`[ADS-USERS] Enviado: ${success} | Falhas: ${failed}`);
}

async function sendAdsToGroups() {
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const groups = await ChatModel.find({
        is_ban: false,
        $or: [{ last_ad_sent: null }, { last_ad_sent: { $lt: cutoff } }],
    })
        .lean()
        .select("chatId");

    if (!groups.length) return;

    const now = new Date();
    let success = 0, failed = 0;

    for (const { chatId } of groups) {
        try {
            const link = randomItem(adsterra.links);
            const tpl = randomItem(adsterra.groupTemplates);
            await bot.sendMessage(chatId, tpl.text, {
                parse_mode: "HTML",
                disable_web_page_preview: true,
                reply_markup: { inline_keyboard: [[{ text: tpl.buttonText, url: link }]] },
            });
            await ChatModel.updateOne({ chatId }, { $set: { last_ad_sent: now } });
            success++;
        } catch (err) {
            const code = err?.response?.body?.error_code;
            if (code === 403 || code === 400) {
                await ChatModel.deleteOne({ chatId }).catch(() => {});
            } else {
                failed++;
            }
        }
        await delay(100);
    }

    console.log(`[ADS-GROUPS] Enviado: ${success} | Falhas: ${failed}`);
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
            `#Togurosbot #Status\n\nStatus: ON\nPing: \`${ping}ms\`\nUptime: \`${timeFormatter(process.uptime())}\`\nUsuários: \`${numUsers}\`\nGrupos: \`${numChats}\``,
            { chat_id: replied.chat.id, message_id: replied.message_id, parse_mode: "Markdown" }
        )
        .catch(() => {});
}

// ─── lifecycle ────────────────────────────────────────────────────────────────

function sendBotOnlineMessage() {
    console.log("Toguro iniciado com sucesso...");
    bot.sendMessage(groupId, "#Toguro #ONLINE\n\nBot is now playing ...", {
        ...(logMsgId && { reply_to_message_id: logMsgId }),
    }).catch(() => {});
}

function sendBotOfflineMessage() {
    console.log("Toguro encerrado...");
    bot.sendMessage(groupId, "#Toguro #OFFLINE\n\nBot is now off ...", {
        ...(logMsgId && { reply_to_message_id: logMsgId }),
    })
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

function pollingError(error) {
    console.error("Polling error:", error.message || error);
}

process.on("SIGINT", sendBotOfflineMessage);

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
                "/sendgp — Envia mensagem para todos os grupos",
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
            const firstName = q.from.first_name;
            const devText =
                `Olá, <b>${firstName}</b>! Você é um dos desenvolvedores 🧑‍💻\n\n` +
                `Você está no painel do Toguro. Use os comandos com responsabilidade.`;
            await bot
                .editMessageText(devText, {
                    parse_mode: "HTML",
                    disable_web_page_preview: true,
                    chat_id: q.message.chat.id,
                    message_id: q.message.message_id,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "📦 Github", url: "https://github.com/leviobrabo/togurosbot" }],
                            [
                                { text: "📣 Canal", url: "https://t.me/lbrabo" },
                                { text: "👨‍💻 Suporte", url: "https://t.me/kylorensbot" },
                            ],
                            [{ text: "🗃 Comandos do Dev", callback_data: "dev_commands" }],
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

// ─── exports ──────────────────────────────────────────────────────────────────

exports.initHandler = () => {
    registerCallbackHandler();

    bot.on("message", main);
    bot.on("message", saveUserInformation);
    bot.on("polling_error", pollingError);
    bot.on("new_chat_members", saveNewChatMembers);
    bot.on("left_chat_member", removeLeftChatMember);

    bot.onText(/^\/start$/, start);
    bot.onText(/^\/stats$/, stats);
    bot.onText(/^\/grupos$/, groups);
    bot.onText(/^\/ban/, ban);
    bot.onText(/^\/unban/, unban);
    bot.onText(/^\/banned/, banned);
    bot.onText(/^\/delmsg/, removeMessage);
    bot.onText(/^\/devs/, devs);

    bot.onText(/\/ping/, async (msg) => {
        const start = new Date();
        const replied = await bot.sendMessage(msg.chat.id, "𝚙𝚘𝚗𝚐!");
        const ms = new Date() - start;
        await bot.editMessageText(
            `𝚙𝚒𝚗𝚐: \`${ms}𝚖𝚜\`\n𝚞𝚙𝚝𝚒𝚖𝚎: \`${timeFormatter(process.uptime())}\``,
            { chat_id: replied.chat.id, message_id: replied.message_id, parse_mode: "Markdown" }
        );
    });

    bot.onText(/^\/bc\b/, bc);
    bot.onText(/^\/broadcast\b/, broadcast);
    bot.onText(/^\/sendgp/, sendgp);

    // Status diário às 12:02
    new CronJob("02 00 12 * * *", sendStatus, null, true, "America/Sao_Paulo");

    // Ads para usuários: todo domingo às 10h
    new CronJob("0 0 10 * * 0", sendAdsToUsers, null, true, "America/Sao_Paulo");

    // Ads para grupos: quarta às 14h e sábado às 18h
    new CronJob("0 0 14 * * 3", sendAdsToGroups, null, true, "America/Sao_Paulo");
    new CronJob("0 0 18 * * 6", sendAdsToGroups, null, true, "America/Sao_Paulo");

    sendBotOnlineMessage();
};
