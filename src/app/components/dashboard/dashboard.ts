import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-dashboard',
  imports: [CommonModule],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.css',
})
export class Dashboard {
  chartBars = [
    { day: 'Sat', height: 128, fill: 70, tooltip: '₱28,000' },
    { day: 'Sun', height: 96,  fill: 80, tooltip: '₱30,500' },
    { day: 'Mon', height: 64,  fill: 60, tooltip: '₱14,200' },
    { day: 'Tue', height: 112, fill: 60, tooltip: '₱32,849' },
    { day: 'Wed', height: 160, fill: 80, tooltip: '₱38,100' },
    { day: 'Thu', height: 128, fill: 75, tooltip: '₱25,700' },
    { day: 'Fri', height: 48,  fill: 40, tooltip: '₱9,400'  },
  ];

  quickStats = [
    { label: 'Items Sold Today',   value: '142',  percent: '72%',  color: 'bg-blue-500'   },
    { label: 'Near-Expiry Alerts', value: '18',   percent: '28%',  color: 'bg-red-400'    },
    { label: 'Active Suppliers',   value: '5',    percent: '50%',  color: 'bg-green-500'  },
    { label: 'PO Completion',      value: '89%',  percent: '89%',  color: 'bg-purple-500' },
  ];

  salesHistory = [
    { cashier: 'Jane Doe',   products: 'Canned Tuna x3',    total: '136.50', date: 'Jul 18, 2026' },
    { cashier: 'Mark Cruz',  products: 'Whole Milk x2',     total: '180.00', date: 'Jul 18, 2026' },
    { cashier: 'Jane Doe',   products: 'Jasmine Rice x1',   total: '250.00', date: 'Jul 17, 2026' },
    { cashier: 'Ana Reyes',  products: 'Canned Tuna x10',   total: '455.00', date: 'Jul 17, 2026' },
  ];
}
