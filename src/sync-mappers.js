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

function parseSlugFromUrl(url) {
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
  { categoryIds = [], tagIds = [], brandIds = [] } = {}
) {
  const slug = parseSlugFromUrl(product?.url);
  if (!slug) {
    return null;
  }

  const price = parsePrice(product?.price);
  const images = Array.isArray(product?.images)
    ? dedupeStrings(product.images).map((src) => ({ src }))
    : [];

  const payload = {
    name: cleanText(product?.title) || slug,
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

  return payload;
}

export function productSlugFromUrl(url) {
  return parseSlugFromUrl(url);
}
