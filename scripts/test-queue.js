const assert = require("assert");
const {
  queueHigh,
  queueLow,
  setGlobal429,
  setChat429,
  waitForGlobal429,
  waitForChatThrottle,
} = require("../src/queue");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testGlobal429PausesAndResumesQueues() {
  const ran = [];
  const keepAlive = setTimeout(() => {}, 3000);

  try {
    setGlobal429(1);
    const highJob = queueHigh(() => ran.push("high"));
    const lowJob = queueLow(() => ran.push("low"));

    await sleep(250);
    assert.deepStrictEqual(ran, [], "queued jobs must not run while global 429 is active");

    await waitForGlobal429();
    await Promise.all([highJob, lowJob]);

    assert.deepStrictEqual(
      ran.sort(),
      ["high", "low"],
      "queued jobs must resume after the global 429 pause"
    );
  } finally {
    clearTimeout(keepAlive);
  }
}

async function testGlobal429WaitIsImmediateWhenNotPaused() {
  const startedAt = Date.now();
  await waitForGlobal429();
  assert(Date.now() - startedAt < 100, "waitForGlobal429 should resolve immediately when not paused");
}

async function testChat429Cooldown() {
  setChat429(12345, 1);
  const startedAt = Date.now();
  await waitForChatThrottle(12345, false);
  assert(Date.now() - startedAt >= 1800, "chat-specific 429 must delay only that chat");
}

async function main() {
  await testGlobal429PausesAndResumesQueues();
  await testGlobal429WaitIsImmediateWhenNotPaused();
  await testChat429Cooldown();
  console.log("queue tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
