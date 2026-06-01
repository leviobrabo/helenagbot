const { Schema } = require("mongoose");

const userSchema = new Schema({
  user_id: { type: Number, required: true, unique: true, index: true },
  username: { type: String },
  firstname: { type: String, required: true },
  lastname: { type: String },
  lang_code: { type: String, default: "unknown", index: true },
  is_dev: { type: Boolean, default: false, index: true },
  last_ad_sent: { type: Date, default: null, index: true },
  created_at: { type: Date, default: Date.now, index: true },
  first_seen_at: { type: Date, default: Date.now, index: true },
  last_seen_at: { type: Date, default: Date.now, index: true },
  activity_days: { type: [String], default: [], index: true },
  start_source: { type: String, default: "direct", index: true },
  first_action_at: { type: Date, default: null, index: true },
  first_action_type: { type: String, default: null },
  message_count: { type: Number, default: 0, index: true },
  last_donation_ask_month: { type: String, default: null, index: true },
  revenue_total: { type: Number, default: 0 },
  payment_count: { type: Number, default: 0 },
  is_paying: { type: Boolean, default: false, index: true },
  subscription_canceled_at: { type: Date, default: null, index: true },
  funnel: {
    entered_at: { type: Date, default: null },
    first_message_at: { type: Date, default: null },
    first_reply_at: { type: Date, default: null },
    added_group_at: { type: Date, default: null },
    donated_at: { type: Date, default: null },
  },
});

module.exports = userSchema;
