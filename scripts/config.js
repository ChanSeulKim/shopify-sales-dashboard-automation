// =============================================
// CONFIG
// Shared configuration used by daily-sync.gs, product-type-sync.gs, and historical-backfill.gs. 
// Sensitive values (tokens, domains) are stored in Script Properties, not hardcoded here.
// =============================================
const CONFIG = {
  API_VERSION:     '2026-04',
  SPREADSHEET_ID:  'YOUR_SPREADSHEET_ID',
  SHEET_NAME: 'Daily Sales',
  SHEET_TOP_PRODUCTS: 'Top Product by Product Type',
  SHEET_SALES:        'Sales by Product Type',
  LA_TIMEZONE:     'America/Los_Angeles',                      // Shopify reports in store time (LA)
  KST_TIMEZONE:    'Asia/Seoul',                               // Google Sheet / trigger timezone
  STORES: [
    {name: 'store1', domain: 'store1.myshopify.com'},
    {name: 'store2', domain: 'store2.myshopify.com'},
  ],
};

// =============================================
// Authentication
// =============================================

// Issues a short-lived Admin API access token via OAuth client credentials.
// Client ID/secret are stored in Script Properties.
function getAccessToken(storeDomain) {
  const props        = PropertiesService.getScriptProperties();
  const clientId     = props.getProperty('SHOPIFY_CLIENT_ID');
  const clientSecret = props.getProperty('SHOPIFY_CLIENT_SECRET');
 
  const res = UrlFetchApp.fetch(
    `https://${storeDomain}/admin/oauth/access_token`,
    {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: `client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`,
      muteHttpExceptions: true,
    }
  );
 
  if (res.getResponseCode() !== 200) {
    throw new Error(`Token request failed [${storeDomain}]: ${res.getContentText()}`);
  }
 
  const body = JSON.parse(res.getContentText());
  Logger.log(`✅ Token issued (${storeDomain})`);
  return body.access_token;
}

// =============================================
// SHOPIFY API HELPERS
// =============================================
 
// Runs a ShopifyQL query via the GraphQL endpoint and returns tableData.
// Used by both daily-sync.gs (sales/sessions metrics) and product-type-sync.gs (category sales, top products).
function runShopifyQL(storeDomain, shopifyQuery, token) {
  const graphqlQuery = `{
    shopifyqlQuery(query: "${shopifyQuery}") {
      tableData {
        columns { name }
        rows
      }
      parseErrors
    }
  }`;
 
  const res = UrlFetchApp.fetch(
    `https://${storeDomain}/admin/api/${CONFIG.API_VERSION}/graphql.json`,
    {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Shopify-Access-Token': token },
      payload: JSON.stringify({ query: graphqlQuery }),
      muteHttpExceptions: true,
    }
  );
 
  const code = res.getResponseCode();
  const body = res.getContentText();
  Logger.log(`ShopifyQL [${shopifyQuery.substring(0, 50)}...] status: ${code}`);
 
  if (code !== 200) return null;
 
  const json        = JSON.parse(body);
  const parseErrors = json?.data?.shopifyqlQuery?.parseErrors;
  if (parseErrors?.length > 0) {
    Logger.log(`ShopifyQL parse error: ${parseErrors}`);
    return null;
  }
 
  return json?.data?.shopifyqlQuery?.tableData || null;
}
 
// Generic authenticated GET request. Returns null (instead of throwing)
// on failure so callers can decide how to handle missing data.
function shopifyGet(token, storeDomain, url) {
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
    muteHttpExceptions: true,
  });
 
  if (res.getResponseCode() === 200) return res;
 
  Logger.log(`API error [${res.getResponseCode()}]: ${url}\n${res.getContentText()}`);
  return null;
}
 
// Parses the "next" page URL out of Shopify's pagination Link header.
function extractNextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    if (part.includes('rel="next"')) {
      const m = part.match(/<([^>]+)>/);
      if (m) return m[1];
    }
  }
  return null;
}
 
// =============================================
// DATE / TIMEZONE HELPERS
// =============================================
 
// LA's UTC offset shifts between PST (-08:00) and PDT (-07:00) depending on DST. 
// This computes the correct offset for a given LA calendar date so "midnight to midnight LA" can be translated into UTC-bound ISO strings.
function getLAUTCOffset(dateStr) {
  const d     = new Date(`${dateStr}T12:00:00Z`);
  const laStr = Utilities.formatDate(d, CONFIG.LA_TIMEZONE, 'Z');
  return `${laStr.substring(0, 3)}:${laStr.substring(3)}`;
}
 
// True if the given LA calendar date is the last day of its month.
function isLastDayOfMonth(dateStr) {
  const d    = new Date(`${dateStr}T12:00:00`);
  const next = new Date(d);
  next.setDate(d.getDate() + 1);
  return next.getDate() === 1;
}
 
// =============================================
// SHEET HELPERS
// =============================================
 
function getOrCreateSheet() {
  const ss  = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    sheet.appendRow([
      'store', 'period', 'date', 'net_sales', 'shipping_charges', 'duties',
      'additional_fees', 'taxes', 'total_sales', 'orders', 'aov',
      'conversion_rate', 'customers', 'returning_customers',
      'newly_added_customers', 'total_customer_count',
    ]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
 
// Looks up an existing row by store + period + date so callers can decide between updating in place (preserves edit history / sort order) versus appending a new row.
function findRow(sheet, storeName, period, date) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowStore  = String(data[i][0]);
    const rowPeriod = String(data[i][1]);
    const rowDate   = data[i][2] instanceof Date
      ? Utilities.formatDate(data[i][2], CONFIG.KST_TIMEZONE, 'yyyy-MM-dd')
      : String(data[i][2]).substring(0, 10);
    if (rowStore === storeName && rowPeriod === period && rowDate === date) return i + 1;
  }
  return null;
}
 
function appendRow(sheet, row) {
  sheet.appendRow(row);
}
 
function updateRow(sheet, rowNum, row) {
  sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
}
 
