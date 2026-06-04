const { Schema } = require("mongoose");

const EmojiEntitySchema = new Schema(
  {
    o: { type: Number, required: true },
    l: { type: Number, default: 2 },
    i: { type: String, required: true },
  },
  { _id: false }
);

const ReplyItemSchema = new Schema(
  {
    v: { type: String, required: true },
    t: { type: Number, enum: [1, 2] },
    e: { type: [EmojiEntitySchema], default: undefined },
  },
  { _id: false, minimize: true }
);

const MessageSchema = new Schema(
  {
    l: { type: String, required: true, index: true },
    m: { type: String, required: true },
    r: { type: [ReplyItemSchema], default: [] },
  },
  { minimize: true }
);

MessageSchema.index({ l: 1, m: 1 }, { unique: true });
MessageSchema.index({ "r.v": 1 });

module.exports = MessageSchema;
