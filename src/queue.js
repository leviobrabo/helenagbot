class SimpleQueue {
  constructor(opts = {}) {
    this._concurrency = opts.concurrency || 1;
    this._interval = opts.interval || 0;
    this._intervalCap = opts.intervalCap || Infinity;
    this._running = 0;
    this._queue = [];
    this._intervalCount = 0;
    this._intervalTimer = null;
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
  concurrency: 5,
  interval: 1000,
  intervalCap: 10,
});

const lowQueue = new SimpleQueue({
  concurrency: 1,
  interval: 1000,
  intervalCap: 15,
});

const chatTimestamps = new Map();
const CHAT_THROTTLE_TTL = 60_000;
const GROUP_MIN_INTERVAL = 3000;
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

function setGlobal429(retryAfterSeconds) {
  const ms = (retryAfterSeconds + 1) * 1000;
  global429Until = Date.now() + ms;
  console.warn(`[QUEUE] 429 global — pausando low queue por ${retryAfterSeconds + 1}s`);

  lowQueue.pause();
  setTimeout(() => {
    lowQueue.start();
    console.log("[QUEUE] low queue retomada após 429");
  }, ms).unref();
}

function isGlobal429Paused() {
  return Date.now() < global429Until;
}

let campaignRunning = false;
let campaignName = "";

function setCampaignRunning(name) {
  if (campaignRunning) return false;
  campaignRunning = true;
  campaignName = name;
  console.log(`[CAMPAIGN] "${name}" iniciada — bloqueando outras campanhas`);
  return true;
}

function clearCampaignRunning() {
  console.log(`[CAMPAIGN] "${campaignName}" concluída — campanhas desbloqueadas`);
  campaignRunning = false;
  campaignName = "";
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
  setCampaignRunning,
  clearCampaignRunning,
  isCampaignRunning,
  getCampaignName,
  waitForChatThrottle,
};
