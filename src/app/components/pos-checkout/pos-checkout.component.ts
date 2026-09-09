import { Component, inject, OnInit, signal, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InventoryLogicService } from '../../services/inventory-logic.service';
import { SupabaseService } from '../../services/supabase.service';
import { ConnectivityService } from '../../services/connectivity.service';
import { Product, Batches } from '../../models/itrack.models';

/**
 * One slice of a cart line, drawn from a single batch. A line spanning a
 * near-expiry batch and a fresh one produces one allocation each, priced by the
 * shelf life of the batch those particular units came from.
 */
interface BatchAllocation {
  batch: Batches;
  quantity: number;
  unitPrice: number;
  discountApplied: number;
  riskLevel: 'Low' | 'Medium' | 'High' | 'Expired';
  daysRemaining: number;
  subtotal: number;
}

interface CartItem {
  product: Product;
  quantity: number;
  originalPrice: number;
  /** FEFO allocation across batches, earliest expiry first. */
  allocations: BatchAllocation[];
  subtotal: number;
  /** Total money taken off this line by near-expiry markdowns. */
  discountTotal: number;
  /** Risk of the earliest-expiring batch the line draws from. */
  riskLevel: 'Low' | 'Medium' | 'High' | 'Expired';
  daysRemaining: number;
  /** True when the line draws from batches at different markdown tiers. */
  hasMixedPricing: boolean;
}

export interface CompletedOrder {
  saleId: string;
  code: string;
  items: CartItem[];
  total: number;
  paymentMethod: 'Cash' | 'Gcash';
  cashRendered: number;
  change: number;
  timestamp: Date;
}

@Component({
  selector: 'app-pos-checkout',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './pos-checkout.component.html',
})
export class PosCheckoutComponent implements OnInit {
  private inventoryLogic = inject(InventoryLogicService);
  private supabaseService = inject(SupabaseService);
  readonly connectivity = inject(ConnectivityService);

  // State using Angular Signals for fetched data
  products = signal<Product[]>([]);
  batches = signal<Batches[]>([]);
  
  isLoading = signal<boolean>(true);
  errorMessage = signal<string | null>(null);
  validationError = signal<string | null>(null);

  showSuccessModal = signal<boolean>(false);
  completedOrder = signal<CompletedOrder | null>(null);

  searchQuery: string = '';
  searchResults: Product[] = [];
  
  cart: CartItem[] = [];
  
  showClearCartModal = signal<boolean>(false);
  
  clearCart() {
    if (this.cart.length === 0) return;
    this.showClearCartModal.set(true);
  }

  executeClearCart() {
    this.cart = [];
    this.showClearCartModal.set(false);
  }

  cancelClearCart() {
    this.showClearCartModal.set(false);
  }
  
  paymentMethod: 'Cash' | 'Gcash' = 'Cash';
  cashRendered: number = 0;

  private scanBuffer: string = '';
  private scanTimeout: any = null;

  async ngOnInit() {
    await this.loadData();
  }

  /**
   * Listen globally to barcode scanner keystrokes across window
   */
  @HostListener('window:keydown', ['$event'])
  handleGlobalKeydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement;
    // Don't intercept if user is typing in another input (e.g. cash rendered or textarea)
    // However, if the input is our pos-search-input, we must NOT intercept it here to prevent double-firing
    // since the pos-search-input has its own (keydown.enter) binding!
    const isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (isInput) return;

    if (event.key === 'Enter') {
      if (this.scanBuffer.trim().length > 0) {
        this.processScanQuery(this.scanBuffer.trim());
        this.scanBuffer = '';
        event.preventDefault();
      }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      this.scanBuffer += event.key;
      if (this.scanTimeout) clearTimeout(this.scanTimeout);
      this.scanTimeout = setTimeout(() => {
        this.scanBuffer = '';
      }, 250);
    }
  }

  async loadData() {
    try {
      this.isLoading.set(true);
      this.errorMessage.set(null);
      
      const supabase = this.supabaseService.client;

      const [
        { data: prodData, error: prodError },
        { data: batchData, error: batchError }
      ] = await Promise.all([
        supabase.from('products').select('*, inventory(*)'),
        supabase.from('batches').select('*').gt('quantity_remaining', 0)
      ]);

      if (prodError) throw prodError;
      if (batchError) throw batchError;

      this.batches.set(batchData ?? []);

      // Sellable stock is the sum of the open, unexpired batches, because that is
      // what the checkout draws from. Showing the inventory total here would let
      // a cashier build a cart the server then rejects, and counting expired
      // batches would advertise stock that can no longer be sold.
      const now = new Date();
      const availableByProduct = new Map<string, number>();
      for (const batch of batchData ?? []) {
        if (this.inventoryLogic.isExpired(batch.batch_expiration, now)) continue;
        availableByProduct.set(
          batch.product_id,
          (availableByProduct.get(batch.product_id) ?? 0) + batch.quantity_remaining
        );
      }

      if (prodData) {
        const mapped = prodData.map((p: any) => {
          const inv = p.inventory?.[0] || {};
          const rop = inv.reorder_point ?? 0;
          const stock = availableByProduct.get(p.product_id) ?? 0;
          return {
            ...p,
            stock_quantity: stock,
            needs_restock: stock <= rop
          };
        });
        this.products.set(mapped);
        this.searchResults = mapped;
      }
      this.connectivity.reportRequestSuccess();
    } catch (err: any) {
      this.connectivity.reportRequestFailure(err);
      this.errorMessage.set(err.message || 'Failed to load POS data.');
    } finally {
      this.isLoading.set(false);
    }
  }

  onSearchChange() {
    const allProducts = this.products();
    if (!this.searchQuery.trim()) {
      this.searchResults = allProducts;
      return;
    }
    const query = this.searchQuery.toLowerCase();
    this.searchResults = allProducts.filter(p => 
      p.product_name.toLowerCase().includes(query) || (p.barcode && p.barcode.toLowerCase().includes(query))
    );
  }

  handleScanEnter(event: Event) {
    event.preventDefault();
    const inputVal = (event.target as HTMLInputElement)?.value || this.searchQuery;
    const query = inputVal.trim();
    if (!query) return;

    this.processScanQuery(query);
  }

  processScanQuery(rawQuery: string) {
    const query = rawQuery.trim();
    if (!query) return;

    const lowerQuery = query.toLowerCase();
    const cleanQuery = lowerQuery.replace(/[^a-z0-9]/gi, '');

    // Strategy 1: Exact barcode match
    let match = this.products().find(p => p.barcode && p.barcode.trim().toLowerCase() === lowerQuery);

    // Strategy 2: Clean alphanumeric barcode match (ignore spaces/dashes)
    if (!match && cleanQuery.length > 0) {
      match = this.products().find(p => p.barcode && p.barcode.replace(/[^a-z0-9]/gi, '').toLowerCase() === cleanQuery);
    }

    // Strategy 3: Barcode substring match
    if (!match) {
      match = this.products().find(p => p.barcode && (p.barcode.toLowerCase().includes(lowerQuery) || lowerQuery.includes(p.barcode.toLowerCase())));
    }

    // Strategy 4: Exact product name match
    if (!match) {
      match = this.products().find(p => p.product_name.toLowerCase() === lowerQuery);
    }

    // Strategy 5: Single result in current filtered search list
    if (!match && this.searchResults.length === 1) {
      match = this.searchResults[0];
    }

    if (match) {
      this.addToCart(match);
      this.searchQuery = '';
      this.searchResults = this.products();
      this.validationError.set(null);
    } else {
      this.validationError.set(`No product found matching barcode: "${rawQuery}"`);
    }
  }

  simulateScan(barcode: string) {
    this.processScanQuery(barcode);
  }

  /**
   * Open batches for a product, earliest expiry first — the order the server
   * will consume them in.
   */
  private fefoBatches(productId: string): Batches[] {
    const now = new Date();
    return this.batches()
      .filter(b =>
        b.product_id === productId &&
        b.quantity_remaining > 0 &&
        // Expired goods are never offered for sale. They stay on the books until
        // an admin writes them off through Adjust Stock, which is what keeps the
        // loss visible instead of quietly discounting it onto a customer.
        !this.inventoryLogic.isExpired(b.batch_expiration, now)
      )
      .sort((a, b) => new Date(a.batch_expiration).getTime() - new Date(b.batch_expiration).getTime());
  }

  /** Units on the books for a product that are already past their expiry date. */
  private expiredUnits(productId: string): number {
    const now = new Date();
    return this.batches()
      .filter(b =>
        b.product_id === productId &&
        b.quantity_remaining > 0 &&
        this.inventoryLogic.isExpired(b.batch_expiration, now)
      )
      .reduce((sum, b) => sum + b.quantity_remaining, 0);
  }

  /** Total sellable units across every open batch. */
  private availableUnits(productId: string): number {
    return this.fefoBatches(productId).reduce((sum, b) => sum + b.quantity_remaining, 0);
  }

  /**
   * Walk the batches in expiry order and split `quantity` across them, pricing
   * each slice by its own batch. Mirrors what process_pos_sale does server-side
   * so the cart total matches the receipt.
   */
  private allocateFefo(product: Product, quantity: number): BatchAllocation[] {
    const allocations: BatchAllocation[] = [];
    const now = new Date();
    const msPerDay = 1000 * 60 * 60 * 24;
    let remaining = quantity;

    for (const batch of this.fefoBatches(product.product_id)) {
      if (remaining <= 0) break;

      const take = Math.min(batch.quantity_remaining, remaining);
      const expiryDate = new Date(batch.batch_expiration);
      const evalResult = this.inventoryLogic.evaluateExpiryMarkdown(
        product.price, expiryDate, now, product.discount_rate
      );

      allocations.push({
        batch,
        quantity: take,
        unitPrice: product.price,
        discountApplied: evalResult.discountApplied,
        riskLevel: evalResult.riskLevel,
        daysRemaining: Math.floor((expiryDate.getTime() - now.getTime()) / msPerDay),
        subtotal: this.inventoryLogic.calculateLineSubtotal(product.price, evalResult.discountApplied, take)
      });

      remaining -= take;
    }

    return allocations;
  }

  /** Rebuild a cart line's allocation and totals after its quantity changes. */
  private applyAllocation(item: CartItem, quantity: number) {
    const allocations = this.allocateFefo(item.product, quantity);

    item.quantity = quantity;
    item.allocations = allocations;
    item.subtotal = allocations.reduce((sum, a) => sum + a.subtotal, 0);
    item.discountTotal = allocations.reduce((sum, a) => sum + a.discountApplied * a.quantity, 0);
    item.riskLevel = allocations[0]?.riskLevel ?? 'Low';
    item.daysRemaining = allocations[0]?.daysRemaining ?? 0;
    item.hasMixedPricing = allocations.length > 1
      && allocations.some(a => a.discountApplied !== allocations[0].discountApplied);
  }

  addToCart(product: Product) {
    this.validationError.set(null);

    // Availability is the batch pool, not the inventory total — the batches are
    // what the checkout actually draws from.
    const available = this.availableUnits(product.product_id);

    if (available <= 0) {
      const expired = this.expiredUnits(product.product_id);
      const recordedStock = product.stock_quantity ?? 0;

      if (expired > 0) {
        this.validationError.set(
          `${product.product_name} cannot be sold — all ${expired} remaining unit(s) are past their expiry date. Pull them from the shelf and write them off in Inventory.`
        );
      } else {
        this.validationError.set(
          recordedStock > 0
            ? `No active batch found for ${product.product_name}. Please check inventory records.`
            : `Out of stock for ${product.product_name}!`
        );
      }
      return;
    }

    const existingItem = this.cart.find(item => item.product.product_id === product.product_id);

    if (existingItem) {
      if (existingItem.quantity >= available) {
        this.validationError.set(`Cannot add more. Only ${available} available for ${product.product_name}.`);
        return;
      }
      this.applyAllocation(existingItem, existingItem.quantity + 1);
    } else {
      const item: CartItem = {
        product,
        quantity: 0,
        originalPrice: product.price,
        allocations: [],
        subtotal: 0,
        discountTotal: 0,
        riskLevel: 'Low',
        daysRemaining: 0,
        hasMixedPricing: false
      };
      this.applyAllocation(item, 1);
      this.cart.push(item);
    }
  }

  removeFromCart(index: number) {
    this.cart.splice(index, 1);
  }

  adjustQty(index: number, delta: number) {
    const item = this.cart[index];
    const newQty = item.quantity + delta;

    if (newQty <= 0) {
      this.removeFromCart(index);
      return;
    }

    const available = this.availableUnits(item.product.product_id);
    if (newQty > available) {
      this.validationError.set(`Cannot add more. Only ${available} available for ${item.product.product_name}.`);
      return;
    }

    this.validationError.set(null);
    this.applyAllocation(item, newQty);
  }

  get cartTotal(): number {
    return this.cart.reduce((sum, item) => sum + item.subtotal, 0);
  }

  get totalDiscount(): number {
    return this.cart.reduce((sum, item) => sum + item.discountTotal, 0);
  }

  async checkout() {
    if (this.cart.length === 0) return;
    this.validationError.set(null);

    // Stock deduction is server authoritative, so there is no safe way to
    // complete a sale offline. Say so before the cashier takes payment.
    if (!this.connectivity.isOnline()) {
      this.validationError.set(
        'No connection — this sale cannot be recorded. Write it on the Excel sales log and upload it from Offline Sync once you are back online.'
      );
      return;
    }

    if (this.paymentMethod === 'Cash' && this.cashRendered < this.cartTotal) {
      this.validationError.set(`Insufficient cash rendered! Minimum required: ₱${this.cartTotal.toFixed(2)}`);
      return;
    }

    try {
      this.isLoading.set(true);
      // Only product and quantity are sent. The server picks the batches in
      // expiry order and prices each slice itself.
      const itemsForRpc = this.cart.map(item => ({
        product_id: item.product.product_id,
        quantity: item.quantity
      }));

      const saleId = await this.supabaseService.processPosSale(
        this.paymentMethod,
        itemsForRpc
      );

      const itemsSnapshot = [...this.cart];
      const totalSnapshot = this.cartTotal;
      const cashRenderedSnapshot = this.cashRendered;
      const changeAmount = this.paymentMethod === 'Cash' ? Math.max(0, cashRenderedSnapshot - totalSnapshot) : 0;
      const confirmCode = `TRX-${saleId ? String(saleId).slice(0, 8).toUpperCase() : Math.random().toString(36).substring(2, 10).toUpperCase()}`;

      // Save order details for modal display
      this.completedOrder.set({
        saleId: saleId ?? '',
        code: confirmCode,
        items: itemsSnapshot,
        total: totalSnapshot,
        paymentMethod: this.paymentMethod,
        cashRendered: cashRenderedSnapshot,
        change: changeAmount,
        timestamp: new Date()
      });

      // Clear current order cart immediately
      this.cart = [];
      this.cashRendered = 0;

      // Display in-app confirmation modal
      this.showSuccessModal.set(true);

      // Run predictive analytics in background for items sold is removed per request
      
      // Reload inventory stock
      await this.loadData();

    } catch (error: any) {
      console.error('Checkout failed', error);
      this.connectivity.reportRequestFailure(error);
      this.validationError.set(error?.message || 'An error occurred during checkout.');
    } finally {
      this.isLoading.set(false);
    }
  }

  closeSuccessModal() {
    this.showSuccessModal.set(false);
    this.completedOrder.set(null);
  }

  /**
   * Use Case Table 30 — Print Receipt.
   * Formats the completed order as a 80mm thermal receipt and hands it to the
   * browser's print pipeline via a hidden iframe, so the same action produces a
   * physical receipt on a receipt printer or a PDF when none is attached.
   */
  printReceipt() {
    const order = this.completedOrder();
    if (!order) return;

    const escapeHtml = (value: string) =>
      value.replace(/[&<>"']/g, ch => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string
      ));

    const peso = (amount: number) => `P ${amount.toFixed(2)}`;

    // One block per product, then one row per batch the line drew from. A line
    // that spans batches at different markdown tiers therefore shows the split
    // rather than an averaged price the customer cannot reconcile.
    const itemsHtml = order.items.map(item => {
      const rows = item.allocations.map(alloc => {
        const lineDiscount = alloc.discountApplied * alloc.quantity;
        return `
        <tr>
          <td class="qty">${alloc.quantity} x ${peso(alloc.unitPrice)}</td>
          <td class="amt">${peso(alloc.unitPrice * alloc.quantity)}</td>
        </tr>
        ${lineDiscount > 0 ? `
        <tr class="disc">
          <td class="qty">&nbsp;&nbsp;Near-expiry markdown</td>
          <td class="amt">-${peso(lineDiscount)}</td>
        </tr>` : ''}
        `;
      }).join('');

      return `
        <tr>
          <td colspan="2" class="name">${escapeHtml(item.product.product_name)}</td>
        </tr>
        ${rows}
      `;
    }).join('');

    const totalDiscount = order.items.reduce((sum, item) => sum + item.discountTotal, 0);

    const receiptHtml = `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Receipt ${escapeHtml(order.code)}</title>
          <style>
            @page { size: 80mm auto; margin: 4mm; }
            body { font-family: 'Courier New', monospace; font-size: 11px; color: #000; margin: 0; }
            .center { text-align: center; }
            .store { font-size: 14px; font-weight: bold; letter-spacing: 1px; }
            .muted { font-size: 10px; }
            hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
            table { width: 100%; border-collapse: collapse; }
            td { padding: 0; vertical-align: top; }
            .name { font-weight: bold; padding-top: 4px; }
            .qty { text-align: left; }
            .amt { text-align: right; white-space: nowrap; }
            .disc { font-style: italic; }
            .totals td { padding: 1px 0; }
            .grand td { font-size: 13px; font-weight: bold; padding-top: 4px; }
            .footer { margin-top: 10px; font-size: 10px; }
          </style>
        </head>
        <body>
          <div class="center">
            <div class="store">AL-BAZAR ENTERPRISES</div>
            <div class="muted">Panggao Saduc, Marawi City</div>
            <div class="muted">Lanao del Sur</div>
          </div>
          <hr>
          <div class="muted">
            Receipt: ${escapeHtml(order.code)}<br>
            Date: ${order.timestamp.toLocaleString()}<br>
            Payment: ${escapeHtml(order.paymentMethod)}
          </div>
          <hr>
          <table>${itemsHtml}</table>
          <hr>
          <table class="totals">
            ${totalDiscount > 0 ? `
            <tr>
              <td>Total Discount</td>
              <td class="amt">-${peso(totalDiscount)}</td>
            </tr>` : ''}
            <tr class="grand">
              <td>TOTAL</td>
              <td class="amt">${peso(order.total)}</td>
            </tr>
            ${order.paymentMethod === 'Cash' ? `
            <tr>
              <td>Cash</td>
              <td class="amt">${peso(order.cashRendered)}</td>
            </tr>
            <tr>
              <td>Change</td>
              <td class="amt">${peso(order.change)}</td>
            </tr>` : ''}
          </table>
          <hr>
          <div class="center footer">
            Thank you for shopping with us!<br>
            This serves as your official receipt.
          </div>
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
    doc.write(receiptHtml);
    doc.close();

    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      setTimeout(() => {
        if (iframe.parentNode) document.body.removeChild(iframe);
      }, 1000);
    }, 250);
  }
}
