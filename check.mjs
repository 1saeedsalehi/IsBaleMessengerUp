import fs from "node:fs/promises";
import path from "node:path";

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
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const data = JSON.parse(raw);
    if (data.last === "up" || data.last === "down") return data.last;
  } catch {
    // missing or invalid — treat as up so first run does not blast "recovered" with sound
  }
  return "up";
}

/** @param {"up" | "down"} last */
async function writeLastState(last) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, `${JSON.stringify({ last })}\n`, "utf8");
}

/** @returns {Promise<{ ok: boolean; detail: string }>} */
async function probeUrl() {
  try {
    const res = await fetch(CHECK_URL, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "bale-uptime-checker/1.0 (GitHub Actions)" },
    });
    const detail = `HTTP ${res.status} ${res.statusText}`;
    if (!isSuccessStatus(res.status)) return { ok: false, detail };
    return { ok: true, detail };
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) };
  }
}

/** @param {{ silent?: boolean }} [opts] — silent: no sound (e.g. down alerts) */
async function sendTelegram(text, opts = {}) {
  const silent = Boolean(opts.silent);
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
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
}

async function main() {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (e.g. GitHub Actions secrets).");
    process.exit(1);
  }

  const last = await readLastState();
  const { ok: currentOk, detail } = await probeUrl();

  if (currentOk) {
    if (last === "down") {
      await sendTelegram(`✅ بله دوباره داره میبله! \n ${CHECK_URL}`, { silent: false });
      console.log("Telegram recovery notification (with sound) sent.");
    } else {
      console.log("Up (no change); skipping Telegram.");
    }
    await writeLastState("up");
  } else {

    await sendTelegram(`🔴 بله هنوز داره نمیبله!`, { silent: true });
    console.log("Telegram down notification (silent) sent.");
    await writeLastState("down");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
