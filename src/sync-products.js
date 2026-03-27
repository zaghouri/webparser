import { readFile } from "fs/promises";
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
  productSlugFromUrl,
  shouldSkipProduct,
} from "./sync-mappers.js";

const PRODUCTS_PATH = fileURLToPath(new URL("../products.json", import.meta.url));
const CATEGORIES_PATH = fileURLToPath(
  new URL("../categories.json", import.meta.url)
);

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
  return `${name ?? ""}`
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
  const allProducts = await loadJsonArray(PRODUCTS_PATH);
  const allCategories = await loadJsonArray(CATEGORIES_PATH);
  const categoryNameToSlug = buildCategoryNameToSlug(allCategories);

  const allRows = await getProductUrls();
  const limitedRows = applyMaxProducts(allRows);
  const state = await loadState(PRODUCT_STATE_PATH);
  const fullSync = process.env.FULL_SYNC === "true";
  const { queue } = selectUrlsToScrape(limitedRows, state, fullSync, warnMissingLastmod);
  const queueSet = new Set(queue.map((item) => item.url));

  const targets = allProducts.filter((product) => queueSet.has(product.url));
  const counters = {
    considered: 0,
    synced: 0,
    created: 0,
    updated: 0,
    skipped_by_filter: 0,
    failed: 0,
  };
  const tagCache = new Map();
  const categoryIdCache = new Map();
  const brandIdCache = new Map();

  for (const product of targets) {
    counters.considered++;
    const skipResult = shouldSkipProduct(product);
    if (skipResult.skip) {
      counters.skipped_by_filter++;
      continue;
    }

    try {
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
      const payloadWithBrands = mapProductToWooPayload(product, {
        categoryIds: [...new Set(categoryIds)],
        tagIds: [...new Set(tagIds)],
        brandIds: [...new Set(brandIds)],
      });
      if (!payloadWithBrands) {
        counters.failed++;
        console.error(`[fail] product ${product.url}: could not derive slug`);
        continue;
      }

      const existing = await findProductBySlug(client, payloadWithBrands.slug);
      if (existing?.id) {
        await client.put(`/products/${existing.id}`, payloadWithBrands);
        counters.updated++;
      } else {
        await client.post("/products", payloadWithBrands);
        counters.created++;
      }
      counters.synced++;
    } catch (error) {
      counters.failed++;
      const slug = productSlugFromUrl(product.url) ?? product.url;
      console.error(
        `[fail] product ${slug}:`,
        error?.response?.data?.message ?? error?.message ?? error
      );
    }
  }

  return { counters };
}
