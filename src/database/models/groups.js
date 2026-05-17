const { Schema } = require("mongoose");

const ChatSchema = new Schema({
  chatId: { type: Number, required: true, unique: true },
  chatName: { type: String, required: true },
  chat_type: { type: String, default: "unknown" },
  is_ban: { type: Boolean, default: false },
  lang_code: { type: String, default: "unknown" },
  last_ad_sent: { type: Date, default: null },
});

module.exports = ChatSchema;
