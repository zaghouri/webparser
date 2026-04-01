import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import {
  loadState,
  selectUrlsToScrape,
  STATE_PATH as PRODUCT_STATE_PATH,
} from "./state.js";
import { getProductUrls } from "./sitemap.js";
import { createWooClientFromEnv } from "./woocommerce-client.js";
import {
  mapProductToWooPayload,
  parseSlugFromUrl,
  defaultProductSlug,
  shortSlugDisambiguator,
  shouldSkipProduct,
} from "./sync-mappers.js";
import { formatBrandName } from "./brand-format.js";

const PRODUCTS_PATH = fileURLToPath(new URL("../products.json", import.meta.url));
const CATEGORIES_PATH = fileURLToPath(
  new URL("../categories.json", import.meta.url)
);
const WC_PRODUCT_MAP_PATH = fileURLToPath(
  new URL("../wc-product-map.json", import.meta.url)
);

/** When true, products already in Woo (`wc-product-map.json` or slug match) are skipped (no PUT). */
const SKIP_EXISTING_PRODUCTS = true;

function applyMaxPerRun(items) {
  const raw = process.env.MAX_PER_RUN;
  if (raw === undefined || raw === "") return items;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return items;
  return items.slice(0, n);
}

function warnMissingLastmod(url) {
  console.warn(`[warn] Missing product <lastmod> for ${url}, syncing anyway.`);
}

function applyMaxProducts(rows) {
  const raw = process.env.MAX_PRODUCTS;
  if (raw === undefined || raw === "") return rows;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return rows;
  return rows.slice(0, n);
}

async function loadJsonArray(path) {
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function findProductBySlug(client, slug) {
  const rows = await client.get("/products", { slug, per_page: 100 });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

async function loadProductMap() {
  if (!existsSync(WC_PRODUCT_MAP_PATH)) return {};
  try {
    const raw = await readFile(WC_PRODUCT_MAP_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

async function saveProductMap(map) {
  const ordered = Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  );
  await writeFile(WC_PRODUCT_MAP_PATH, JSON.stringify(ordered, null, 2), "utf8");
}

/**
 * Stable sync key: source product `url`. Resolves Woo product id from map
 * or legacy lookup by source URL slug.
 */
async function resolveWooProductId(client, product, productMap) {
  const url = product?.url;
  if (!url || typeof url !== "string") return 0;

  let id = Number(productMap[url] ?? 0);
  if (id > 0) {
    try {
      const p = await client.get(`/products/${id}`);
      if (p?.id) return Number(p.id);
    } catch {
      delete productMap[url];
    }
  }

  const legacySlug = parseSlugFromUrl(url);
  if (legacySlug) {
    const existing = await findProductBySlug(client, legacySlug);
    if (existing?.id) {
      productMap[url] = Number(existing.id);
      return Number(existing.id);
    }
  }
  return 0;
}

function pickUniqueSlug(baseSlug, usedSlugs) {
  if (!baseSlug) return "";
  let candidate = baseSlug;
  let n = 0;
  while (usedSlugs.has(candidate)) {
    n++;
    candidate = `${baseSlug}-${n}`;
  }
  usedSlugs.add(candidate);
  return candidate;
}

async function createProductPost(client, payload, productUrl) {
  const post = (body) => client.post("/products", body);
  try {
    return await post(payload);
  } catch (error) {
    const status = error?.response?.status;
    const msg = `${error?.response?.data?.message ?? error?.message ?? ""}`;
    if (
      status === 400 &&
      /slug|already|exists|duplicate|utilis/i.test(msg) &&
      productUrl
    ) {
      const alt = `${payload.slug}-${shortSlugDisambiguator(productUrl)}`;
      return await post({ ...payload, slug: alt });
    }
    if (
      payload.brands &&
      payload.brands.length > 0 &&
      (status === 400 || status === 404)
    ) {
      const { brands, ...rest } = payload;
      return await post(rest);
    }
    throw error;
  }
}

function formatProductSyncError(error) {
  const status = error?.response?.status;
  const wooMsg = error?.response?.data?.message;
  const reqUrl = error?.config?.url;
  const base = wooMsg ?? error?.message ?? String(error);
  if (status && reqUrl) return `${base} (HTTP ${status} ${reqUrl})`;
  if (status) return `${base} (HTTP ${status})`;
  return base;
}

async function findCategoryIdBySlug(client, slug, categoryIdCache) {
  if (categoryIdCache.has(slug)) return categoryIdCache.get(slug);
  const rows = await client.get("/products/categories", { slug, per_page: 100 });
  const id = Array.isArray(rows) && rows[0]?.id ? Number(rows[0].id) : 0;
  categoryIdCache.set(slug, id);
  return id;
}

async function findOrCreateTag(client, tagName, tagCache) {
  const key = tagName.toLocaleLowerCase();
  if (tagCache.has(key)) return tagCache.get(key);

  const existing = await client.get("/products/tags", {
    search: tagName,
    per_page: 100,
  });
  if (Array.isArray(existing)) {
    const exact = existing.find(
      (item) => item?.name?.toLocaleLowerCase() === key
    );
    if (exact?.id) {
      tagCache.set(key, exact.id);
      return exact.id;
    }
  }

  const created = await client.post("/products/tags", { name: tagName });
  if (created?.id) {
    tagCache.set(key, created.id);
    return created.id;
  }
  return null;
}

function buildCategoryNameToSlug(categories) {
  const map = new Map();
  for (const row of categories) {
    const name = (row?.name ?? "").trim();
    const slug = (row?.slug ?? "").trim();
    if (!name || !slug) continue;
    map.set(name.toLocaleLowerCase(), slug);
  }
  return map;
}

function brandSlugFromName(name) {
  const formatted = formatBrandName(typeof name === "string" ? name : `${name ?? ""}`);
  return `${formatted}`
    .trim()
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function findBrandIdBySlug(client, slug, brandIdCache) {
  if (!slug) return 0;
  if (brandIdCache.has(slug)) return brandIdCache.get(slug);
  try {
    const rows = await client.get("/products/brands", { slug, per_page: 100 });
    const id = Array.isArray(rows) && rows[0]?.id ? Number(rows[0].id) : 0;
    brandIdCache.set(slug, id);
    return id;
  } catch {
    brandIdCache.set(slug, 0);
    return 0;
  }
}

export async function syncProducts({ categoryMap = {}, brandMap = {} } = {}) {
  const client = createWooClientFromEnv();
  const productMap = await loadProductMap();
  const allProducts = await loadJsonArray(PRODUCTS_PATH);
  const allCategories = await loadJsonArray(CATEGORIES_PATH);
  const categoryNameToSlug = buildCategoryNameToSlug(allCategories);

  const allRows = await getProductUrls();
  const limitedRows = applyMaxProducts(allRows);
  const state = await loadState(PRODUCT_STATE_PATH);
  const fullSync = process.env.FULL_SYNC === "true";
  const { queue } = selectUrlsToScrape(
    limitedRows,
    state,
    fullSync,
    warnMissingLastmod
  );
  const limitedQueue = applyMaxPerRun(queue);
  const queueSet = new Set(limitedQueue.map((item) => item.url));

  const targets = allProducts.filter((product) => queueSet.has(product.url));
  const counters = {
    considered: 0,
    synced: 0,
    created: 0,
    updated: 0,
    skipped_by_filter: 0,
    skipped_existing: 0,
    failed: 0,
  };
  const tagCache = new Map();
  const categoryIdCache = new Map();
  const brandIdCache = new Map();
  const usedSlugs = new Set();

  for (const product of targets) {
    counters.considered++;
    const skipResult = shouldSkipProduct(product);
    if (skipResult.skip) {
      counters.skipped_by_filter++;
      continue;
    }

    try {
      const wooId = await resolveWooProductId(client, product, productMap);
      if (SKIP_EXISTING_PRODUCTS && wooId > 0) {
        counters.skipped_existing++;
        continue;
      }

      const tagIds = [];
      const productTags = Array.isArray(product?.tags) ? product.tags : [];
      for (const tagNameRaw of productTags) {
        const tagName = `${tagNameRaw ?? ""}`.trim();
        if (!tagName) continue;
        const tagId = await findOrCreateTag(client, tagName, tagCache);
        if (tagId) tagIds.push(tagId);
      }

      const categoryIds = [];
      const productCategories = Array.isArray(product?.categories)
        ? product.categories
        : [];
      for (const categoryNameRaw of productCategories) {
        const normalized = `${categoryNameRaw ?? ""}`.trim().toLocaleLowerCase();
        if (!normalized) continue;
        const sourceSlug = categoryNameToSlug.get(normalized);
        if (!sourceSlug) continue;
        let wcCategoryId = Number(categoryMap[sourceSlug] ?? 0);
        if (wcCategoryId <= 0) {
          wcCategoryId = await findCategoryIdBySlug(
            client,
            sourceSlug,
            categoryIdCache
          );
          if (wcCategoryId > 0) {
            categoryMap[sourceSlug] = wcCategoryId;
          }
        }
        if (wcCategoryId > 0) {
          categoryIds.push(wcCategoryId);
        }
      }

      const brandIds = [];
      const brandSlug = brandSlugFromName(product?.brand);
      if (brandSlug) {
        let wcBrandId = Number(brandMap[brandSlug] ?? 0);
        if (wcBrandId <= 0) {
          wcBrandId = await findBrandIdBySlug(client, brandSlug, brandIdCache);
          if (wcBrandId > 0) {
            brandMap[brandSlug] = wcBrandId;
          }
        }
        if (wcBrandId > 0) {
          brandIds.push(wcBrandId);
        }
      }
      const baseSlug = defaultProductSlug(product);
      if (!baseSlug) {
        counters.failed++;
        console.error(`[fail] product ${product.url}: could not derive slug`);
        continue;
      }

      const slug = pickUniqueSlug(baseSlug, usedSlugs);

      const payloadWithBrands = mapProductToWooPayload(product, {
        categoryIds: [...new Set(categoryIds)],
        tagIds: [...new Set(tagIds)],
        brandIds: [...new Set(brandIds)],
        slug,
      });
      if (!payloadWithBrands) {
        counters.failed++;
        console.error(`[fail] product ${product.url}: could not build payload`);
        continue;
      }

      let wrote = false;
      if (wooId > 0) {
        try {
          await client.put(`/products/${wooId}`, payloadWithBrands);
          productMap[product.url] = wooId;
          counters.updated++;
          wrote = true;
        } catch (putError) {
          if (putError?.response?.status !== 404) throw putError;
          delete productMap[product.url];
        }
      }
      if (!wrote) {
        const created = await createProductPost(
          client,
          payloadWithBrands,
          product.url
        );
        if (created?.id) {
          productMap[product.url] = Number(created.id);
          counters.created++;
        } else {
          counters.failed++;
          continue;
        }
      }
      counters.synced++;
    } catch (error) {
      counters.failed++;
      const label = defaultProductSlug(product) || product.url;
      console.error(`[fail] product ${label}:`, formatProductSyncError(error));
    }
  }

  await saveProductMap(productMap);

  return { counters };
}
