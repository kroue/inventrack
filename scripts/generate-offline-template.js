/**
 * Generates the offline sales log template handed to cashiers for use during a
 * power or internet interruption (Use Case Table 31).
 *
 * The header row must keep matching the column names OfflineSync accepts in
 * src/app/components/offline-sync/offline-sync.ts — if you rename a column
 * there, regenerate this file.
 *
 *   node scripts/generate-offline-template.js
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'public', 'templates');
const OUT_FILE = path.join(OUT_DIR, 'inventrack-offline-sales-log.xlsx');

// ─── Sheet 1: the log itself ────────────────────────────────────────────────
// Must be the first sheet — the importer reads workbook.SheetNames[0].
// Left empty on purpose: an untouched template should be rejected as empty
// rather than importing sample rows as if they were real sales.
const HEADERS = ['Date', 'Barcode', 'Product Name', 'Quantity', 'Unit Price', 'Total Amount'];

const logSheet = XLSX.utils.aoa_to_sheet([HEADERS]);
logSheet['!cols'] = [
  { wch: 12 }, // Date
  { wch: 18 }, // Barcode
  { wch: 32 }, // Product Name
  { wch: 10 }, // Quantity
  { wch: 12 }, // Unit Price
  { wch: 14 }, // Total Amount
  { wch: 3 },  // spacer
  { wch: 60 }, // the visible reminder in H1
];
logSheet['!freeze'] = { xSplit: 0, ySplit: 1 };

// The header text has to stay byte-identical to what the importer looks up
// (row['Barcode'], row['Quantity'], ...), so the required columns cannot be
// marked with an asterisk in the header itself. Cell comments carry the rule
// instead: Excel shows a red corner marker and reveals the text on hover, and
// the underlying cell value is untouched.
const HEADER_NOTES = {
  A1: 'Optional. The date the sale happened. Leave blank and the system uses the upload time instead — which will skew the demand forecast if you are uploading several days late.',
  B1: 'REQUIRED. This is the ONLY way the system identifies the product. A row without a barcode is rejected, and the whole file fails with it.',
  C1: 'Optional. For your own reference and to make error messages readable. It is NOT used to find the product.',
  D1: 'REQUIRED. A whole number greater than zero.',
  E1: 'REQUIRED. The price per unit you actually charged the customer. If it is below the current retail price, the difference is recorded as a markdown.',
  F1: 'Optional. For your own running total. The system recalculates the total and ignores whatever is typed here.',
};

for (const [cell, note] of Object.entries(HEADER_NOTES)) {
  logSheet[cell].c = [{ a: 'InvenTrack', t: note }];
  logSheet[cell].c.hidden = true; // marker only until hovered
}

// A reminder that is visible the moment the file is opened, parked clear of the
// data columns. The importer only reads the six known headers, so an extra
// column here is ignored.
XLSX.utils.sheet_add_aoa(
  logSheet,
  [['Barcode is required on every row. Hover any heading for its rule, or open the Instructions sheet.']],
  { origin: 'H1' }
);

// ─── Sheet 2: how to fill it in ─────────────────────────────────────────────
const instructions = [
  ['InvenTrack — Offline Sales Log'],
  ['Al-Bazar Enterprises'],
  [],
  ['Use this form when the system is unavailable due to a power or internet interruption.'],
  ['Record every sale as one row on the "Sales Log" sheet, then upload the file from'],
  ['Offline Sync once the system is back online.'],
  [],
  ['COLUMNS'],
  ['Date', 'Optional. The day the sale happened. Leave blank to use the upload time.'],
  ['', 'Format the cell as a date, or type it plainly (e.g. 2026-08-29).'],
  ['Barcode', 'REQUIRED. Scan it, or copy it exactly from the product label.'],
  ['', 'This is the only way the system identifies the product.'],
  ['Product Name', 'Optional, for your own reference and to make errors readable.'],
  ['', 'It is NOT used to find the product — the barcode decides.'],
  ['Quantity', 'Required. A whole number greater than zero.'],
  ['Unit Price', 'Required. The price per unit actually charged to the customer.'],
  ['Total Amount', 'Optional, for your own running total. The system recalculates it and'],
  ['', 'ignores whatever is typed here.'],
  [],
  ['EXAMPLE'],
  ['Date', 'Barcode', 'Product Name', 'Quantity', 'Unit Price', 'Total Amount'],
  ['2026-08-29', '4800016641107', "Nature's Spring 1L", 3, 25.0, 75.0],
  ['2026-08-29', '4806502191094', 'Century Tuna 155g', 2, 45.5, 91.0],
  ['2026-08-30', '4801981123456', 'Lucky Me Pancit Canton', 12, 18.0, 216.0],
  [],
  ['RULES WORTH KNOWING'],
  ['1.', 'Every row must have a barcode. A row without one is rejected, because a'],
  ['', 'hand-typed name could resolve to the wrong product and deduct its stock.'],
  ['', 'If a label is unreadable, look the barcode up in the system before uploading.'],
  ['2.', 'The whole file is imported at once. If one row is wrong, nothing is saved and'],
  ['', 'the error names the row number — fix it and upload again.'],
  ['3.', 'Enter the price you actually charged. If it is below the current retail price,'],
  ['', 'the difference is recorded as a markdown against that sale.'],
  ['4.', 'Stock is deducted First Expired, First Out, exactly as the POS would.'],
  ['5.', 'If the sheet records more units than the system still has on hand, the import'],
  ['', 'is refused so stock cannot go negative. Reconcile the count first.'],
  ['6.', 'Do not rename, reorder or delete the header row on the "Sales Log" sheet.'],
  ['7.', 'InvenTrack caches this form, so it can still be downloaded from the Offline'],
  ['', 'Sync page when the internet drops — but only on a device that has opened'],
  ['', 'InvenTrack before. Keep a saved copy anyway: a power cut takes the device'],
  ['', 'with it, and the cache is per browser.'],
];

const helpSheet = XLSX.utils.aoa_to_sheet(instructions);
helpSheet['!cols'] = [{ wch: 14 }, { wch: 20 }, { wch: 30 }, { wch: 10 }, { wch: 12 }, { wch: 14 }];

// ─── Write ──────────────────────────────────────────────────────────────────
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, logSheet, 'Sales Log');
XLSX.utils.book_append_sheet(workbook, helpSheet, 'Instructions');

fs.mkdirSync(OUT_DIR, { recursive: true });
XLSX.writeFile(workbook, OUT_FILE);

console.log(`Wrote ${OUT_FILE}`);
