import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SupabaseService } from '../../services/supabase.service';

@Component({
  selector: 'app-stock-log',
  imports: [CommonModule],
  templateUrl: './stock-log.html',
  styleUrl: './stock-log.css',
})
export class StockLog implements OnInit {
  private supabase = inject(SupabaseService);

  stockLogs = signal<any[]>([]);
  isLoading = signal<boolean>(true);
  errorMessage = signal<string | null>(null);

  totalIn = computed(() => {
    return this.stockLogs()
      .filter(l => l.type === 'IN')
      .reduce((sum, l) => sum + l.quantity, 0);
  });

  totalOut = computed(() => {
    return this.stockLogs()
      .filter(l => l.type === 'OUT')
      .reduce((sum, l) => sum + l.quantity, 0);
  });

  async ngOnInit() {
    try {
      this.isLoading.set(true);
      const { data, error } = await this.supabase.client
        .from('stock_log')
        .select('*, products(product_name)')
        .order('log_date', { ascending: false });
        
      if (error) throw error;

      if (data) {
        this.stockLogs.set(data.map(log => ({
          id: log.log_id,
          product: (log.products as any)?.product_name || 'Unknown Product',
          quantity: Math.abs(log.quantity || 0),
          type: log.change_type,
          date: new Date(log.log_date || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
          remarks: log.remarks || 'Stock transaction'
        })));
      }
    } catch (err: any) {
      console.error('Error loading stock logs', err);
      this.errorMessage.set(err.message || 'Error loading stock logs');
    } finally {
      this.isLoading.set(false);
    }
  }
}
