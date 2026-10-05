import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase.service';
import { InventoryLogicService } from '../../services/inventory-logic.service';

@Component({
  selector: 'app-stock-log',
  imports: [CommonModule, FormsModule],
  templateUrl: './stock-log.html',
  styleUrl: './stock-log.css',
})
export class StockLog implements OnInit {
  private supabase = inject(SupabaseService);
  private inventoryLogic = inject(InventoryLogicService);

  stockLogs = signal<any[]>([]);
  isLoading = signal<boolean>(true);
  errorMessage = signal<string | null>(null);

  // Return Modal State
  isReturnModalOpen = signal<boolean>(false);
  isSubmitting = signal<boolean>(false);
  products = signal<any[]>([]);
  maxReturnQuantity = signal<number>(1);
  selectedLogId = signal<string>('');
  
  returnForm = signal<{ productId: string; returnType: 'Customer Return' | 'Return to Supplier'; quantity: number; remarks: string }>({
    productId: '',
    returnType: 'Customer Return',
    quantity: 1,
    remarks: ''
  });

  /** Selected period as 'YYYY-MM', or 'all' for the whole history. */
  selectedMonth = signal<string>('all');

  /**
   * Months that actually have entries, newest first. Built from the data rather
   * than a fixed calendar so the dropdown never offers an empty period.
   */
  availableMonths = computed(() => {
    const seen = new Map<string, string>();
    for (const log of this.stockLogs()) {
      const d: Date = log.logDate;
      if (!d || isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!seen.has(key)) {
        seen.set(key, d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
      }
    }
    return [...seen.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => b.value.localeCompare(a.value));
  });

  filteredLogs = computed(() => {
    const month = this.selectedMonth();
    if (month === 'all') return this.stockLogs();

    return this.stockLogs().filter(log => {
      const d: Date = log.logDate;
      if (!d || isNaN(d.getTime())) return false;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === month;
    });
  });

  selectedMonthLabel = computed(() => {
    const month = this.selectedMonth();
    if (month === 'all') return 'All time';

    const known = this.availableMonths().find(m => m.value === month);
    if (known) return known.label;

    // The selected month can stop appearing in the list if its entries are
    // reversed or reloaded away. Format the key rather than showing '2026-06'.
    const [year, m] = month.split('-').map(Number);
    if (!year || !m) return month;
    return new Date(year, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  });

  totalIn = computed(() => {
    return this.filteredLogs()
      .filter(l => l.type === 'IN' || l.type === 'Customer Return')
      .reduce((sum, l) => sum + l.quantity, 0);
  });

  totalOut = computed(() => {
    return this.filteredLogs()
      .filter(l => l.type === 'OUT' || l.type === 'Return to Supplier')
      .reduce((sum, l) => sum + l.quantity, 0);
  });

  setMonth(value: string) {
    this.selectedMonth.set(value);
  }

  async ngOnInit() {
    try {
      this.isLoading.set(true);
      const { data, error } = await this.supabase.client
        .from('stock_log')
        .select('*, products(product_name), users(full_name)')
        .order('log_date', { ascending: false });
        
      if (error) throw error;

      if (data) {
        const rawLogs = data.map(log => ({
          id: log.log_id,
          product_id: log.product_id,
          product: (log.products as any)?.product_name || 'Unknown Product',
          quantity: Math.abs(log.quantity || 0),
          type: log.change_type,
          logDate: new Date(log.log_date || Date.now()),
          date: new Date(log.log_date || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
          remarks: log.remarks || 'Stock transaction',
          processed_by: (log.users as any)?.full_name || 'System'
        }));

        this.stockLogs.set(rawLogs.map(log => {
          let returnedQty = 0;
          if (log.type === 'IN' || log.type === 'OUT') {
            returnedQty = rawLogs
              .filter(r => r.remarks.includes(log.id))
              .reduce((sum, r) => sum + r.quantity, 0);
          }
          return {
            ...log,
            available_quantity: log.quantity - returnedQty
          };
        }));
      }
    } catch (err: any) {
      console.error('Error loading stock logs', err);
      this.errorMessage.set(err.message || 'Error loading stock logs');
    } finally {
      this.isLoading.set(false);
    }
  }

  openSpecificReturnModal(log: any) {
    if (log.type !== 'IN' && log.type !== 'OUT') return;
    
    this.selectedLogId.set(log.id);
    this.maxReturnQuantity.set(log.available_quantity);
    this.isReturnModalOpen.set(true);
    this.errorMessage.set(null);
    
    const returnType = log.type === 'OUT' ? 'Customer Return' : 'Return to Supplier';
    
    this.returnForm.set({
      productId: log.product_id,
      returnType: returnType,
      quantity: log.available_quantity,
      remarks: `Reversal of log: ${log.id}`
    });
    
    this.products.set([{ product_id: log.product_id, product_name: log.product }]);
  }

  closeReturnModal() {
    this.isReturnModalOpen.set(false);
    this.errorMessage.set(null);
  }

  async logReturn() {
    const data = this.returnForm();
    if (!data.productId) {
      this.errorMessage.set('Please select a product');
      return;
    }
    if (data.quantity <= 0) {
      this.errorMessage.set('Quantity must be greater than 0');
      return;
    }
    if (data.quantity > this.maxReturnQuantity()) {
      this.errorMessage.set(`Quantity cannot exceed the original logged quantity of ${this.maxReturnQuantity()}`);
      return;
    }

    try {
      this.isSubmitting.set(true);
      this.errorMessage.set(null);
      await this.inventoryLogic.processReturn(data.productId, data.returnType, data.quantity, data.remarks);
      this.closeReturnModal();
      await this.ngOnInit(); // Refresh logs
    } catch (err: any) {
      this.errorMessage.set(err.message || 'Failed to process return');
    } finally {
      this.isSubmitting.set(false);
    }
  }
}
