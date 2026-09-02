// =============================================
// MAIN ENTRY POINT
// Runs on a daily trigger at 09:00 KST. (see setupDailySyncTrigger)
// Two blocks run in sequence: 1) refresh daily/monthly for every store, 2) refresh weekly for a single store (CONFIG.STORES[1]).
// Weekly is NOT folded into syncData() — keeping it as a separate block makes it obvious from the code alone that weekly only applies to one store.
// =============================================
function runDailySync() {
  const props = PropertiesService.getScriptProperties();

  CONFIG.STORES.forEach(store => {
    const domain = store.domain !== null ? store.domain : props.getProperty('SHOPIFY_STORE2_DOMAIN');
    const token  = getAccessToken(domain);
    Logger.log(`[STORE] ${store.name} starting`);

    for (let i = 3; i >= 1; i--) {
      const laDate = getLADateDaysAgo(i);
      Logger.log(`[START] ${store.name} ${i} day(s) ago: ${laDate}`);
      syncData(token, domain, store.name, laDate, true);
    }
  });

  // ── weekly ──
  const weeklyStore  = CONFIG.STORES[1];
  const weeklyDomain = weeklyStore.domain !== null ? weeklyStore.domain : props.getProperty('SHOPIFY_STORE2_DOMAIN');
  const weeklyToken  = getAccessToken(weeklyDomain);
  const sheet        = getOrCreateSheet();

  for (let i = 3; i >= 1; i--) {
    const laDate = getLADateDaysAgo(i);
    if (isSaturday(laDate)) {
      const weekStart      = getSundayOfWeek(laDate);
      Logger.log(`[WEEKLY RANGE] ${weekStart} ~ ${laDate}`);
      const existingWeekly = findRow(sheet, weeklyStore.name, 'weekly', laDate);
      const row            = fetchWeeklyRow(weeklyToken, weeklyDomain, weeklyStore.name, laDate, weekStart);
      if (row) {
        existingWeekly ? updateRow(sheet, existingWeekly, row) : appendRow(sheet, row);
        Logger.log(`[${existingWeekly ? 'UPDATE' : 'INSERT'}] ${laDate} weekly`);
      } else {
        Logger.log(`[WARN] ${laDate} weekly data not received`);
      }
    } else {
      Logger.log(`[SKIP] ${laDate} is not Saturday, skipping weekly`);
    }
  }
}

// =============================================
// DATA SYNC
// =============================================

function syncData(token, storeDomain, storeName, laDateStr, isRetry) {
  const sheet = getOrCreateSheet();

  // ── daily ──
  const existingDaily = findRow(sheet, storeName, 'daily', laDateStr);
  Logger.log(`findRow result: ${existingDaily}, date: ${laDateStr}, period: daily`);

  if (existingDaily && !isRetry) {
    Logger.log(`[SKIP] ${laDateStr} daily already exists`);
  } else {
    const row = fetchDailyRow(token, storeDomain, storeName, laDateStr);
    if (row) {
      existingDaily ? updateRow(sheet, existingDaily, row) : appendRow(sheet, row);
      Logger.log(`[${existingDaily ? 'UPDATE' : 'INSERT'}] ${laDateStr} daily`);
    } else {
      Logger.log(`[WARN] ${laDateStr} daily data not received`);
    }
  }

  // ── monthly ──
  if (isLastDayOfMonth(laDateStr)) {
    const monthStr        = `${laDateStr.substring(0, 7)}-01`;
    const existingMonthly = findRow(sheet, storeName, 'monthly', monthStr);
    const row             = fetchMonthlyRow(token, storeDomain, storeName, laDateStr);
    if (row) {
      existingMonthly ? updateRow(sheet, existingMonthly, row) : appendRow(sheet, row);
      Logger.log(`[${existingMonthly ? 'UPDATE' : 'INSERT'}] ${monthStr} monthly`);
    }
  }
}

// =============================================
// ROW BUILDERS — one per period type
// =============================================

// ── daily ──
function fetchDailyRow(token, storeDomain, storeName, laDateStr) {
  try {
    const metrics = fetchShopifyQL(storeDomain, laDateStr, laDateStr, token);
    if (!metrics) return null;

    const offset         = getLAUTCOffset(laDateStr);
    const startISO       = `${laDateStr}T00:00:00${offset}`;
    const endISO         = `${laDateStr}T23:59:59${offset}`;
    const newCust        = fetchNewCustomers(token, storeDomain, startISO, endISO);
    const totalCustCount = fetchTotalCustomerCount(token, storeDomain, laDateStr);

    return buildRow(storeName, 'daily', laDateStr, metrics, ['', '', ''], newCust, totalCustCount);
  } catch (e) {
    Logger.log(`fetchDailyRow error: ${e}`);
    return null;
  }
}

// ── weekly ──
function fetchWeeklyRow(token, storeDomain, storeName, lastDayStr, firstDayStr) {
  try {
    const offset         = getLAUTCOffset(lastDayStr);
    const startISO       = `${firstDayStr}T00:00:00${offset}`;
    const endISO         = `${lastDayStr}T23:59:59${offset}`;

    const metrics        = fetchShopifyQL(storeDomain, firstDayStr, lastDayStr, token);
    if (!metrics) return null;

    const newCust        = fetchNewCustomers(token, storeDomain, startISO, endISO);
    const totalCustCount = fetchTotalCustomerCount(token, storeDomain, lastDayStr);
    const topProducts    = getTopProductsByRevenue(storeDomain, token, firstDayStr, lastDayStr, 3);

    return buildRow(storeName, 'weekly', lastDayStr, metrics, topProducts, newCust, totalCustCount);
  } catch (e) {
    Logger.log(`fetchWeeklyRow error: ${e}`);
    return null;
  }
}

// ── monthly ──
function fetchMonthlyRow(token, storeDomain, storeName, lastDayStr) {
  try {
    const year     = lastDayStr.substring(0, 4);
    const month    = lastDayStr.substring(5, 7);
    const firstDay = `${year}-${month}-01`;
    const offset   = getLAUTCOffset(lastDayStr);
    const startISO = `${firstDay}T00:00:00${offset}`;
    const endISO   = `${lastDayStr}T23:59:59${offset}`;

    const metrics        = fetchShopifyQL(storeDomain, firstDay, lastDayStr, token);
    if (!metrics) return null;

    const newCust        = fetchNewCustomers(token, storeDomain, startISO, endISO);
    const totalCustCount = fetchTotalCustomerCount(token, storeDomain, lastDayStr);
    const topProducts    = getTopProductsByRevenue(storeDomain, token, firstDay, lastDayStr, 3);
    const monthStr       = lastDayStr.substring(0, 7);

    return buildRow(storeName, 'monthly', monthStr, metrics, topProducts, newCust, totalCustCount);
  } catch (e) {
    Logger.log(`fetchMonthlyRow error: ${e}`);
    return null;
  }
}

// ── shopifyQL ──
// sales and sessions are different ShopifyQL data sources, so two separate queries are required.
function fetchShopifyQL(storeDomain, startDate, endDate, token) {
  const salesQuery = `FROM sales SHOW net_sales, shipping_charges, duties, additional_fees, taxes, total_sales, orders, average_order_value, customers, returning_customers 
                      SINCE ${startDate} UNTIL ${endDate}`;
  const sessionsQuery = `FROM sessions SHOW conversion_rate SINCE ${startDate} UNTIL ${endDate}`;
  const salesResult    = runShopifyQL(storeDomain, salesQuery, token);
  const sessionsResult = runShopifyQL(storeDomain, sessionsQuery, token);

  if (!salesResult) return null;

  const getVal = (result, name) => {
    if (!result) return 0;
    const cols = result.columns.map(c => c.name);
    const row  = result.rows[0];
    if (!row) return 0;
    const idx = cols.indexOf(name);
    return idx >= 0 ? parseFloat(row[name] || 0) : 0;
  };

  return {
    netSales:           getVal(salesResult, 'net_sales'),
    shippingCharges:    getVal(salesResult, 'shipping_charges'),
    duties:             getVal(salesResult, 'duties'),
    additionalFees:     getVal(salesResult, 'additional_fees'),
    tax:                getVal(salesResult, 'taxes'),
    totalSales:         getVal(salesResult, 'total_sales'),
    orderCount:         getVal(salesResult, 'orders'),
    aov:                getVal(salesResult, 'average_order_value'),
    conversionRate:     getVal(sessionsResult, 'conversion_rate'),
    totalCustomers:     getVal(salesResult, 'customers'),
    returningCustomers: getVal(salesResult, 'returning_customers'),
  };
}

// ── new customers ──
// Counts customers created within the window — newly signed-up customers, not customers who placed an order.
function fetchNewCustomers(token, storeDomain, startISO, endISO) {
  let count = 0;
  let url = `https://${storeDomain}/admin/api/${CONFIG.API_VERSION}/customers.json`
    + `?created_at_min=${encodeURIComponent(startISO)}`
    + `&created_at_max=${encodeURIComponent(endISO)}`
    + `&limit=250`;

  while (url) {
    const res = shopifyGet(token, storeDomain, url);
    if (!res) break;

    const data = JSON.parse(res.getContentText());
    count += (data.customers || []).length;
    url = extractNextLink(res.getHeaders()['Link'] || res.getHeaders()['link'] || '');
  }

  Logger.log(`New customers: ${count}`);
  return count;
}

// ── total customer count ──
// Cumulative customer count as of a given date, not just customers created within the period.
function fetchTotalCustomerCount(token, storeDomain, asOfDate) {
  const offset = getLAUTCOffset(asOfDate);
  const endISO = `${asOfDate}T23:59:59${offset}`;

  const url = `https://${storeDomain}/admin/api/${CONFIG.API_VERSION}/customers/count.json`
    + `?created_at_max=${encodeURIComponent(endISO)}`;

  const res = shopifyGet(token, storeDomain, url);
  if (!res) return 0;

  const data = JSON.parse(res.getContentText());
  Logger.log(`Cumulative customers (${asOfDate}): ${data.count}`);
  return data.count;
}

// ── top 3 products ──
function getTopProductsByRevenue(storeDomain, token, startDate, endDate, topN) {
  const query  = `FROM sales SHOW total_sales WHERE product_title IS NOT NULL GROUP BY product_title SINCE ${startDate} UNTIL ${endDate} ORDER BY total_sales DESC LIMIT 10`;
  const result = runShopifyQL(storeDomain, query, token);

  if (!result || !result.rows || result.rows.length === 0) return ['', '', ''];

  return result.rows.slice(0, topN).map(function(row) {
    return row['product_title'] || '';
  });
}

// =============================================
// ROW ASSEMBLY
// =============================================

function buildRow(storeName, period, date, m, topProducts, newCust, totalCustCount) {
  return [
    storeName,
    period,
    date,
    m.netSales,
    m.shippingCharges,
    m.duties,
    m.additionalFees,
    m.tax,
    m.totalSales,
    m.orderCount,
    m.aov,
    m.conversionRate,
    m.totalCustomers,
    m.returningCustomers,
    m.totalCustomers > 0 ? m.returningCustomers / m.totalCustomers : 0,
    topProducts[0] || '',
    topProducts[1] || '',
    topProducts[2] || '',
    newCust,
    totalCustCount,
  ];
}

// =============================================
// DATE HELPERS — daily-sync specific
// =============================================

function getLADateDaysAgo(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return Utilities.formatDate(d, CONFIG.LA_TIMEZONE, 'yyyy-MM-dd');
}

// Anchored to UTC ('Z') — without this, weekday calculations shift by a day depending on server/runtime timezone, which previously caused Sundays to be misidentified as Saturdays.
function isSaturday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return Utilities.formatDate(d, CONFIG.LA_TIMEZONE, 'EEEE') === 'Saturday';
}

// Given a Saturday (week-ending day), returns the Sunday that starts that same week (6 days earlier).
function getSundayOfWeek(saturdayStr) {
  const d = new Date(saturdayStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 6);
  return Utilities.formatDate(d, CONFIG.LA_TIMEZONE, 'yyyy-MM-dd');
}
