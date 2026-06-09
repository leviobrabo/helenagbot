require("dotenv").config();

const fs = require("fs");
const mongoose = require("mongoose");
const userSchema = require("../src/database/models/users");

const UserModel = mongoose.models.User || mongoose.model("User", userSchema);

const execute = process.argv.includes("--execute");

function dbString() {
  try {
    const envText = fs.readFileSync(".env", "utf8");
    const first = envText.split(/\r?\n/).find((line) => /^\s*DB_STRING=/.test(line));
    if (first) return first.replace(/^\s*DB_STRING=/, "").trim();
  } catch (_) {}
  return process.env.DB_STRING;
}

async function waitForDb() {
  if (mongoose.connection.readyState === 1) {
    return;
  }
  await mongoose.connect(dbString(), {
    serverSelectionTimeoutMS: 10000,
  });
}

async function main() {
  if (!dbString()) {
    throw new Error("Configure DB_STRING no ambiente.");
  }

  await waitForDb();

  const filter = {
    can_broadcast: { $ne: true },
    message_count: { $gt: 0 },
  };
  const count = await UserModel.countDocuments(filter);

  console.log(`[MARK-BROADCAST] candidatos=${count} modo=${execute ? "execute" : "dry-run"}`);
  if (!execute || count === 0) return;

  const result = await UserModel.updateMany(filter, [
    {
      $set: {
        can_broadcast: true,
        private_seen_at: { $ifNull: ["$private_seen_at", "$last_seen_at"] },
      },
    },
  ]);

  console.log(`[MARK-BROADCAST] atualizados=${result.modifiedCount || result.nModified || 0}`);
}

main()
  .catch((err) => {
    console.error(`[MARK-BROADCAST] erro: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
