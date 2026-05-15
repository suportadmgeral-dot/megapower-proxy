/**
 * Netlify Serverless Function — jackpot.js
 * Estratégia Mega Power — v7.0 — 15/05/2026
 *
 * FONTES (cascata):
 * 1. Texas Lottery — atualiza manhã seguinte ao sorteio, formato limpo
 * 2. NC Lottery — fallback confiável
 * 3. Virginia Lottery — fallback final
 *
 * CÂMBIO: exchangerate-api.com (gratuito, sem auth)
 */

const TX_PB = "https://www.texaslottery.com/export/sites/lottery/Games/Powerball/index.html";
const TX_MM = "https://www.texaslottery.com/export/sites/lottery/Games/Mega_Millions/index.html";
const NC_PB = "https://nclottery.com/powerball";
const NC_MM = "https://nclottery.com/megamillions";
const VA_PB = "https://www.valottery.com/data/draw-games/powerball";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

exports.handler = async function (event, context) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    "Cache-Control": "public, max-age=1800",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const [fx, lotteries] = await Promise.all([getFxRate(), getLotteryData()]);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        fx,
        powerball: lotteries.powerball,
        megamillions: lotteries.megamillions,
        source: lotteries.source,
        updatedAt: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error("jackpot error:", err.message);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        fx: 5.80,
        powerball: { jackpot: null, nextDraw: nextDate("powerball") },
        megamillions: { jackpot: null, nextDraw: nextDate("megamillions") },
        source: "error",
      }),
    };
  }
};

// ─── CÂMBIO ──────────────────────────────────────────────────────────────────

async function getFxRate() {
  for (const url of [
    "https://api.exchangerate-api.com/v4/latest/USD",
    "https://open.er-api.com/v6/latest/USD",
  ]) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "MegaPower/7.0" }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) continue;
      const d = await r.json();
      const rate = d.rates?.BRL ?? d.conversion_rates?.BRL;
      if (rate) return rate;
    } catch (_) {}
  }
  return 5.80;
}

// ─── JACKPOT ─────────────────────────────────────────────────────────────────

async function getLotteryData() {

  // ── FONTE 1: Texas Lottery ────────────────────────────────────────────────
  // Formato exato: "Current Est. Annuitized Jackpot for MM/DD/YYYY:\n$86 Million"
  try {
    const [pbR, mmR] = await Promise.allSettled([
      get(TX_PB), get(TX_MM)
    ]);
    const pb = pbR.status === "fulfilled" ? parseTX(pbR.value, "powerball") : null;
    const mm = mmR.status === "fulfilled" ? parseTX(mmR.value, "megamillions") : null;
    if (pb?.jackpot || mm?.jackpot) {
      return {
        powerball: pb || { jackpot: null, nextDraw: nextDate("powerball") },
        megamillions: mm || { jackpot: null, nextDraw: nextDate("megamillions") },
        source: "tx-lottery",
      };
    }
  } catch (e) { console.warn("TX:", e.message); }

  // ── FONTE 2: NC Lottery ───────────────────────────────────────────────────
  // Formato: "Jackpot Estimate $86 Million" / "Next Drawing Saturday, May. 16"
  try {
    const [pbR, mmR] = await Promise.allSettled([
      get(NC_PB), get(NC_MM)
    ]);
    const pb = pbR.status === "fulfilled" ? parseNC(pbR.value, "powerball") : null;
    const mm = mmR.status === "fulfilled" ? parseNC(mmR.value, "megamillions") : null;
    if (pb?.jackpot || mm?.jackpot) {
      return {
        powerball: pb || { jackpot: null, nextDraw: nextDate("powerball") },
        megamillions: mm || { jackpot: null, nextDraw: nextDate("megamillions") },
        source: "nc-lottery",
      };
    }
  } catch (e) { console.warn("NC:", e.message); }

  // ── FONTE 3: Virginia Lottery ─────────────────────────────────────────────
  // Formato: "$251 MILLION ... Next Drawing: Fri 05/15/2026"
  try {
    const html = await get(VA_PB);
    const pb = parseVA(html, "powerball");
    const mm = parseVA(html, "megamillions");
    if (pb.jackpot || mm.jackpot) {
      return { powerball: pb, megamillions: mm, source: "va-lottery" };
    }
  } catch (e) { console.warn("VA:", e.message); }

  return {
    powerball: { jackpot: null, nextDraw: nextDate("powerball") },
    megamillions: { jackpot: null, nextDraw: nextDate("megamillions") },
    source: "calendar-fallback",
  };
}

// ─── FETCH HELPER ─────────────────────────────────────────────────────────────

async function get(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

// ─── PARSER: TEXAS LOTTERY ────────────────────────────────────────────────────
// "Current Est. Annuitized Jackpot for 05/16/2026: $86 Million"

function parseTX(html, type) {
  let jackpot = null;
  let nextDraw = null;

  // Jackpot
  const bil = html.match(/Current Est\..*?Jackpot[^$]*\$([\d,.]+)\s*Billion/is);
  if (bil) jackpot = Math.round(parseFloat(bil[1].replace(/,/g, "")) * 1e9);

  if (!jackpot) {
    const mil = html.match(/Current Est\..*?Jackpot[^$]*\$([\d,.]+)\s*Million/is);
    if (mil) jackpot = Math.round(parseFloat(mil[1].replace(/,/g, "")) * 1e6);
  }

  // Data do sorteio: "for MM/DD/YYYY"
  const dm = html.match(/for\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (dm) {
    const [mo, dd, yyyy] = dm[1].split("/");
    nextDraw = `${yyyy}-${mo}-${dd}T22:59:00`;
  }

  if (!nextDraw) nextDraw = nextDate(type);
  return jackpot ? { jackpot, nextDraw } : null;
}

// ─── PARSER: NC LOTTERY ───────────────────────────────────────────────────────
// "Jackpot Estimate $86 Million" / "Next Drawing Saturday, May. 16, 10:59 PM"

function parseNC(html, type) {
  let jackpot = null;
  let nextDraw = null;

  const bil = html.match(/Jackpot Estimate[^$]*\$([\d,.]+)\s*Billion/i);
  if (bil) jackpot = Math.round(parseFloat(bil[1].replace(/,/g, "")) * 1e9);
  if (!jackpot) {
    const mil = html.match(/Jackpot Estimate[^$]*\$([\d,.]+)\s*Million/i);
    if (mil) jackpot = Math.round(parseFloat(mil[1].replace(/,/g, "")) * 1e6);
  }

  // "Next Drawing Saturday, May. 16, 10:59 PM"
  const dm = html.match(/Next Drawing\s+\w+,\s+(\w+)\.?\s+(\d{1,2})/i);
  if (dm) {
    const months = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12};
    const mo = months[dm[1].substring(0,3)];
    const dd = parseInt(dm[2], 10);
    if (mo && dd) {
      const yyyy = new Date().getFullYear();
      nextDraw = `${yyyy}-${String(mo).padStart(2,"0")}-${String(dd).padStart(2,"0")}T22:59:00`;
    }
  }

  if (!nextDraw) nextDraw = nextDate(type);
  return jackpot ? { jackpot, nextDraw } : null;
}

// ─── PARSER: VIRGINIA LOTTERY ────────────────────────────────────────────────
// "$251 MILLION ... Next Drawing: Fri 05/15/2026"

function parseVA(html, type) {
  const isPB = type === "powerball";
  const startRx = isPB ? /Powerball(?:Current|\s)/i : /mega\s+millions(?:Current|\s)/i;
  const startMatch = html.match(startRx);
  if (!startMatch) return { jackpot: null, nextDraw: nextDate(type) };

  const start = startMatch.index;
  const endRx = isPB ? /mega\s+millions/i : /Powerball/i;
  const after = html.substring(start + 15);
  const endMatch = after.match(endRx);
  const end = endMatch ? start + 15 + endMatch.index : Math.min(start + 800, html.length);
  const block = html.substring(start, end);

  let jackpot = null;
  const bil = block.match(/\$([\d,.]+)\s*BILLION/i);
  if (bil) jackpot = Math.round(parseFloat(bil[1].replace(/,/g, "")) * 1e9);
  if (!jackpot) {
    const mil = block.match(/\$([\d,.]+)\s*MILLION/i);
    if (mil) jackpot = Math.round(parseFloat(mil[1].replace(/,/g, "")) * 1e6);
  }

  let nextDraw = null;
  const dm = block.match(/Next Drawing[:\s]+\w{3}\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (dm) {
    const [mo, dd, yyyy] = dm[1].split("/");
    nextDraw = `${yyyy}-${mo}-${dd}T22:59:00`;
  }
  if (!nextDraw) nextDraw = nextDate(type);
  return { jackpot, nextDraw };
}

// ─── CALENDÁRIO FIXO ─────────────────────────────────────────────────────────
// Powerball: seg(1), qua(3), sáb(6) | Mega Millions: ter(2), sex(5) | EDT=UTC-4

function nextDate(type) {
  const days = type === "powerball" ? [1, 3, 6] : [2, 5];
  const etNow = new Date(Date.now() + (-4 * 60 * 60 * 1000));
  for (let i = 0; i < 7; i++) {
    const d = new Date(etNow);
    d.setDate(d.getDate() + i);
    if (!days.includes(d.getDay())) continue;
    if (i === 0 && etNow.getHours() >= 23) continue;
    const yyyy = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mo}-${dd}T22:59:00`;
  }
  return null;
}
