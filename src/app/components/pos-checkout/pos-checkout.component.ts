import { Component, inject, OnInit, signal, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InventoryLogicService } from '../../services/inventory-logic.service';
import { SupabaseService } from '../../services/supabase.service';
import { Product, Batches } from '../../models/itrack.models';

interface CartItem {
  product: Product;
  batch: Batches;
  quantity: number;
  originalPrice: number;
  sellingPrice: number;
  discountApplied: number;
  riskLevel: 'Low' | 'Medium' | 'High';
  subtotal: number;
  daysRemaining: number;
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
      // Fetch Products with real inventory stock quantity
      const { data: prodData, error: prodError } = await supabase
        .from('products')
        .select('*, inventory(*)');
      if (prodError) throw prodError;
      
      if (prodData) {
        const mapped = prodData.map((p: any) => {
          const inv = p.inventory?.[0] || {};
          const stock = inv.stock_quantity ?? 0;
          const rop = inv.reorder_point ?? 0;
          return {
            ...p,
            stock_quantity: stock,
            needs_restock: stock <= rop
          };
        });
        this.products.set(mapped);
        this.searchResults = mapped;
      }

      // Fetch Batches with remaining quantity > 0
      const { data: batchData, error: batchError } = await supabase.from('batches').select('*').gt('quantity_remaining', 0);
      if (batchError) throw batchError;

      if (batchData) {
        this.batches.set(batchData);
      }
    } catch (err: any) {
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

  addToCart(product: Product) {
    this.validationError.set(null);
    const currentStock = product.stock_quantity ?? 0;

    // Find earliest expiring batch (FEFO)
    const batchesForProduct = this.batches()
      .filter(b => b.product_id === product.product_id && b.quantity_remaining > 0)
      .sort((a, b) => new Date(a.batch_expiration).getTime() - new Date(b.batch_expiration).getTime());

    let selectedBatch: Batches;

    if (batchesForProduct.length > 0) {
      selectedBatch = batchesForProduct[0];
    } else {
      // Fallback: If product has inventory stock, synthesize a default batch
      if (currentStock <= 0) {
        this.validationError.set(`Out of stock for ${product.product_name}!`);
        return;
      }
      selectedBatch = {
        batch_id: 'default-' + product.product_id,
        product_id: product.product_id,
        quantity_received: currentStock,
        quantity_remaining: currentStock,
        batch_expiration: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        risk_score: 'Normal',
        created_at: new Date().toISOString()
      };
    }

    const expiryDate = new Date(selectedBatch.batch_expiration);
    
    // Evaluate Pricing
    const evalResult = this.inventoryLogic.evaluateExpiryMarkdown(product.price, expiryDate, new Date(), product.discount_rate);
    
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysRemaining = Math.floor((expiryDate.getTime() - new Date().getTime()) / msPerDay);

    // Check if already in cart
    const existingItem = this.cart.find(item => item.product.product_id === product.product_id && item.batch.batch_id === selectedBatch.batch_id);

    if (existingItem) {
      if (currentStock > 0 && existingItem.quantity >= currentStock) {
        this.validationError.set(`Cannot add more. Only ${currentStock} in stock for ${product.product_name}.`);
        return;
      }
      existingItem.quantity += 1;
      existingItem.subtotal = this.inventoryLogic.calculateLineSubtotal(product.price, evalResult.discountApplied, existingItem.quantity);
    } else {
      this.cart.push({
        product: product,
        batch: selectedBatch,
        quantity: 1,
        originalPrice: product.price,
        sellingPrice: evalResult.sellingPrice,
        discountApplied: evalResult.discountApplied,
        riskLevel: evalResult.riskLevel,
        daysRemaining: daysRemaining,
        subtotal: this.inventoryLogic.calculateLineSubtotal(product.price, evalResult.discountApplied, 1)
      });
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
    item.quantity = newQty;
    item.subtotal = this.inventoryLogic.calculateLineSubtotal(item.originalPrice, item.discountApplied, newQty);
  }

  get cartTotal(): number {
    return this.cart.reduce((sum, item) => sum + item.subtotal, 0);
  }

  get totalDiscount(): number {
    return this.cart.reduce((sum, item) => sum + (item.discountApplied * item.quantity), 0);
  }

  async checkout() {
    if (this.cart.length === 0) return;
    this.validationError.set(null);
    
    if (this.paymentMethod === 'Cash' && this.cashRendered < this.cartTotal) {
      this.validationError.set(`Insufficient cash rendered! Minimum required: ₱${this.cartTotal.toFixed(2)}`);
      return;
    }

    try {
      this.isLoading.set(true);
      const { data: userData } = await this.supabaseService.client.auth.getUser();
      const userId = userData?.user?.id || null;

      const itemsForRpc = this.cart.map(item => ({
        product_id: item.product.product_id,
        batch_id: item.batch.batch_id,
        quantity: item.quantity,
        unit_price: item.originalPrice,
        discount_applied: item.discountApplied
      }));

      const saleId = await this.supabaseService.processPosSale(
        userId,
        this.cartTotal,
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
      this.validationError.set(error?.message || 'An error occurred during checkout.');
    } finally {
      this.isLoading.set(false);
    }
  }

  closeSuccessModal() {
    this.showSuccessModal.set(false);
    this.completedOrder.set(null);
  }
}
