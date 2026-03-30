import { load } from "cheerio";
import { fetchHtml } from "./fetch.js";
import { SOURCE_BASE_URL } from "./config.js";
import { formatBrandName, normalizeCatalogProductTitle } from "./brand-format.js";

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

function innerHtml($el) {
  if (!$el?.length) return "";
  const h = $el.html();
  return typeof h === "string" ? h.trim() : "";
}

/**
 * Short + full description for this theme (Flatsome-style accordion + summary).
 * Short: `.product-short-description`; full: `#accordion-description-content`.
 * Uses inner HTML so lists, headings, and links sync to WooCommerce; merge
 * deduplication uses plain text (same as before).
 */
function extractDescriptions($) {
  let shortEl = $(".product-short-description").first();
  if (!shortEl.length) {
    shortEl = $(".woocommerce-product-details__short-description").first();
  }

  const shortText = shortEl.length ? normalizeWhitespace(shortEl.text()) : "";
  const shortHtml = innerHtml(shortEl);

  const fullEl = $("#accordion-description-content").first();
  const fullText = fullEl.length ? normalizeWhitespace(fullEl.text()) : "";
  const fullHtml = innerHtml(fullEl);

  let description = "";
  if (fullHtml && shortHtml) {
    if (fullText.includes(shortText)) description = fullHtml;
    else description = `${shortHtml}<br><br>${fullHtml}`;
  } else if (fullHtml) description = fullHtml;
  else if (shortHtml) description = shortHtml;
  else {
    const fallback = $(
      "#tab-description, .woocommerce-Tabs-panel--description, #tab-description .woocommerce-Tabs-panel"
    ).first();
    if (fallback.length) description = innerHtml(fallback);
  }

  return {
    shortDescription: shortHtml ? shortHtml : null,
    description,
  };
}

/**
 * Scrape a single WooCommerce product HTML page.
 */
export async function scrapeProduct(url) {
  const html = await fetchHtml(url);
  const $ = load(html);

  const rawTitle = trimText($("h1.product_title").first().text());
  const { title, brandFromTitle } = normalizeCatalogProductTitle(rawTitle);
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
  const brandName = brand.name ? formatBrandName(brand.name) : brandFromTitle;

  return {
    url,
    title,
    price,
    stock: stock || null,
    brand: brandName || null,
    brandUrl: brand.url,
    categories,
    tags,
    images,
    shortDescription,
    description,
  };
}
