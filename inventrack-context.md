# Inventrack - System Context

## Project Overview
**Inventrack** is an inventory management and point-of-sale (POS) system. It allows users to track products, manage inventory (restocks, deliveries, suppliers), handle POS transactions, generate forecasts, and monitor low stock or near-expiry alerts.

## Technology Stack
- **Frontend Framework**: Angular 22 (using `@angular/core`, `@angular/router`, `@angular/forms`)
- **Styling**: TailwindCSS (v4.1)
- **Backend/Database**: Supabase (using `@supabase/supabase-js`)
- **Language**: TypeScript
- **Testing**: Vitest, jsdom

## Application Structure
- **Components** (`src/app/components/`):
  - `dashboard`: Main dashboard view
  - `inventory`: Inventory management views
  - `login`: Authentication view
  - `offline-sync`: Offline capabilities/sync views
  - `pos-checkout`: Point-of-Sale checkout interface
  - `procurement`: Purchasing and supplier management
  - `stock-log`: Logs for stock movements (in, out, adjustments)
  - `users`: User management

- **Services** (`src/app/services/`):
  - `auth.service.ts`: Handles authentication
  - `inventory-logic.service.ts`: Core logic for inventory, forecasting, alerts
  - `supabase.service.ts`: Supabase client initialization and generic DB operations

- **Guards** (`src/app/guards/`): Route guards for protecting routes based on roles or auth state
- **Layouts** (`src/app/layouts/`): Shared layout templates (e.g., sidebars, headers)

## Database Schema / Models (`src/app/models/itrack.models.ts`)
The application defines the following primary TypeScript interfaces which mirror the database tables:

1. **User**: `user_id`, `full_name`, `email`, `role` (Admin/Cashier).
2. **Product**: `product_id`, `product_name`, `category_name`, `barcode`, `price`, `discount_rate`, `status`.
3. **Inventory**: `inventory_id`, `product_id`, `stock_quantity`, `safety_stock`, `lead_time`, `reorder_point`.
4. **SalesHistory**: Track product sales over time.
5. **Forecasts**: `daily_velocity`, `calculated_rop`, `suggested_order_qty`.
6. **Alerts**: Types include `LOW STOCK` and `NEAR EXPIRY`.
7. **RestockRequests**: Tracks suggested quantities and approval statuses.
8. **Suppliers**: Contact info for suppliers.
9. **PurchaseOrders & PurchaseItems**: Orders placed with suppliers.
10. **Deliveries & DeliveryItems**: Receiving goods from purchase orders.
11. **Sales & SaleItems**: POS records (includes payment methods like Cash/Gcash).
12. **StockLog**: Granular tracking of stock changes (IN, OUT, ADJUST, Returns).
13. **Batches**: Tracks items with expirations to calculate risk scores (Normal, Warning, Near-Expiry).

## Key Features
- **POS & Checkout**: Interface for cashiers to ring up sales and handle transactions.
- **Inventory & Batch Tracking**: Monitor quantities, expiration dates, and adjust stock.
- **Forecasting & Alerts**: Automatically calculate reorder points and warn about low/expiring stock.
- **Procurement Workflow**: From Restock Requests -> Purchase Orders -> Deliveries.
- **Offline Sync**: Architecture to support operations when disconnected.
