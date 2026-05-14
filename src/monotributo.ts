/**
 * Monotributo category thresholds.
 *
 * Source: https://www.afip.gob.ar/monotributo/categorias.asp
 * Effective: 2026-02-01
 *
 * To update: change the values below when ARCA publishes new thresholds
 * (typically every 6 months, in February and September).
 */

export interface MonotributoCategory {
  name: string;
  maxAnnualIncome: number;
}

// Effective 2026-02-01
export const CATEGORIES: MonotributoCategory[] = [
  { name: "A", maxAnnualIncome: 10_277_988.13 },
  { name: "B", maxAnnualIncome: 15_058_447.71 },
  { name: "C", maxAnnualIncome: 21_113_696.52 },
  { name: "D", maxAnnualIncome: 26_212_853.42 },
  { name: "E", maxAnnualIncome: 30_833_964.37 },
  { name: "F", maxAnnualIncome: 38_642_048.36 },
  { name: "G", maxAnnualIncome: 46_211_109.37 },
  { name: "H", maxAnnualIncome: 70_113_407.33 },
  { name: "I", maxAnnualIncome: 78_479_211.62 },
  { name: "J", maxAnnualIncome: 89_872_640.30 },
  { name: "K", maxAnnualIncome: 108_357_084.05 },
];

export const CATEGORIES_EFFECTIVE_DATE = "2026-02-01";

/**
 * Find the category that matches a given annual income.
 * Returns null if income exceeds the highest category (K).
 */
export function findCategory(annualIncome: number): MonotributoCategory | null {
  for (const cat of CATEGORIES) {
    if (annualIncome <= cat.maxAnnualIncome) return cat;
  }
  return null;
}

/**
 * Find the next category above the given one, or null if already at K.
 */
export function nextCategory(current: MonotributoCategory): MonotributoCategory | null {
  const idx = CATEGORIES.findIndex((c) => c.name === current.name);
  if (idx === -1 || idx >= CATEGORIES.length - 1) return null;
  return CATEGORIES[idx + 1];
}
