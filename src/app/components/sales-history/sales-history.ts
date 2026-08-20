import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase.service';

@Component({
  selector: 'app-sales-history',
  imports: [CommonModule, FormsModule],
  templateUrl: './sales-history.html',
  styleUrl: './sales-history.css',
})
export class SalesHistory implements OnInit {
  private supabase = inject(SupabaseService);

  isLoading = signal<boolean>(true);
  errorMessage = signal<string | null>(null);

  salesHistory = signal<any[]>([]);
  searchQuery = signal<string>('');

  // Sale History Modal State
  isSaleModalOpen = signal<boolean>(false);
  selectedSale = signal<any>(null);

  filteredSales = computed(() => {
    const q = this.searchQuery().toLowerCase();
    if (!q) return this.salesHistory();
    return this.salesHistory().filter(s => 
      s.cashier.toLowerCase().includes(q) ||
      s.products.toLowerCase().includes(q) ||
      s.date.toLowerCase().includes(q)
    );
  });

  async ngOnInit() {
    await this.loadSalesHistory();
  }

  async loadSalesHistory() {
    try {
      this.isLoading.set(true);
      this.errorMessage.set(null);
      
      const client = this.supabase.client;

      const { data: salesHistData, error: salesErr } = await client
        .from('sales_history')
        .select('*, products(*), sales(users(full_name))')
        .order('date', { ascending: false });

      if (salesErr) throw salesErr;

      const { data: returnsData, error: returnsErr } = await client
        .from('stock_log')
        .select('*, products(price)')
        .eq('change_type', 'Customer Return')
        .order('log_date', { ascending: false });

      if (returnsErr) throw returnsErr;

      let combinedHistory: any[] = [];
      
      if (salesHistData && salesHistData.length > 0) {
        combinedHistory = combinedHistory.concat(salesHistData.map(s => ({
          sale_id: s.sale_id,
          cashier: s.sales?.users?.full_name || 'Unknown', 
          products: `${s.products?.product_name || 'Item'} (x${s.quantity_sold})`,
          total: (s.quantity_sold * (s.products?.price || 0)).toFixed(2),
          dateObj: new Date(s.date),
          isReturn: false
        })));
      }
      
      if (returnsData && returnsData.length > 0) {
        combinedHistory = combinedHistory.concat(returnsData.map(r => ({
          sale_id: r.log_id,
          cashier: 'Customer Return',
          products: `${r.products?.product_name || 'Item'} (x${r.quantity})`,
          total: `-${(r.quantity * (r.products?.price || 0)).toFixed(2)}`,
          dateObj: new Date(r.log_date),
          isReturn: true
        })));
      }

      combinedHistory.sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime());

      this.salesHistory.set(combinedHistory.map((item, index) => ({
        id: item.sale_id || `hist_${index}`,
        cashier: item.cashier,
        products: item.products,
        total: item.total,
        date: item.dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        isReturn: item.isReturn
      })));

    } catch (err: any) {
      console.error('Failed to load sales history data', err);
      this.errorMessage.set(err.message || 'Failed to load sales history data');
    } finally {
      this.isLoading.set(false);
    }
  }

  openSaleModal(sale: any) {
    this.selectedSale.set(sale);
    this.isSaleModalOpen.set(true);
  }

  closeSaleModal() {
    this.isSaleModalOpen.set(false);
    this.selectedSale.set(null);
  }
}
