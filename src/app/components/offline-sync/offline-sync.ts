import { Component, inject, SecurityContext } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer } from '@angular/platform-browser';
import * as XLSX from 'xlsx';
import { SupabaseService } from '../../services/supabase.service';

@Component({
  selector: 'app-offline-sync',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './offline-sync.html',
  styleUrl: './offline-sync.css',
})
export class OfflineSync {
  fileName = '';
  selectedFile: File | null = null;
  isSyncing = false;
  errorMessage = '';
  successMessage = '';

  private sanitizer = inject(DomSanitizer);
  private supabaseService = inject(SupabaseService);

  onFileSelected(event: any) {
    const file = event.target.files[0];
    if (file) {
      this.selectedFile = file;
      this.fileName = file.name;
      this.errorMessage = '';
      this.successMessage = '';
    }
  }

  async syncSalesLog() {
    if (!this.selectedFile) return;

    this.isSyncing = true;
    this.errorMessage = '';
    this.successMessage = '';

    try {
      const data = await this.selectedFile.arrayBuffer();
      const workbook = XLSX.read(data);
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rows: any[] = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

      if (rows.length === 0) {
        throw new Error('The uploaded Excel file is empty.');
      }

      const sanitizedPayloads = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        
        // Sanitize string fields using DomSanitizer to block XSS
        const rawProductName = String(row['Product Name'] || row['product_name'] || '');
        const sanitizedProductName = this.sanitizer.sanitize(SecurityContext.HTML, rawProductName) || '';
        
        const rawBarcode = String(row['Barcode'] || row['barcode'] || '');
        const sanitizedBarcode = this.sanitizer.sanitize(SecurityContext.HTML, rawBarcode) || '';

        // Strictly enforce numeric types
        const rawQuantity = row['Quantity'] || row['quantity'];
        const quantity = parseInt(String(rawQuantity).replace(/[^0-9.-]/g, ''), 10);
        
        const rawPrice = row['Unit Price'] || row['unit_price'] || row['Price'] || row['price'];
        const unitPrice = parseFloat(String(rawPrice).replace(/[^0-9.-]/g, ''));

        if (isNaN(quantity) || quantity <= 0) {
          throw new Error(`Row ${i + 1}: Invalid quantity. Must be a positive number.`);
        }
        
        if (isNaN(unitPrice) || unitPrice < 0) {
          throw new Error(`Row ${i + 1}: Invalid unit price. Must be a valid positive number.`);
        }

        const safeProductName = sanitizedProductName.replace(/<[^>]*>?/gm, '').trim();
        const safeBarcode = sanitizedBarcode.replace(/<[^>]*>?/gm, '').trim();

        // Barcode is the only lookup key. Product Name is carried through purely
        // so the error messages name the item the cashier wrote down — matching
        // on a hand-typed name risks resolving to the wrong product and
        // deducting stock from it.
        if (!safeBarcode) {
          const hint = safeProductName ? ` (you wrote "${safeProductName}")` : '';
          throw new Error(`Row ${i + 1}: Barcode is required${hint}.`);
        }

        // Optional date column — preserved so the imported sale lands on the day
        // it actually happened and feeds the EMA velocity correctly.
        const rawDate = row['Date'] || row['date'] || row['Sale Date'] || row['sale_date'];
        const saleDate = this.parseSheetDate(rawDate);

        sanitizedPayloads.push({
          product_name: safeProductName,
          barcode: safeBarcode,
          quantity: quantity,
          unit_price: unitPrice,
          ...(saleDate ? { sale_date: saleDate } : {})
        });
      }

      // Commit the sheet to the database in a single transaction.
      const result = await this.supabaseService.importOfflineSales(sanitizedPayloads);

      this.successMessage =
        `Imported ${result.rows_imported} offline sales record(s) — ` +
        `${result.units_imported} unit(s), ₱${Number(result.total_amount).toFixed(2)} total. ` +
        `Stock, batches and the stock log have been updated.`;
      this.selectedFile = null;
      this.fileName = '';

    } catch (err: any) {
      this.errorMessage = err.message || 'An error occurred while processing the Excel file.';
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Excel dates arrive either as a serial number or as a display string.
   * Returns an ISO string, or null when the column is absent or unparseable —
   * in which case the database falls back to the upload time.
   */
  private parseSheetDate(raw: any): string | null {
    if (raw === undefined || raw === null || raw === '') return null;

    if (typeof raw === 'number') {
      const parsed = XLSX.SSF.parse_date_code(raw);
      if (!parsed) return null;
      return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H || 0, parsed.M || 0, parsed.S || 0)).toISOString();
    }

    const asDate = new Date(String(raw));
    return isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }
}
