import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Product } from '../../models/itrack.models';
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
  currentProduct = signal<Partial<Product> & { initialStock?: number }>({});

  async ngOnInit() {
    try {
      this.isLoading.set(true);
      this.errorMessage.set(null);
      
      const data = await this.inventoryLogic.getActiveProducts();
      const map: Record<string, number> = {};
      const updatedData = (data as any[]).map(p => {
        const inv = p.inventory?.[0] || {};
        const stock_quantity = inv.stock_quantity ?? 0;
        const reorder_point = inv.reorder_point ?? 0;
        const needs_restock = stock_quantity <= reorder_point;
        
        map[p.product_id] = stock_quantity;
        return { ...p, stock_quantity, needs_restock };
      });
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
      initialStock: 0
    });
    this.isModalOpen.set(true);
  }

  openEditModal(product: Product) {
    this.modalMode.set('Edit');
    this.currentProduct.set({ ...product });
    this.isModalOpen.set(true);
  }

  closeModal() {
    this.isModalOpen.set(false);
    this.errorMessage.set(null);
  }

  async saveProduct() {
    try {
      this.isSubmitting.set(true);
      this.errorMessage.set(null);
      const data = this.currentProduct();
      
      if (this.modalMode() === 'Add') {
        const productToInsert = {
          product_name: data.product_name,
          category_name: data.category_name,
          barcode: data.barcode,
          description: data.description,
          price: data.price,
          status: data.status,
          discount_rate: 0
        };
        await this.inventoryLogic.createProduct(productToInsert, data.initialStock || 0);
      } else {
        const { product_id, initialStock, ...updates } = data as any;
        await this.inventoryLogic.updateProduct(product_id, updates);
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

  async deleteProduct(productId: string) {
    if (confirm('Are you sure you want to delete this product? This action cannot be undone.')) {
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
  }

  async adjustStock(productId: string, batchId: string, quantityAdjusted: number, reason: string) {
    // TODO: Implement stock adjustment
  }
}
