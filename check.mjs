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

function isSuccessStatus(status) {
  return status >= 200 && status < 400;
}

async function sendTelegram(text) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
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

  let status;
  let statusText;
  try {
    
    const res = await fetch(CHECK_URL, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "bale-uptime-checker/1.0 (GitHub Actions)" },
    });
    status = res.status;
    statusText = res.statusText;
  } catch (err) {
    console.log(`No HTTP success (timeout or error — expected): ${err.message}`);
    process.exit(0);
  }

  if (!isSuccessStatus(status)) {
    console.log(`HTTP ${status} ${statusText} — not 2xx/3xx, no Telegram message.`);
    process.exit(0);
  }

  const msg = `✅ ${CHECK_URL} responded\nHTTP ${status} ${statusText}`;
  await sendTelegram(msg);
  console.log("Telegram notification sent.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
