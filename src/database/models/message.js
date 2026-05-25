const { Schema } = require("mongoose");

const EmojiEntitySchema = new Schema({
  offset: { type: Number, required: true },
  length: { type: Number, default: 2 },
  custom_emoji_id: { type: String, required: true },
});

const ReplyItemSchema = new Schema({
  type: {
    type: String,
    enum: ["text", "sticker", "custom_emoji"],
    default: "text",
  },
  value: {
    type: String,
    required: true,
  },
  emoji_entities: {
    type: [EmojiEntitySchema],
    default: [],
  },
});

const MessageSchema = new Schema({
  message: {
    unique: true,
    required: true,
    type: String,
  },
  reply: {
    type: [ReplyItemSchema],
    default: [],
  },
});

module.exports = MessageSchema;
