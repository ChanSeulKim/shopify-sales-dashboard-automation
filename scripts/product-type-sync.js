// =============================================
// LAST MONTH RANGE (LA TIME)
// Used for manual runs or backfills where "last month" needs to be computed. The regular daily trigger (runDailyProductTypeSync) does NOT use this — it walks individual LA dates day by day instead.
// =============================================
function getLastMonthRangeLA() {
  const now   = new Date();
  const laStr = Utilities.formatDate(now, CONFIG.LA_TIMEZONE, 'yyyy-MM-dd');
  const year  = parseInt(laStr.substring(0, 4));
  const month = parseInt(laStr.substring(5, 7));

  const firstDay = new Date(Date.UTC(year, month - 2, 1));
  const lastDay  = new Date(Date.UTC(year, month - 1, 0));
  const fmt      = (d) => Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');

  return {
    firstDay: fmt(firstDay),
    lastDay:  fmt(lastDay),
  };
}

// =============================================
// CATEGORY GROUPING — for Sales by Product Type
// Shopify product types are stored as [Top_Mid_Sub] (e.g. "CATEGORY1_A_Item"). This collapses that into the smaller set of categories used on the dashboard.
// When adding/removing a category, update both this function and productTypeOrder inside writeSalesByProductType() below. (See docs/03-product-type-manual.md for the full procedure.)
// =============================================
function getProductTypeGroup(productType) {
  if (!productType || productType.trim() === '') return 'ETC';
  const pt = productType.toUpperCase();
  if (pt.includes('CATEGORY1_A'))            return 'CATEGORY1_A';
  if (pt.includes('CATEGORY1_B'))            return 'CATEGORY1_B';
  if (pt.includes('CATEGORY1_C'))            return 'CATEGORY1_C';
  if (pt.includes('CATEGORY1_D'))            return 'CATEGORY1_D';
  if (pt.includes('CATEGORY1_E'))            return 'CATEGORY1_E';
  if (pt.includes('CATEGORY2'))              return 'CATEGORY2';
  if (pt.includes('CATEGORY3_A'))            return 'CATEGORY3';
  return 'ETC';
}

// =============================================
// CATEGORY-LEVEL SALES
// =============================================
function fetchSalesByProductType(storeDomain, token, firstDay, lastDay) {
  const query  = `FROM sales SHOW total_sales, orders GROUP BY product_type SINCE ${firstDay} UNTIL ${lastDay} ORDER BY total_sales DESC`;
  const result = runShopifyQL(storeDomain, query, token);

  if (!result || !result.rows || result.rows.length === 0) return {};

  const productTypeMap = {};
  result.rows.forEach(row => {
    const productType = getProductTypeGroup(row['product_type'] || '');
    const sales        = parseFloat(row['total_sales']) || 0;
    const orders        = parseInt(row['orders']) || 0;

    if (!productTypeMap[productType]) productTypeMap[productType] = { totalSales: 0, orders: 0 };
    productTypeMap[productType].totalSales += sales;
    productTypeMap[productType].orders     += orders;
  });
  return productTypeMap;
}

// =============================================
// TOP 3 PRODUCTS PER TOP-LEVEL CATEGORY
// Unlike Sales by Product Type, this only queries at the top-level category (e.g. "CATEGORY1_A" and "CATEGORY1_B" are merged into a single "CATEGORY1" bucket), since the dashboard only needs best sellers per broad category, not per sub-category.
// =============================================
function fetchTop3ByProductType(storeDomain, token, firstDay, lastDay) {
  const productTypeQueries = [
    { productType: 'CATEGORY1',    contains: 'CATEGORY1_' },
    { productType: 'CATEGORY2', contains: 'CATEGORY2' },
    { productType: 'CATEGORY3',   contains: 'CATEGORY3_A' },
  ];

  const topProductsMap = {};

  productTypeQueries.forEach(({ productType, contains }) => {
    const query  = `FROM sales SHOW total_sales, quantity_ordered WHERE product_type CONTAINS '${contains}' GROUP BY product_title SINCE ${firstDay} UNTIL ${lastDay} ORDER BY total_sales DESC LIMIT 3`;
    const result = runShopifyQL(storeDomain, query, token);

    if (!result || !result.rows || result.rows.length === 0) {
      topProductsMap[productType] = [];
      return;
    }

    topProductsMap[productType] = result.rows.slice(0, 3).map((row, index) => ({
      title:        row['product_title'] || '',
      productType:  productType,
      totalSales:   parseFloat(row['total_sales']) || 0,
      quantitySold: parseInt(row['quantity_ordered']) || 0,
      rank:         index + 1,
    }));

    Utilities.sleep(200); // multiple queries per run — avoid hitting Shopify's rate limit
  });

  return topProductsMap;
}

// =============================================
// ROW LOOKUP
// Sales by Product Type has multiple rows per date (one per category), so store+period+date alone can't identify a unique row — productType is compared as well.
// =============================================
function findProductTypeRow(sheet, storeName, period, date, productType) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowStore        = String(data[i][0]);
    const rowPeriod       = String(data[i][1]);
    const rowDate         = data[i][2] instanceof Date
      ? Utilities.formatDate(data[i][2], CONFIG.KST_TIMEZONE, 'yyyy-MM-dd')
      : String(data[i][2]).substring(0, 10);
    const rowProductType  = String(data[i][3]);

    if (rowStore === storeName && rowPeriod === period && rowDate === date && rowProductType === productType) {
      return i + 1;
    }
  }
  return null;
}

// For the Top Product sheet — three rows per category (rank 1-3), so rank is compared as well to identify a unique row.
function findTopProductRow(sheet, storeName, date, productType, rank) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowStore        = String(data[i][0]);
    const rowPeriod       = String(data[i][1]);
    const rowDate         = data[i][2] instanceof Date
      ? Utilities.formatDate(data[i][2], CONFIG.KST_TIMEZONE, 'yyyy-MM')
      : String(data[i][6]).substring(0, 7);
    const rowProductType  = String(data[i][4]);
    const rowRank          = parseInt(data[i][7]);

    if (rowStore === storeName && rowPeriod === 'monthly' && rowDate === date && rowProductType === productType && rowRank === rank) {
      return i + 1;
    }
  }
  return null;
}

// =============================================
// SHEET WRITER — Sales by Product Type
// Columns: store, period, date, category, total sales, orders
// Monthly rows display as "yyyy-MM" while the underlying cell value stays a real Date, so sorting/filtering by date still works.
// =============================================
function writeSalesByProductType(storeName, productTypeMap, date, period) {
  const ss         = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheetSales = ss.getSheetByName(CONFIG.SHEET_SALES);
  if (!sheetSales) throw new Error('Sales by Product Type sheet not found.');

  const productTypeOrder = [
    'CATEGORY1_A', 'CATEGORY1_B', 'CATEGORY1_C',
    'CATEGORY1_D', 'CATEGORY1_E', 'CATEGORY2', 'CATEGORY3', 'ETC',
  ];

  productTypeOrder.forEach(productType => {
    const sales       = Math.round((productTypeMap[productType]?.totalSales || 0) * 100) / 100;
    const orders       = productTypeMap[productType]?.orders || 0;
    const row           = [storeName, period, date, productType, sales, orders];
    const existingRow   = findProductTypeRow(sheetSales, storeName, period, date, productType);
    const targetRow     = existingRow || sheetSales.getLastRow() + 1;

    if (existingRow) {
      updateRow(sheetSales, existingRow, row);
      Logger.log(`[UPDATE] Sales ${period} - ${productType}`);
    } else {
      appendRow(sheetSales, row);
      Logger.log(`[INSERT] Sales ${period} - ${productType}`);
    }

    if (period === 'monthly') {
      sheetSales.getRange(targetRow, 3).setNumberFormat('yyyy-MM');
    }
  });
}

// =============================================
// SHEET WRITER — Top Product by Product Type
// Columns: store, period, date, product title, product type, total sales, quantity sold, rank
// One row per product per category (rank 1-3) rather than one row per category with 3 product columns — preserves per-product edit history and makes it easy to extend to top 5/10 later.
// =============================================
function writeTopProducts(storeName, topProductsMap, lastDay) {
  const ss       = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheetTop = ss.getSheetByName(CONFIG.SHEET_TOP_PRODUCTS);
  if (!sheetTop) throw new Error('Top Product by Product Type sheet not found.');

  const date              = lastDay.substring(0, 7); // display as "yyyy-MM"
  const productTypeOrder  = ['CATEGORY1', 'CATEGORY2', 'CATEGORY3'];

  productTypeOrder.forEach(productType => {
    const products = topProductsMap[productType] || [];
    products.forEach(p => {
      const row         = [storeName, 'monthly', date, p.title, p.productType, p.totalSales, p.quantitySold, p.rank];
      const existingRow = findTopProductRow(sheetTop, storeName, date, productType, p.rank);

      if (existingRow) {
        updateRow(sheetTop, existingRow, row);
        Logger.log(`[UPDATE] Top Product - ${productType} rank ${p.rank}`);
      } else {
        appendRow(sheetTop, row);
        Logger.log(`[INSERT] Top Product - ${productType} rank ${p.rank}`);
      }
    });
  });
}

// =============================================
// MAIN ENTRY POINT
// Runs daily. Always refreshes "daily" category sales for the last 3 LA calendar days (Shopify analytics can lag slightly behind real-time, so re-checking recent days corrects any incomplete numbers from the initial load).
// Additionally refreshes "monthly" sales + top 3 products whenever one of those 3 days is the last day of its month.
// =============================================
function runDailyProductTypeSync() {
  const props       = PropertiesService.getScriptProperties();
  const storeDomain = props.getProperty('SHOPIFY_STORE1');
  const storeName   = 'example_store';
  const token         = getAccessToken(storeDomain);

  for (let i = 3; i >= 1; i--) {
    const laDate = getLADateDaysAgo(i);
    Logger.log(`[Daily Product Type] ${i} day(s) ago: ${laDate}`);

    // daily
    const productTypeMap = fetchSalesByProductType(storeDomain, token, laDate, laDate);
    writeSalesByProductType(storeName, productTypeMap, laDate, 'daily');

    // monthly: only recompute on month-end. Top-3 products require a separate ShopifyQL query per category, so this is only worth doing once a month rather than every day.
    if (isLastDayOfMonth(laDate)) {
      const year     = laDate.substring(0, 4);
      const month    = laDate.substring(5, 7);
      const firstDay = `${year}-${month}-01`;
      const lastDay  = laDate;

      Logger.log(`[Monthly Product Type] ${firstDay} ~ ${lastDay}`);
      const monthlyProductTypeMap = fetchSalesByProductType(storeDomain, token, firstDay, lastDay);
      const topProductsMap        = fetchTop3ByProductType(storeDomain, token, firstDay, lastDay);
      writeSalesByProductType(storeName, monthlyProductTypeMap, firstDay, 'monthly');
      writeTopProducts(storeName, topProductsMap, firstDay);
    }
  }
}
