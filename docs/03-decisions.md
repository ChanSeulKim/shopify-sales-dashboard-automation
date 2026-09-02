# Technical Decisions

This document records the key design choices made while building this automation, and the reasoning behind each one.

## Business Context

These three decisions came from business/operational needs rather than purely technical constraints, and are worth separating out from the implementation choices below.

### Why weekly rollups apply to only one store

Weekly reporting was only needed for one specific store, because that store's team makes operating decisions on a weekly cadence. The other store(s) in `CONFIG.STORES` don't have a weekly review process, so building and maintaining a weekly rollup for them would have added cost without supporting any actual decision-making cycle.

### Why these particular metrics

The metric set (net sales, shipping, duties, additional fees, taxes, total sales, orders, AOV, conversion rate, new/returning/cumulative customers) was chosen to be broadly usable across audiences rather than narrowly tailored to one team's KPIs. This sheet is shared with both the management/leadership side and other teams who reference it for their own purposes, so the metric set intentionally covers sales, order behavior, and customer composition together rather than a narrower set optimized for a single use case.

### Why daily and monthly are stored as separate rows, not a calculated monthly = sum(daily)

Some metrics — most notably conversion rate and returning-customer rate — don't aggregate correctly as a simple sum or average of daily values. A conversion rate is itself a ratio (sessions that converted ÷ total sessions), so averaging 30 daily conversion rates does not equal the true monthly conversion rate; the same applies to returning-customer rate. Because of this, monthly figures are queried directly from Shopify for the full month range rather than derived from daily rows in the sheet. This means daily rows support day-to-day, self-serve monitoring, while monthly rows remain independently accurate for any metric where simple aggregation across days would distort the result.

## Implementation Decisions

## ShopifyQL over the REST Orders API

**Decision**: Use ShopifyQL via the Admin GraphQL endpoint for sales metrics and category aggregation, rather than pulling raw orders via the REST Orders API and aggregating them in Apps Script.

**Why**: The existing manual process already used ShopifyQL reports exported from Shopify's Analytics dashboard, so keeping the same query language meant the automation produced numbers that matched the team's existing mental model and prior reports — no re-validation against a different aggregation method was needed. ShopifyQL also aggregates on Shopify's side (`GROUP BY product_type`, `SHOW total_sales`), which is simpler and faster than pulling every order via REST and summing them locally, especially as order volume grows.

## Update-in-place instead of delete-and-reappend

**Decision**: Every sheet write checks for an existing row (by store + period + date + category/rank) and updates it if found, rather than deleting old rows and appending new ones.

**Why**: Deleting and re-appending loses Google Sheets' edit history — there's no way to see what a value used to be. Updating in place preserves that history and avoids the extra complexity of re-sorting rows to keep a stable order after repeated delete/append cycles.

## Re-checking the last 3 days on every run

**Decision**: Each daily run re-validates the last 3 LA calendar days, not just the current day.

**Why**: Shopify's analytics can lag slightly behind real-time. A day's numbers pulled right after midnight may not yet reflect orders that settle later. Re-running the same date across a few days self-corrects this without needing a manual re-trigger or a "did this day finish properly" check.

## Computing the LA/UTC offset per date instead of hardcoding it

**Decision**: `getLAUTCOffset()` recomputes the UTC offset for each specific date rather than assuming a fixed `-08:00`.

**Why**: Los Angeles shifts between PST (UTC-8) and PDT (UTC-7) depending on daylight saving time. A fixed offset works for part of the year and silently produces wrong date boundaries for the rest. This was discovered the hard way — see [04-troubleshooting.md](04-troubleshooting.md) for the specific bugs it caused.

## Weekly rollups scoped to a single store, kept as a separate block

**Decision**: Weekly metrics only apply to one store in `CONFIG.STORES`, and that logic lives in its own block inside `runDailySync()` rather than being folded into the per-store loop that handles daily/monthly.

**Why**: Folding a single-store special case into a loop that otherwise runs for every store would hide that asymmetry — someone reading `syncData()` might assume weekly applies everywhere. Keeping it as a separate, clearly-labeled block makes the single-store scope visible directly in the code structure, not just in a comment.

## Splitting product-type sales (mid-level) from top-3 products (top-level only)

**Decision**: `Sales by Product Type` breaks the largest category down to the mid-level (e.g. `CATEGORY1_A`, `CATEGORY1_B`), while `Top Product by Product Type` only distinguishes top-level categories (e.g. `CATEGORY1` as a whole).

**Why**: The dashboard's sales breakdown needed mid-level granularity to match prior reporting detail, but best-seller tracking only needed to answer "what's selling well within each broad category" — running a separate ShopifyQL query per mid-level sub-category for top-3 products would have multiplied API calls without adding insight the team actually used.

## Recomputing monthly rollups only on month-end, not daily

**Decision**: Monthly sales and top-3 products are only recalculated when one of the 3 re-validated days happens to be the last day of its month — not every day.

**Why**: Top-3 product queries run once per category and add up in API cost. Since a month's totals don't change after the month ends, there's no benefit to recomputing them daily — only the final day's run needs to produce the monthly rollup, and the 3-day re-validation window already ensures that day gets re-checked if the first attempt was incomplete.

## Storing credentials and store config outside the code

**Decision**: Access tokens, client secrets, and store domains are stored in Apps Script's Script Properties, never hardcoded in the script files.

**Why**: This keeps secrets out of version control entirely, which matters both for normal security hygiene and specifically for publishing a sanitized version of this project publicly (as in this repository).
