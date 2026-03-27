import { load } from "cheerio";
import { fetchHtml } from "./fetch.js";
import { SOURCE_BASE_URL } from "./config.js";

function normalizeWhitespace(str) {
  if (!str || typeof str !== "string") return "";
  return str.replace(/\s+/g, " ").trim();
}

function trimText(str) {
  return normalizeWhitespace(str ?? "");
}

/**
 * Brand: (1) any `a[href*="/marque/"]`, (2) same inside breadcrumb containers, else null.
 */
function extractBrand($) {
  const fromMarque = $('a[href*="/marque/"]').first();
  if (fromMarque.length) {
    const t = trimText(fromMarque.text());
    return {
      name: t || null,
      url: resolveUrl(fromMarque.attr("href"), SOURCE_BASE_URL),
    };
  }

  const crumbRoots =
    ".woocommerce-breadcrumb, .breadcrumb, nav.breadcrumb, [class*='breadcrumb']";
  const inCrumb = $(crumbRoots).find('a[href*="/marque/"]').first();
  if (inCrumb.length) {
    const t = trimText(inCrumb.text());
    return {
      name: t || null,
      url: resolveUrl(inCrumb.attr("href"), SOURCE_BASE_URL),
    };
  }

  return { name: null, url: null };
}

function resolveUrl(href, baseUrl) {
  if (!href || href.startsWith("data:")) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function collectGalleryImages($, pageUrl) {
  const seen = new Set();
  const selectors =
    ".woocommerce-product-gallery img, .woocommerce-product-gallery__image img, .product-images img, .flex-active-slide img";
  $(selectors).each((_, el) => {
    const $el = $(el);
    const candidates = [
      $el.attr("data-large_image"),
      $el.attr("data-src"),
      $el.attr("data-full-url"),
      $el.attr("src"),
    ];
    for (const c of candidates) {
      const abs = resolveUrl(c, pageUrl);
      if (abs) seen.add(abs);
    }
    const srcset = $el.attr("srcset");
    if (srcset) {
      const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
      const abs = resolveUrl(first, pageUrl);
      if (abs) seen.add(abs);
    }
  });
  return [...seen];
}

/**
 * Short + full description for this theme (Flatsome-style accordion + summary).
 * Short: `.product-short-description`; full: `#accordion-description-content`.
 */
function extractDescriptions($) {
  const shortEl = $(".product-short-description").first();
  let short = shortEl.length ? normalizeWhitespace(shortEl.text()) : "";
  if (!short) {
    const fb = $(".woocommerce-product-details__short-description").first();
    if (fb.length) short = normalizeWhitespace(fb.text());
  }

  const fullEl = $("#accordion-description-content").first();
  const full = fullEl.length ? normalizeWhitespace(fullEl.text()) : "";

  let description = "";
  if (full && short) {
    if (full.includes(short)) description = full;
    else description = `${short}\n\n${full}`;
  } else if (full) description = full;
  else if (short) description = short;
  else {
    const fallback = $(
      "#tab-description, .woocommerce-Tabs-panel--description, #tab-description .woocommerce-Tabs-panel"
    ).first();
    if (fallback.length) description = normalizeWhitespace(fallback.text());
  }

  return {
    shortDescription: short ? short : null,
    description,
  };
}

/**
 * Scrape a single WooCommerce product HTML page.
 */
export async function scrapeProduct(url) {
  const html = await fetchHtml(url);
  const $ = load(html);

  const title = trimText($("h1.product_title").first().text());
  const price = trimText($(".price").first().text());
  const stockEl = $(".stock").first();
  const stock = stockEl.length ? trimText(stockEl.text()) : "";

  const { shortDescription, description } = extractDescriptions($);

  const categories = [];
  $(".posted_in a").each((_, el) => {
    const t = trimText($(el).text());
    if (t) categories.push(t);
  });

  const tags = [];
  $(".tagged_as a").each((_, el) => {
    const t = trimText($(el).text());
    if (t) tags.push(t);
  });

  const images = collectGalleryImages($, url);
  const brand = extractBrand($);

  return {
    url,
    title,
    price,
    stock: stock || null,
    brand: brand.name,
    brandUrl: brand.url,
    categories,
    tags,
    images,
    shortDescription,
    description,
  };
}
