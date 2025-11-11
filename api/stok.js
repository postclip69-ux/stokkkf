// api/stok.js
// Serverless (Vercel) – Normalisasi stok KHFY dan tangani kondisi "stok kosong" tanpa error.
// ENV opsional: UPSTREAM_URL, CORS_ORIGIN, FETCH_TIMEOUT_MS

const DEFAULT_UPSTREAM = process.env.UPSTREAM_URL
  || "https://panel.khfy-store.com/api_v3/cek_stock_akrab";

const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 10000);

function cors(req, res) {
  const origin = process.env.CORS_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
}

function toNumber(x) {
  if (x == null) return 0;
  if (typeof x === "number" && Number.isFinite(x)) return x;
  const n = parseInt(String(x).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

// Ekstrak list stok dari JSON bervariasi
function extractFromJSON(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw?.data) ? raw.data
           : Array.isArray(raw) ? raw
           : (raw?.items || raw?.result || raw?.rows || []);

  const out = [];
  for (const it of arr) {
    if (!it) continue;
    const lower = {}; for (const k in it) lower[k.toLowerCase()] = it[k];
    const sku = String(
      lower.sku || lower.kode || lower.code || lower.type || lower.product || lower.product_code || ""
    ).trim().toUpperCase();
    const name = String(lower.nama || lower.name || lower.title || lower.type || sku || "-").trim();
    let stock = lower.stock ?? lower.stok ?? lower.sisa ?? lower.sisa_slot ?? lower.slot ?? lower.qty ?? lower.quantity;
    stock = toNumber(stock);
    if (name || sku) out.push({ sku: sku || name, name: name || sku, stock });
  }
  return out;
}

// Parsir HTML tabel sederhana jika upstream mengembalikan halaman
function extractFromHTML(html) {
  if (typeof html !== "string" || !html) return [];
  const out = [];
  const rowRe = /<tr[^>]*>(.*?)<\/tr>/gis;
  let m;
  while ((m = rowRe.exec(html))) {
    const row = m[1];
    const cols = [...row.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gis)]
      .map(x => x[1].replace(/<[^>]*>/g, "").trim());
    if (cols.length >= 2 && cols[0] && /\d/.test(cols[1])) {
      out.push({ sku: cols[0].toUpperCase(), name: cols[0], stock: toNumber(cols[1]) });
    }
  }
  return out;
}

module.exports = async (req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const url = DEFAULT_UPSTREAM;

  // Timeout via AbortController
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { "accept": "application/json, text/html;q=0.9, */*;q=0.8" },
      signal: ac.signal
    }).catch(e => { throw e; });
    clearTimeout(timer);

    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }

    // Kumpulkan list dari JSON/HTML
    let list = extractFromJSON(json);
    if (!list.length) {
      const htmlList = extractFromHTML(text);
      if (htmlList.length) list = htmlList;
    }

    // --- JANGAN error ketika kosong --- //
    if (!list.length) {
      res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=60");
      return res.status(200).json({
        ok: true,
        count: 0,
        list: [],
        text: "(Info) Saat ini stok kosong / belum tersedia.\nSilakan cek lagi nanti.",
        upstream_ok: r.ok,
        upstream_status: r.status
      });
    }

    // Susun text block mirip WA
    const lines = list.map(it => `(${it.sku}) ${it.name} : ${toNumber(it.stock)}`);
    const textBlock = lines.join("\n");

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=300");
    return res.status(200).json({ ok: true, count: list.length, list, text: textBlock });
  } catch (e) {
    const isAbort = e && (e.name === "AbortError" || e.code === "ABORT_ERR");
    return res.status(isAbort ? 504 : 502).json({
      ok: false,
      error: isAbort ? "Timeout ke server supplier" : (e && e.message) || "Proxy error"
    });
  }
};
