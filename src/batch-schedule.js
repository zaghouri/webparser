import { existsSync, statSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { fileURLToPath } from "url";

const SCHEDULE_STATE_PATH = fileURLToPath(
  new URL("../batch-schedule-state.json", import.meta.url)
);
const PRODUCT_CACHE_PATH = fileURLToPath(
  new URL("../product-sitemap-cache.json", import.meta.url)
);

function utcDayKey() {
  return new Date().toISOString().slice(0, 10);
}

function envTruthy(name) {
  const v = process.env[name];
  if (v === undefined || v === "") return false;
  return ["true", "1", "yes"].includes(String(v).trim().toLowerCase());
}

async function loadScheduleState() {
  if (!existsSync(SCHEDULE_STATE_PATH)) return {};
  try {
    const raw = await readFile(SCHEDULE_STATE_PATH, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Once per UTC calendar day: live sitemap discovery, write caches, full category + brand Woo sync.
 * Other runs: use cached sitemaps, skip category/brand sync, scrape + sync up to MAX_PER_RUN products.
 *
 * Override with DAILY_FULL_SYNC=true (force full) or FORCE_INCREMENTAL_SYNC=true (force incremental).
 */
export async function applyBatchScheduleEnv() {
  const state = await loadScheduleState();
  const today = utcDayKey();
  const lastFull = state.lastFullRunDay;

  const forceFull = envTruthy("DAILY_FULL_SYNC");
  const forceIncremental = envTruthy("FORCE_INCREMENTAL_SYNC");
  let hasProductCache = false;
  if (existsSync(PRODUCT_CACHE_PATH)) {
    try {
      hasProductCache = statSync(PRODUCT_CACHE_PATH).size > 4;
    } catch {
      hasProductCache = false;
    }
  }

  let isFullDay = false;
  if (forceIncremental && !forceFull) {
    isFullDay = false;
  } else if (forceFull) {
    isFullDay = true;
  } else if (lastFull !== today) {
    isFullDay = true;
  } else {
    isFullDay = false;
  }

  if (!isFullDay && !hasProductCache) {
    console.warn(
      "[schedule] No product-sitemap-cache.json (or empty); running full discovery + category/brand sync."
    );
    isFullDay = true;
  }

  if (isFullDay) {
    process.env.USE_CACHED_PRODUCT_SITEMAP = "false";
    process.env.USE_CACHED_CATEGORY_SITEMAP = "false";
    process.env.WRITE_PRODUCT_SITEMAP_CACHE = "true";
    process.env.WRITE_CATEGORY_SITEMAP_CACHE = "true";
    process.env.SKIP_CATEGORY_SYNC = "false";
    process.env.SKIP_BRAND_SYNC = "false";
    process.env.FULL_SCRAPE = "true";
    process.env.FULL_SYNC = "true";
  } else {
    process.env.USE_CACHED_PRODUCT_SITEMAP = "true";
    process.env.USE_CACHED_CATEGORY_SITEMAP = "true";
    process.env.WRITE_PRODUCT_SITEMAP_CACHE = "false";
    process.env.WRITE_CATEGORY_SITEMAP_CACHE = "false";
    process.env.SKIP_CATEGORY_SYNC = "true";
    process.env.SKIP_BRAND_SYNC = "true";
    process.env.FULL_SCRAPE = "false";
    process.env.FULL_SYNC = "false";
  }

  console.log(
    `[schedule] ${isFullDay ? "FULL (UTC day first run or forced): live sitemaps + category + brand sync" : "INCREMENTAL: cached sitemaps, products only"} (day=${today}, lastFull=${lastFull ?? "never"})`
  );

  if (
    process.env.PRODUCT_SYNC_BACKFILL === undefined ||
    process.env.PRODUCT_SYNC_BACKFILL === ""
  ) {
    process.env.PRODUCT_SYNC_BACKFILL = "true";
  }

  return { isFullDay, today };
}

export async function markFullRunCompletedIfApplicable(isFullDay, today) {
  if (!isFullDay || !today) return;
  const state = await loadScheduleState();
  state.lastFullRunDay = today;
  await writeFile(
    SCHEDULE_STATE_PATH,
    JSON.stringify(state, null, 2),
    "utf8"
  );
  console.log(`[schedule] Marked full run complete for UTC day ${today}.`);
}
