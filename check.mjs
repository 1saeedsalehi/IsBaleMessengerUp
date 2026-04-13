import fs from "node:fs/promises";
import path from "node:path";

function log(...args) {
  console.log(new Date().toISOString(), "[uptime]", ...args);
}

function logError(...args) {
  console.error(new Date().toISOString(), "[uptime]", ...args);
}

const CHECK_URL =
  (process.env.CHECK_URL && process.env.CHECK_URL.trim()) || "https://web.bale.ai/";
const TIMEOUT_MS = (() => {
  const raw = process.env.TIMEOUT_MS?.trim();
  if (!raw) return 90_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 90_000;
})();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
/** Persisted between CI runs via actions/cache; default avoids repo root clutter */
const STATE_PATH =
  (process.env.STATE_PATH && process.env.STATE_PATH.trim()) ||
  path.join(".cache", "uptime-last-state.json");

function isSuccessStatus(status) {
  return status >= 200 && status < 400;
}

/** @returns {Promise<"up" | "down">} */
async function readLastState() {
  let raw;
  try {
    raw = await fs.readFile(STATE_PATH, "utf8");
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
    log(
      `readLastState: no cache file at ${STATE_PATH} (${code ?? err?.message ?? err}), defaulting to "up"`
    );
    return "up";
  }

  log(
    `readLastState: cache raw (${STATE_PATH}, ${raw.length} chars) ${JSON.stringify(raw)}`
  );

  let data;
  try {
    data = JSON.parse(raw);
  } catch (parseErr) {
    log(
      `readLastState: invalid JSON in cache, defaulting to "up": ${parseErr?.message ?? parseErr}`
    );
    return "up";
  }

  if (data.last === "up" || data.last === "down") {
    log(`readLastState: loaded "${data.last}" from ${STATE_PATH}`);
    return data.last;
  }
  log(`readLastState: invalid last field ${JSON.stringify(data)}, defaulting to "up"`);
  return "up";
}

/** @param {"up" | "down"} last */
async function writeLastState(last) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  const payload = `${JSON.stringify({ last })}\n`;
  await fs.writeFile(STATE_PATH, payload, "utf8");
  log(
    `writeLastState: persisted (${STATE_PATH}, ${payload.length} chars) ${JSON.stringify(payload)}`
  );
}

/** @returns {Promise<{ ok: boolean; detail: string }>} */
async function probeUrl() {
  log(`probeUrl: GET ${CHECK_URL} (timeout ${TIMEOUT_MS}ms)`);
  try {
    const res = await fetch(CHECK_URL, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "bale-uptime-checker/1.0 (GitHub Actions)" },
    });
    const detail = `HTTP ${res.status} ${res.statusText}`;
    if (!isSuccessStatus(res.status)) {
      log(`probeUrl: failure ${detail}`);
      return { ok: false, detail };
    }
    log(`probeUrl: success ${detail}`);
    return { ok: true, detail };
  } catch (err) {
    const detail = String(err?.message ?? err);
    log(`probeUrl: error ${detail}`);
    return { ok: false, detail };
  }
}

/** @param {{ silent?: boolean }} [opts] — silent: no sound (e.g. down alerts) */
async function sendTelegram(text, opts = {}) {
  const silent = Boolean(opts.silent);
  log(`sendTelegram: posting message (silent=${silent}, len=${text.length})`);
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
        disable_notification: silent,
      }),
    }
  );
  const body = await res.text();
  if (!res.ok) {
    logError(`sendTelegram: API error HTTP ${res.status}: ${body}`);
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
  log("sendTelegram: OK");
}

async function main() {
  log(
    `start: CHECK_URL=${CHECK_URL} TIMEOUT_MS=${TIMEOUT_MS} STATE_PATH=${STATE_PATH} TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID ? "(set)" : "(missing)"} TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN ? "(set)" : "(missing)"}`
  );

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logError("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (e.g. GitHub Actions secrets).");
    process.exit(1);
  }

  const last = await readLastState();
  const { ok: currentOk, detail } = await probeUrl();
  const current = currentOk ? "up" : "down";
  log(`decision: last=${last} current=${current} (${detail})`);

  if (currentOk) {
    if (last === "down") {
      log("notify: transition down → up (recovery, with sound)");
      await sendTelegram(`✅ بله دوباره داره میبله! \n ${CHECK_URL}`, { silent: false });
    } else {
      log("skip Telegram: still up (no state change)");
    }
    await writeLastState("up");
  } else {
    if (last === "up") {
      log("notify: transition up → down (silent alert)");
      await sendTelegram(`🔴 بله هنوز داره نمیبله!`, { silent: true });
    } else {
      log("skip Telegram: still down (no state change)");
    }
    await writeLastState("down");
  }

  log("done");
}

main().catch((err) => {
  logError("fatal:", err);
  process.exit(1);
});
