import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { loadState, selectUrlsToScrape } from "./state.js";
import { getCategoryUrlsForRun } from "./sitemap.js";
import { createWooClientFromEnv } from "./woocommerce-client.js";
import { mapCategoryToWooPayload } from "./sync-mappers.js";

const CATEGORIES_PATH = fileURLToPath(
  new URL("../categories.json", import.meta.url)
);
const CATEGORY_STATE_PATH = fileURLToPath(
  new URL("../category-sitemap-state.json", import.meta.url)
);
const WC_CATEGORY_MAP_PATH = fileURLToPath(
  new URL("../wc-category-map.json", import.meta.url)
);

function warnMissingLastmod(url) {
  console.warn(`[warn] Missing category <lastmod> for ${url}, syncing anyway.`);
}

function applyMaxCategories(rows) {
  const raw = process.env.MAX_CATEGORIES;
  if (raw === undefined || raw === "") return rows;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return rows;
  return rows.slice(0, n);
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

async function loadCategoryMap() {
  if (!existsSync(WC_CATEGORY_MAP_PATH)) return {};
  try {
    const raw = await readFile(WC_CATEGORY_MAP_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

async function saveCategoryMap(map) {
  const ordered = Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  );
  await writeFile(WC_CATEGORY_MAP_PATH, JSON.stringify(ordered, null, 2), "utf8");
}

async function findCategoryBySlug(client, slug) {
  const rows = await client.get("/products/categories", { slug, per_page: 100 });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

function isPlaceholderCategoryImage(url) {
  if (!url || typeof url !== "string") return false;
  return /kit-par-defaut/i.test(url);
}

function normalizeImageCandidate(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (isPlaceholderCategoryImage(trimmed)) return null;
  return trimmed;
}

function resolveCategoryImage(slug, categoriesBySlug, cache = new Map()) {
  if (!slug) return null;
  if (cache.has(slug)) return cache.get(slug);

  const category = categoriesBySlug.get(slug);
  if (!category) {
    cache.set(slug, null);
    return null;
  }

  const ownImage = normalizeImageCandidate(category.image);
  if (ownImage) {
    cache.set(slug, ownImage);
    return ownImage;
  }

  const parentSlug = category.parentSlug;
  if (!parentSlug || parentSlug === slug) {
    cache.set(slug, null);
    return null;
  }

  const inherited = resolveCategoryImage(parentSlug, categoriesBySlug, cache);
  cache.set(slug, inherited);
  return inherited;
}

async function upsertCategory(client, category, parentId, counters, fallbackImageSrc) {
  const payload = mapCategoryToWooPayload(category, parentId);
  const existing = await findCategoryBySlug(client, payload.slug);
  const endpoint = existing
    ? `/products/categories/${existing.id}`
    : "/products/categories";
  const method = existing ? "put" : "post";

  try {
    const result = await client[method](endpoint, payload);
    if (existing) counters.updated++;
    else counters.created++;
    return result;
  } catch (error) {
    const requestedImageSrc = payload?.image?.src ?? null;
    const canTryParent =
      fallbackImageSrc &&
      requestedImageSrc &&
      fallbackImageSrc !== requestedImageSrc;

    if (canTryParent) {
      const parentImagePayload = {
        ...payload,
        image: { src: fallbackImageSrc },
      };
      console.warn(
        `[warn] category ${payload.slug}: image rejected by Woo API, retrying with parent image.`
      );
      try {
        const parentImageResult = await client[method](endpoint, parentImagePayload);
        if (existing) counters.updated++;
        else counters.created++;
        return parentImageResult;
      } catch {
        // Continue to no-image fallback below.
      }
    }

    if (!payload.image) throw error;

    const noImagePayload = { ...payload };
    delete noImagePayload.image;
    console.warn(
      `[warn] category ${payload.slug}: image rejected by Woo API, retrying without image.`
    );
    const noImageResult = await client[method](endpoint, noImagePayload);
    if (existing) counters.updated++;
    else counters.created++;
    return noImageResult;
  }
}

export async function syncCategories() {
  const client = createWooClientFromEnv();
  const categories = await loadCategories();

  const allRows = await getCategoryUrlsForRun();
  const limitedRows = applyMaxCategories(allRows);
  const state = await loadState(CATEGORY_STATE_PATH);
  const fullSync = process.env.FULL_SYNC === "true";
  const { queue } = selectUrlsToScrape(limitedRows, state, fullSync, warnMissingLastmod);
  const queueSet = new Set(queue.map((item) => item.url));

  const targetCategories = categories.filter((category) => queueSet.has(category.url));
  const categoriesBySlug = new Map(
    targetCategories
      .filter((category) => typeof category?.slug === "string" && category.slug)
      .map((category) => [category.slug, category])
  );

  const categoryMap = await loadCategoryMap();
  const resolvedImageCache = new Map();
  const counters = {
    considered: 0,
    synced: 0,
    created: 0,
    updated: 0,
    skipped_by_filter: 0,
    failed: 0,
  };

  const pendingSlugs = new Set(categoriesBySlug.keys());
  while (pendingSlugs.size > 0) {
    let progressed = false;

    for (const slug of [...pendingSlugs]) {
      const category = categoriesBySlug.get(slug);
      if (!category) {
        pendingSlugs.delete(slug);
        continue;
      }

      const parentSlug = category.parentSlug;
      if (parentSlug && !categoryMap[parentSlug] && categoriesBySlug.has(parentSlug)) {
        continue;
      }

      counters.considered++;
      try {
        const parentId = parentSlug ? Number(categoryMap[parentSlug] ?? 0) : 0;
        const inheritedImage = resolveCategoryImage(
          slug,
          categoriesBySlug,
          resolvedImageCache
        );
        const parentImage = parentSlug
          ? resolveCategoryImage(parentSlug, categoriesBySlug, resolvedImageCache)
          : null;
        const categoryForSync = {
          ...category,
          image: inheritedImage,
        };
        const result = await upsertCategory(
          client,
          categoryForSync,
          parentId,
          counters,
          parentImage
        );
        if (result?.id) {
          categoryMap[slug] = result.id;
          counters.synced++;
        } else {
          counters.failed++;
          console.error(`[fail] category ${slug}: missing id in response`);
        }
      } catch (error) {
        counters.failed++;
        console.error(
          `[fail] category ${slug}:`,
          error?.response?.data?.message ?? error?.message ?? error
        );
      }

      pendingSlugs.delete(slug);
      progressed = true;
    }

    if (!progressed) {
      for (const slug of pendingSlugs) {
        counters.considered++;
        counters.failed++;
        console.error(
          `[fail] category ${slug}: unresolved parent dependency (${categoriesBySlug.get(slug)?.parentSlug ?? "none"})`
        );
      }
      break;
    }
  }

  await saveCategoryMap(categoryMap);

  return {
    counters,
    categoryMap,
  };
}
