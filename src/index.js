import "dotenv/config";
import { isMain } from "./is-main.js";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import pLimit from "p-limit";
import { getProductUrlsForRun } from "./sitemap.js";
import {
  loadState,
  saveState,
  buildStateFromSitemap,
  selectUrlsToScrape,
  STATE_PATH,
} from "./state.js";
import { scrapeProduct } from "./scrape.js";

const PRODUCTS_PATH = fileURLToPath(
  new URL("../products.json", import.meta.url)
);
const CONCURRENCY = 6;

function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  return `${m}m ${rs}s`;
}

/**
 * Extrapolate wall-clock scrape time for the full catalog from a sample run.
 * Uses batch count (ceil(n / concurrency)) since tasks run in parallel waves.
 */
function estimateFullScrapeMs({
  scrapeMs,
  queuedCount,
  fullCatalogCount,
}) {
  if (scrapeMs <= 0 || queuedCount <= 0 || fullCatalogCount <= 0) return null;
  const wavesSample = Math.ceil(queuedCount / CONCURRENCY);
  const wavesFull = Math.ceil(fullCatalogCount / CONCURRENCY);
  if (wavesSample <= 0) return null;
  return scrapeMs * (wavesFull / wavesSample);
}

/** Optional cap for dry runs (e.g. `MAX_PRODUCTS=10`). Full sitemap is still fetched first. */
function applyMaxProducts(rows) {
  const raw = process.env.MAX_PRODUCTS;
  if (raw === undefined || raw === "") return rows;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(`[warn] Invalid MAX_PRODUCTS="${raw}", ignoring.`);
    return rows;
  }
  const sliced = rows.slice(0, n);
  console.log(
    `[limit] MAX_PRODUCTS=${n} — processing ${sliced.length} of ${rows.length} product URLs from sitemap.`
  );
  return sliced;
}

function applyMaxPerRun(queue) {
  const raw = process.env.MAX_PER_RUN;
  if (raw === undefined || raw === "") return queue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(`[warn] Invalid MAX_PER_RUN="${raw}", ignoring.`);
    return queue;
  }
  const sliced = queue.slice(0, n);
  console.log(
    `[limit] MAX_PER_RUN=${n} — processing ${sliced.length} of ${queue.length} queued product URLs.`
  );
  return sliced;
}

async function loadProducts() {
  if (!existsSync(PRODUCTS_PATH)) return [];
  try {
    const raw = await readFile(PRODUCTS_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}

function mergeProducts(existingList, scrapedByUrl) {
  const map = new Map();
  for (const p of existingList) {
    if (p && typeof p.url === "string") map.set(p.url, p);
  }
  for (const [url, p] of scrapedByUrl) {
    map.set(url, p);
  }
  return [...map.values()].sort((a, b) => a.url.localeCompare(b.url));
}

function warnMissingLastmod(url) {
  console.warn(
    `[warn] <lastmod> missing in sitemap for ${url}; scraping anyway (no HTML-based change detection).`
  );
}

export async function main() {
  const t0 = performance.now();
  const fullScrape = process.env.FULL_SCRAPE === "true";
  console.log(`Starting scrape (FULL_SCRAPE=${fullScrape})`);

  const allRows = await getProductUrlsForRun();
  const fullCatalogCount = allRows.length;
  const tAfterDiscovery = performance.now();

  const rows = applyMaxProducts(allRows);
  const state = await loadState(STATE_PATH);

  const { queue, stats } = selectUrlsToScrape(
    rows,
    state,
    fullScrape,
    warnMissingLastmod
  );

  console.log(
    `Sitemap: total URLs=${stats.total}, new=${stats.new}, updated=${stats.updated}, skipped=${stats.skipped}`
  );

  const limitedQueue = applyMaxPerRun(queue);

  const existing = await loadProducts();
  const scrapedByUrl = new Map();
  let failed = 0;

  const limit = pLimit(CONCURRENCY);
  const tasks = limitedQueue.map((item, index) =>
    limit(async () => {
      const n = index + 1;
      const total = limitedQueue.length;
      console.log(`[${n}/${total}] ${item.url}`);
      try {
        const product = await scrapeProduct(item.url);
        scrapedByUrl.set(item.url, product);
      } catch (err) {
        failed++;
        console.error(
          `[fail] ${item.url}:`,
          err?.message ?? err
        );
      }
    })
  );

  await Promise.all(tasks);
  const tAfterScrape = performance.now();

  const merged = mergeProducts(existing, scrapedByUrl);
  await writeFile(
    PRODUCTS_PATH,
    JSON.stringify(merged, null, 2),
    "utf8"
  );

  // Incremental batch runs must only advance state for URLs we actually processed successfully.
  // Otherwise we'd "ack" URLs we haven't scraped yet and they'd never be picked up later.
  let nextState;
  if (fullScrape) {
    nextState = buildStateFromSitemap(rows);
  } else {
    nextState = { ...state };
    const rowByUrl = new Map(rows.map((r) => [r.url, r]));
    for (const url of scrapedByUrl.keys()) {
      const row = rowByUrl.get(url);
      if (!row) continue;
      nextState[url] = row.lastmod ?? "__missing__";
    }
  }
  await saveState(nextState, STATE_PATH);

  const tEnd = performance.now();
  const discoveryMs = tAfterDiscovery - t0;
  const scrapeMs = tAfterScrape - tAfterDiscovery;
  const totalMs = tEnd - t0;
  const queuedCount = limitedQueue.length;

  console.log(
    `Done. Wrote ${merged.length} products to products.json, state updated (${Object.keys(nextState).length} URLs). Failed scrapes: ${failed}.`
  );
  console.log(
    `[timing] Discovery (all sitemaps): ${formatDuration(discoveryMs)}`
  );
  console.log(
    `[timing] Scrape (${queuedCount} product pages @ concurrency ${CONCURRENCY}): ${formatDuration(scrapeMs)}`
  );
  console.log(`[timing] Total (including save): ${formatDuration(totalMs)}`);

  if (queuedCount === 0 && fullCatalogCount > 0) {
    console.log(
      `[timing] No product pages scraped (incremental skip or empty queue). To measure scrape speed on a sample, run: FULL_SCRAPE=true MAX_PRODUCTS=10 node src/index.js`
    );
  }

  if (fullCatalogCount > 0 && queuedCount > 0) {
    const estScrapeFull = estimateFullScrapeMs({
      scrapeMs,
      queuedCount,
      fullCatalogCount,
    });
    if (estScrapeFull != null && fullCatalogCount !== queuedCount) {
      const estTotalFull = discoveryMs + estScrapeFull;
      console.log(
        `[timing] Full-store estimate (${fullCatalogCount} products, same network/server): discovery ${formatDuration(discoveryMs)} + ~${formatDuration(estScrapeFull)} scrape ≈ ${formatDuration(estTotalFull)} total`
      );
      console.log(
        `[timing] (Extrapolated from this run’s scrape waves; real full run may vary.)`
      );
    } else if (fullCatalogCount === queuedCount && queuedCount > 0) {
      console.log(
        `[timing] Full catalog was scraped this run (${fullCatalogCount} URLs); total wall time is the full-store time.`
      );
    }
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
