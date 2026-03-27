import { load } from "cheerio";
import { fetchHtml } from "./fetch.js";

function normalizeWhitespace(str) {
  if (!str || typeof str !== "string") return "";
  return str.replace(/\s+/g, " ").trim();
}

function trimText(str) {
  return normalizeWhitespace(str ?? "");
}

function resolveUrl(href, baseUrl) {
  if (!href || href.startsWith("data:")) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function isPlaceholderCategoryImage(url) {
  if (!url) return false;
  return /kit-par-defaut/i.test(url);
}

function parseBackgroundImage(styleValue, pageUrl) {
  if (!styleValue) return null;
  const match = /background-image\s*:\s*url\((['\"]?)(.*?)\1\)/i.exec(styleValue);
  if (!match) return null;
  return resolveUrl(match[2], pageUrl);
}

function removeInlineTagText(str) {
  if (!str) return "";
  return normalizeWhitespace(str.replace(/<[^>]+>/g, " "));
}

function parseCategoryHierarchy(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("product-category");
    if (idx < 0) {
      return {
        slug: null,
        parentSlug: null,
        parentUrl: null,
      };
    }
    const trail = segments.slice(idx + 1);
    if (trail.length === 0) {
      return {
        slug: null,
        parentSlug: null,
        parentUrl: null,
      };
    }

    const slug = trail[trail.length - 1];
    if (trail.length === 1) {
      return {
        slug,
        parentSlug: null,
        parentUrl: null,
      };
    }

    const parentTrail = trail.slice(0, -1);
    const parentSlug = parentTrail[parentTrail.length - 1] ?? null;
    const parentPath = `/${segments.slice(0, idx + 1).join("/")}/${parentTrail.join("/")}/`;
    const parentUrl = new URL(parentPath, u.origin).href;
    return {
      slug,
      parentSlug,
      parentUrl,
    };
  } catch {
    return {
      slug: null,
      parentSlug: null,
      parentUrl: null,
    };
  }
}

function extractParentNameFromBreadcrumb($) {
  const currentName = extractCategoryName($);
  const links = $(
    ".woocommerce-breadcrumb a, .breadcrumb a, nav.breadcrumb a, [class*='breadcrumb'] a"
  )
    .map((_, el) => trimText($(el).text()))
    .get()
    .filter(Boolean);

  if (links.length === 0) return null;
  if (links.length >= 2) {
    const candidate = links[links.length - 1];
    if (candidate && candidate !== currentName) return candidate;
  }
  return links[links.length - 1] ?? null;
}

function extractCategoryImage($, url) {
  const imgSelectors = [
    ".woocommerce-products-header img",
    ".category-banner img",
    ".term-image img",
    ".archive-header img",
    ".term-thumbnail img",
  ];

  for (const selector of imgSelectors) {
    const img = $(selector).first();
    if (!img.length) continue;
    const candidate =
      img.attr("data-src") ||
      img.attr("data-lazy-src") ||
      img.attr("src") ||
      (img.attr("srcset") || "").split(",")[0]?.trim().split(/\s+/)[0];
    const resolved = resolveUrl(candidate, url);
    if (resolved && !isPlaceholderCategoryImage(resolved)) return resolved;
  }

  const bgSelectors = [
    ".woocommerce-products-header",
    ".category-banner",
    ".archive-header",
    ".term-banner",
  ];

  for (const selector of bgSelectors) {
    const el = $(selector).first();
    if (!el.length) continue;
    const bg = parseBackgroundImage(el.attr("style"), url);
    if (bg && !isPlaceholderCategoryImage(bg)) return bg;
  }

  const descImg = $(".term-description img, .archive-description img").first();
  if (descImg.length) {
    const candidate =
      descImg.attr("data-src") ||
      descImg.attr("data-lazy-src") ||
      descImg.attr("src");
    const resolved = resolveUrl(candidate, url);
    if (resolved && !isPlaceholderCategoryImage(resolved)) return resolved;
  }

  return null;
}

function extractCategoryDescription($) {
  const selectors = [
    ".term-description",
    ".archive-description",
    ".taxonomy-description",
    ".woocommerce-products-header .term-description",
  ];
  for (const selector of selectors) {
    const el = $(selector).first();
    if (!el.length) continue;
    const text = removeInlineTagText(el.text());
    if (text) return text;
  }
  return "";
}

function extractCategoryName($) {
  const selectors = [
    "h1.page-title",
    "h1.archive-title",
    ".woocommerce-products-header__title",
    "h1",
  ];
  for (const selector of selectors) {
    const el = $(selector).first();
    if (!el.length) continue;
    const text = trimText(el.text());
    if (text) return text;
  }
  return "";
}

export async function scrapeCategory(url) {
  const html = await fetchHtml(url);
  const $ = load(html);
  const { slug, parentSlug, parentUrl } = parseCategoryHierarchy(url);
  const parentName = parentSlug ? extractParentNameFromBreadcrumb($) : null;

  return {
    url,
    slug,
    name: extractCategoryName($),
    parentSlug,
    parentName,
    parentUrl,
    description: extractCategoryDescription($),
    image: extractCategoryImage($, url),
  };
}
