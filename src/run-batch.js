import "dotenv/config";
import { main as scrapeMain } from "./index.js";
import { main as syncMain } from "./sync-index.js";

/**
 * Run one incremental batch: scrape then sync.
 *
 * Intended usage:
 * - MAX_PER_RUN=15 node src/run-batch.js
 * - schedule every 15 minutes (cron / launchd / etc.)
 *
 * Notes:
 * - Scrape advances sitemap state only for successfully scraped URLs (in incremental mode).
 * - Sync uses the same MAX_PER_RUN cap and skips existing Woo products via wc-product-map.json.
 */
async function main() {
  await scrapeMain();
  await syncMain();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

