// Colourdiam site sync: fetch the full loose-diamond catalogue (742 items) from
// www.colourdiam.com, enrich each stone with full specs from its detail page,
// cache the result to a local JSON file and serve it fast from memory.
//
// Usage:
//   node server/site-sync.js --enrich     # full sync (list + detail enrichment)
//   node server/site-sync.js              # list-only sync (faster)
//   node server/site-sync.js --status     # print cached inventory status
//
// Imported by server/index.js for /api/sync/site + startup load.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SITE = "https://www.colourdiam.com";
const SEARCH_PATH = "/Home/SearchDiamonds";
const DETAIL_PATH = (id) => `/diamonddetails/Menu Diamonds/${encodeURIComponent(id)}`;
const SITEMAP_URL = `${SITE}/sitemap.xml`;
const PRODUCT_SEARCH_PATH = "/Home/SearchProduct";
const JEWELLERY_DETAIL_PATH = (id) => `/productdetail/${encodeURIComponent(id)}`;
const UA = "colourdiam-messaging/1.0";

const DEFAULT_INVENTORY_FILE = path.join(__dirname, "inventory.json");
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const ENRICH_CONCURRENCY = 8;
const SAVE_EVERY = 50;

const COLOUR_EMOJI = {
  yellow: "💛", green: "💚", pink: "💗", blue: "💙", brown: "🤎", white: "🤍",
  gray: "🩶", grey: "🩶", orange: "🧡", red: "❤️", violet: "💜", purple: "💜",
  black: "🖤",
};
const COLOUR_BG = {
  yellow: "#f7e08a", green: "#cde8c4", pink: "#f5d7de", blue: "#cfdff5", brown: "#d9c5a8",
  white: "#eceae4", gray: "#d9d9d9", grey: "#d9d9d9", orange: "#fbe0c0", red: "#f2c3c3",
  violet: "#ddd2ef", purple: "#ddd2ef", black: "#c9c9c9",
};

export const syncConfig = {
  site: SITE,
  inventoryFile: process.env.INVENTORY_FILE || DEFAULT_INVENTORY_FILE,
  pageSize: Number(process.env.SYNC_PAGE_SIZE) || PAGE_SIZE,
  maxPages: Number(process.env.SYNC_MAX_PAGES) || MAX_PAGES,
  concurrency: Number(process.env.SYNC_CONCURRENCY) || ENRICH_CONCURRENCY,
};

let inventory = { at: 0, list: [], status: "idle", total: 0, enriched: 0, error: null, lastSync: null };
let syncRun = null;

/* ----------------------------- helpers ----------------------------- */

function log(...args) {
  console.log("[site-sync]", ...args);
}

function colourMeta(name) {
  const lower = name.toLowerCase();
  let found = "";
  for (const key of Object.keys(COLOUR_EMOJI)) {
    if (lower.includes(key)) { found = key; break; }
  }
  return { emoji: COLOUR_EMOJI[found] || "💎", bg: COLOUR_BG[found] || "#f3ead7", colorName: found || "white" };
}

function toHttps(p) {
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return p;
  if (p.startsWith("//")) return "https:" + p;
  if (p.startsWith("/")) return SITE + p;
  return p;
}

function clean(str) {
  return String(str || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/json" } });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
    } catch (err) {
      if (attempt === retries) throw err;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  throw new Error("fetch failed: " + url);
}

/* --------------------------- list fetching --------------------------- */

export async function fetchSitemapCategories() {
  const text = await fetchText(SITEMAP_URL);
  if (!text) return [];
  const slugs = new Set();
  for (const m of String(text).matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = m[1].trim();
    const u = url.split("#")[0].split("?")[0].replace(/\/+$/, "");
    const m2 = u.match(/\/product\/([^/]+)$/i);
    if (m2) slugs.add(decodeURIComponent(m2[1]));
  }
  return [...slugs];
}

export function jewellerySearchUrl(slug, page, pageSize = syncConfig.pageSize) {
  const q = new URLSearchParams({
    SubMenuName: slug, FromHome: "0", PageIndex: String(page), PageCount: String(pageSize), SortById: "",
    PriceFrm: "", PriceTo: "", PriceList: "", CaratList: "",
  });
  return `${SITE}${PRODUCT_SEARCH_PATH}?${q.toString()}`;
}

export async function fetchJewelleryByCategory(slug, { onProgress } = {}) {
  const seen = new Map();
  let total = 0;
  for (let page = 1; page <= syncConfig.maxPages; page++) {
    const text = await fetchText(jewellerySearchUrl(slug, page));
    if (!text) break;
    let data;
    try { data = JSON.parse(text); } catch { break; }
    const items = Array.isArray(data.searchProductsList) ? data.searchProductsList : [];
    if (!items.length) break;
    total = Number((items[0] && items[0].TotRec) || total) || total;
    for (const it of items) {
      const id = String(it.ProdId || "");
      if (id && !seen.has(id)) seen.set(id, it);
    }
    if (onProgress) onProgress(seen.size, total);
    if (seen.size >= total && total > 0) break;
    if (items.length < syncConfig.pageSize) break;
  }
  return { list: [...seen.values()], total };
}

export function searchUrl(page, pageSize = syncConfig.pageSize) {
  const q = new URLSearchParams({
    SubMenuName: "", FromHome: "", PageIndex: String(page), PageCount: String(pageSize), SortById: "",
    Shp: "", Col: "", Crt: "", Int: "", Cut: "", Pol: "", Sym: "", Fluo: "", Lab: "",
    PriceFrm: "", PriceTo: "", CtsFrm: "", CtsTo: "", PriceList: "", CaratList: "",
  });
  return `${SITE}${SEARCH_PATH}?${q.toString()}`;
}

export async function fetchAllDiamonds({ onProgress } = {}) {
  const seen = new Map();
  let total = 0;
  for (let page = 1; page <= syncConfig.maxPages; page++) {
    const text = await fetchText(searchUrl(page));
    if (!text) break;
    let data;
    try { data = JSON.parse(text); } catch { break; }
    const items = Array.isArray(data.SearchProductsList) ? data.SearchProductsList : [];
    if (!items.length) break;
    total = Number((items[0] && items[0].TotRec) || data.TotalCount || total) || total;
    for (const it of items) {
      const id = String(it.ProdId || "");
      if (id && !seen.has(id)) seen.set(id, it);
    }
    if (onProgress) onProgress(seen.size, total);
    if (seen.size >= total && total > 0) break;
    if (items.length < syncConfig.pageSize) break;
  }
  return { list: [...seen.values()], total };
}

/* --------------------------- detail parsing --------------------------- */

function grab(html, re) {
  const m = String(html).match(re);
  return m ? clean(m[1]) : "";
}

export function parseDiamondDetail(html) {
  if (!html || html.includes("pagenotfound")) return null;
  const spec = {};
  const table = String(html).match(/<tbody class="table-body">([\s\S]*?)<\/tbody>/i);
  const cells = table
    ? [...table[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => clean(m[1]))
    : [];
  if (!cells.length) return null;
  spec.shape = cells[0] || "";
  spec.carat = cells[1] || "";
  spec.color = cells[2] || "";
  spec.clarity = cells[3] || "";
  spec.measurement = cells[4] || "";
  spec.depth = cells[5] || "";
  spec.table = cells[6] || "";
  spec.ratio = cells[7] || "";
  spec.fluorescence = cells[8] || "";
  spec.polish = cells[9] || "";
  spec.symmetry = cells[10] || "";

  const name =
    grab(html, /property="og:title"\s+content="([^"]+)"/) ||
    grab(html, /<h3 class="product-name[^"]*">([\s\S]*?)<\/h3>/i);
  const priceMatch = String(html).match(/price-regular">\$([\d,]+)/i);
  const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;
  const certMatch = String(html).match(/CertModal\('([^']+)'\)/);
  const labMatch = String(html).match(/\/assets\/img\/Lab\/([A-Za-z0-9]+)\.png/i);
  const images = [...String(html).matchAll(/data-thumb="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => p && !p.includes("/assets/"));
  const still = String(html).match(/\/Product\/Diamond\/[^"?]+\/still\.jpg/i);
  if (!images.length && still) images.push(still[0]);

  return {
    name: name.replace(/\s*\|\s*ColourDiam\s*$/i, ""),
    price,
    shape: spec.shape,
    carat: spec.carat,
    colorGrade: spec.color,
    clarity: spec.clarity,
    measurement: spec.measurement,
    depth: spec.depth,
    tablePct: spec.table,
    ratio: spec.ratio,
    fluorescence: spec.fluorescence,
    polish: spec.polish,
    symmetry: spec.symmetry,
    lab: labMatch ? labMatch[1].toUpperCase() : "",
    certificate: certMatch && certMatch[1] ? certMatch[1] : "",
    images,
  };
}

export async function fetchDiamondDetail(id) {
  const text = await fetchText(SITE + DETAIL_PATH(id));
  return parseDiamondDetail(text);
}

/* ------------------------------ mapping ------------------------------ */

function parseCarat(name, fallback) {
  const m = String(name || "").match(/([\d.]+)\s*carat/i) || String(fallback || "").match(/^([\d.]+)/);
  return m ? m[1] : "";
}

export function mapDiamond(raw, detail) {
  const name = String(detail && detail.name ? detail.name : (raw.ProdName || "")).trim();
  const meta = colourMeta(name);
  const carat = parseCarat(name, detail && detail.carat);
  const real = (id) => id && !String(id).startsWith("/assets/");
  const imgPath = (detail && detail.images && detail.images[0]) ||
    (real(raw.ImgPath) ? raw.ImgPath : null);
  return {
    id: String(raw.ProdId || raw.TagNo || "cd-" + Math.random().toString(36).slice(2, 8)),
    name,
    type: "diamond",
    category: detail && detail.shape ? detail.shape : "Diamond",
    carat,
    price: Number(detail && detail.price ? detail.price : (raw.NewPrice || raw.OldPrice || 0)),
    oldPrice: Number(raw.OldPrice || 0),
    stock: "In stock",
    emoji: meta.emoji,
    color: meta.bg,
    colorName: meta.colorName,
    img: imgPath ? toHttps(imgPath) : null,
    shape: (detail && detail.shape) || "",
    clarity: (detail && detail.clarity) || "",
    colorGrade: (detail && detail.colorGrade) || "",
    lab: (detail && detail.lab) || "",
    polish: (detail && detail.polish) || "",
    symmetry: (detail && detail.symmetry) || "",
    fluorescence: (detail && detail.fluorescence) || "",
    measurement: (detail && detail.measurement) || "",
    depth: (detail && detail.depth) || "",
    tablePct: (detail && detail.tablePct) || "",
    ratio: (detail && detail.ratio) || "",
    certificate: detail && detail.certificate ? toHttps(detail.certificate) : null,
    images: (detail && detail.images ? detail.images : []).map(toHttps),
    detailUrl: toHttps(DETAIL_PATH(String(raw.ProdId || raw.TagNo || ""))),
    source: "colourdiam",
  };
}

/* ------------------------- jewellery parsing ------------------------- */

export function parseJewelleryDetail(html) {
  if (!html || html.includes("pagenotfound")) return null;
  const spec = { metal: "", purity: "", weight: "", shape: "", colour: "", pcs: "", cts: "" };
  const tables = String(html).matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi);
  for (const t of tables) {
    const body = t[1];
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => clean(m[1]));
    if (cells.length >= 3 && /^(Gold|White|Yellow|Rose|Platinum|Silver)/i.test(cells[0])) {
      spec.metal = cells[0];
      spec.purity = cells[1];
      spec.weight = cells[2];
      continue;
    }
    if (cells.some((c) => /^(Round|Princess|Emerald|Pear|Marquise|Oval|Cushion|Heart|Radiant|Asscher|Shield)$/i.test(c))) {
      const idx = cells.findIndex((c) => /^(Round|Princess|Emerald|Pear|Marquise|Oval|Cushion|Heart|Radiant|Asscher|Shield)$/i.test(c));
      spec.shape = cells[idx] || "";
      spec.colour = cells[idx + 1] || "";
      spec.pcs = cells[idx + 2] || "";
      spec.cts = cells[idx + 3] || "";
    }
  }
  const name =
    grab(html, /property="og:title"\s+content="([^"]+)"/) ||
    grab(html, /<h3 class="product-name[^"]*">([\s\S]*?)<\/h3>/i);
  const priceMatch = String(html).match(/price-regular">\$([\d,]+)/i);
  const price = priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : 0;
  const certMatch = String(html).match(/CertModal\('([^']+)'\)/);
  const labMatch = String(html).match(/\/assets\/img\/Lab\/([A-Za-z0-9]+)\.png/i);
  const images = [...String(html).matchAll(/data-thumb="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => p && !p.includes("/assets/"));
  const still = String(html).match(/\/Product\/Jewellery\/[^"?]+\/(?:still|center)\.jpg/i);
  if (!images.length && still) images.push(still[0]);

  return {
    name: name.replace(/\s*\|\s*ColourDiam\s*$/i, ""),
    price,
    metal: spec.metal,
    purity: spec.purity,
    weight: spec.weight,
    shape: spec.shape,
    colour: spec.colour,
    pcs: spec.pcs,
    cts: spec.cts,
    lab: labMatch ? labMatch[1].toUpperCase() : "",
    certificate: certMatch && certMatch[1] ? certMatch[1] : "",
    images,
  };
}

export async function fetchJewelleryDetail(id) {
  const text = await fetchText(SITE + JEWELLERY_DETAIL_PATH(id));
  return parseJewelleryDetail(text);
}

export function mapJewellery(raw, detail, categorySlug) {
  const name = String(detail && detail.name ? detail.name : (raw.ProdName || "")).trim();
  const meta = colourMeta(name);
  const carat = parseCarat(name, detail && detail.cts);
  const real = (id) => id && !String(id).startsWith("/assets/");
  const isCenter = (p) => /\/center(?:\.jpe?g)$/i.test(String(p || ""));
  const detailImgs = (detail && detail.images ? detail.images : []).map(toHttps);
  const mainImg =
    detailImgs.find(isCenter) ||
    detailImgs[0] ||
    toHttps(real(raw.ImgPath) ? raw.ImgPath : (real(raw.ModelImgPath) ? raw.ModelImgPath : null)) ||
    toHttps(Array.isArray(raw.ImgPathList) ? raw.ImgPathList.find(real) : null);
  return {
    id: String(raw.ProdId || raw.TagNo || "cd-" + Math.random().toString(36).slice(2, 8)),
    name,
    type: "jewelry",
    category: categorySlug || "Jewelry",
    carat,
    price: Number(detail && detail.price ? detail.price : (raw.NewPrice || raw.OldPrice || 0)),
    oldPrice: Number(raw.OldPrice || 0),
    stock: "In stock",
    emoji: meta.emoji,
    color: meta.bg,
    colorName: meta.colorName,
    img: mainImg || null,
    shape: (detail && detail.shape) || "",
    clarity: "",
    colorGrade: (detail && detail.colour) || "",
    lab: (detail && detail.lab) || "",
    polish: "",
    symmetry: "",
    fluorescence: "",
    measurement: "",
    depth: "",
    tablePct: "",
    ratio: "",
    metal: (detail && detail.metal) || "",
    purity: (detail && detail.purity) || "",
    weight: (detail && detail.weight) || "",
    certificate: detail && detail.certificate ? toHttps(detail.certificate) : null,
    images: (detail && detail.images ? detail.images : []).map(toHttps),
    detailUrl: toHttps(JEWELLERY_DETAIL_PATH(String(raw.ProdId || raw.TagNo || ""))),
    source: "colourdiam",
  };
}

/* ------------------------- persistence ------------------------- */

export function inventoryFile() {
  return syncConfig.inventoryFile;
}

export function loadInventoryFromDisk() {
  try {
    if (fs.existsSync(syncConfig.inventoryFile)) {
      const parsed = JSON.parse(fs.readFileSync(syncConfig.inventoryFile, "utf8"));
      if (parsed && Array.isArray(parsed.list)) {
        inventory = {
          ...inventory,
          ...parsed,
          status: parsed.status || "cached",
          error: parsed.error || null,
        };
      }
    }
  } catch (err) {
    inventory.error = "inventory load failed: " + err.message;
  }
  return inventory;
}

function saveInventory() {
  try {
    const tmp = syncConfig.inventoryFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(inventory, null, 2));
    fs.renameSync(tmp, syncConfig.inventoryFile);
  } catch (err) {
    inventory.error = "inventory save failed: " + err.message;
  }
}

/* ------------------------------ sync ------------------------------ */

export function getInventory() {
  return inventory;
}

export function getSyncStatus() {
  return {
    ok: true,
    status: inventory.status,
    total: inventory.total,
    count: inventory.list.length,
    enriched: inventory.enriched,
    at: inventory.at,
    lastSync: inventory.lastSync,
    error: inventory.error,
    running: !!syncRun,
  };
}

async function enrichList(list, onItem) {
  let next = 0;
  let done = 0;
  const results = new Array(list.length);
  const worker = async () => {
    while (next < list.length) {
      const idx = next++;
      const raw = list[idx];
      let detail = null;
      try {
        detail = await fetchDiamondDetail(raw.ProdId || raw.TagNo);
      } catch (err) {
        detail = null;
      }
      const mapped = mapDiamond(raw, detail);
      results[idx] = mapped;
      done++;
      if (onItem) onItem(mapped, done, list.length);
    }
  };
  await Promise.all(Array.from({ length: syncConfig.concurrency }, worker));
  return results;
}

export async function syncSite({ enrich = true, onProgress } = {}) {
  if (syncRun) return syncRun;
  syncRun = (async () => {
    const started = Date.now();
    inventory = { ...inventory, status: "syncing", error: null };
    try {
      log("fetching diamond list…");
      const { list, total } = await fetchAllDiamonds({
        onProgress: (n, t) => { if (onProgress) onProgress({ phase: "list", count: n, total: t }); },
      });
      inventory.total = total;
      log(`list complete: ${list.length} diamonds (site total ${total})`);

      let mapped;
      if (enrich) {
        log(`enriching ${list.length} diamonds from detail pages…`);
        const enrichedSoFar = [];
        mapped = await enrichList(list, (item, n, t) => {
          enrichedSoFar[n - 1] = item;
          if (onProgress) onProgress({ phase: "enrich", count: n, total: t });
          inventory.enriched = n;
          inventory.list = enrichedSoFar.filter(Boolean);
          if (n % SAVE_EVERY === 0) saveInventory();
        });
        inventory.enriched = mapped.filter((d) => d.clarity || d.shape).length;
      } else {
        mapped = list.map((raw) => mapDiamond(raw, null));
        inventory.enriched = 0;
      }

      const jewellery = await syncJewellery({ enrich, onProgress, diamondCount: mapped.length });
      inventory.list = [...mapped, ...jewellery];
      inventory.total = mapped.length + jewellery.length;
      inventory.status = "ready";
      inventory.at = Date.now();
      inventory.lastSync = new Date().toISOString();
      inventory.error = null;
      saveInventory();
      log(`done: ${mapped.length} diamonds + ${jewellery.length} jewellery in inventory, ${inventory.enriched} enriched (${Date.now() - started}ms)`);
      return inventory;
    } catch (err) {
      inventory.status = "error";
      inventory.error = String((err && err.message) || err);
      saveInventory();
      log("sync failed:", inventory.error);
      throw err;
    } finally {
      syncRun = null;
    }
  })();
  return syncRun;
}

export async function syncJewellery({ enrich = true, onProgress, diamondCount = 0 } = {}) {
  log("fetching jewellery categories from sitemap…");
  let slugs = await fetchSitemapCategories().catch((err) => {
    log("sitemap fetch failed:", (err && err.message) || err);
    return [];
  });
  const ITEM_CATS = new Set(["ring", "necklace", "pendant", "earring", "bracelet", "bangle", "brooch", "cufflink"]);
  const COLOR_PATTERN = /diamond jewelry$/i;
  const itemSlugs = slugs.filter((s) => ITEM_CATS.has(s.toLowerCase()));
  const colorSlugs = slugs.filter((s) => !ITEM_CATS.has(s.toLowerCase()) && COLOR_PATTERN.test(s));
  if (!itemSlugs.length) {
    log("no jewellery categories in sitemap — skipping jewellery sync");
    return [];
  }
  log(`sitemap: ${itemSlugs.length} item categories + ${colorSlugs.length} colour categories`);

  const rawByCategory = {};
  const allRaw = new Map();
  for (const slug of itemSlugs) {
    const { list, total } = await fetchJewelleryByCategory(slug, {
      onProgress: (n, t) => { if (onProgress) onProgress({ phase: "jewellery-list", category: slug, count: n, total: t }); },
    });
    log(`  ${slug}: ${list.length} items (site total ${total})`);
    rawByCategory[slug] = list;
    for (const it of list) allRaw.set(String(it.ProdId || ""), it);
  }

  const combined = [...allRaw.values()];
  if (!combined.length) {
    log("no jewellery items found");
    return [];
  }
  const categoryOf = (raw) => {
    for (const slug of itemSlugs) {
      if (rawByCategory[slug].some((x) => String(x.ProdId || "") === String(raw.ProdId || ""))) return slug;
    }
    return itemSlugs[0];
  };

  const mapped = [];
  let done = 0;
  if (enrich) {
    log(`enriching ${combined.length} jewellery items from detail pages…`);
    const results = new Array(combined.length);
    let next = 0;
    const worker = async () => {
      while (next < combined.length) {
        const idx = next++;
        const raw = combined[idx];
        let detail = null;
        try { detail = await fetchJewelleryDetail(raw.ProdId || raw.TagNo); } catch { detail = null; }
        const item = mapJewellery(raw, detail, categoryOf(raw));
        results[idx] = item;
        done++;
        if (onProgress) onProgress({ phase: "jewellery-enrich", count: done, total: combined.length });
      }
    };
    await Promise.all(Array.from({ length: syncConfig.concurrency }, worker));
    mapped.push(...results.filter(Boolean));
  } else {
    for (const raw of combined) mapped.push(mapJewellery(raw, null, categoryOf(raw)));
  }
  log(`jewellery complete: ${mapped.length} items (${diamondCount} diamonds already in inventory)`);
  return mapped;
}

/* ------------------------------ CLI ------------------------------ */

const isMain =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--status")) {
    loadInventoryFromDisk();
    console.log(JSON.stringify(getSyncStatus(), null, 2));
    process.exit(0);
  }
  const enrich = args.includes("--enrich");
  loadInventoryFromDisk();
  log(`starting ${enrich ? "full" : "list-only"} sync…`);
  syncSite({ enrich })
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
