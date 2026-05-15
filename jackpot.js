/**
 * Netlify Serverless Function — jackpot.js
 * Estratégia Mega Power — v5.0 — 15/05/2026
 *
 * FONTE: Virginia Lottery (valottery.com)
 * Testada e confirmada: retorna Powerball $86mi e Mega Millions $251mi corretamente.
 * Sem autenticação. Sem scraping frágil. Parser calibrado para o formato exato do site.
 *
 * CÂMBIO: exchangerate-api.com (gratuito, sem auth)
 * FALLBACK DE DATA: calendário fixo EDT quando o site não retorna data
 */

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
    const [fx, lotteries] = await Promise.all([
      getFxRate(),
      getLotteryData(),
    ]);

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
        powerball: { jackpot: null, nextDraw: getNextDrawDate("powerball") },
        megamillions: { jackpot: null, nextDraw: getNextDrawDate("megamillions") },
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
      const r = await fetch(url, {
        headers: { "User-Agent": "MegaPower/5.0" },
        signal: AbortSignal.timeout(5000),
      });
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
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // Fonte 1: página do Powerball na VA Lottery (tem PB + MM no mesmo HTML)
  try {
    const r = await fetch("https://www.valottery.com/data/draw-games/powerball", {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const html = await r.text();
      const pb = extractGame(html, "powerball");
      const mm = extractGame(html, "megamillions");
      if (pb.jackpot || mm.jackpot) {
        return { powerball: pb, megamillions: mm, source: "va-lottery-pb-page" };
      }
    }
  } catch (e) { console.warn("VA PB page:", e.message); }

  // Fonte 2: página do Mega Millions (fallback)
  try {
    const r = await fetch("https://www.valottery.com/data/draw-games/megamillions", {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const html = await r.text();
      const pb = extractGame(html, "powerball");
      const mm = extractGame(html, "megamillions");
      if (pb.jackpot || mm.jackpot) {
        return { powerball: pb, megamillions: mm, source: "va-lottery-mm-page" };
      }
    }
  } catch (e) { console.warn("VA MM page:", e.message); }

  // Fallback final: sem jackpot, só datas pelo calendário
  return {
    powerball: { jackpot: null, nextDraw: getNextDrawDate("powerball") },
    megamillions: { jackpot: null, nextDraw: getNextDrawDate("megamillions") },
    source: "calendar-fallback",
  };
}

// ─── PARSER ──────────────────────────────────────────────────────────────────
//
// O HTML da VA Lottery contém blocos como:
//   "mega millionsCurrent Estimated Jackpot$251 MILLION ... Next Drawing: Fri 05/15/2026"
//   "PowerballCurrent Estimated Jackpot$86 MILLION ... Next Drawing: Sat 05/16/2026"
//
// Estratégia: encontrar posição do jogo, extrair substring até o próximo jogo.

function extractGame(html, type) {
  const isPB = type === "powerball";

  // Localizar início do bloco
  const startRx = isPB ? /Powerball(?:Current|\s)/i : /mega\s+millions(?:Current|\s)/i;
  const startMatch = html.match(startRx);
  if (!startMatch) return { jackpot: null, nextDraw: getNextDrawDate(type) };

  const start = startMatch.index;

  // Localizar fim do bloco (próximo jogo diferente)
  const endRx = isPB
    ? /mega\s+millions/i
    : /Powerball/i;

  const afterStart = html.substring(start + 15);
  const endMatch = afterStart.match(endRx);
  const end = endMatch ? start + 15 + endMatch.index : Math.min(start + 800, html.length);

  const block = html.substring(start, end);

  // Jackpot — formato "$251 MILLION" ou "$1.2 BILLION"
  let jackpot = null;
  const bil = block.match(/\$([\d,.]+)\s*BILLION/i);
  if (bil) jackpot = Math.round(parseFloat(bil[1].replace(/,/g, "")) * 1e9);

  if (!jackpot) {
    const mil = block.match(/\$([\d,.]+)\s*MILLION/i);
    if (mil) jackpot = Math.round(parseFloat(mil[1].replace(/,/g, "")) * 1e6);
  }

  // Data — formato "Next Drawing: Sat 05/16/2026"
  let nextDraw = null;
  const dm = block.match(/Next Drawing[:\s]+\w{3}\s+(\d{2}\/\d{2}\/\d{4})/i);
  if (dm) {
    const [mo, dd, yyyy] = dm[1].split("/");
    nextDraw = `${yyyy}-${mo}-${dd}T22:59:00`;
  }

  if (!nextDraw) nextDraw = getNextDrawDate(type);

  return { jackpot, nextDraw };
}

// ─── CALENDÁRIO FIXO ─────────────────────────────────────────────────────────
// Powerball: seg(1), qua(3), sáb(6) | Mega Millions: ter(2), sex(5)
// EDT = UTC-4 (vigente mai–nov)

function getNextDrawDate(type) {
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
