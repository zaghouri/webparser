import { normalizeCatalogProductTitle } from "./brand-format.js";

function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function replaceStoreDomain(value) {
  return value.replace(/parachezvous\.ma/gi, "Parabeautylab.ma");
}

function normalizeToken(value) {
  return cleanText(value).toLocaleLowerCase();
}

export function parseSlugFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const { pathname } = new URL(url);
    const parts = pathname.split("/").filter(Boolean);
    const productIdx = parts.indexOf("product");
    if (productIdx < 0 || !parts[productIdx + 1]) return null;
    return parts[productIdx + 1];
  } catch {
    return null;
  }
}

/** Woo-style slug from product title (target may differ from source URL slug). */
export function slugifyTitle(value) {
  const text = cleanText(value);
  if (!text) return "";
  return text
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function shortSlugDisambiguator(url) {
  if (!url || typeof url !== "string") return "x";
  let h = 0;
  for (let i = 0; i < url.length; i++) {
    h = (h * 31 + url.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}

function parsePrice(value) {
  const text = cleanText(value);
  if (!text) return "";
  const normalized = text.replace(",", ".");
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  return match ? match[1] : "";
}

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export function shouldSkipProduct(product) {
  const categories = Array.isArray(product?.categories) ? product.categories : [];
  const hasDestockageCategory = categories.some((name) =>
    normalizeToken(name).includes("destockage")
  );
  if (hasDestockageCategory) {
    return { skip: true, reason: "destockage_category" };
  }

  const stock = normalizeToken(product?.stock ?? "");
  if (stock.includes("rupture de stock")) {
    return { skip: true, reason: "rupture_de_stock" };
  }

  return { skip: false, reason: null };
}

export function mapCategoryToWooPayload(category, parentId = 0) {
  const slug = cleanText(category?.slug);
  const name = cleanText(category?.name) || slug || "Unnamed category";
  const description = replaceStoreDomain(cleanText(category?.description));
  const imageSrc = cleanText(category?.image);

  const payload = {
    name,
    slug: slug || undefined,
    description,
    parent: Number.isFinite(parentId) ? parentId : 0,
  };

  if (imageSrc) {
    payload.image = { src: imageSrc };
  }
  return payload;
}

export function mapProductToWooPayload(
  product,
  {
    categoryIds = [],
    tagIds = [],
    brandIds = [],
    slug: slugOverride,
  } = {}
) {
  const rawTitle = cleanText(product?.title);
  const { title: normalizedTitle } = normalizeCatalogProductTitle(rawTitle);
  const titleForWoo = normalizedTitle || rawTitle;
  const fromTitle = slugifyTitle(titleForWoo);
  const fromUrl = parseSlugFromUrl(product?.url);
  const slug =
    (typeof slugOverride === "string" && slugOverride.trim()) ||
    fromTitle ||
    fromUrl;
  if (!slug) {
    return null;
  }

  const price = parsePrice(product?.price);
  const images = Array.isArray(product?.images)
    ? dedupeStrings(product.images).map((src) => ({ src }))
    : [];

  const sourceUrl = cleanText(product?.url);
  const payload = {
    name: titleForWoo || slug,
    slug,
    description: replaceStoreDomain(cleanText(product?.description)),
    short_description: replaceStoreDomain(cleanText(product?.shortDescription)),
    regular_price: price,
    manage_stock: false,
    in_stock: true,
    stock_status: "instock",
    images,
    categories: categoryIds.map((id) => ({ id })),
    tags: tagIds.map((id) => ({ id })),
  };
  if (brandIds.length > 0) {
    payload.brands = brandIds.map((id) => ({ id }));
  }
  if (sourceUrl) {
    payload.meta_data = [{ key: "_source_product_url", value: sourceUrl }];
  }

  return payload;
}

export function productSlugFromUrl(url) {
  return parseSlugFromUrl(url);
}

export function defaultProductSlug(product) {
  const rawTitle = cleanText(product?.title);
  const { title: normalizedTitle } = normalizeCatalogProductTitle(rawTitle);
  const titleForSlug = normalizedTitle || rawTitle;
  return (
    slugifyTitle(titleForSlug) ||
    parseSlugFromUrl(product?.url) ||
    ""
  );
}
