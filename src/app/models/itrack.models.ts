export interface User {
  user_id: string;
  full_name: string;
  email: string;
  password?: string;
  role: 'Admin' | 'Cashier';
  created_at: Date | string;
}

export interface Product {
  product_id: string;
  product_name: string;
  category_name: string;
  barcode: string;
  description?: string;
  cost_price?: number;
  price: number;
  discount_rate: number;
  status: 'Available' | 'Low Stock' | 'Out of Stock';
  stock_quantity?: number;
  needs_restock?: boolean;
  supplier_id?: string;
  image_url?: string;
}

export interface Inventory {
  inventory_id: string;
  product_id: string;
  stock_quantity: number;
  safety_stock: number;
  lead_time: number;
  reorder_point: number;
}

export interface SalesHistory {
  history_id: string;
  sales_id: string;
  product_id: string;
  date: Date | string;
  quantity_sold: number;
}

export interface Forecasts {
  forecast_id: string;
  product_id: string;
  daily_velocity: number;
  calculated_rop: number;
  suggested_order_qty: number;
}

export interface Alerts {
  alert_id: string;
  product_id: string;
  forecast_id?: string;
  alert_type: 'LOW STOCK' | 'NEAR EXPIRY';
  triggered_date: Date | string;
  status: 'Active' | 'Resolved';
}

export interface RestockRequests {
  request_id: string;
  product_id: string;
  alert_id?: string;
  suggested_quantity: number;
  request_date: Date | string;
  status: 'Pending' | 'Approved' | 'Completed';
}

export interface Suppliers {
  supplier_id: string;
  supplier_name: string;
  contact_person: string;
  phone: string;
  email?: string;
  address: string;
}

export interface PurchaseOrders {
  purchase_order_id: string;
  supplier_id: string;
  request_id?: string;
  fulfillment_type: 'Delivery' | 'Pick-up';
  order_date: Date | string;
  expected_date: Date | string;
  status: 'Draft' | 'Approved' | 'Received';
  total_amount: number;
}

export interface PurchaseItems {
  purchase_item_id: string;
  purchase_order_id: string;
  product_id: string;
  quantity_ordered: number;
  unit_cost: number;
  subtotal: number;
}

export interface Deliveries {
  delivery_id: string;
  purchase_order_id: string;
  delivery_date: Date | string;
  received_by: string;
  status: 'Pending' | 'Received';
}

export interface DeliveryItems {
  delivery_item_id: string;
  delivery_id: string;
  product_id: string;
  quantity_ordered: number;
  quantity_received: number;
  remarks?: string;
}

export interface Sales {
  sale_id: string;
  user_id: string;
  sale_date: Date | string;
  total_amount: number;
  payment_method: 'Cash' | 'Gcash';
  record_type: 'POS' | 'Excel Log';
}

export interface SaleItems {
  sale_item_id: string;
  sale_id: string;
  product_id: string;
  batch_id?: string;
  quantity: number;
  unit_price: number;
  discount_applied: number;
  subtotal: number;
}

export interface StockLog {
  log_id: string;
  product_id: string;
  batch_id?: string;
  user_id: string;
  sale_id?: string;
  delivery_id?: string;
  quantity: number;
  change_type: 'IN' | 'OUT' | 'ADJUST' | 'Customer Return' | 'Return to Supplier';
  log_date: Date | string;
  remarks?: string;
}

export interface Batches {
  batch_id: string;
  product_id: string;
  delivery_item_id?: string;
  quantity_received: number;
  quantity_remaining: number;
  batch_expiration: Date | string;
  risk_score: 'Normal' | 'Warning' | 'Near-Expiry';
  created_at: Date | string;
}
