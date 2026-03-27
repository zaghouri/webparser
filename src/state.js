import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

export const STATE_PATH = fileURLToPath(
  new URL("../sitemap-state.json", import.meta.url)
);
export const MISSING_LASTMOD_SENTINEL = "__missing__";

export async function loadState(path = STATE_PATH) {
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
  } catch {
    // ignore corrupt state
  }
  return {};
}

export async function saveState(state, path = STATE_PATH) {
  const ordered = Object.fromEntries(
    Object.entries(state).sort(([a], [b]) => a.localeCompare(b))
  );
  await writeFile(path, JSON.stringify(ordered, null, 2), "utf8");
}

/**
 * Build next state from current sitemap rows (all URLs seen this run).
 */
export function buildStateFromSitemap(rows) {
  const next = {};
  for (const { url, lastmod } of rows) {
    next[url] = lastmod ?? MISSING_LASTMOD_SENTINEL;
  }
  return next;
}

/**
 * Decide which URLs to scrape. Sitemap lastmod is the only change signal.
 */
export function selectUrlsToScrape(rows, state, fullScrape, warnMissingLastmod) {
  if (fullScrape) {
    for (const { url, lastmod } of rows) {
      if (!lastmod) warnMissingLastmod(url);
    }
    return {
      queue: rows.map(({ url, lastmod }) => ({ url, lastmod, reason: "full" })),
      stats: {
        total: rows.length,
        new: rows.length,
        updated: 0,
        skipped: 0,
      },
    };
  }

  const queue = [];
  let newCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const { url, lastmod } of rows) {
    const prev = state[url];

    if (!lastmod) {
      warnMissingLastmod(url);
      queue.push({ url, lastmod: null, reason: "missing_lastmod" });
      if (prev === undefined) newCount++;
      else updatedCount++;
      continue;
    }

    if (prev === undefined) {
      queue.push({ url, lastmod, reason: "new" });
      newCount++;
      continue;
    }
    if (prev === MISSING_LASTMOD_SENTINEL) {
      queue.push({ url, lastmod, reason: "updated" });
      updatedCount++;
      continue;
    }
    if (prev !== lastmod) {
      queue.push({ url, lastmod, reason: "updated" });
      updatedCount++;
      continue;
    }
    skippedCount++;
  }

  return {
    queue,
    stats: {
      total: rows.length,
      new: newCount,
      updated: updatedCount,
      skipped: skippedCount,
    },
  };
}
