import { load as loadXml } from "cheerio";
import { fetchXML } from "./fetch.js";
import { SOURCE_SITEMAP_INDEX_URL } from "./config.js";

const SITEMAP_INDEX_URL = SOURCE_SITEMAP_INDEX_URL;

/**
 * Parse sitemap index XML and return child sitemap `<loc>` URLs.
 */
export function parseSitemapIndex(xml) {
  const $ = loadXml(xml, { xmlMode: true, decodeEntities: true });
  const locs = [];
  $("sitemap").each((_, el) => {
    const loc = $(el).find("loc").first().text().trim();
    if (loc) locs.push(loc);
  });
  if (locs.length === 0) {
    const re = /<sitemap[^>]*>[\s\S]*?<loc[^>]*>([^<]+)<\/loc>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      locs.push(m[1].trim());
    }
  }
  return locs;
}

/**
 * WooCommerce / WordPress: keep only sitemaps that list products.
 * Heuristic: pathname contains `product` and resource is `.xml` (no site-specific slugs).
 */
export function filterProductSitemapUrls(locations) {
  return locations.filter((loc) => {
    try {
      const u = new URL(loc);
      const path = u.pathname.toLowerCase();
      if (!path.endsWith(".xml")) return false;
      return path.includes("product");
    } catch {
      return false;
    }
  });
}

/**
 * Keep taxonomy sitemaps that likely represent categories.
 */
export function filterCategorySitemapUrls(locations) {
  return locations.filter((loc) => {
    try {
      const u = new URL(loc);
      const path = u.pathname.toLowerCase();
      if (!path.endsWith(".xml")) return false;
      return path.includes("product_cat") || path.includes("category");
    } catch {
      return false;
    }
  });
}

/**
 * Extract `{ url, lastmod }` from a urlset sitemap (handles default sitemap XML shape).
 */
export function parseUrlset(xml) {
  const results = [];
  const urlBlockRe = /<url[^>]*>([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = urlBlockRe.exec(xml)) !== null) {
    const block = m[1];
    const locMatch = /<loc[^>]*>\s*([^<]+?)\s*<\/loc>/i.exec(block);
    const lastmodMatch = /<lastmod[^>]*>\s*([^<]+?)\s*<\/lastmod>/i.exec(block);
    if (locMatch) {
      const url = locMatch[1].trim();
      const lastmodRaw = lastmodMatch ? lastmodMatch[1].trim() : "";
      results.push({
        url,
        lastmod: lastmodRaw ? normalizeLastmod(lastmodRaw) : null,
      });
    }
  }
  return results;
}

function normalizeLastmod(raw) {
  const t = raw.trim();
  if (!t) return null;
  const d = Date.parse(t);
  if (!Number.isNaN(d)) return new Date(d).toISOString();
  return t;
}

function pickNewerLastmod(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function mergeByUrl(entries) {
  const map = new Map();
  for (const { url, lastmod } of entries) {
    const prev = map.get(url);
    if (!prev) {
      map.set(url, { url, lastmod });
      continue;
    }
    map.set(url, { url, lastmod: pickNewerLastmod(prev.lastmod, lastmod) });
  }
  return [...map.values()];
}

/**
 * WooCommerce product sitemaps may list the shop archive (`/shop/`). Keep only single product URLs.
 * This site uses `/product/{slug}/` permalinks.
 */
export function filterSingleProductPageUrls(rows) {
  return rows.filter(({ url }) => {
    try {
      const { pathname } = new URL(url);
      const normalized = pathname.replace(/\/+$/, "") || "/";
      if (normalized === "/shop") return false;
      const segments = normalized.split("/").filter(Boolean);
      return segments[0] === "product" && segments.length >= 2;
    } catch {
      return false;
    }
  });
}

/**
 * Keep category/taxonomy archive URLs only.
 */
export function filterCategoryPageUrls(rows) {
  return rows.filter(({ url }) => {
    try {
      const { pathname } = new URL(url);
      const normalized = pathname.replace(/\/+$/, "") || "/";
      const segments = normalized.split("/").filter(Boolean);
      return segments.includes("product-category");
    } catch {
      return false;
    }
  });
}

/**
 * Fetch index → product sitemaps → all product URLs with lastmod.
 */
export async function getProductUrls(indexUrl = SITEMAP_INDEX_URL) {
  const indexXml = await fetchXML(indexUrl);
  const childLocs = parseSitemapIndex(indexXml);
  const productSitemapUrls = filterProductSitemapUrls(childLocs);
  if (productSitemapUrls.length === 0) {
    throw new Error(
      "No product sitemap URLs found in index. Check filterProductSitemapUrls / sitemap shape."
    );
  }
  const all = [];
  for (const sitemapUrl of productSitemapUrls) {
    const xml = await fetchXML(sitemapUrl);
    const rows = parseUrlset(xml);
    all.push(...rows);
  }
  const filtered = filterSingleProductPageUrls(all);
  return mergeByUrl(filtered);
}

/**
 * Fetch index → category sitemaps → all category URLs with lastmod.
 */
export async function getCategoryUrls(indexUrl = SITEMAP_INDEX_URL) {
  const indexXml = await fetchXML(indexUrl);
  const childLocs = parseSitemapIndex(indexXml);
  const categorySitemapUrls = filterCategorySitemapUrls(childLocs);
  if (categorySitemapUrls.length === 0) {
    throw new Error(
      "No category sitemap URLs found in index. Check filterCategorySitemapUrls / sitemap shape."
    );
  }
  const all = [];
  for (const sitemapUrl of categorySitemapUrls) {
    const xml = await fetchXML(sitemapUrl);
    const rows = parseUrlset(xml);
    all.push(...rows);
  }
  const filtered = filterCategoryPageUrls(all);
  return mergeByUrl(filtered);
}

export { SITEMAP_INDEX_URL };
