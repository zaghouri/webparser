function cleanText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

/** En dash, em dash, or spaced ASCII hyphen (avoids splitting e.g. Anti-Chute). */
const TITLE_SEGMENT_SPLIT = /\s*[–—]\s*|\s+-\s+/;

/** Uppercase ASCII key for brand map lookup (handles mixed case and accents). */
function brandMapLookupKey(brand) {
  return brand
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

/**
 * Canonical display names for known brands. Keys are ASCII uppercase (accents stripped).
 */
const BRAND_NAME_MAP = {
  CERAVE: "CeraVe",
  "LA ROCHE POSAY": "La Roche-Posay",
  "LA ROCHE-POSAY": "La Roche-Posay",
  AVENE: "Avène",
  "A-DERMA": "A-Derma",
  SVR: "SVR",
  ISDIN: "ISDIN",
  URIAGE: "Uriage",
  BIODERMA: "Bioderma",
  VICHY: "Vichy",
  DUCRAY: "Ducray",
  MUSTELA: "Mustela",
  FILORGA: "Filorga",
  NUXE: "Nuxe",
  CAUDALIE: "Caudalie",
  EUCERIN: "Eucerin",
  LIERAC: "Lierac",
  TOPICREM: "Topicrem",
  BEPANTHEN: "Bepanthen",
  ELGYDIUM: "Elgydium",
  PARODONTAX: "Parodontax",
  "ORAL-B": "Oral-B",
  GUM: "GUM",
  BABE: "Babé",
  ACM: "ACM",
  ARKOPHARMA: "Arkopharma",
  "FORTÉ PHARMA": "Forté Pharma",
  "FORTE PHARMA": "Forté Pharma",
  JOWAE: "Jowaé",
  "RENÉ FURTERER": "René Furterer",
  "RENE FURTERER": "René Furterer",
  KLORANE: "Klorane",
  PHYTO: "Phyto",
  INNOVATOUCH: "Innovatouch",
  NATESSANCE: "Natessance",
  PRANAROM: "Pranarôm",
  WELEDA: "Weleda",
  PEDIAKID: "Pediakid",
  PILEJE: "Pileje",
  NHCO: "NHCO",
  SOLGAR: "Solgar",
  NOW: "NOW",
  "VITALL+": "Vitall+",
};

function titleCaseWord(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Format raw brand strings for display (mixed case, accents, known cosmetics brands).
 */
export function formatBrandName(brand) {
  const trimmed = cleanText(brand);
  if (!trimmed) return "";

  const normalized = trimmed.replace(/\s+/g, " ");
  const key = brandMapLookupKey(normalized);
  if (Object.prototype.hasOwnProperty.call(BRAND_NAME_MAP, key)) {
    return BRAND_NAME_MAP[key];
  }

  if (normalized.includes("-")) {
    return normalized
      .split("-")
      .map((w) => titleCaseWord(w.trim()))
      .join("-");
  }

  if (/\s/.test(normalized)) {
    return normalized
      .split(/\s+/)
      .map((w) => titleCaseWord(w))
      .join(" ");
  }

  return titleCaseWord(normalized);
}

/**
 * Strip catalog title separators (–, —, spaced -), join the rest with spaces,
 * and apply {@link formatBrandName} to the leading brand segment.
 *
 * @returns {{ title: string, brandFromTitle: string | null }}
 */
export function normalizeCatalogProductTitle(rawTitle) {
  const trimmed = cleanText(rawTitle).replace(/\s+/g, " ");
  if (!trimmed) {
    return { title: "", brandFromTitle: null };
  }

  const segments = trimmed
    .split(TITLE_SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);

  if (segments.length < 2) {
    return { title: trimmed, brandFromTitle: null };
  }

  const formattedBrand = formatBrandName(segments[0]);
  const tail = segments.slice(1).join(" ");
  const title = tail ? `${formattedBrand} ${tail}`.replace(/\s+/g, " ").trim() : formattedBrand;

  return { title, brandFromTitle: formattedBrand || null };
}
