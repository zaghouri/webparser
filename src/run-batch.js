import "dotenv/config";
import { existsSync } from "fs";
import { readFile, unlink, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import { main as scrapeMain } from "./index.js";
import { main as syncMain } from "./sync-index.js";

const LOCK_PATH = fileURLToPath(new URL("../.run-batch.lock", import.meta.url));

async function acquireLock() {
  if (existsSync(LOCK_PATH)) {
    try {
      const raw = await readFile(LOCK_PATH, "utf8");
      const pid = Number.parseInt(raw.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          console.error(
            `[run-batch] Another instance is already running (PID ${pid}). Run only one batch at a time (cron + manual, or two shells).`
          );
          process.exit(1);
        } catch (err) {
          if (err?.code === "ESRCH") {
            await unlink(LOCK_PATH);
          } else {
            throw err;
          }
        }
      } else {
        await unlink(LOCK_PATH);
      }
    } catch {
      await unlink(LOCK_PATH).catch(() => {});
    }
  }
  await writeFile(LOCK_PATH, `${process.pid}\n`, "utf8");
}

async function releaseLock() {
  await unlink(LOCK_PATH).catch(() => {});
}

/**
 * Run one incremental batch: scrape then sync.
 *
 * Intended usage:
 * - MAX_PER_RUN=15 node src/run-batch.js
 * - schedule every 15 minutes (cron / launchd / etc.)
 *
 * Notes:
 * - Scrape advances sitemap state only for successfully scraped URLs (incremental mode).
 * - Sync uses the same MAX_PER_RUN cap and skips existing Woo products via wc-product-map.json.
 * - A lock file prevents two batches from running at once (duplicate log lines).
 */
async function main() {
  await acquireLock();
  try {
    await scrapeMain();
    await syncMain();
  } finally {
    await releaseLock();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
