import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-stock-log',
  imports: [CommonModule],
  templateUrl: './stock-log.html',
  styleUrl: './stock-log.css',
})
export class StockLog {
  stockLogs = [
    { product: 'product 1', quantity: 100, type: 'IN',     date: 'Jul 18, 2026', remarks: 'Delivery #PO-001' },
    { product: 'product 2', quantity: 5,   type: 'OUT',    date: 'Jul 18, 2026', remarks: 'POS Sale'         },
    { product: 'product 3', quantity: 100, type: 'IN',     date: 'Jul 17, 2026', remarks: 'Delivery #PO-002' },
    { product: 'product 1', quantity: 10,  type: 'ADJUST', date: 'Jul 16, 2026', remarks: 'Damaged goods'    },
  ];
}
