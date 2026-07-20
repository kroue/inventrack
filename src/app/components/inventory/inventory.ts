import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Product } from '../../models/itrack.models';

@Component({
  selector: 'app-inventory',
  imports: [CommonModule, FormsModule],
  templateUrl: './inventory.html',
  styleUrl: './inventory.css',
})
export class Inventory {
  searchQuery = '';

  products: Product[] = [
    { product_id: 'P001', product_name: 'Premium Jasmine Rice (5kg)', category_name: 'Grains',      barcode: '123456789', price: 250.00, discount_rate: 0.20, status: 'Available'  },
    { product_id: 'P002', product_name: 'Whole Milk (1L)',             category_name: 'Dairy',       barcode: '987654321', price: 90.00,  discount_rate: 0.50, status: 'Available'  },
    { product_id: 'P003', product_name: 'Canned Tuna (Spicy)',         category_name: 'Canned Goods', barcode: '456123789', price: 45.50,  discount_rate: 0.10, status: 'Available'  },
    { product_id: 'P004', product_name: 'Cooking Oil (1L)',            category_name: 'Condiments',  barcode: '111222333', price: 69.00,  discount_rate: 0.00, status: 'Available'  },
    { product_id: 'P005', product_name: 'Instant Noodles (5s)',        category_name: 'Dry Goods',   barcode: '444555666', price: 60.00,  discount_rate: 0.00, status: 'Low Stock'  },
    { product_id: 'P006', product_name: 'Tomato Sauce (250g)',         category_name: 'Condiments',  barcode: '777888999', price: 87.00,  discount_rate: 0.00, status: 'Available'  },
    { product_id: 'P007', product_name: 'White Sugar (1kg)',           category_name: 'Dry Goods',   barcode: '101010101', price: 99.00,  discount_rate: 0.00, status: 'Out of Stock' },
  ];

  stockMap: Record<string, number> = {
    P001: 100, P002: 50,  P003: 200,
    P004: 78,  P005: 12,  P006: 55,  P007: 0,
  };

  get filteredProducts(): Product[] {
    if (!this.searchQuery.trim()) return this.products;
    const q = this.searchQuery.toLowerCase();
    return this.products.filter(p =>
      p.product_name.toLowerCase().includes(q) ||
      p.category_name.toLowerCase().includes(q) ||
      p.barcode.includes(q)
    );
  }
}
