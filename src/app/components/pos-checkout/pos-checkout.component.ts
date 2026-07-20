import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { InventoryLogicService } from '../../services/inventory-logic.service';
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

@Component({
  selector: 'app-pos-checkout',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './pos-checkout.component.html',
})
export class PosCheckoutComponent implements OnInit {
  private inventoryLogic = inject(InventoryLogicService);

  // Mock Data
  mockProducts: Product[] = [
    { product_id: 'P001', product_name: 'Premium Jasmine Rice (5kg)', category_name: 'Grains', barcode: '123456789', price: 250.00, discount_rate: 0.20, status: 'Available' },
    { product_id: 'P002', product_name: 'Whole Milk (1L)', category_name: 'Dairy', barcode: '987654321', price: 90.00, discount_rate: 0.50, status: 'Available' },
    { product_id: 'P003', product_name: 'Canned Tuna (Spicy)', category_name: 'Canned Goods', barcode: '456123789', price: 45.50, discount_rate: 0.10, status: 'Available' }
  ];

  mockBatches: Batches[] = [
    { batch_id: 'B001', product_id: 'P001', quantity_received: 100, quantity_remaining: 100, batch_expiration: this.addDays(new Date(), 365), risk_score: 'Normal', created_at: new Date() },
    { batch_id: 'B002', product_id: 'P002', quantity_received: 50, quantity_remaining: 50, batch_expiration: this.addDays(new Date(), 10), risk_score: 'Near-Expiry', created_at: new Date() },
    { batch_id: 'B003', product_id: 'P003', quantity_received: 200, quantity_remaining: 200, batch_expiration: this.addDays(new Date(), 25), risk_score: 'Warning', created_at: new Date() }
  ];

  searchQuery: string = '';
  searchResults: Product[] = [];
  
  cart: CartItem[] = [];
  
  paymentMethod: 'Cash' | 'Gcash' = 'Cash';
  cashRendered: number = 0;

  ngOnInit() {
    this.searchResults = this.mockProducts;
  }

  addDays(date: Date, days: number): Date {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
  }

  onSearchChange() {
    if (!this.searchQuery.trim()) {
      this.searchResults = this.mockProducts;
      return;
    }
    const query = this.searchQuery.toLowerCase();
    this.searchResults = this.mockProducts.filter(p => 
      p.product_name.toLowerCase().includes(query) || p.barcode.includes(query)
    );
  }

  simulateScan(barcode: string) {
    this.searchQuery = barcode;
    this.onSearchChange();
    if (this.searchResults.length === 1) {
      this.addToCart(this.searchResults[0]);
      this.searchQuery = '';
      this.searchResults = this.mockProducts;
    }
  }

  addToCart(product: Product) {
    // Find earliest expiring batch (FEFO)
    const batchesForProduct = this.mockBatches.filter(b => b.product_id === product.product_id && b.quantity_remaining > 0)
      .sort((a, b) => new Date(a.batch_expiration).getTime() - new Date(b.batch_expiration).getTime());

    if (batchesForProduct.length === 0) {
      alert('Out of stock!');
      return;
    }

    const selectedBatch = batchesForProduct[0];
    const expiryDate = new Date(selectedBatch.batch_expiration);
    
    // Evaluate Pricing
    const evalResult = this.inventoryLogic.evaluateExpiryMarkdown(product.price, expiryDate, new Date(), product.discount_rate);
    
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysRemaining = Math.floor((expiryDate.getTime() - new Date().getTime()) / msPerDay);

    // Check if already in cart
    const existingItem = this.cart.find(item => item.product.product_id === product.product_id && item.batch.batch_id === selectedBatch.batch_id);

    if (existingItem) {
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

  checkout() {
    if (this.cart.length === 0) return;
    
    if (this.paymentMethod === 'Cash' && this.cashRendered < this.cartTotal) {
      alert('Insufficient cash rendered!');
      return;
    }

    console.log('Checkout completed with yield logs:', this.cart);
    alert('Checkout successful! Receipt printed.');
    
    // Reset
    this.cart = [];
    this.cashRendered = 0;
  }
}
