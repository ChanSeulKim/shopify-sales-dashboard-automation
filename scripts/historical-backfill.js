// =============================================
// HISTORICAL BACKFILL — daily-sync.gs data (daily + monthly)
// Split into 6-month chunks per run to stay under Apps Script's execution time limit (6 minutes for free tier accounts).
// =============================================

function fetch_2025_01() { fetchHistoricalData('store1.myshopify.com', 'store1', '2025-01-01', '2025-06-30'); }
function fetch_2025_07() { fetchHistoricalData('store1.myshopify.com', 'store1', '2025-07-01', '2025-12-31'); }
function fetch_2026_01() { fetchHistoricalData('store1.myshopify.com', 'store1', '2026-01-01', '2026-05-31'); }
function fetch_2026_06() { fetchHistoricalData('store1.myshopify.com', 'store1', '2026-06-01', '2026-06-08'); }

// Walks the date range day by day, refreshing daily rows (and monthly rows on month-end) for a single store. Always overwrites existing rows rather than skipping them, so re-running a backfill is safe.
function fetchHistoricalData(storeDomain, storeName, startDate, endDate) {
  Logger.log(`storeDomain: ${storeDomain}, storeName: ${storeName}`);

  const token = getAccessToken(storeDomain);
  const start = new Date(startDate + 'T12:00:00');
  const end   = new Date(endDate + 'T12:00:00');
  let current = new Date(start);

  while (current <= end) {
    const laDateStr = Utilities.formatDate(current, CONFIG.LA_TIMEZONE, 'yyyy-MM-dd');
    Logger.log(`[HISTORICAL] processing: ${laDateStr}`);

    const sheet = getOrCreateSheet();

    // daily
    const row = fetchDailyRow(token, storeDomain, storeName, laDateStr);
    if (row) {
      const existing = findRow(sheet, storeName, 'daily', laDateStr);
      existing ? updateRow(sheet, existing, row) : appendRow(sheet, row);
      Logger.log(`[${existing ? 'UPDATE' : 'INSERT'}] ${laDateStr} daily`);
    }

    // monthly
    if (isLastDayOfMonth(laDateStr)) {
      const monthStr = `${laDateStr.substring(0, 7)}-01`;
      const monthRow = fetchMonthlyRow(token, storeDomain, storeName, laDateStr);
      if (monthRow) {
        const existing = findRow(sheet, storeName, 'monthly', monthStr);
        existing ? updateRow(sheet, existing, monthRow) : appendRow(sheet, monthRow);
        Logger.log(`[${existing ? 'UPDATE' : 'INSERT'}] ${monthStr} monthly`);
      }
    }

    current.setDate(current.getDate() + 1);
  }
}

// =============================================
// HISTORICAL BACKFILL — weekly rollups
// Weekly only applies to CONFIG.STORES[1]. Generates every Saturday from 2025-01-04 through today and refreshes each week's row.
// =============================================
function runWeeklyBackfill() {
  const props = PropertiesService.getScriptProperties();
  const sheet = getOrCreateSheet();

  const saturdays = [];
  const start     = new Date('2025-01-04T12:00:00-08:00');
  const today     = new Date();

  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 7)) {
    saturdays.push(Utilities.formatDate(d, CONFIG.LA_TIMEZONE, 'yyyy-MM-dd'));
  }

  const store  = CONFIG.STORES[1];
  const domain = store.domain !== null ? store.domain : props.getProperty('SHOPIFY_STORE2_DOMAIN');
  const token  = getAccessToken(domain);

  saturdays.forEach(lastDayStr => {
    const firstDayStr = getSundayOfWeek(lastDayStr);
    const row         = fetchWeeklyRow(token, domain, store.name, lastDayStr, firstDayStr);
    if (row) {
      const existing = findRow(sheet, store.name, 'weekly', lastDayStr);
      existing ? updateRow(sheet, existing, row) : appendRow(sheet, row);
      Logger.log(`[${existing ? 'UPDATE' : 'INSERT'}] ${lastDayStr} weekly`);
    }
  });
}

// =============================================
// HISTORICAL BACKFILL — monthly rollups only
// Use this only if a monthly row was missed by fetchHistoricalData (e.g. a backfill chunk was interrupted mid-month). Re-running fetchHistoricalData covers the same ground, so this is a narrower fallback rather than a regular part of the backfill flow.
// =============================================
function runMonthlyBackfill() {
  const props = PropertiesService.getScriptProperties();
  const sheet = getOrCreateSheet();

  const lastDays = [
    '2025-01-31', '2025-02-28', '2025-03-31', '2025-04-30',
    '2025-05-31', '2025-06-30', '2025-07-31', '2025-08-31',
    '2025-09-30', '2025-10-31', '2025-11-30', '2025-12-31',
    '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30',
    '2026-05-31',
  ];

  CONFIG.STORES.forEach(store => {
    const domain = store.domain !== null ? store.domain : props.getProperty('SHOPIFY_STORE2_DOMAIN');
    const token  = getAccessToken(domain);

    lastDays.forEach(lastDayStr => {
      const monthStr = `${lastDayStr.substring(0, 7)}-01`;
      const row      = fetchMonthlyRow(token, domain, store.name, lastDayStr);
      if (row) {
        const existing = findRow(sheet, store.name, 'monthly', monthStr);
        existing ? updateRow(sheet, existing, row) : appendRow(sheet, row);
        Logger.log(`[${existing ? 'UPDATE' : 'INSERT'}] ${monthStr} monthly`);
      }
    });
  });
}

// =============================================
// HISTORICAL BACKFILL — product-type-sync.gs data (category sales + top 3 products, daily + monthly)
// =============================================

function fetchProductType_2025_01() { fetchHistoricalProductTypeData('store1.myshopify.com', 'store1', '2025-01-01', '2025-06-30'); }
function fetchProductType_2025_07() { fetchHistoricalProductTypeData('store1.myshopify.com', 'store1', '2025-07-01', '2025-12-31'); }
function fetchProductType_2026_01() { fetchHistoricalProductTypeData('store1.myshopify.com', 'store1', '2026-01-01', '2026-05-31'); }

// Walks the date range day by day. Refreshes daily category sales every day, and additionally refreshes monthly sales + top 3 products on month-end — mirroring the structure of runDailyProductTypeSync().
function fetchHistoricalProductTypeData(storeDomain, storeName, startDate, endDate) {
  Logger.log(`[Product Type Historical] ${storeDomain} / ${startDate} ~ ${endDate}`);

  const token = getAccessToken(storeDomain);
  const start = new Date(startDate + 'T12:00:00Z');
  const end   = new Date(endDate + 'T12:00:00Z');
  let current = new Date(start);

  while (current <= end) {
    const laDate = Utilities.formatDate(current, CONFIG.LA_TIMEZONE, 'yyyy-MM-dd');
    Logger.log(`[HISTORICAL] processing: ${laDate}`);

    // daily
    const productTypeMap = fetchSalesByProductType(storeDomain, token, laDate, laDate);
    writeSalesByProductType(storeName, productTypeMap, laDate, 'daily');

    // monthly
    if (isLastDayOfMonth(laDate)) {
      const year     = laDate.substring(0, 4);
      const month    = laDate.substring(5, 7);
      const firstDay = `${year}-${month}-01`;

      Logger.log(`[HISTORICAL Monthly] ${firstDay} ~ ${laDate}`);
      const monthlyProductTypeMap = fetchSalesByProductType(storeDomain, token, firstDay, laDate);
      const topProductsMap        = fetchTop3ByProductType(storeDomain, token, firstDay, laDate);
      writeSalesByProductType(storeName, monthlyProductTypeMap, firstDay, 'monthly');
      writeTopProducts(storeName, topProductsMap, firstDay);
    }

    current.setUTCDate(current.getUTCDate() + 1);
    Utilities.sleep(300); // avoid hitting Shopify's rate limit
  }
}
