import { Component, computed, inject, OnInit, signal } from '@angular/core';
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

  // Sale History Modal State
  isSaleModalOpen = signal<boolean>(false);
  selectedSale = signal<any>(null);

  // Predictive Analytics Engine (IPO Model Outputs)
  predictiveAnalytics = signal<any[]>([]);

  // Product movement ranking — most sold to least (Specific Objective #4)
  movementRanking = signal<any[]>([]);
  movementFilter = signal<'All' | 'Fast Moving' | 'Slow Moving' | 'No Movement'>('All');

  // Which analytics table is on screen
  analyticsTab = signal<'Forecast' | 'Movement'>('Forecast');

  filteredMovement = computed(() => {
    const filter = this.movementFilter();
    const rows = this.movementRanking();
    return filter === 'All' ? rows : rows.filter(r => r.movement === filter);
  });

  fastMovingCount = computed(() => this.movementRanking().filter(r => r.movement === 'Fast Moving').length);
  slowMovingCount = computed(() => this.movementRanking().filter(r => r.movement === 'Slow Moving').length);
  nearExpiryCount = computed(() => this.predictiveAnalytics().filter(a => a.nearestBatchRisk === 'High').length);

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

  selectAnalyticsTab(tab: 'Forecast' | 'Movement') {
    this.analyticsTab.set(tab);
  }

  selectMovementFilter(filter: 'All' | 'Fast Moving' | 'Slow Moving' | 'No Movement') {
    this.movementFilter.set(filter);
  }

  /**
   * Use Case Table 25 — export the analytics report the Admin is looking at.
   */
  exportReportCsv() {
    this.showOptionsMenu.set(false);

    const escapeCell = (value: any) => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    let headers: string[];
    let rows: any[][];
    let filename: string;

    if (this.analyticsTab() === 'Movement') {
      filename = 'inventrack-product-movement';
      headers = ['Rank', 'Product', 'Category', 'Units Sold (30d)', 'Daily Average', 'Revenue', 'Movement'];
      rows = this.filteredMovement().map(r => [
        r.rank, r.name, r.category, r.unitsSold, r.dailyAverage, r.revenue.toFixed(2), r.movement
      ]);
    } else {
      filename = 'inventrack-demand-forecast';
      headers = ['Product', 'Category', 'Stock (Q)', 'Velocity (V)', 'Lead Time (L)', 'Safety Stock (ss)', 'ROP', 'SOQ', 'Status', 'Expiry Risk'];
      rows = this.predictiveAnalytics().map(a => [
        a.name, a.category, a.currentStock, a.dailyVelocity, a.leadTime,
        a.safetyStock, a.rop, a.soq, a.status, a.nearestBatchRisk
      ]);
    }

    const csv = [headers, ...rows]
      .map(row => row.map(escapeCell).join(','))
      .join('\r\n');

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}-${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Use Case Table 25 — print the analytics report currently on screen.
   */
  printReport() {
    this.showOptionsMenu.set(false);

    const escapeHtml = (value: any) =>
      String(value ?? '').replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string
      ));

    const isMovement = this.analyticsTab() === 'Movement';
    const title = isMovement ? 'Product Movement Report' : 'Demand Forecast Report';

    const headers = isMovement
      ? ['Rank', 'Product', 'Category', 'Units Sold (30d)', 'Daily Avg', 'Revenue', 'Movement']
      : ['Product', 'Category', 'Stock (Q)', 'Velocity (V)', 'Lead Time (L)', 'Safety Stock', 'ROP', 'SOQ', 'Status'];

    const bodyRows = isMovement
      ? this.filteredMovement().map(r =>
          [r.rank, r.name, r.category, r.unitsSold, r.dailyAverage, `P ${r.revenue.toFixed(2)}`, r.movement])
      : this.predictiveAnalytics().map(a =>
          [a.name, a.category, a.currentStock, a.dailyVelocity, a.leadTime, a.safetyStock, a.rop, a.soq, a.status]);

    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${title}</title>
          <style>
            @page { size: A4 landscape; margin: 12mm; }
            body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 11px; }
            h1 { font-size: 18px; margin: 0 0 2px; }
            .sub { color: #666; font-size: 11px; margin-bottom: 14px; }
            table { width: 100%; border-collapse: collapse; }
            th { background: #f3f4f6; text-align: left; font-size: 10px; text-transform: uppercase;
                 letter-spacing: .04em; padding: 6px; border-bottom: 2px solid #d1d5db; }
            td { padding: 5px 6px; border-bottom: 1px solid #e5e7eb; }
            tr:nth-child(even) td { background: #fafafa; }
            .footer { margin-top: 16px; color: #666; font-size: 10px; }
          </style>
        </head>
        <body>
          <h1>InvenTrack — ${title}</h1>
          <div class="sub">
            Al-Bazar Enterprises &middot; Generated ${new Date().toLocaleString()}<br>
            Velocity computed by Exponential Moving Average over a 30-day window (&alpha; = 2/(n+1)).
          </div>
          <table>
            <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
            <tbody>
              ${bodyRows.map(row =>
                `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`
              ).join('')}
            </tbody>
          </table>
          <div class="footer">Generated by the InvenTrack Predictive Analytics Engine.</div>
        </body>
      </html>
    `;

    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = 'none';
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document;
    if (!doc) {
      document.body.removeChild(iframe);
      return;
    }

    doc.open();
    doc.write(html);
    doc.close();

    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      setTimeout(() => {
        if (iframe.parentNode) document.body.removeChild(iframe);
      }, 1000);
    }, 250);
  }

  openSaleModal(sale: any) {
    this.selectedSale.set(sale);
    this.isSaleModalOpen.set(true);
  }

  closeSaleModal() {
    this.isSaleModalOpen.set(false);
    this.selectedSale.set(null);
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

      // 0. Run the Predictive Analytics Engine before reading it back. This is the
      //    Admin-side pass that persists forecasts, refreshes each batch's expiry
      //    risk score, and raises or resolves LOW STOCK / NEAR EXPIRY alerts.
      await this.inventoryLogic.runPredictiveAnalyticsForAll();

      // 1. Fetch Predictive Analytics Engine Outputs
      const [analyticsData, ranking] = await Promise.all([
        this.inventoryLogic.getPredictiveAnalyticsSummary(),
        this.inventoryLogic.getProductMovementRanking()
      ]);
      this.predictiveAnalytics.set(analyticsData);
      this.movementRanking.set(ranking);

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
      const { data: salesTotalData } = await client.from('sales').select('*, sale_items(*), users(full_name)');
      const { data: salesHistData } = await client.from('sales_history').select('*, products(*), sales(users(full_name))');

      let totalRev = 0;
      let thisWeekRev = 0;
      let lastWeekRev = 0;
      const now = new Date();
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      if (salesTotalData && salesTotalData.length > 0) {
        this.rawSalesData = salesTotalData;
        salesTotalData.forEach(s => {
          const amount = Number(s.total_amount || 0);
          totalRev += amount;
          const saleDate = new Date(s.sale_date);
          if (saleDate >= oneWeekAgo) {
            thisWeekRev += amount;
          } else if (saleDate >= twoWeeksAgo && saleDate < oneWeekAgo) {
            lastWeekRev += amount;
          }
        });
      } else if (salesHistData && salesHistData.length > 0) {
        // Fallback to sales_history if sales table is not yet populated
        this.rawSalesData = salesHistData;
        salesHistData.forEach(s => {
          const price = s.products?.price || 100;
          const amount = (s.quantity_sold * price);
          totalRev += amount;
          const saleDate = new Date(s.date);
          if (saleDate >= oneWeekAgo) {
            thisWeekRev += amount;
          } else if (saleDate >= twoWeeksAgo && saleDate < oneWeekAgo) {
            lastWeekRev += amount;
          }
        });
      }
      
      // 3. Fetch returns to subtract from revenue
      const { data: returnsData } = await client
        .from('stock_log')
        .select('*, products(price)')
        .eq('change_type', 'Customer Return');

      if (returnsData) {
        returnsData.forEach(r => {
          const price = r.products?.price || 0;
          const refundAmount = r.quantity * price;
          totalRev -= refundAmount;
          const returnDate = new Date(r.log_date);
          if (returnDate >= oneWeekAgo) {
            thisWeekRev -= refundAmount;
          } else if (returnDate >= twoWeeksAgo && returnDate < oneWeekAgo) {
            lastWeekRev -= refundAmount;
          }
        });
      }
      
      this.totalRevenue.set(Math.max(0, totalRev));
      let trend = 0;
      if (lastWeekRev > 0) {
        trend = ((thisWeekRev - lastWeekRev) / lastWeekRev) * 100;
      } else if (thisWeekRev > 0) {
        trend = 100;
      }
      this.revenueTrend.set(Number(trend.toFixed(1)));

      this.updateChart();

      // Fetch active alerts & suppliers for Quick Stats
      const { count: alertsCount } = await client
        .from('alerts')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'Active');
      
      const { count: suppliersCount } = await client
        .from('suppliers')
        .select('*', { count: 'exact', head: true });

      const healthyPercent = total > 0 ? (inCount / total) * 100 : 0;
      const warningPercent = total > 0 ? (lowCount / total) * 100 : 0;
      const criticalPercent = total > 0 ? (outCount / total) * 100 : 0;
      
      this.quickStats.set([
        { label: 'Healthy Stock Rate', value: `${Math.round(healthyPercent)}%`, percent: `${healthyPercent}%`, color: 'bg-green-500' },
        { label: 'Low Stock Alerts',   value: lowCount || 0,                    percent: `${warningPercent}%`, color: 'bg-yellow-500'  },
        { label: 'Out of Stock Items', value: outCount || 0,                    percent: `${criticalPercent}%`, color: 'bg-red-500'}, 
        { label: 'Total Products',     value: total || 0,                       percent: `0%`, hideBar: true}, // We hide the bar for absolute totals
      ]);

      let combinedHistory: any[] = [];
      
      if (salesHistData && salesHistData.length > 0) {
        combinedHistory = combinedHistory.concat(salesHistData.map(s => ({
          cashier: s.sales?.users?.full_name || 'Unknown', 
          products: `${s.products?.product_name || 'Item'} (x${s.quantity_sold})`,
          total: (s.quantity_sold * (s.products?.price || 0)).toFixed(2),
          dateObj: new Date(s.date),
          isReturn: false
        })));
      }
      
      if (returnsData && returnsData.length > 0) {
        combinedHistory = combinedHistory.concat(returnsData.map(r => ({
          cashier: 'Customer Return',
          products: `${r.products?.product_name || 'Item'} (x${r.quantity})`,
          total: `-${(r.quantity * (r.products?.price || 0)).toFixed(2)}`,
          dateObj: new Date(r.log_date),
          isReturn: true
        })));
      }

      combinedHistory.sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime());

      this.salesHistory.set(combinedHistory.slice(0, 5).map((item, index) => ({
        id: item.sale_id || `hist_${index}`,
        cashier: item.cashier,
        products: item.products,
        total: item.total,
        date: item.dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        isReturn: item.isReturn
      })));

    } catch (err: any) {
      console.error('Failed to load dashboard data', err);
      this.errorMessage.set(err.message || 'Failed to load dashboard data');
    } finally {
      this.isLoading.set(false);
    }
  }
}
