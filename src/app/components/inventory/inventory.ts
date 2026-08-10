import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Product, Suppliers } from '../../models/itrack.models';
import { InventoryLogicService } from '../../services/inventory-logic.service';

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

  async adjustStock(productId: string, batchId: string, quantityAdjusted: number, reason: string) {
    // TODO: Implement stock adjustment
  }
}
