// Plain arithmetic order-planning calculator — no AI involved.
//
// A drink line either points at a single product, or at a recipe made of
// several products (e.g. cordial + soda water). Either way, the question is
// always the same: given a number of servings of a given size, how many
// containers of a given size do I need, and — after subtracting what's
// already in stock — how many whole cases do I need to order?

// units_needed = ceil(servings * serving_ml / container_ml * (1 + buffer))
//
// Test case from the spec: 100 servings of 125ml prosecco from 750ml
// bottles, no buffer -> ceil(100*125/750) = ceil(16.666..) = 17 bottles.
export function unitsNeeded(servings, servingMl, containerMl, bufferPct = 0) {
  const s = Number(servings) || 0;
  const sm = Number(servingMl) || 0;
  const cm = Number(containerMl) || 0;
  if (s <= 0 || sm <= 0 || cm <= 0) return 0;
  const buffer = Number(bufferPct) || 0;
  return Math.ceil((s * sm / cm) * (1 + buffer));
}

// How many of those units are still needed once existing stock is
// subtracted, and how many whole cases that comes to.
export function casesToOrder(unitsNeededCount, availableUnits, caseSize) {
  const need = Math.max(0, Number(unitsNeededCount) || 0);
  const have = Math.max(0, Number(availableUnits) || 0);
  const shortfallUnits = Math.max(0, need - have);
  const size = Number(caseSize) || 0;
  return {
    shortfallUnits,
    cases: size > 0 ? Math.ceil(shortfallUnits / size) : null,
  };
}

// Cost of only the new cases you'd actually need to buy (not the full
// serving cost) — per the "cost of new cases only" basis chosen for this
// feature.
export function orderCost(cases, costPerCase) {
  const c = Number(cases) || 0;
  const cost = Number(costPerCase) || 0;
  if (c <= 0 || cost <= 0) return 0;
  return c * cost;
}

// Full pipeline for one drink line against one product (either the line's
// own product, or one component of its recipe). `availableUnits` should
// already be the product's total stock in *container* units — i.e.
// totalStock(product, siteId) from constants/App, which already folds
// loose + sealed-case stock together.
export function planLineForProduct({ servings, servingMl, containerMl, bufferPct, availableUnits, caseSize, costPerCase }) {
  const need = unitsNeeded(servings, servingMl, containerMl, bufferPct);
  const { shortfallUnits, cases } = casesToOrder(need, availableUnits, caseSize);
  return {
    unitsNeeded: need,
    availableUnits: Math.max(0, Number(availableUnits) || 0),
    shortfallUnits,
    cases,
    cost: orderCost(cases, costPerCase),
  };
}

// A recipe-based drink line needs one of these per component, using the
// component's ml_per_serving in place of a plain serving_ml.
export function planLineForRecipe(servings, bufferPct, components) {
  return components.map(comp => ({
    productId: comp.productId,
    ...planLineForProduct({
      servings,
      servingMl: comp.mlPerServing,
      containerMl: comp.containerMl,
      bufferPct,
      availableUnits: comp.availableUnits,
      caseSize: comp.caseSize,
      costPerCase: comp.costPerCase,
    }),
  }));
}

// Total order cost for a whole drink line (single product, or every
// component of a recipe summed) — what item 4/5 actually compare between
// alternatives.
export function totalLineCost(planResults) {
  const list = Array.isArray(planResults) ? planResults : [planResults];
  return list.reduce((sum, r) => sum + (r.cost || 0), 0);
}
