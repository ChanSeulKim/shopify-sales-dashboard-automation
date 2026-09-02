# Architecture

## Overview

```
Shopify Admin API / ShopifyQL (Analytics GraphQL endpoint)
        │
        ▼
Google Apps Script (scheduled trigger, daily 09:00 KST)
        │
        ▼
Google Sheets
  ├─ Daily Sales                       (daily / weekly / monthly metrics)
  ├─ Sales by Product Type             (category-level sales)
  └─ Top Product by Product Type       (top 3 products per category)
```

## Components

### Trigger

A single time-based Apps Script trigger fires every day at 09:00 KST. Two entry-point functions run independently:

- `runDailySync()` — core sales metrics (daily/weekly/monthly)
- `runDailyProductTypeSync()` — category-level sales and top 3 products

Both are registered once via `setup-triggers.gs` and require no further manual scheduling.

### Data source

Two Shopify data access patterns are used, depending on what's needed:

- **ShopifyQL (via the Admin GraphQL endpoint)** — used for aggregated sales metrics (net sales, orders, AOV, conversion rate) and category-level breakdowns. ShopifyQL was chosen over the REST Orders API because it matches the query style of the analytics reports this project replaced, and because it can aggregate (`GROUP BY`, `SHOW total_sales`) directly on Shopify's side rather than requiring every order to be pulled and aggregated locally.
- **Admin REST API** — used for customer counts (new signups, cumulative total), which ShopifyQL does not expose in the same way.

### Timezone handling

Shopify's analytics are scoped to the store's local time zone (Los Angeles), while the Google Sheet and trigger schedule run on Korean time (KST). This means every date boundary (start/end of day, start/end of month, which day is a Saturday) has to be computed in LA time and then converted to UTC-bound ISO strings for API calls.

LA shifts between PST (UTC-8) and PDT (UTC-7) depending on daylight saving time, so a fixed offset can't be hardcoded — `getLAUTCOffset()` recomputes the correct offset for each specific date. See [04-troubleshooting.md](04-troubleshooting.md) for the bugs this caused before the offset was computed per-date instead of assumed fixed.

### Write strategy: update-in-place, not delete-and-reappend

Every sheet write first looks up whether a row already exists for the same key (store + period + date, plus category/rank where relevant). If it exists, the row is updated in place; if not, a new row is appended. This was chosen over deleting and re-inserting rows for two reasons:

- Google Sheets' version history shows what value changed, rather than just "a row was deleted and a new one appended"
- It avoids re-sorting/re-ordering rows on every run, which a delete-and-reappend approach would otherwise require to keep row order stable

### Re-validation window

Every run re-checks the last 3 LA calendar days, not just "today." Shopify's analytics data can lag slightly behind real-time, so a day's numbers loaded immediately after midnight may not yet be final. Re-running the same date for a few days corrects this without requiring any manual re-trigger.

### Category grouping

Shopify's raw `product_type` field is stored as `Top_Mid_Sub` (e.g. `CATEGORY1_A_Item`). A grouping function (`getProductTypeGroup()`) collapses this into a smaller, dashboard-facing set of categories — the dashboard's largest top-level category is broken down to the mid-level, while the rest are grouped at the top level only. This asymmetry reflects the actual sales mix: that one category accounts for the large majority of total sales, so a single combined total wouldn't be informative enough for that category specifically, while the remaining categories are small enough that a top-level total is sufficient. This logic, originally implemented only as a spreadsheet formula, now also exists in code, so it's version-controlled and consistent across daily, monthly, and historical-backfill runs.

### Historical backfill

Because the regular sync only ever looks at the last 3 days, a separate set of functions (`historical-backfill.gs`) exists to populate longer date ranges — for initial setup, or to recover from an extended outage. These are split into multi-month chunks to stay under Apps Script's execution time limit, and use the same update-in-place logic as the daily sync, so re-running a backfill is always safe.

## Why Google Sheets as the dashboard layer

Sheets was kept as the destination (rather than introducing a separate BI tool) because:

- It matched the team's existing reporting habit, requiring no new tool adoption
- It supports per-team access without exposing raw Shopify credentials
- Pivot tables and charts can be built directly on top of the structured output sheets without any additional ETL step
