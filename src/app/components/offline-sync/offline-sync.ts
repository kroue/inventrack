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

        if (!safeProductName && !safeBarcode) {
          throw new Error(`Row ${i + 1}: Product Name or Barcode is required.`);
        }

        sanitizedPayloads.push({
          product_name: safeProductName,
          barcode: safeBarcode,
          quantity: quantity,
          unit_price: unitPrice,
          payment_method: 'Cash', // Default for offline sync
          record_type: 'Excel Log'
        });
      }

      // Process the sanitized payloads (This is where you'd map to actual product IDs in the DB)
      // For this demo, we mock the successful database upload of the sanitized payload
      console.log('Sanitized Payload ready for DB:', sanitizedPayloads);
      
      this.successMessage = `Successfully parsed and validated ${sanitizedPayloads.length} offline sales records!`;
      this.selectedFile = null;
      this.fileName = '';

    } catch (err: any) {
      this.errorMessage = err.message || 'An error occurred while processing the Excel file.';
    } finally {
      this.isSyncing = false;
    }
  }
}
