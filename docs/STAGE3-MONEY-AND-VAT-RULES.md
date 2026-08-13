# STAGE 3 — MONEY & VAT RULES (WS6)

The launch standard, as verified live by the WS1 inventory and enforced by
the WS5 constraints. Single currency assumption: GBP everywhere.

## Representation — two deliberate domains, one boundary

**Web platform: exact `numeric`, 2-dp semantics.** Orders (subtotal,
discount_total, tax_amount, total, cash_received, change_given), order
lines/modifiers (unit_price, line_total, price) and payslips (hourly_rate,
gross, deductions, net) are PostgreSQL `numeric` — never float, never text
(inventory-verified: zero float/text money columns exist). pay_rate is
numeric(10,2); holiday_balance numeric(5,1).

**POS: integer minor units (pence, bigint).** Every `pos_*` money column is
`*_pence bigint` with non-negativity checks from inception. All till
arithmetic is integer.

**The boundary is the server.** *(R4.8 note: `submit_web_order()` was later replaced by the quote → reserve → finalise lifecycle; the server-side principle below is unchanged.)* The order pipeline computes ENTIRELY in
pence integers, then materialises `numeric` at insert as `pence / 100.0` —
so web rows are exact 2-dp by construction. POS→web sync keeps pence on the
`pos_*` side. No JavaScript floating-point result is ever the source of
truth: clients send items and payment facts; the server reprices.

## VAT — the WS6d lifecycle model (closure brief §1)

**Operator ruling (the accountant decision this round implements):** the
business launches **NOT_REGISTERED** — tax charged **0**, tax amount **0**,
no VAT number, and **no 20% fallback anywhere**. The former fallback chain
(`site_settings.vat_rate_percent` default 20 → `orders.tax_rate` default 20
→ `:= 20` in the RPC → `?? 20` in the till UI) has been REMOVED at every
link; `test:vat-launch` statically guards against any of those shapes
returning, and matrix §16 proves the live behaviour.

**Configuration lives on the STORE, nowhere else.** `stores.vat_status`
(`NOT_REGISTERED` fail-closed default | `REGISTERED`), `vat_number`
(GB-format enforced: `^GB[0-9]{9}([0-9]{3})?$`), and
`vat_registration_effective_date` are constraint-locked into exactly two
coherent shapes (`stores_vat_coherent`): NOT_REGISTERED carries neither
number nor date; REGISTERED requires both, well-formed. The browser reads
these fields but can never push them (cloudSync omits them; the publish
upsert preserves absent keys).

**The trading gate.** `stores.vat_config_confirmed_at` is the explicit
"§1 configuration completed" fact. `submit_web_order()` refuses to trade —
`store_vat_unconfigured` — for a caller with no home store or a store whose
configuration is unconfirmed. Missing config **blocks trading**; nothing is
ever defaulted. Since WS6e this confirmation is a Store Setup Wizard
completion fact — see the setup-lifecycle section below.

**Classification is explicit.** `menu_items.tax_code` references the
4-code service-owned registry `tax_codes` (`ZERO_RATED` 0%,
`REDUCED_RATE` 5%, `STANDARD_RATE` 20%, `OUTSIDE_SCOPE` 0%/uncharged —
statutory reference values, client read-only, verb-revoked). NULL means
*not yet classified*: a REGISTERED store refuses to sell it
(`product_tax_unclassified`); a NOT_REGISTERED store sells it at rate 0
like everything else. Nothing ever assumes a classification.

**Per-line derivation (REGISTERED mode), single rounding step.** The order
discount is allocated across lines by cumulative largest-exact shares —
`alloc_i = floor(D·C_i/S) − floor(D·C_{i−1}/S)` over line-pence prefix sums
— deterministic, order-preserving, summing EXACTLY to the discount with no
line over-allocated. Each line's contained VAT is then
`round(taxable_pence × rate / (100 + rate))` (half-up on integer pence, the
only rounding), and **order tax = Σ line taxes** with no re-rounding.
`orders.tax_rate` is now a nullable headline SNAPSHOT: `0` under
NOT_REGISTERED, the uniform rate when one rate applies, **NULL for a
mixed-rate order** — the per-line snapshots on `order_items`
(tax_code, tax_rate, taxable_amount, tax_amount) are the authority.

**Snapshots are forward-only truth.** Every order stores
`store_vat_status` (+ `vat_effective_date` when REGISTERED) at the moment
of sale; `orders_vat_snapshot_coherent` makes charged VAT against a
NOT_REGISTERED snapshot impossible for ANY writer (the NULL-passes-CHECK
loophole is closed with `coalesce`). Registering later, or re-classifying a
product later, provably alters no prior order or line (matrix §16).

## Enforced invariants (WS5, live-proven)

Non-negativity across all money columns; `discount ≤ subtotal`; the total
equation; `tax ≤ total`; cash orders require `received ≥ total` and
`change = received − total` exact to 2 dp; non-cash orders carry NULL cash
fields (the RPC's model); payslips require `net = gross − deductions` and
`deductions ≤ gross`; POS pence checks predate Stage 3 and remain.

## Registered follow-ups

Explicit MAXIMUM-value bounds (e.g. `total ≤ 100000.00`) are not yet
constrained — registered for the WS8 lifecycle round alongside completed-row
sealing. `job_vacancies.salary` is a public display STRING ("£12.50/hr"),
classified non-financial. The brief's optional numeric(12,2) unification is
deliberately NOT applied: existing precisions are retained to avoid POS/web
disruption (permitted by the brief), with consistency enforced by the
constraint set instead.

## Store setup lifecycle (WS6e — closure brief §1 completion)

`stores.setup_status` is `DRAFT` (fail-closed default) or `ACTIVE`, and is
DISTINCT from `stores.status` (the public open/closed display state). A
DRAFT store cannot trade: `submit_web_order()` raises
`store_setup_incomplete` after the VAT gate (an unconfirmed store still
reports `store_vat_unconfigured` first — the §16 contract).

Activation is atomic and total. `stores_setup_coherent` makes a
half-configured ACTIVE state impossible: ACTIVE requires an IANA
`timezone` (the store's business day derives from local midnight in that
zone — the WS2 reporting contract stated per store), an ISO-shaped
`currency_code`, a valid non-empty `payment_methods` set (⊆
{cash, card, online, gift_card}, no duplicates — `valid_payment_methods()`,
an immutable pure-jsonb validator usable in the CHECK), and the WS6d VAT
confirmation. The till offers, and the server accepts, ONLY methods in the
configured set (`payment_method_not_accepted`).

**One writer.** `configure_store_setup()` (owner + MFA — `is_owner()`
bakes aal2 in) validates every field with named errors (`invalid_timezone`
proven against PostgreSQL itself, `invalid_currency`,
`invalid_payment_methods`, `invalid_vat_config`), then writes the
configuration, confirms VAT and flips DRAFT→ACTIVE in one statement.
`trg_stores_config_guard` makes the configuration + VAT columns RPC/
service-only for API sessions (`store_config_is_rpc_only`); the wizard
marks its transaction with a local GUC, and `replace_collection`
publishes — which OMIT these keys by client contract — pass untouched
because absent keys never touch columns. `trg_stores_id_immutable` seals
the store's primary key forever (`store_id_immutable`): history is keyed
to it. Existing stores carrying the WS6d operator confirmation were
backfilled ACTIVE with the live till's embodied values (Europe/London,
GBP, cash/card/online); stores created later start DRAFT.

## Round-9b corrections (WS6f — audit items 1–10 + F11)

**Effective-date charging (F1).** REGISTERED status alone never charges.
`submit_web_order()` derives `v_charging = REGISTERED AND effective date ≤
the store's business today` (the local date in the store's configured
timezone). A future-dated registration snapshots `REGISTERED` + its date on
every order but derives 0 exactly like NOT_REGISTERED until the date
arrives; the pre-effective orders are immutable history. Registering is
forward-only in both directions.

**Component tax model (F5).** A line is priced as COMPONENTS — the base
product portion plus each modifier, every one taxed by ITS OWN
classification. The order discount allocates over lines by cumulative
largest-exact shares, then the SAME method splits each line's share across
its components (base first, then modifiers in payload order). One rounding
per component — `round(taxable_pence × rate / (100 + rate))` — the line's
tax is the sum of its component taxes, the order's tax the sum of line
taxes; nothing re-rounds. `order_item_modifiers` rows snapshot
`tax_code / tax_rate / taxable_amount / tax_amount`; a line whose
components mix rates snapshots a NULL line rate (the modifier rows are the
authority), exactly as a mixed order snapshots a NULL headline rate. A
charging store refuses an unclassified extra with the same
`product_tax_unclassified` it uses for products.

**Classification governance (F3/F4).** `menu_items.tax_code` is an OWNER
decision: `trg_menu_tax_code_guard` (invoker) refuses any other API writer
(`tax_code_is_owner_only`); menu publishes omit the key by client contract,
so manager publishing is untouched. `classify_products()` (owner + MFA) is
the classification path — json null explicitly unclassifies — and
`configure_store_setup()` refuses to make any store REGISTERED while a
single product is unclassified (`products_unclassified`, with the count).

**Store-scoped idempotency (F6).** A replayed order id must belong to the
caller's own store — on the fast path AND the insert-race path — or the
DEFINER function raises `order_id_conflict` instead of serving another
store's order around RLS.

**Launch vocabulary (F10).** The wizard and the database both pin
`timezone = 'Europe/London'` and `currency_code = 'GBP'`
(`unsupported_timezone` / `unsupported_currency` at the RPC;
`stores_timezone_supported` / `stores_currency_supported` CHECKs). These
are the values the platform genuinely drives — WS2 business-day reporting
and GBP money display; the till renders the store's currency symbol and
its `receipt_footer`. Widening the vocabulary is a deliberate future
migration, not a free-text field.

**Anonymous exposure (F11).** `stores` is no longer anonymously readable
at all; the public locator reads the `stores_public` view (the original
locator columns only, definer-style). Signed-in staff read the full row —
the till's fail-closed configuration path is an authenticated fetch in the
staff bundle, and the confirmed server order returned by the RPC replaces
the till's optimistic local copy (audit F7), so receipts show the
authoritative VAT immediately.

### Classification over time (WS6f-b)

The mandatory-classification gate fires at ACTIVATION, so the honest
question is what happens to a menu published afterwards. Two properties are
proven live rather than assumed:

* **Publishes never wipe a classification.** `replace_collection()` upserts
  each payload row using ONLY the columns that row provides, and the client
  contract omits `taxCode` entirely — so a manager's menu publish leaves
  every stored classification exactly as the owner set it.
* **A late addition fails closed on its own.** A manager may still ADD a
  product; it lands unclassified (the column stays owner-only). A charging
  store then refuses to sell THAT product (`product_tax_unclassified`)
  while the rest of the menu keeps selling — no mis-charge, and no
  menu-wide outage.

Because the condition is operational rather than structural, the owner gets
a permanent surface for it: a STANDALONE VAT-classification editor on the
menu tab (not only the activation wizard), per-product VAT chips on the menu
cards, and a warning banner listing the unclassified count whenever a store
is actually charging. The till's own VAT line mirrors the server's charging
predicate — status AND an arrived effective date — so a future-dated
registration never implies VAT is being taken.

## Operational closure (WS6g — Round 9e)

Three rules that keep the till's behaviour identical to the server's:

* **Classification is a PRE-PAYMENT gate.** While a store is charging, an
  unclassified product or extra cannot enter the cart at all — the tile is
  disabled and marked, and a cart-wide sweep repeats the check at the payment
  gate for carts assembled before a classification changed. The server's
  `product_tax_unclassified` remains the authority; the till simply never
  reaches it with money already taken.
* **No store fallback, ever.** The till binds to the employee's own store or
  refuses to trade. Borrowing another store's row would ring the sale into
  the wrong VAT configuration, accepted-method set and ledger.
* **One business date.** `businessDate.ts` derives the store's local date via
  `Intl` in the configured timezone, mirroring
  `(now() at time zone store.timezone)::date`. The UTC calendar date is never
  used for VAT decisions — during BST they disagree between 23:00 and 00:00.

**Gift cards are out of the launch vocabulary.** `gift_card` survives as a
`payment_method` enum value for POS imports, but no store may configure it
and the till does not offer it, because accepting one would record a money
movement with no balance validation and no redemption. Re-admitting it is a
deliberate future migration paired with a real gift-card ledger.

## Classification permanence (WS6i — Round 9g)

A VAT classification is **permanent historical metadata**. Once a product
carries a controlled code, that code may be CHANGED to another controlled
code but never removed. The rule is unconditional — it does not depend on
whether a store is registered, whether an effective date has arrived, or on
who is asking — so no passage of time can move a valid database into an
invalid one. To stop selling a product, delete it or reclassify it; to
correct data, an operator with real database credentials (a non-API session,
where `request.jwt.claims` is unset) remains the single auditable repair
path.

The invariant lives in `trg_menu_tax_code_guard`, ahead of every authority
branch, so it binds the owner's direct PostgREST update, `classify_products()`
itself, and the service role equally. An invariant that could be walked
around by choosing a different write path would not be one.

`configure_store_setup()` and `classify_products()` share a transaction-scoped
advisory lock so registration and classification cannot validate against each
other's pre-state concurrently.

**The server is the authority on time.** `store_trading_state()` returns the
store's business date, whether VAT is charging right now, and a
`configVersion` covering the store configuration and every classification.
The till consults it on mount, at each business-day boundary and immediately
before payment while online; the browser's own date calculation is the
offline fallback only.

## Online-confirmed selling (WS6j — Round 9h)

**A sale is not a sale until the server has recorded it.** The till submits,
waits, and only then clears the basket and tells the cashier that payment may
be taken. On any other outcome it says, explicitly, DO NOT take payment, and
keeps the basket so the sale can be retried.

This follows from server-authoritative pricing rather than contradicting it.
`submit_web_order()` deliberately ignores client-supplied prices — that is
what stops a compromised till forging totals or tax codes — and reprices from
the CURRENT catalogue while stamping its own `placed_at`/`completed_at` and
allocating the order number. A sale completed offline at 14:00 and delivered
at 17:00 would therefore be recorded with 17:00 prices, 17:00 tax
classifications, 17:00 deals and a 17:00 timestamp. The money in the drawer
would not match the money in the book. Durable delivery was never the same
thing as a durable transaction.

**What the outbox is for now.** It remains, and the sale is still written to
it BEFORE any network call — but only to resolve the committed-but-
response-lost case. The order id is client-generated and the RPC is
idempotent on it, so replaying the same id either commits once or returns the
row already stored: an ambiguous outcome becomes a knowable one. A sale the
server has permanently refused is dropped from the queue rather than retried
forever, and the cashier is told why, using an allow-listed refusal code —
raw backend text never reaches the UI.

**Genuinely offline trading belongs elsewhere.** Accepting payment with no
server would require immutable, versioned catalogues so the server could
price a queued sale against the catalogue that was valid when the money
changed hands. That machinery already exists on the Android POS side
(event-sourced `pos_*` ledger, immutable event ids, integer pence, sealed
shifts) and is audited separately. The browser till is the online instrument;
the POS app is the offline one.
