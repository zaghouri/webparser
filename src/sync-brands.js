import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { load } from "cheerio";
import { createWooClientFromEnv } from "./woocommerce-client.js";
import { fetchHtml } from "./fetch.js";

const PRODUCTS_PATH = fileURLToPath(new URL("../products.json", import.meta.url));
const WC_BRAND_MAP_PATH = fileURLToPath(
  new URL("../wc-brand-map.json", import.meta.url)
);

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function slugify(value) {
  return cleanText(value)
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeImageCandidate(url) {
  const text = cleanText(url);
  if (!text) return null;
  if (/kit-par-defaut/i.test(text)) return null;
  return text;
}

async function loadProducts() {
  if (!existsSync(PRODUCTS_PATH)) return [];
  try {
    const raw = await readFile(PRODUCTS_PATH, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function loadBrandMap() {
  if (!existsSync(WC_BRAND_MAP_PATH)) return {};
  try {
    const raw = await readFile(WC_BRAND_MAP_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

async function saveBrandMap(map) {
  const ordered = Object.fromEntries(
    Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
  );
  await writeFile(WC_BRAND_MAP_PATH, JSON.stringify(ordered, null, 2), "utf8");
}

function extractBrandImageFromHtml(html, pageUrl) {
  const $ = load(html);
  const selectors = [
    ".term-image img",
    ".archive-header img",
    ".taxonomy-description img",
    ".woocommerce-products-header img",
    ".brand-logo img",
  ];
  for (const selector of selectors) {
    const img = $(selector).first();
    if (!img.length) continue;
    const candidate =
      img.attr("data-src") ||
      img.attr("data-lazy-src") ||
      img.attr("src") ||
      (img.attr("srcset") || "").split(",")[0]?.trim().split(/\s+/)[0];
    if (!candidate) continue;
    try {
      const abs = new URL(candidate, pageUrl).href;
      const normalized = normalizeImageCandidate(abs);
      if (normalized) return normalized;
    } catch {
      // skip invalid URL
    }
  }
  return null;
}

async function enrichBrandImage(brand) {
  if (brand.image || !brand.url) return brand;
  try {
    const html = await fetchHtml(brand.url);
    const image = extractBrandImageFromHtml(html, brand.url);
    return { ...brand, image };
  } catch {
    return brand;
  }
}

async function findBrandBySlug(client, slug) {
  const rows = await client.get("/products/brands", { slug, per_page: 100 });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

function mapBrandPayload(brand) {
  const payload = {
    name: brand.name,
    slug: brand.slug,
  };
  if (brand.image) payload.image = { src: brand.image };
  return payload;
}

async function upsertBrand(client, brand, counters) {
  const payload = mapBrandPayload(brand);
  const existing = await findBrandBySlug(client, brand.slug);
  const endpoint = existing ? `/products/brands/${existing.id}` : "/products/brands";
  const method = existing ? "put" : "post";
  try {
    const result = await client[method](endpoint, payload);
    if (existing) counters.updated++;
    else counters.created++;
    return result;
  } catch (error) {
    if (!payload.image) throw error;
    const fallbackPayload = { ...payload };
    delete fallbackPayload.image;
    const result = await client[method](endpoint, fallbackPayload);
    if (existing) counters.updated++;
    else counters.created++;
    return result;
  }
}

function buildUniqueBrands(products) {
  const bySlug = new Map();
  for (const product of products) {
    const name = cleanText(product?.brand);
    if (!name) continue;
    const slug = slugify(name);
    if (!slug) continue;
    const brandUrl = cleanText(product?.brandUrl);
    const current = bySlug.get(slug);
    if (!current) {
      bySlug.set(slug, {
        name,
        slug,
        url: brandUrl || null,
        image: null,
      });
      continue;
    }
    if (!current.url && brandUrl) {
      current.url = brandUrl;
    }
  }
  return [...bySlug.values()];
}

export async function syncBrands() {
  const client = createWooClientFromEnv();
  const products = await loadProducts();
  const brandMap = await loadBrandMap();

  const counters = {
    considered: 0,
    synced: 0,
    created: 0,
    updated: 0,
    skipped_by_filter: 0,
    failed: 0,
  };

  const brands = buildUniqueBrands(products);
  for (const rawBrand of brands) {
    counters.considered++;
    const brand = await enrichBrandImage(rawBrand);
    try {
      const result = await upsertBrand(client, brand, counters);
      if (result?.id) {
        brandMap[brand.slug] = Number(result.id);
        counters.synced++;
      } else {
        counters.failed++;
      }
    } catch (error) {
      counters.failed++;
      console.error(
        `[fail] brand ${brand.slug}:`,
        error?.response?.data?.message ?? error?.message ?? error
      );
    }
  }

  await saveBrandMap(brandMap);
  return { counters, brandMap };
}
