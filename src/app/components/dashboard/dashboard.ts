import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SupabaseService } from '../../services/supabase.service';
import { InventoryLogicService } from '../../services/inventory-logic.service';

@Component({
  selector: 'app-dashboard',
  imports: [CommonModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class Dashboard implements OnInit {
  private supabase = inject(SupabaseService);
  private inventoryLogic = inject(InventoryLogicService);

  // State using Angular Signals
  isLoading = signal<boolean>(true);
  errorMessage = signal<string | null>(null);

  // Top Card Signals
  totalRevenue = signal<number>(0);
  revenueTrend = signal<number>(0); 
  todayDate = signal<string>(new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  totalProducts = signal<number>(0);
  inStockCount = signal<number>(0);
  lowStockCount = signal<number>(0);
  outOfStockCount = signal<number>(0);
  pendingRestockCount = signal<number>(0);
  
  // Percentages for progress bar
  inStockPercent = signal<number>(0);
  lowStockPercent = signal<number>(0);
  outOfStockPercent = signal<number>(0);

  chartBars = signal<any[]>([]);
  chartYLabels = signal<string[]>(['₱40K', '₱30K', '₱20K', '₱10K', '0']);
  quickStats = signal<any[]>([]);
  salesHistory = signal<any[]>([]);

  // Predictive Analytics Engine (IPO Model Outputs)
  predictiveAnalytics = signal<any[]>([]);

  // Timeframe and options menu state
  chartTimeframe = signal<'Weekly' | 'Monthly'>('Weekly');
  showTimeframeMenu = signal<boolean>(false);
  showOptionsMenu = signal<boolean>(false);
  rawSalesData: any[] = [];

  toggleTimeframeMenu() {
    this.showTimeframeMenu.set(!this.showTimeframeMenu());
    if (this.showTimeframeMenu()) this.showOptionsMenu.set(false);
  }

  toggleOptionsMenu() {
    this.showOptionsMenu.set(!this.showOptionsMenu());
    if (this.showOptionsMenu()) this.showTimeframeMenu.set(false);
  }

  selectTimeframe(tf: 'Weekly' | 'Monthly') {
    this.chartTimeframe.set(tf);
    this.showTimeframeMenu.set(false);
    this.updateChart();
  }

  updateChart() {
    let bars: any[] = [];
    let maxSale = 40000;
    
    if (this.chartTimeframe() === 'Weekly') {
      const last7Days = Array.from({length: 7}).map((_, i) => {
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        return {
          dateStr: d.toISOString().split('T')[0],
          dayName: d.toLocaleDateString('en-US', { weekday: 'short' }),
          amount: 0
        };
      });

      this.rawSalesData.forEach(sale => {
        const saleDate = new Date(sale.sale_date || sale.date).toISOString().split('T')[0];
        const dayMatch = last7Days.find(d => d.dateStr === saleDate);
        if (dayMatch) {
          dayMatch.amount += Number(sale.total_amount || (sale.quantity_sold * (sale.products?.price || 100)));
        }
      });
      maxSale = Math.max(10000, ...last7Days.map(d => d.amount));
      bars = last7Days.map(d => ({
        day: d.dayName,
        amount: d.amount
      }));
    } else {
      const last4Weeks = Array.from({length: 4}).map((_, i) => ({
        label: `W${i + 1}`,
        amount: 0
      }));
      
      const msPerDay = 1000 * 60 * 60 * 24;
      const todayMs = new Date().getTime();
      this.rawSalesData.forEach(sale => {
        const saleTime = new Date(sale.sale_date || sale.date).getTime();
        const diffDays = Math.floor((todayMs - saleTime) / msPerDay);
        if (diffDays >= 0 && diffDays < 28) {
          const weekIdx = 3 - Math.floor(diffDays / 7);
          if (weekIdx >= 0 && weekIdx < 4) {
            last4Weeks[weekIdx].amount += Number(sale.total_amount || (sale.quantity_sold * (sale.products?.price || 100)));
          }
        }
      });
      maxSale = Math.max(10000, ...last4Weeks.map(w => w.amount));
      bars = last4Weeks.map(w => ({
        day: w.label,
        amount: w.amount
      }));
    }

    this.chartBars.set(bars.map(b => ({
      day: b.day,
      height: maxSale > 0 ? (b.amount / maxSale) * 180 : 0,
      fill: b.amount > 0 ? 100 : 0,
      tooltip: '₱' + b.amount.toLocaleString()
    })));

    this.chartYLabels.set([
      '₱' + (maxSale / 1000).toFixed(1) + 'K',
      '₱' + ((maxSale * 0.75) / 1000).toFixed(1) + 'K',
      '₱' + ((maxSale * 0.5) / 1000).toFixed(1) + 'K',
      '₱' + ((maxSale * 0.25) / 1000).toFixed(1) + 'K',
      '0'
    ]);
  }

  async ngOnInit() {
    try {
      this.isLoading.set(true);
      this.errorMessage.set(null);
      
      const client = this.supabase.client;

      // 1. Fetch Predictive Analytics Engine Outputs
      const analyticsData = await this.inventoryLogic.getPredictiveAnalyticsSummary();
      this.predictiveAnalytics.set(analyticsData);

      // Compute status totals from predictive engine
      const total = analyticsData.length;
      const lowCount = analyticsData.filter(a => a.isLowStock).length;
      const inCount = analyticsData.filter(a => !a.isLowStock && a.currentStock > 0).length;
      const outCount = analyticsData.filter(a => a.currentStock <= 0).length;

      this.totalProducts.set(total);
      this.inStockCount.set(inCount);
      this.lowStockCount.set(lowCount);
      this.outOfStockCount.set(outCount);

      if (total > 0) {
        this.inStockPercent.set((inCount / total) * 100);
        this.lowStockPercent.set((lowCount / total) * 100);
        this.outOfStockPercent.set((outCount / total) * 100);
      }
      
      // Fetch pending restocks count
      const { count: pendingCount } = await client
        .from('restock_requests')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'Pending');
      this.pendingRestockCount.set(pendingCount || 0);

      // 2. Fetch sales transactions & calculate revenue
      const { data: salesTotalData } = await client.from('sales').select('*, sale_items(*)');
      const { data: salesHistData } = await client.from('sales_history').select('*, products(*)');

      let totalRev = 0;
      if (salesTotalData && salesTotalData.length > 0) {
        this.rawSalesData = salesTotalData;
        totalRev = salesTotalData.reduce((sum, s) => sum + Number(s.total_amount || 0), 0);
      } else if (salesHistData && salesHistData.length > 0) {
        // Fallback to sales_history if sales table is not yet populated
        this.rawSalesData = salesHistData;
        totalRev = salesHistData.reduce((sum, s) => {
          const price = s.products?.price || 100;
          return sum + (s.quantity_sold * price);
        }, 0);
      }
      
      this.totalRevenue.set(totalRev);
      this.revenueTrend.set(12.5); // Default positive growth trend demonstration

      this.updateChart();

      // Fetch active alerts & suppliers for Quick Stats
      const { count: alertsCount } = await client
        .from('alerts')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'Active');
      
      const { count: suppliersCount } = await client
        .from('suppliers')
        .select('*', { count: 'exact', head: true });

      this.quickStats.set([
        { label: 'Total Products',    value: total || 0,                 percent: '100%', color: 'bg-blue-500' },
        { label: 'Active Alerts',     value: lowCount || alertsCount || 0, percent: '100%', color: 'bg-red-500'  },
        { label: 'Active Suppliers',  value: suppliersCount || 0,        percent: '100%',  color: 'bg-green-500'}, 
        { label: 'PO Completion',     value: '85%',                      percent: '85%',   color: 'bg-purple-500'},
      ]);

      if (salesHistData && salesHistData.length > 0) {
        this.salesHistory.set(salesHistData.slice(0, 5).map(s => ({
          cashier: 'POS Cashier', 
          products: `${s.products?.product_name || 'Item'} (x${s.quantity_sold})`,
          total: (s.quantity_sold * (s.products?.price || 100)).toFixed(2),
          date: new Date(s.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        })));
      } else {
        this.salesHistory.set([]);
      }

    } catch (err: any) {
      console.error('Failed to load dashboard data', err);
      this.errorMessage.set(err.message || 'Failed to load dashboard data');
    } finally {
      this.isLoading.set(false);
    }
  }
}
