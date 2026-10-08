import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase.service';

/** One product within a transaction, with its batch segments already merged. */
interface SaleLine {
  product: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  subtotal: number;
  /** True when the line drew from batches at different markdown tiers. */
  mixedPricing: boolean;
}

type RangePreset = 'all' | 'today' | '7d' | '30d' | 'month' | 'custom';

/** Local calendar day as `YYYY-MM-DD`; toISOString() would shift the date. */
export function toDateInput(d: Date): string {
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * Turns two `YYYY-MM-DD` box values into an inclusive timestamp range.
 * Either side may be '' for an open end. Exported so the day-boundary
 * handling can be tested on its own.
 */
export function resolveRange(fromValue: string, toValue: string): { start: number | null; end: number | null } {
  // Lexicographic order on YYYY-MM-DD is chronological order, so an inverted
  // range can be straightened out before it becomes a timestamp.
  let [from, to] = [fromValue, toValue];
  if (from && to && from > to) [from, to] = [to, from];

  // Parsing a bare YYYY-MM-DD gives UTC midnight, which lands on the wrong
  // day west of Greenwich. Adding a time keeps it local.
  return {
    start: from ? new Date(`${from}T00:00:00`).getTime() : null,
    end: to ? new Date(`${to}T23:59:59.999`).getTime() : null,
  };
}

interface TransactionRow {
  id: string;
  code: string;
  cashier: string;
  paymentMethod: string;
  recordType: string;
  lines: SaleLine[];
  itemCount: number;
  unitCount: number;
  discountTotal: number;
  total: number;
  dateObj: Date;
  date: string;
  isReturn: boolean;
}

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

  salesHistory = signal<TransactionRow[]>([]);
  searchQuery = signal<string>('');

  /** Transactions whose product lines are currently expanded. */
  expanded = signal<Set<string>>(new Set());

  isSaleModalOpen = signal<boolean>(false);
  selectedSale = signal<TransactionRow | null>(null);

  // ─── Date range ──────────────────────────────────────────────────────────

  /** `YYYY-MM-DD` as produced by <input type="date">; '' means open-ended. */
  fromDate = signal<string>('');
  toDate = signal<string>('');
  activePreset = signal<RangePreset>('all');

  hasDateFilter = computed(() => !!this.fromDate() || !!this.toDate());

  readonly presets: { key: RangePreset; label: string }[] = [
    { key: 'all', label: 'All time' },
    { key: 'today', label: 'Today' },
    { key: '7d', label: 'Last 7 days' },
    { key: '30d', label: 'Last 30 days' },
    { key: 'month', label: 'This month' },
  ];

  /** The chosen range as timestamps, inclusive of both end days. */
  private range = computed(() => resolveRange(this.fromDate(), this.toDate()));

  /** Reads as the footer caption, e.g. "Oct 1 – Oct 8, 2026". */
  rangeLabel = computed(() => {
    const { start, end } = this.range();
    const fmt = (t: number) => new Date(t).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    if (start === null && end === null) return 'all time';
    if (start !== null && end !== null) {
      // Compare the rendered days, not the timestamps: a one-day range spans
      // 00:00:00 to 23:59:59, so the two ends are never equal.
      const [first, last] = [fmt(start), fmt(end)];
      return first === last ? first : `${first} – ${last}`;
    }
    return start !== null ? `from ${fmt(start)}` : `up to ${fmt(end!)}`;
  });

  filteredSales = computed(() => {
    const { start, end } = this.range();
    const q = this.searchQuery().toLowerCase().trim();

    return this.salesHistory().filter(s => {
      const at = s.dateObj.getTime();
      if (start !== null && at < start) return false;
      if (end !== null && at > end) return false;
      if (!q) return true;

      return s.cashier.toLowerCase().includes(q) ||
        s.code.toLowerCase().includes(q) ||
        s.date.toLowerCase().includes(q) ||
        s.paymentMethod.toLowerCase().includes(q) ||
        s.lines.some(l => l.product.toLowerCase().includes(q));
    });
  });

  // ─── Summary, shown at the foot of the list ──────────────────────────────

  grossSales = computed(() =>
    this.filteredSales().filter(s => !s.isReturn).reduce((sum, s) => sum + s.total, 0)
  );

  refundTotal = computed(() =>
    this.filteredSales().filter(s => s.isReturn).reduce((sum, s) => sum + s.total, 0)
  );

  netSales = computed(() => this.grossSales() - this.refundTotal());

  transactionCount = computed(() => this.filteredSales().filter(s => !s.isReturn).length);

  unitsSold = computed(() =>
    this.filteredSales().filter(s => !s.isReturn).reduce((sum, s) => sum + s.unitCount, 0)
  );

  async ngOnInit() {
    await this.loadSalesHistory();
  }

  async loadSalesHistory() {
    try {
      this.isLoading.set(true);
      this.errorMessage.set(null);

      const client = this.supabase.client;

      // Read from `sales` rather than `sales_history`: one row per transaction,
      // with its lines nested. sales_history holds a row per product, which is
      // what made separate items look like separate purchases.
      const { data: salesData, error: salesErr } = await client
        .from('sales')
        .select('*, users(full_name), sale_items(*, products(product_name))')
        .order('sale_date', { ascending: false });

      if (salesErr) throw salesErr;

      const { data: returnsData, error: returnsErr } = await client
        .from('stock_log')
        .select('*, products(product_name, price), users(full_name)')
        .eq('change_type', 'Customer Return')
        .order('log_date', { ascending: false });

      if (returnsErr) throw returnsErr;

      const transactions: TransactionRow[] = [];

      for (const sale of salesData ?? []) {
        const dateObj = new Date(sale.sale_date);

        // A single product can span several batches under FEFO, producing one
        // sale_items row per batch. Merge them back into what the customer
        // actually bought, keeping a flag when the markdown differed.
        const byProduct = new Map<string, {
          product: string;
          quantity: number;
          unitPrice: number;
          discount: number;
          subtotal: number;
          unitDiscounts: Set<number>;
        }>();

        for (const item of sale.sale_items ?? []) {
          const name = (item.products as any)?.product_name ?? 'Unknown product';
          const unitDiscount = Number(item.discount_applied) || 0;

          const group = byProduct.get(name) ?? {
            product: name,
            quantity: 0,
            unitPrice: Number(item.unit_price) || 0,
            discount: 0,
            subtotal: 0,
            unitDiscounts: new Set<number>(),
          };

          group.quantity += item.quantity;
          group.subtotal += Number(item.subtotal) || 0;
          group.discount += unitDiscount * item.quantity;
          group.unitDiscounts.add(unitDiscount);

          byProduct.set(name, group);
        }

        const lines: SaleLine[] = [...byProduct.values()].map(g => ({
          product: g.product,
          quantity: g.quantity,
          unitPrice: g.unitPrice,
          discount: g.discount,
          subtotal: g.subtotal,
          mixedPricing: g.unitDiscounts.size > 1,
        }));

        transactions.push({
          id: sale.sale_id,
          code: `TRX-${String(sale.sale_id).slice(0, 8).toUpperCase()}`,
          cashier: (sale.users as any)?.full_name ?? 'Unknown',
          paymentMethod: sale.payment_method ?? 'Cash',
          recordType: sale.record_type ?? 'POS',
          lines,
          itemCount: lines.length,
          unitCount: lines.reduce((sum, l) => sum + l.quantity, 0),
          discountTotal: lines.reduce((sum, l) => sum + l.discount, 0),
          // The server computes this with the markdowns applied, so it is the
          // authoritative figure rather than anything recalculated here.
          total: Number(sale.total_amount) || 0,
          dateObj,
          date: dateObj.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
          }),
          isReturn: false,
        });
      }

      // Returns are logged per product and have no transaction to group under,
      // so each stands alone.
      for (const ret of returnsData ?? []) {
        const dateObj = new Date(ret.log_date);
        const price = Number((ret.products as any)?.price) || 0;
        const name = (ret.products as any)?.product_name ?? 'Unknown product';

        transactions.push({
          id: ret.log_id,
          code: `RET-${String(ret.log_id).slice(0, 8).toUpperCase()}`,
          cashier: (ret.users as any)?.full_name ?? 'System',
          paymentMethod: '—',
          recordType: 'Return',
          lines: [{
            product: name,
            quantity: ret.quantity,
            unitPrice: price,
            discount: 0,
            subtotal: ret.quantity * price,
            mixedPricing: false,
          }],
          itemCount: 1,
          unitCount: ret.quantity,
          discountTotal: 0,
          total: ret.quantity * price,
          dateObj,
          date: dateObj.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
          }),
          isReturn: true,
        });
      }

      transactions.sort((a, b) => b.dateObj.getTime() - a.dateObj.getTime());
      this.salesHistory.set(transactions);

    } catch (err: any) {
      console.error('Failed to load sales history data', err);
      this.errorMessage.set(err.message || 'Failed to load sales history data');
    } finally {
      this.isLoading.set(false);
    }
  }

  applyPreset(preset: RangePreset) {
    if (preset === 'all') {
      this.fromDate.set('');
      this.toDate.set('');
      this.activePreset.set('all');
      return;
    }

    const now = new Date();
    const from = new Date(now);

    if (preset === '7d') from.setDate(from.getDate() - 6);
    else if (preset === '30d') from.setDate(from.getDate() - 29);
    else if (preset === 'month') from.setDate(1);
    // 'today' leaves `from` on today.

    this.fromDate.set(toDateInput(from));
    this.toDate.set(toDateInput(now));
    this.activePreset.set(preset);
  }

  /** Typing in either date box means the range is no longer a preset. */
  setFromDate(value: string) {
    this.fromDate.set(value);
    this.activePreset.set(value || this.toDate() ? 'custom' : 'all');
  }

  setToDate(value: string) {
    this.toDate.set(value);
    this.activePreset.set(value || this.fromDate() ? 'custom' : 'all');
  }

  clearDateFilter() {
    this.applyPreset('all');
  }

  toggleExpanded(id: string) {
    this.expanded.update(current => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  isExpanded(id: string) {
    return this.expanded().has(id);
  }

  expandAll() {
    this.expanded.set(new Set(this.filteredSales().map(s => s.id)));
  }

  collapseAll() {
    this.expanded.set(new Set());
  }

  openSaleModal(sale: TransactionRow) {
    this.selectedSale.set(sale);
    this.isSaleModalOpen.set(true);
  }

  closeSaleModal() {
    this.isSaleModalOpen.set(false);
    this.selectedSale.set(null);
  }
}
