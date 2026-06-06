class SimpleQueue {
  constructor(opts = {}) {
    this._concurrency = opts.concurrency || 1;
    this._interval = opts.interval || 0;
    this._intervalCap = opts.intervalCap || Infinity;
    this._running = 0;
    this._queue = [];
    this._intervalCount = 0;
    this._intervalTimer = null;
    this._paused = false;

    if (this._interval > 0) {
      this._intervalTimer = setInterval(() => {
        this._intervalCount = 0;
        this._tryRun();
      }, this._interval);
      if (this._intervalTimer.unref) this._intervalTimer.unref();
    }
  }

  add(fn, opts = {}) {
    return new Promise((resolve, reject) => {
      const priority = opts.priority || 0;
      this._queue.push({ fn, resolve, reject, priority });
      this._queue.sort((a, b) => b.priority - a.priority);
      this._tryRun();
    });
  }

  _tryRun() {
    while (
      !this._paused &&
      this._queue.length > 0 &&
      this._running < this._concurrency &&
      this._intervalCount < this._intervalCap
    ) {
      this._running++;
      this._intervalCount++;
      const { fn, resolve, reject } = this._queue.shift();
      Promise.resolve()
        .then(() => fn())
        .then(resolve)
        .catch(reject)
        .finally(() => {
          this._running--;
          this._tryRun();
        });
    }
  }

  pause() {
    this._paused = true;
  }

  start() {
    this._paused = false;
    this._tryRun();
  }

  get size() {
    return this._queue.length + this._running;
  }
}

const highQueue = new SimpleQueue({
  concurrency: 3,
  interval: 1000,
  intervalCap: 25,
});

const lowQueue = new SimpleQueue({
  concurrency: 1,
  interval: 1000,
  intervalCap: 25,
});

const chatTimestamps = new Map();
const CHAT_THROTTLE_TTL = 60_000;
const GROUP_MIN_INTERVAL = 3200;
const PRIVATE_MIN_INTERVAL = 1050;

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of chatTimestamps) {
    if (now - ts > CHAT_THROTTLE_TTL) chatTimestamps.delete(key);
  }
}, 60_000).unref();

async function waitForChatThrottle(chatId, isGroup) {
  const key = chatId;
  const minInterval = isGroup ? GROUP_MIN_INTERVAL : PRIVATE_MIN_INTERVAL;
  const now = Date.now();
  const lastSent = chatTimestamps.get(key) || 0;
  const elapsed = now - lastSent;

  if (elapsed < minInterval) {
    await new Promise((r) => setTimeout(r, minInterval - elapsed));
  }

  chatTimestamps.set(key, Date.now());
}

let global429Until = 0;
let global429Timer = null;
let global429Waiters = [];

function releaseGlobal429Waiters() {
  const waiters = global429Waiters;
  global429Waiters = [];
  waiters.forEach((resolve) => resolve());
}

function scheduleGlobal429Release(ms) {
  if (global429Timer) clearTimeout(global429Timer);
  global429Timer = setTimeout(() => {
    global429Timer = null;
    const remaining = global429Until - Date.now();
    if (remaining > 0) {
      scheduleGlobal429Release(remaining);
      return;
    }
    highQueue.start();
    lowQueue.start();
    releaseGlobal429Waiters();
    console.log("[QUEUE] envios retomados apos 429");
  }, ms);
  if (global429Timer.unref) global429Timer.unref();
}

function setGlobal429(retryAfterSeconds) {
  const retry = Math.max(1, Number(retryAfterSeconds) || 5);
  const ms = (retry + 1) * 1000;
  const until = Date.now() + ms;
  const extended = until > global429Until + 500;
  global429Until = Math.max(global429Until, until);

  if (!extended) return;

  console.warn(`[QUEUE] 429 global - pausando envios por ${retry + 1}s`);
  highQueue.pause();
  lowQueue.pause();
  scheduleGlobal429Release(ms);
}

function isGlobal429Paused() {
  return Date.now() < global429Until;
}

function waitForGlobal429() {
  if (!isGlobal429Paused()) return Promise.resolve();
  return new Promise((resolve) => {
    global429Waiters.push(resolve);
  });
}

let campaignRunning = false;
let campaignName = "";
let campaignStartedAt = 0;
let campaignHeartbeatAt = 0;
const CAMPAIGN_LOCK_MAX_MS = 24 * 60 * 60 * 1000;

function setCampaignRunning(name) {
  if (campaignRunning && Date.now() - campaignHeartbeatAt > CAMPAIGN_LOCK_MAX_MS) {
    console.warn(`[CAMPAIGN] "${campaignName}" expirou por timeout - liberando lock antigo`);
    campaignRunning = false;
    campaignName = "";
    campaignStartedAt = 0;
    campaignHeartbeatAt = 0;
  }
  if (campaignRunning) return false;

  campaignRunning = true;
  campaignName = name;
  campaignStartedAt = Date.now();
  campaignHeartbeatAt = campaignStartedAt;
  console.log(`[CAMPAIGN] "${name}" iniciada - bloqueando outras campanhas`);
  return true;
}

function touchCampaignRunning() {
  if (campaignRunning) campaignHeartbeatAt = Date.now();
}

function clearCampaignRunning() {
  console.log(`[CAMPAIGN] "${campaignName}" concluida - campanhas desbloqueadas`);
  campaignRunning = false;
  campaignName = "";
  campaignStartedAt = 0;
  campaignHeartbeatAt = 0;
}

function isCampaignRunning() {
  return campaignRunning;
}

function getCampaignName() {
  return campaignName;
}

function queueHigh(fn, priority = 10) {
  return highQueue.add(fn, { priority });
}

function queueLow(fn, priority = 1) {
  return lowQueue.add(fn, { priority });
}

module.exports = {
  highQueue,
  lowQueue,
  queueHigh,
  queueLow,
  setGlobal429,
  isGlobal429Paused,
  waitForGlobal429,
  setCampaignRunning,
  clearCampaignRunning,
  touchCampaignRunning,
  isCampaignRunning,
  getCampaignName,
  waitForChatThrottle,
};
