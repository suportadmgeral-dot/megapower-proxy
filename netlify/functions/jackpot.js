/**
 * Netlify Serverless Function — jackpot.js
 * Estratégia Mega Power — v8.0 — 15/05/2026
 *
 * FONTES: Texas Lottery (valor) + calendário fixo (data)
 * A data vem SEMPRE do calendário fixo EDT — mais confiável que parsear HTML.
 * O valor (jackpot em USD) vem da TX Lottery → NC Lottery → VA Lottery.
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
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

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
    console.error("error:", err.message);
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
      const r = await fetch(url, { headers: { "User-Agent": "MegaPower/8.0" }, signal: AbortSignal.timeout(5000) });
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
  // Buscar valores PB e MM em paralelo, cada um da melhor fonte disponível
  const [pbJackpot, mmJackpot] = await Promise.all([
    getJackpot("powerball"),
    getJackpot("megamillions"),
  ]);

  return {
    powerball: { jackpot: pbJackpot, nextDraw: nextDate("powerball") },
    megamillions: { jackpot: mmJackpot, nextDraw: nextDate("megamillions") },
    source: "tx-lottery",
  };
}

// Busca APENAS o valor do jackpot (data vem sempre do calendário fixo)
async function getJackpot(type) {
  const isPB = type === "powerball";

  // Fonte 1: Texas Lottery
  try {
    const url = isPB ? TX_PB : TX_MM;
    const html = await get(url);
    const val = extractMillions(html);
    if (val) return val;
  } catch (_) {}

  // Fonte 2: NC Lottery
  try {
    const url = isPB ? NC_PB : NC_MM;
    const html = await get(url);
    // NC usa "Jackpot Estimate $XX Million"
    const bil = html.match(/Jackpot Estimate[^$]*\$([\d,.]+)\s*Billion/i);
    if (bil) return Math.round(parseFloat(bil[1].replace(/,/g, "")) * 1e9);
    const mil = html.match(/Jackpot Estimate[^$]*\$([\d,.]+)\s*Million/i);
    if (mil) return Math.round(parseFloat(mil[1].replace(/,/g, "")) * 1e6);
  } catch (_) {}

  // Fonte 3: VA Lottery (só para o valor, não para a data)
  try {
    const html = await get(VA_PB);
    const startRx = isPB ? /Powerball(?:Current|\s)/i : /mega\s+millions(?:Current|\s)/i;
    const startMatch = html.match(startRx);
    if (startMatch) {
      const start = startMatch.index;
      const endRx = isPB ? /mega\s+millions/i : /Powerball/i;
      const after = html.substring(start + 15);
      const endMatch = after.match(endRx);
      const end = endMatch ? start + 15 + endMatch.index : Math.min(start + 600, html.length);
      const block = html.substring(start, end);
      const bil = block.match(/\$([\d,.]+)\s*BILLION/i);
      if (bil) return Math.round(parseFloat(bil[1].replace(/,/g, "")) * 1e9);
      const mil = block.match(/\$([\d,.]+)\s*MILLION/i);
      if (mil) return Math.round(parseFloat(mil[1].replace(/,/g, "")) * 1e6);
    }
  } catch (_) {}

  return null;
}

// Extrai valor em dólares de qualquer HTML da TX Lottery
// Formato: "Current Est. Annuitized Jackpot for MM/DD/YYYY: $86 Million"
function extractMillions(html) {
  const bil = html.match(/Current Est\..*?Jackpot[^$]*\$([\d,.]+)\s*Billion/is);
  if (bil) return Math.round(parseFloat(bil[1].replace(/,/g, "")) * 1e9);
  const mil = html.match(/Current Est\..*?Jackpot[^$]*\$([\d,.]+)\s*Million/is);
  if (mil) return Math.round(parseFloat(mil[1].replace(/,/g, "")) * 1e6);
  return null;
}

// ─── FETCH ───────────────────────────────────────────────────────────────────

async function get(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// ─── CALENDÁRIO FIXO ─────────────────────────────────────────────────────────
// Powerball: seg(1), qua(3), sáb(6) | Mega Millions: ter(2), sex(5)
// EDT = UTC-4 (mai–nov) | Sorteio encerra às 23h ET

function nextDate(type) {
  const days = type === "powerball" ? [1, 3, 6] : [2, 5];
  const etNow = new Date(Date.now() + (-4 * 60 * 60 * 1000));

  for (let i = 0; i < 7; i++) {
    const d = new Date(etNow);
    d.setDate(d.getDate() + i);
    if (!days.includes(d.getDay())) continue;
    // Só pula hoje se já passou das 23h ET (sorteio já encerrou)
    if (i === 0 && etNow.getHours() >= 23) continue;
    const yyyy = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mo}-${dd}T22:59:00`;
  }
  return null;
}
