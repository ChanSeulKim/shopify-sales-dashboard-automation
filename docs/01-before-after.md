# Before / After: From Manual Exports to Automated Pipeline

## The Manual Process (Before)

Before this automation, producing the monthly sales report required three separate manual steps, repeated every reporting cycle.

### Step 1 — Category-level sales

A ShopifyQL report was built in Shopify's Analytics dashboard and exported on a recurring basis. The exported file was downloaded and pasted into a Google Sheets template. A spreadsheet formula then grouped Shopify's raw `product_type` field (formatted as `Top_Mid_Sub`, e.g. `CATEGORY1_A_Item`) into a smaller set of dashboard categories, since the largest category (CATEGORY1) needed to be broken down to the mid-level while everything else only needed the top level. A pivot table on top of that grouped column produced the final category totals.

### Step 2 — Top 3 products per category

For each top-level category, a separate ShopifyQL report was built, sorted by total sales, and the top 3 product titles were manually copied into the dashboard sheet.

### Step 3 — Repeat monthly

Both steps were repeated every reporting cycle, by hand, with no automated validation that the right data range was pasted or that the grouping logic had been applied consistently.

### What this cost

- **Time**: one person from each of 4 teams spent roughly 10 minutes per week on data entry — about 35 hours per year in aggregate, not counting the time spent building category-specific reports for the top-3 product step
- **Error risk**: wrong paste range, missed rows, inconsistent category grouping between cycles
- **Single point of failure**: the process depended on one person knowing the exact steps; if that person was unavailable, the report didn't get produced
- **Limited accessibility**: teams that only needed to view the data (rather than enter it) had no self-serve access — they had to send a separate request and wait for someone to check the numbers for them
- **No history**: pasted data overwrote previous values with no record of what changed

## The Automated Process (After)

The same three steps are now handled by a Google Apps Script project running on a daily trigger, with no manual export, download, or paste required.

| Step | Before | After |
|---|---|---|
| Category-level sales | Export report → download → paste → pivot table | `fetchSalesByProductType()` queries Shopify directly and writes to the sheet |
| Category grouping | Spreadsheet formula (`SEARCH` + nested `IF`) | `getProductTypeGroup()` in code, same logic, version-controlled |
| Top 3 products per category | Separate report per category, manually sorted and copied | `fetchTop3ByProductType()` queries and writes automatically |
| Frequency | Manual, whenever someone ran the process | Automatic, daily at 09:00 KST |
| Data range / paste errors | Possible | Not applicable — no manual paste step exists |
| Edit history | Lost on each overwrite | Preserved — rows are updated in place by key (store + period + date + category), not deleted and re-added |
| Dependency on one person | High | Low — runs automatically; the category-grouping logic is documented in `docs/02-architecture.md` |

## What Changed Structurally

- The category-grouping rule that used to live only in a spreadsheet formula now also exists as code (`getProductTypeGroup()`), making it version-controlled and easier to extend
- Top 3 product queries that used to require building and reading a separate Shopify report per category are now parameterized and run automatically (`fetchTop3ByProductType()`)
- Daily, weekly, and monthly rollups are computed and refreshed automatically, including a 3-day lookback window to correct for Shopify analytics data that can lag slightly behind real-time
- Monthly rollups (both core sales metrics and category sales) are automatically recomputed on the last day of each month — no manual trigger needed

## Result

The reporting process that used to cost about 35 hours per year in data-entry time alone now requires zero manual time once set up. Teams that previously had to request and wait for someone to check the numbers can now open the spreadsheet directly and see current data, without needing to know the underlying process or depend on a specific person to run it.
