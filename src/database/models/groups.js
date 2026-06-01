const { Schema } = require("mongoose");

const ChatSchema = new Schema({
  chatId: { type: Number, required: true, unique: true, index: true },
  chatName: { type: String, required: true },
  chat_type: { type: String, default: "unknown", index: true },
  is_ban: { type: Boolean, default: false, index: true },
  lang_code: { type: String, default: "unknown", index: true },
  last_ad_sent: { type: Date, default: null, index: true },
  created_at: { type: Date, default: Date.now, index: true },
  first_seen_at: { type: Date, default: Date.now, index: true },
  last_seen_at: { type: Date, default: Date.now, index: true },
  activity_days: { type: [String], default: [], index: true },
});

module.exports = ChatSchema;
