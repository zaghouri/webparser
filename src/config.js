function normalizeBaseUrl(raw) {
  if (!raw) return "";
  return raw.trim().replace(/\/+$/, "");
}

function normalizeSitemapIndexUrl(raw, fallbackBaseUrl) {
  const value = raw?.trim();
  if (value) return value;
  return `${fallbackBaseUrl}/sitemap_index.xml`;
}

const DEFAULT_SOURCE_BASE_URL = "https://source-store.example.com";

export const SOURCE_BASE_URL = normalizeBaseUrl(
  process.env.SOURCE_BASE_URL || DEFAULT_SOURCE_BASE_URL
);

export const SOURCE_SITEMAP_INDEX_URL = normalizeSitemapIndexUrl(
  process.env.SOURCE_SITEMAP_INDEX_URL,
  SOURCE_BASE_URL
);

export const WC_BASE_URL = normalizeBaseUrl(process.env.WC_BASE_URL);
export const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
export const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;
