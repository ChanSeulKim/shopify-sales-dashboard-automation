# Troubleshooting Log

This document records real bugs encountered while building and testing this automation, and how each was diagnosed and fixed. Kept as a record of the debugging process, not just the final code.

## Bug: Sunday misidentified as Saturday in weekly rollups

**Symptom**: Weekly rollups were sometimes triggered on the wrong day — a Sunday's date was being treated as a Saturday, causing weekly data to be pulled for the wrong 7-day window and to run on days it shouldn't have.

**Root cause**: `isSaturday()` and `getSundayOfWeek()` originally constructed JavaScript `Date` objects without anchoring to a specific time zone (e.g. `new Date(dateStr + 'T12:00:00')`). Without an explicit zone, the date was interpreted relative to the Apps Script runtime's default time zone, which could shift the resulting weekday by one day depending on when and where the script executed.

**Fix**: Anchor every date string explicitly to UTC (`T12:00:00Z`) before computing the weekday or doing date arithmetic, then format the result in the target time zone (`CONFIG.LA_TIMEZONE`) only at the very end. This removed the dependency on the runtime's ambient time zone entirely.

**Verification**: Added a temporary test function that hardcoded known Saturday/Sunday/Monday dates and logged the computed weekday for each, confirming the fix before relying on it in production.

**Impact if left unfixed**: Weekly reporting is used by one store's team for weekly operating decisions (see [03-decisions.md](03-decisions.md)). A misidentified week boundary would have meant that team reviewing numbers for the wrong 7-day window — silently, since the automation would still run and produce a result, just for the wrong dates.

## Bug: Daylight saving time silently shifting day boundaries

**Symptom**: Date-range boundaries (start/end of day, start/end of month) were occasionally off by an hour, depending on the time of year.

**Root cause**: Los Angeles shifts between PST (UTC-8) and PDT (UTC-7) depending on daylight saving time. An earlier version of the offset calculation assumed a fixed `-08:00`, which is only correct for part of the year.

**Fix**: `getLAUTCOffset()` recomputes the actual UTC offset for the specific date being processed, using `Utilities.formatDate(d, CONFIG.LA_TIMEZONE, 'Z')` rather than a hardcoded string. This way the correct offset (PST or PDT) is always used for that date, regardless of when the script runs.

**Impact if left unfixed**: An hour-off boundary near midnight can pull in part of the wrong day's orders or drop part of the correct day's — for daily and monthly totals that get reviewed by management and other teams, this would have produced numbers that looked plausible but were quietly wrong, for roughly half the year (whichever half fell outside the assumed fixed offset).

## Bug: `getSundayOfWeek()` returning an 8-day range instead of 7

**Symptom**: A manual test logged a "weekly range" of `2026-05-30 ~ 2026-06-06` — 8 days instead of 7.

**Root cause**: Mixing `setDate()` (which uses the local/runtime time zone) with `getUTCDate()` (which reads the UTC value) in the same line produced an inconsistent result, because the two methods weren't operating on the same time-zone basis.

**Fix**: Used `setUTCDate()` and `getUTCDate()` consistently together, after anchoring the input date to UTC. Mixing local-time and UTC-time methods on the same `Date` object turned out to be the recurring source of off-by-one-day bugs throughout this project — the general lesson was to pick one time basis (UTC) for all date arithmetic and only convert to a named time zone for display/formatting at the end.

## Bug: `findRow()` lookup mismatch after restructuring `Sales by Product Type` writes

**Symptom**: Rows that should have been updated were instead being inserted as new rows every run, duplicating data for `Top Product by Product Type`.

**Root cause**: While building the lookup function for that sheet (`findTopProductRow()`), the column index used to read the date and category from existing rows didn't match the actual column order in the sheet (`store, period, date, title, productType, ...`), so the function was comparing against the wrong cells and never found a match.

**Fix**: Re-verified the actual column order in the target sheet and corrected the indices used in the lookup function to match.

**Takeaway**: Whenever a sheet's column layout changes, every lookup function reading that sheet by fixed index needs to be re-checked — a silent index mismatch doesn't throw an error, it just always returns "not found," which looks like normal insert behavior until duplicates pile up.

**Impact if left unfixed**: Duplicate rows would have accumulated in the Top Product sheet every single run, making the same rank/category combination appear multiple times and breaking any downstream pivot or chart that assumed one row per category/rank/date.

## Bug: ShopifyQL GraphQL field not found after testing on a different API version

**Symptom**: `runShopifyQL()` returned a 200 status code but the field came back `null`, with the response body containing:
```
"Field 'shopifyqlQuery' doesn't exist on type 'QueryRoot'"
```

**Root cause**: The Admin API version configured in `CONFIG.API_VERSION` did not match the API version the production app was actually built against. The `shopifyqlQuery` GraphQL field is only available on specific API versions.

**Fix**: Updated `CONFIG.API_VERSION` to match the correct, current API version.

**Takeaway**: A 200 response code on its own doesn't mean the request succeeded — GraphQL can return 200 with an `errors` array in the body. Logging the raw response body (not just the status code) during debugging surfaced this immediately.
