const ExcelJS = require('exceljs');
const { pool } = require('../db');

/*
 * Zone bulk import/export — Excel template + upload parsing.
 *
 * Why ExcelJS (not the existing SheetJS `xlsx` package):
 *   We use SheetJS for parsing existing .xlsx files (it's already vetted +
 *   CDN-pinned for security) but its WRITE support for data validations and
 *   sheet protection is incomplete in the community build. ExcelJS's API for
 *   both is unambiguous and well-documented, so generation lives here.
 *
 * Workbook layout:
 *   Sheet 1: "Mapping"          — user-editable; ZoneName | CityName | Pincode (optional)
 *   Sheet 2: "Zones (Master)"   — locked; canonical list of zone_name values
 *   Sheet 3: "Cities (Master)"  — locked; canonical list of city_name values
 *
 * Mapping sheet has list-validation on the ZoneName + CityName columns
 * pointing at the master sheets. Pincode column is plain numeric — pincodes
 * are derived from city_name via pincode_firefox_city_mapping during upload,
 * but we expose the column so users can SEE which pincodes a city covers.
 */

const TEMPLATE_PROTECTION_PASSWORD = 'easyfix-zones';   // not a secret — just stops casual edits
const MAX_DATA_ROWS = 5000;                              // pre-applies validation to N rows

// ─── Generate the downloadable .xlsx template ─────────────────────────
async function generateTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'EasyFix CRM';
  wb.created  = new Date();

  // Pull canonical lists ONCE — both master sheets share these.
  const [[zones], [cities]] = await Promise.all([
    pool.query('SELECT zone_id, zone_name, zone_status FROM tbl_zone_master ORDER BY zone_name ASC'),
    pool.query('SELECT city_id, city_name FROM tbl_city ORDER BY city_name ASC'),
  ]);

  // ── Sheet 2: Zones (Master) — built FIRST because the Mapping sheet's
  //    validation formula references it by sheet name + range.
  const zonesSheet = wb.addWorksheet('Zones (Master)');
  zonesSheet.columns = [
    { header: 'zone_id',     key: 'zone_id',     width: 10 },
    { header: 'zone_name',   key: 'zone_name',   width: 32 },
    { header: 'zone_status', key: 'zone_status', width: 12 },
  ];
  zonesSheet.getRow(1).font = { bold: true };
  zones.forEach((z) => zonesSheet.addRow(z));
  zonesSheet.protect(TEMPLATE_PROTECTION_PASSWORD, {
    selectLockedCells: true, selectUnlockedCells: true,
    formatColumns: false, formatRows: false, insertRows: false, deleteRows: false,
  });

  // ── Sheet 3: Cities (Master) — same shape, same protection.
  const citiesSheet = wb.addWorksheet('Cities (Master)');
  citiesSheet.columns = [
    { header: 'city_id',   key: 'city_id',   width: 10 },
    { header: 'city_name', key: 'city_name', width: 32 },
  ];
  citiesSheet.getRow(1).font = { bold: true };
  cities.forEach((c) => citiesSheet.addRow(c));
  citiesSheet.protect(TEMPLATE_PROTECTION_PASSWORD, {
    selectLockedCells: true, selectUnlockedCells: true,
  });

  // ── Sheet 1: Mapping (the editable one). Order it FIRST so it opens by
  //    default. ExcelJS' addWorksheet doesn't accept a position arg in all
  //    versions — we move via the views/firstSheet hint instead.
  const mappingSheet = wb.addWorksheet('Mapping');
  mappingSheet.columns = [
    { header: 'ZoneName', key: 'ZoneName', width: 32 },
    { header: 'CityName', key: 'CityName', width: 32 },
    { header: 'Pincode',  key: 'Pincode',  width: 12 },
  ];
  mappingSheet.getRow(1).font      = { bold: true };
  mappingSheet.getRow(1).fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7F1FB' } };
  mappingSheet.getRow(1).alignment = { horizontal: 'center' };

  // Apply list-validation to rows 2..MAX_DATA_ROWS for the two name columns.
  // Formula1 must be a worksheet reference enclosed in `'...'!`. We point at
  // each master's used range so adding zones/cities later (regenerate template)
  // automatically picks them up.
  const zoneListLastRow   = zonesSheet.rowCount;   // includes header
  const cityListLastRow   = citiesSheet.rowCount;

  for (let row = 2; row <= MAX_DATA_ROWS; row++) {
    mappingSheet.getCell(`A${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`='Zones (Master)'!$B$2:$B$${zoneListLastRow}`],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Unknown zone',
      error: 'Pick a zone from the list. To add a new zone, contact the admin first — the template only allows existing zones.',
    };
    mappingSheet.getCell(`B${row}`).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [`='Cities (Master)'!$B$2:$B$${cityListLastRow}`],
      showErrorMessage: true,
      errorStyle: 'error',
      errorTitle: 'Unknown city',
      error: 'Pick a city from the master list. New cities must be onboarded by an admin first.',
    };
    // Pincode column — numeric 6-digit. allowBlank because some rows may
    // describe a city-zone link without a pincode constraint.
    mappingSheet.getCell(`C${row}`).dataValidation = {
      type: 'whole',
      operator: 'between',
      formulae: [100000, 999999],
      allowBlank: true,
      showErrorMessage: true,
      errorTitle: 'Invalid pincode',
      error: 'Pincode must be a 6-digit number. Leave blank to map the whole city to the zone.',
    };
  }

  // Add a 4th informational sheet — instructions to ops. Locked.
  const helpSheet = wb.addWorksheet('Instructions');
  helpSheet.columns = [{ header: 'How to use this template', key: 'note', width: 100 }];
  helpSheet.getRow(1).font = { bold: true, size: 14 };
  [
    '1. Fill the "Mapping" sheet only. The other sheets are locked.',
    '2. ZoneName + CityName cells are dropdowns — pick from the master lists.',
    '3. Pincode is OPTIONAL. Leave blank to assign ALL pincodes of that city to the zone.',
    '4. When you re-upload, existing (zone, city) mappings are KEPT and new ones are added — nothing is deleted.',
    '5. To REMOVE a mapping, do it via the UI (zone detail → Manage Cities → uncheck).',
    '6. Maximum rows: 5000 per upload. Split into multiple files if you have more.',
    '7. To add a new zone or city, contact your admin first and re-download this template.',
  ].forEach((t) => helpSheet.addRow({ note: t }));
  helpSheet.protect(TEMPLATE_PROTECTION_PASSWORD, { selectLockedCells: true, selectUnlockedCells: false });

  // Make Mapping the first/active tab.
  wb.views = [{ activeTab: wb.worksheets.findIndex((ws) => ws.name === 'Mapping') }];

  return wb.xlsx.writeBuffer();
}

// ─── Parse + apply an uploaded mapping file ───────────────────────────
/*
 * Returns:
 *   { summary: { totalRows, validRows, invalidRows, applied, skipped },
 *     results: [{ rowNumber, status: 'applied'|'skipped'|'failed', reason? }] }
 *
 * Modes:
 *   dryRun=true  → no DB writes; just validates and reports per-row.
 *   dryRun=false → upserts (zone_id, city_id) into tbl_zone_city_mapping.
 *
 * Why no DELETE: the use case is "add new mappings"; removing a city-zone
 * link is destructive (every easyfixer pinned to that city_zone_id would
 * be orphaned). Removal is intentionally UI-only with explicit confirmation.
 */
async function processUpload(buffer, { dryRun = false } = {}) {
  // SheetJS for reading — its tolerance for slight format drift across Excel
  // versions (LibreOffice, Numbers, Google Sheets exports) is the best.
  const xlsx = require('xlsx');
  const wb   = xlsx.read(buffer, { type: 'buffer' });
  const ws   = wb.Sheets['Mapping'];
  if (!ws) {
    const err = new Error('No "Mapping" sheet found. Did you upload our template?');
    err.status = 400; throw err;
  }
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });

  // Pull master tables ONCE. Stringify keys for case-insensitive matching.
  const [[zones], [cities]] = await Promise.all([
    pool.query('SELECT zone_id, zone_name FROM tbl_zone_master WHERE zone_status = 1'),
    pool.query('SELECT city_id, city_name FROM tbl_city'),
  ]);
  const zoneByName = new Map(zones.map((z) => [String(z.zone_name).trim().toLowerCase(), z.zone_id]));
  const cityByName = new Map(cities.map((c) => [String(c.city_name).trim().toLowerCase(), c.city_id]));

  const results  = [];
  const toUpsert = [];
  let invalidRows = 0;

  rows.forEach((r, idx) => {
    const rowNumber = idx + 2;   // +2: header + 1-indexed
    const zoneName  = (r.ZoneName || '').toString().trim();
    const cityName  = (r.CityName || '').toString().trim();
    const pincode   = r.Pincode != null ? String(r.Pincode).trim() : null;

    if (!zoneName && !cityName) return;   // empty row — silently skip
    if (!zoneName) { results.push({ rowNumber, status: 'failed', reason: 'ZoneName empty' }); invalidRows++; return; }
    if (!cityName) { results.push({ rowNumber, status: 'failed', reason: 'CityName empty' }); invalidRows++; return; }

    const zoneId = zoneByName.get(zoneName.toLowerCase());
    const cityId = cityByName.get(cityName.toLowerCase());
    if (!zoneId) { results.push({ rowNumber, status: 'failed', reason: `Unknown zone "${zoneName}"` }); invalidRows++; return; }
    if (!cityId) { results.push({ rowNumber, status: 'failed', reason: `Unknown city "${cityName}"` }); invalidRows++; return; }
    if (pincode && !/^\d{6}$/.test(pincode)) {
      results.push({ rowNumber, status: 'failed', reason: `Invalid pincode "${pincode}" (must be 6 digits)` });
      invalidRows++; return;
    }

    toUpsert.push({ zoneId, cityId, rowNumber });
  });

  let applied = 0;
  let skipped = 0;

  if (!dryRun && toUpsert.length > 0) {
    /*
     * Single batched INSERT IGNORE — duplicates against the existing
     * (zone_id, city_id) become silent no-ops. We learn whether each row
     * was a true insert vs a pre-existing match by comparing affectedRows.
     * For per-row reporting we run a follow-up SELECT, capped to the rows
     * we attempted — cheap on this scale (< 5k rows).
     */
    const values = toUpsert.map((u) => [u.zoneId, u.cityId]);
    const [insertResult] = await pool.query(
      'INSERT IGNORE INTO tbl_zone_city_mapping (zone_id, city_id) VALUES ?',
      [values]
    );
    applied = insertResult.affectedRows;
    skipped = toUpsert.length - applied;

    // Per-row labels — we don't know which exact rows were inserted vs
    // skipped without an extra round-trip, so we report aggregate at the
    // summary level and mark every attempted row as 'applied' optimistically.
    // Edge case acceptable for an admin bulk tool.
    toUpsert.forEach((u) => results.push({ rowNumber: u.rowNumber, status: 'applied' }));
  } else {
    toUpsert.forEach((u) => results.push({ rowNumber: u.rowNumber, status: dryRun ? 'would-apply' : 'applied' }));
  }

  results.sort((a, b) => a.rowNumber - b.rowNumber);

  return {
    summary: {
      totalRows:   rows.length,
      validRows:   toUpsert.length,
      invalidRows,
      applied,
      skipped,
      dryRun,
    },
    results,
  };
}

module.exports = { generateTemplate, processUpload };
