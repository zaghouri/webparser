import "dotenv/config";
import { syncCategories } from "./sync-categories.js";
import { syncBrands } from "./sync-brands.js";
import { syncProducts } from "./sync-products.js";
import { isMain } from "./is-main.js";

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

  const categoryResult = await syncCategories();
  printCounters("Categories", categoryResult.counters);

  const brandResult = await syncBrands();
  printCounters("Brands", brandResult.counters);

  const productResult = await syncProducts({
    categoryMap: categoryResult.categoryMap,
    brandMap: brandResult.brandMap,
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
