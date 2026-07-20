import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-procurement',
  imports: [CommonModule],
  templateUrl: './procurement.html',
  styleUrl: './procurement.css',
})
export class Procurement {
  restockItems = [
    { name: 'Product 1', quantity: 25, soq: 100, checked: true },
    { name: 'Product 2', quantity: 25, soq: 100, checked: true },
    { name: 'Product 3', quantity: 25, soq: 100, checked: true },
  ];

  pendingRequests = [
    { supplier: 'Supplier 1', items: '3 Items', type: 'Pick-up' },
    { supplier: 'Supplier 2', items: '3 Items', type: 'Delivery' },
  ];

  deliveries = [
    { product: 'product 1', ordered: 100, received: 100 },
    { product: 'product 2', ordered: 100, received: 100 },
    { product: 'product 3', ordered: 100, received: 100 },
  ];
}
