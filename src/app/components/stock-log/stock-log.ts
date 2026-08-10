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

  totalIn = computed(() => {
    return this.stockLogs()
      .filter(l => l.type === 'IN' || l.type === 'Customer Return')
      .reduce((sum, l) => sum + l.quantity, 0);
  });

  totalOut = computed(() => {
    return this.stockLogs()
      .filter(l => l.type === 'OUT' || l.type === 'Return to Supplier')
      .reduce((sum, l) => sum + l.quantity, 0);
  });

  async ngOnInit() {
    try {
      this.isLoading.set(true);
      const { data, error } = await this.supabase.client
        .from('stock_log')
        .select('*, products(product_name), users(full_name)')
        .order('log_date', { ascending: false });
        
      if (error) throw error;

      if (data) {
        this.stockLogs.set(data.map(log => ({
          id: log.log_id,
          product_id: log.product_id,
          product: (log.products as any)?.product_name || 'Unknown Product',
          quantity: Math.abs(log.quantity || 0),
          type: log.change_type,
          date: new Date(log.log_date || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
          remarks: log.remarks || 'Stock transaction',
          processed_by: (log.users as any)?.full_name || 'System'
        })));
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
    this.maxReturnQuantity.set(log.quantity);
    this.isReturnModalOpen.set(true);
    this.errorMessage.set(null);
    
    const returnType = log.type === 'OUT' ? 'Customer Return' : 'Return to Supplier';
    
    this.returnForm.set({
      productId: log.product_id,
      returnType: returnType,
      quantity: log.quantity,
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
