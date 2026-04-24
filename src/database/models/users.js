const { Schema } = require("mongoose");

const userSchema = new Schema({
    user_id: { type: Number, required: true, unique: true },
    username: { type: String },
    firstname: { type: String, required: true },
    lastname: { type: String },
    lang_code: { type: String, default: "unknown" },
    is_dev: { type: Boolean, default: false },
    last_ad_sent: { type: Date, default: null },
});

module.exports = userSchema;
