import "dotenv/config";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { syncCategories } from "./sync-categories.js";
import { syncBrands } from "./sync-brands.js";
import { syncProducts } from "./sync-products.js";
import { isMain } from "./is-main.js";

const WC_CATEGORY_MAP_PATH = fileURLToPath(
  new URL("../wc-category-map.json", import.meta.url)
);
const WC_BRAND_MAP_PATH = fileURLToPath(
  new URL("../wc-brand-map.json", import.meta.url)
);

async function loadSlugIdMap(path) {
  if (!existsSync(path)) return {};
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

function printCounters(label, counters) {
  const skipExisting =
    counters.skipped_existing != null
      ? `, skipped_existing=${counters.skipped_existing}`
      : "";
  console.log(
    `${label}: considered=${counters.considered}, synced=${counters.synced}, created=${counters.created}, updated=${counters.updated}, skipped_by_filter=${counters.skipped_by_filter}${skipExisting}, failed=${counters.failed}`
  );
}

export async function main() {
  console.log("Starting WooCommerce sync.");

  const skipCategories = process.env.SKIP_CATEGORY_SYNC === "true";
  const skipBrands = process.env.SKIP_BRAND_SYNC === "true";

  let categoryMap;
  if (!skipCategories) {
    const categoryResult = await syncCategories();
    categoryMap = categoryResult.categoryMap;
    printCounters("Categories", categoryResult.counters);
  } else {
    categoryMap = await loadSlugIdMap(WC_CATEGORY_MAP_PATH);
    console.log(
      `[schedule] Skipped category sync; using wc-category-map.json (${Object.keys(categoryMap).length} slugs).`
    );
  }

  let brandMap;
  if (!skipBrands) {
    const brandResult = await syncBrands();
    brandMap = brandResult.brandMap;
    printCounters("Brands", brandResult.counters);
  } else {
    brandMap = await loadSlugIdMap(WC_BRAND_MAP_PATH);
    console.log(
      `[schedule] Skipped brand sync; using wc-brand-map.json (${Object.keys(brandMap).length} slugs).`
    );
  }

  const productResult = await syncProducts({
    categoryMap,
    brandMap,
  });
  printCounters("Products", productResult.counters);

  console.log("WooCommerce sync complete.");
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
