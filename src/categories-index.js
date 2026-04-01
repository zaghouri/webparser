import "dotenv/config";
import { isMain } from "./is-main.js";
import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import pLimit from "p-limit";
import { getCategoryUrls } from "./sitemap.js";
import {
  loadState,
  saveState,
  buildStateFromSitemap,
  selectUrlsToScrape,
} from "./state.js";
import { scrapeCategory } from "./scrape-category.js";

const CATEGORIES_PATH = fileURLToPath(
  new URL("../categories.json", import.meta.url)
);
const CATEGORY_STATE_PATH = fileURLToPath(
  new URL("../category-sitemap-state.json", import.meta.url)
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

function applyMaxCategories(rows) {
  const raw = process.env.MAX_CATEGORIES;
  if (raw === undefined || raw === "") return rows;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    console.warn(`[warn] Invalid MAX_CATEGORIES="${raw}", ignoring.`);
    return rows;
  }
  const sliced = rows.slice(0, n);
  console.log(
    `[limit] MAX_CATEGORIES=${n} — processing ${sliced.length} of ${rows.length} category URLs from sitemap.`
  );
  return sliced;
}

async function loadCategories() {
  if (!existsSync(CATEGORIES_PATH)) return [];
  try {
    const raw = await readFile(CATEGORIES_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function mergeCategories(existingList, scrapedByUrl) {
  const map = new Map();
  for (const c of existingList) {
    if (c && typeof c.url === "string") map.set(c.url, c);
  }
  for (const [url, c] of scrapedByUrl) {
    map.set(url, c);
  }
  return [...map.values()].sort((a, b) => a.url.localeCompare(b.url));
}

function warnMissingLastmod(url) {
  console.warn(
    `[warn] <lastmod> missing in category sitemap for ${url}; scraping anyway.`
  );
}

export async function main() {
  const t0 = performance.now();
  const fullScrape = process.env.FULL_SCRAPE === "true";
  console.log(`Starting category scrape (FULL_SCRAPE=${fullScrape})`);

  const allRows = await getCategoryUrls();
  const rows = applyMaxCategories(allRows);
  const state = await loadState(CATEGORY_STATE_PATH);

  const { queue, stats } = selectUrlsToScrape(
    rows,
    state,
    fullScrape,
    warnMissingLastmod
  );

  console.log(
    `Category sitemap: total URLs=${stats.total}, new=${stats.new}, updated=${stats.updated}, skipped=${stats.skipped}`
  );

  const existing = await loadCategories();
  const scrapedByUrl = new Map();
  let failed = 0;

  const limit = pLimit(CONCURRENCY);
  const tasks = queue.map((item, index) =>
    limit(async () => {
      const n = index + 1;
      const total = queue.length;
      console.log(`[${n}/${total}] ${item.url}`);
      try {
        const category = await scrapeCategory(item.url);
        scrapedByUrl.set(item.url, category);
      } catch (err) {
        failed++;
        console.error(`[fail] ${item.url}:`, err?.message ?? err);
      }
    })
  );

  await Promise.all(tasks);

  const merged = mergeCategories(existing, scrapedByUrl);
  await writeFile(CATEGORIES_PATH, JSON.stringify(merged, null, 2), "utf8");

  const nextState = buildStateFromSitemap(rows);
  await saveState(nextState, CATEGORY_STATE_PATH);

  const totalMs = performance.now() - t0;
  console.log(
    `Done. Wrote ${merged.length} categories to categories.json, state updated (${Object.keys(nextState).length} URLs). Failed scrapes: ${failed}.`
  );
  console.log(`[timing] Category run total: ${formatDuration(totalMs)}`);
}

if (isMain(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
