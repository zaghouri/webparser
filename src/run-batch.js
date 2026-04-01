import "dotenv/config";
import { existsSync } from "fs";
import { readFile, unlink, writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import {
  applyBatchScheduleEnv,
  markFullRunCompletedIfApplicable,
} from "./batch-schedule.js";
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
 * Scrape then WooCommerce sync.
 *
 * Schedule (UTC calendar day, see src/batch-schedule.js):
 * - First successful run each day: live product + category sitemap fetch, write caches,
 *   full category + brand sync, FULL_SCRAPE + FULL_SYNC.
 * - Later runs same day: cached sitemaps, skip category/brand sync, incremental scrape + product sync.
 *
 * Env: MAX_PER_RUN (e.g. 15), DAILY_FULL_SYNC / FORCE_INCREMENTAL_SYNC overrides.
 * Lock file prevents overlapping cron + manual runs.
 */
async function main() {
  await acquireLock();
  const { isFullDay, today } = await applyBatchScheduleEnv();
  let ok = false;
  try {
    await scrapeMain();
    await syncMain();
    ok = true;
  } finally {
    if (ok && isFullDay) {
      await markFullRunCompletedIfApplicable(isFullDay, today);
    }
    await releaseLock();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
