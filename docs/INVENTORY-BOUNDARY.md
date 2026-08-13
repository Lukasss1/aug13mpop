# Inventory & food-operations boundary (R4.8, Workstream P — explicit disable)

**Decision:** the inventory domain is **explicitly disabled** for this launch
rather than half-shipped. The schema stubs that exist (`ingredients`,
`stock_movements`) are retained for the allergen specification chain
(`ingredient_specifications` references `ingredients`) and future build-out,
but **no surface displays stock levels, supplier facts, costs or reorder
state** — displaying invented numbers would violate the no-fabrication rule.

* Stock control, purchase orders, goods-in, counts, waste and transfers run on
  the owner's **external system / paper process** until the domain is built to
  the standard in the closure spec (§20). Recipe sales do NOT decrement any
  theoretical stock — there is no half-true ledger.
* Food-safety operational checks (opening/closing, fridge/freezer temps,
  cleaning, allergen station, corrective actions) run on the existing shift
  **checklist** feature where configured by the owner, or on paper; a failed
  critical check is recorded as failed — the checklist feature has no
  auto-complete.
* Re-enabling is a scoped project: the closure report classifies inventory as
  *intentionally disabled*, with the minimum model from the spec as the
  build-out definition.
