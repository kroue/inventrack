import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Product, Suppliers } from '../../models/itrack.models';
import { InventoryLogicService } from '../../services/inventory-logic.service';

interface AdjustStockForm {
  changeType: 'ADJUST' | 'Customer Return' | 'Return to Supplier';
  /** Only meaningful for 'ADJUST', which is the one signed category. */
  direction: 'Increase' | 'Decrease';
  quantity: number;
  reason: string;
}

interface DiscountRateRow {
  product_id: string;
  product_name: string;
  category_name: string;
  price: number;
  /** Stored as a fraction (0.15) but edited as a percentage (15). */
  discount_percent: number;
  original_percent: number;
  dirty: boolean;
}

@Component({
  selector: 'app-inventory',
  imports: [CommonModule, FormsModule],
  templateUrl: './inventory.html',
  styleUrl: './inventory.css',
})
export class Inventory implements OnInit {
  private inventoryLogic = inject(InventoryLogicService);

  searchQuery = '';

  // State using Angular Signals
  products = signal<Product[]>([]);
  isLoading = signal<boolean>(true);
  errorMessage = signal<string | null>(null);

  stockMap: Record<string, number> = {};

  // View Mode State
  viewMode = signal<'Grid' | 'List'>('Grid');

  // Modal State
  isModalOpen = signal<boolean>(false);
  modalMode = signal<'Add' | 'Edit'>('Add');
  isSubmitting = signal<boolean>(false);
  
  // Current Form Data
  currentProduct = signal<Partial<Product> & { initialStock?: number, discount_rate_percent?: number }>({});

  // Supplier State
  suppliers = signal<Suppliers[]>([]);
  isCreatingSupplier = signal<boolean>(false);
  newSupplierForm = signal<Partial<Suppliers>>({});

  // Category State
  categories = signal<string[]>([]);
  isCreatingCategory = signal<boolean>(false);

  // Price History State
  priceHistory = signal<any[]>([]);
  isPriceHistoryModalOpen = signal<boolean>(false);

  // Markdown Discount Rate State (Use Case Table 27)
  isDiscountModalOpen = signal<boolean>(false);
  isSavingDiscounts = signal<boolean>(false);
  discountRows = signal<DiscountRateRow[]>([]);
  bulkDiscountPercent = signal<number>(20);
  discountError = signal<string | null>(null);
  discountSuccess = signal<string | null>(null);

  dirtyDiscountCount = computed(() => this.discountRows().filter(r => r.dirty).length);

  // Adjust Stock State (Use Case Table 20)
  isAdjustModalOpen = signal<boolean>(false);
  isSubmittingAdjustment = signal<boolean>(false);
  adjustProduct = signal<Product | null>(null);
  adjustError = signal<string | null>(null);
  adjustSuccess = signal<string | null>(null);
  adjustForm = signal<AdjustStockForm>({
    changeType: 'ADJUST',
    direction: 'Decrease',
    quantity: 1,
    reason: ''
  });

  async ngOnInit() {
    try {
      this.isLoading.set(true);
      this.errorMessage.set(null);
      
      const [data, suppliersData] = await Promise.all([
        this.inventoryLogic.getActiveProducts(),
        this.inventoryLogic.getSuppliers()
      ]);
      this.suppliers.set(suppliersData);

      const map: Record<string, number> = {};
      const updatedData = (data as any[]).map(p => {
        const inv = p.inventory?.[0] || {};
        const stock_quantity = inv.stock_quantity ?? 0;
        const reorder_point = inv.reorder_point ?? 0;
        const needs_restock = stock_quantity <= reorder_point;
        
        map[p.product_id] = stock_quantity;
        return { ...p, stock_quantity, needs_restock };
      });
      
      const uniqueCategories = Array.from(new Set(updatedData.map(p => p.category_name))).filter(Boolean).sort();
      this.categories.set(uniqueCategories);

      this.stockMap = map;
      this.products.set(updatedData);
      
    } catch (err: any) {
      console.error('Failed to load inventory data', err);
      this.errorMessage.set(err.message || 'Failed to load inventory data');
    } finally {
      this.isLoading.set(false);
    }
  }

  get filteredProducts(): Product[] {
    const allProducts = this.products();
    if (!this.searchQuery.trim()) return allProducts;
    
    const q = this.searchQuery.toLowerCase();
    return allProducts.filter(p =>
      p.product_name.toLowerCase().includes(q) ||
      p.category_name.toLowerCase().includes(q) ||
      p.barcode.includes(q)
    );
  }

  openAddModal() {
    this.modalMode.set('Add');
    this.currentProduct.set({
      product_name: '',
      category_name: '',
      barcode: '',
      description: '',
      cost_price: 0,
      price: 0,
      status: 'Available',
      initialStock: 0,
      supplier_id: '',
      discount_rate_percent: 0
    } as any);
    this.isCreatingSupplier.set(false);
    this.isCreatingCategory.set(false);
    this.newSupplierForm.set({});
    this.isModalOpen.set(true);
  }

  openEditModal(product: Product) {
    this.modalMode.set('Edit');
    const discountPercent = product.discount_rate ? product.discount_rate * 100 : 0;
    this.currentProduct.set({ ...product, discount_rate_percent: discountPercent } as any);
    this.isCreatingSupplier.set(false);
    this.isCreatingCategory.set(false);
    this.newSupplierForm.set({});
    this.isModalOpen.set(true);
  }

  closeModal() {
    this.isModalOpen.set(false);
    this.errorMessage.set(null);
  }

  async openPriceHistoryModal(productId: string) {
    this.priceHistory.set([]);
    this.isPriceHistoryModalOpen.set(true);
    try {
      const history = await this.inventoryLogic.getProductPriceHistory(productId);
      this.priceHistory.set(history);
    } catch (err) {
      console.error('Failed to load price history', err);
    }
  }

  closePriceHistoryModal() {
    this.isPriceHistoryModalOpen.set(false);
  }

  async saveProduct() {
    try {
      this.isSubmitting.set(true);
      this.errorMessage.set(null);
      const data = this.currentProduct();
      
      let finalSupplierId = data.supplier_id;

      if (this.isCreatingSupplier()) {
        const newSupplierData = this.newSupplierForm();
        if (!newSupplierData.supplier_name || !newSupplierData.contact_person || !newSupplierData.phone || !newSupplierData.address) {
          throw new Error('Please fill in all required supplier fields (Name, Contact Person, Phone, Address).');
        }
        const createdSupplier = await this.inventoryLogic.createSupplier(newSupplierData);
        finalSupplierId = createdSupplier.supplier_id;
      }

      if (this.modalMode() === 'Add') {
        const productToInsert = {
          product_name: data.product_name,
          category_name: data.category_name,
          barcode: data.barcode,
          description: data.description,
          price: data.price,
          cost_price: data.cost_price,
          status: data.status,
          discount_rate: (data as any).discount_rate_percent ? (data as any).discount_rate_percent / 100 : 0,
          supplier_id: finalSupplierId || undefined,
          image_url: data.image_url
        };
        await this.inventoryLogic.createProduct(productToInsert, data.initialStock || 0);
      } else {
        const updates: any = {
          product_name: data.product_name,
          category_name: data.category_name,
          barcode: data.barcode,
          description: data.description,
          price: data.price,
          cost_price: data.cost_price,
          status: data.status,
          image_url: data.image_url
        };
        if (finalSupplierId !== undefined) {
            updates.supplier_id = finalSupplierId || null;
        }
        if ((data as any).discount_rate_percent !== undefined) {
            updates.discount_rate = ((data as any).discount_rate_percent || 0) / 100;
        }
        await this.inventoryLogic.updateProduct(data.product_id!, updates);
      }
      
      this.closeModal();
      await this.ngOnInit(); // Refresh list
    } catch (err: any) {
      console.error('Save failed', err);
      this.errorMessage.set(err.message || 'Failed to save product');
    } finally {
      this.isSubmitting.set(false);
    }
  }

  productToDelete: string | null = null;

  confirmDeleteProduct(productId: string) {
    this.productToDelete = productId;
  }

  cancelDeleteProduct() {
    this.productToDelete = null;
  }

  async executeDeleteProduct() {
    if (!this.productToDelete) return;
    const productId = this.productToDelete;
    this.productToDelete = null;
    
    try {
      this.isLoading.set(true);
        await this.inventoryLogic.deleteProduct(productId);
        await this.ngOnInit(); // Refresh list
      } catch (err: any) {
        console.error('Delete failed', err);
        this.errorMessage.set(err.message || 'Failed to delete product');
        this.isLoading.set(false);
      }
  }

  // ─── Adjust Stock (Use Case Table 20) ────────────────────────────────────

  readonly adjustCategories: { value: AdjustStockForm['changeType']; label: string }[] = [
    { value: 'ADJUST', label: 'Adjust' },
    { value: 'Customer Return', label: 'Customer Return' },
    { value: 'Return to Supplier', label: 'Return to Supplier' }
  ];

  adjustCategoryHint = computed(() => {
    switch (this.adjustForm().changeType) {
      case 'Customer Return':
        return 'A customer brought goods back — stock is returned to the shelf.';
      case 'Return to Supplier':
        return 'Goods are being sent back to the supplier — stock leaves the shelf.';
      default:
        return 'A correction to the recorded quantity, such as a physical count or damaged goods.';
    }
  });

  openAdjustModal(product: Product) {
    this.adjustProduct.set(product);
    this.adjustForm.set({
      changeType: 'ADJUST',
      direction: 'Decrease',
      quantity: 1,
      reason: ''
    });
    this.adjustError.set(null);
    this.adjustSuccess.set(null);
    this.isAdjustModalOpen.set(true);
  }

  closeAdjustModal() {
    this.isAdjustModalOpen.set(false);
    this.adjustProduct.set(null);
    this.adjustError.set(null);
    this.adjustSuccess.set(null);
  }

  setAdjustType(changeType: 'ADJUST' | 'Customer Return' | 'Return to Supplier') {
    this.adjustForm.update(form => ({ ...form, changeType }));
    this.adjustError.set(null);
  }

  setAdjustDirection(direction: 'Increase' | 'Decrease') {
    this.adjustForm.update(form => ({ ...form, direction }));
  }

  updateAdjustField<K extends keyof AdjustStockForm>(field: K, value: AdjustStockForm[K]) {
    this.adjustForm.update(form => ({ ...form, [field]: value }));
    this.adjustError.set(null);
  }

  /**
   * The net effect the current form will have on stock, shown to the admin
   * before they commit so the sign of an ADJUST is never a surprise.
   */
  adjustPreview = computed(() => {
    const form = this.adjustForm();
    const product = this.adjustProduct();
    if (!product) return null;

    const current = this.stockMap[product.product_id] ?? 0;
    const magnitude = Math.abs(Number(form.quantity) || 0);

    let delta: number;
    if (form.changeType === 'Customer Return') {
      delta = magnitude;
    } else if (form.changeType === 'Return to Supplier') {
      delta = -magnitude;
    } else {
      delta = form.direction === 'Increase' ? magnitude : -magnitude;
    }

    return { current, delta, resulting: Math.max(0, current + delta) };
  });

  async submitAdjustment() {
    const form = this.adjustForm();
    const product = this.adjustProduct();
    if (!product) return;

    const magnitude = Math.abs(Number(form.quantity) || 0);

    if (magnitude <= 0) {
      this.adjustError.set('Quantity must be greater than zero.');
      return;
    }
    if (!form.reason.trim()) {
      this.adjustError.set('Please provide a reason for this adjustment.');
      return;
    }

    // 'ADJUST' carries the sign; the two return categories are always positive.
    const signedQuantity = form.changeType === 'ADJUST' && form.direction === 'Decrease'
      ? -magnitude
      : magnitude;

    try {
      this.isSubmittingAdjustment.set(true);
      this.adjustError.set(null);

      const result = await this.inventoryLogic.recordStockAdjustment(
        product.product_id,
        form.changeType,
        signedQuantity,
        form.reason.trim()
      );

      this.adjustSuccess.set(
        `${form.changeType} recorded. ${product.product_name} is now at ${result.stock_quantity} in stock.`
      );

      await this.ngOnInit(); // Refresh stock figures
      this.adjustForm.update(f => ({ ...f, quantity: 1, reason: '' }));
    } catch (err: any) {
      console.error('Stock adjustment failed', err);
      this.adjustError.set(err.message || 'Failed to record the stock adjustment.');
    } finally {
      this.isSubmittingAdjustment.set(false);
    }
  }

  // ─── Markdown Discount Rates (Use Case Table 27) ─────────────────────────

  openDiscountRatesModal() {
    this.discountError.set(null);
    this.discountSuccess.set(null);

    // Percentages are what the admin thinks in; the database stores a fraction.
    this.discountRows.set(
      this.products().map(p => {
        const percent = Math.round((p.discount_rate ?? 0) * 100);
        return {
          product_id: p.product_id,
          product_name: p.product_name,
          category_name: p.category_name,
          price: Number(p.price) || 0,
          discount_percent: percent,
          original_percent: percent,
          dirty: false
        };
      })
    );

    this.isDiscountModalOpen.set(true);
  }

  closeDiscountRatesModal() {
    this.isDiscountModalOpen.set(false);
    this.discountRows.set([]);
    this.discountError.set(null);
    this.discountSuccess.set(null);
  }

  updateDiscountRow(index: number, value: number) {
    const clamped = Math.min(100, Math.max(0, Math.round(Number(value) || 0)));

    this.discountRows.update(rows => {
      const next = [...rows];
      const row = next[index];
      if (!row) return rows;
      next[index] = { ...row, discount_percent: clamped, dirty: clamped !== row.original_percent };
      return next;
    });

    this.discountSuccess.set(null);
  }

  applyBulkDiscount() {
    const clamped = Math.min(100, Math.max(0, Math.round(Number(this.bulkDiscountPercent()) || 0)));

    this.discountRows.update(rows =>
      rows.map(row => ({
        ...row,
        discount_percent: clamped,
        dirty: clamped !== row.original_percent
      }))
    );

    this.discountSuccess.set(null);
  }

  async saveDiscountRates() {
    const changed = this.discountRows().filter(r => r.dirty);
    if (changed.length === 0) return;

    try {
      this.isSavingDiscounts.set(true);
      this.discountError.set(null);
      this.discountSuccess.set(null);

      for (const row of changed) {
        await this.inventoryLogic.updateProduct(row.product_id, {
          discount_rate: row.discount_percent / 100
        });
      }

      // Mark the saved values as the new baseline.
      this.discountRows.update(rows =>
        rows.map(r => ({ ...r, original_percent: r.discount_percent, dirty: false }))
      );

      this.discountSuccess.set(
        `Updated the markdown rate for ${changed.length} product(s).`
      );

      await this.ngOnInit(); // Refresh the product list with the new rates
    } catch (err: any) {
      console.error('Failed to save discount rates', err);
      this.discountError.set(err.message || 'Failed to save discount rates.');
    } finally {
      this.isSavingDiscounts.set(false);
    }
  }
}
