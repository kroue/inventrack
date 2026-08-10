-- ==========================================
-- INVENTRACK SEED DATA
-- ==========================================

-- 1. Insert Products
INSERT INTO products (product_id, product_name, category_name, barcode, description, price, discount_rate, status)
VALUES 
  ('11111111-1111-1111-1111-111111111111', 'Premium Jasmine Rice (5kg)', 'Grains', '123456789', 'High quality jasmine rice', 250.00, 0.20, 'Available'),
  ('22222222-2222-2222-2222-222222222222', 'Whole Milk (1L)', 'Dairy', '987654321', 'Fresh whole milk', 90.00, 0.50, 'Available'),
  ('33333333-3333-3333-3333-333333333333', 'Canned Tuna (Spicy)', 'Canned Goods', '456123789', 'Spicy tuna chunks', 45.50, 0.10, 'Available');

-- 2. Insert Inventory
INSERT INTO inventory (product_id, stock_quantity, safety_stock, lead_time, reorder_point)
VALUES
  ('11111111-1111-1111-1111-111111111111', 100, 20, 2, 30),
  ('22222222-2222-2222-2222-222222222222', 50, 10, 1, 15),
  ('33333333-3333-3333-3333-333333333333', 200, 30, 3, 50);

-- 3. Insert Suppliers
INSERT INTO suppliers (supplier_id, supplier_name, contact_person, phone, email, address)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Agri Rice Co', 'Juan Dela Cruz', '09171234567', 'juan@agri.com', 'Manila, PH'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Dairy Farms Inc', 'Maria Santos', '09181234567', 'maria@dairy.com', 'Laguna, PH'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Century Seafoods', 'Pedro Penduko', '09191234567', 'pedro@century.com', 'Cebu, PH');

-- 4. Insert Batches (with varying expirations to test FEFO and Markdown logic)
INSERT INTO batches (batch_id, product_id, quantity_received, quantity_remaining, batch_expiration, risk_score)
VALUES
  -- Rice: Normal, expires next year
  ('1b1b1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b', '11111111-1111-1111-1111-111111111111', 100, 100, NOW() + INTERVAL '365 days', 'Normal'),
  -- Milk: Near-Expiry, expires in 10 days
  ('2b2b2b2b-2b2b-2b2b-2b2b-2b2b2b2b2b2b', '22222222-2222-2222-2222-222222222222', 50, 50, NOW() + INTERVAL '10 days', 'Near-Expiry'),
  -- Tuna: Warning, expires in 25 days
  ('3b3b3b3b-3b3b-3b3b-3b3b-3b3b3b3b3b3b', '33333333-3333-3333-3333-333333333333', 200, 200, NOW() + INTERVAL '25 days', 'Warning');

-- 5. Insert Mock Sales History (for predictive analytics)
INSERT INTO sales_history (product_id, quantity_sold, date)
VALUES
  ('11111111-1111-1111-1111-111111111111', 5, NOW() - INTERVAL '1 day'),
  ('11111111-1111-1111-1111-111111111111', 3, NOW() - INTERVAL '2 days'),
  ('22222222-2222-2222-2222-222222222222', 10, NOW() - INTERVAL '1 day'),
  ('33333333-3333-3333-3333-333333333333', 2, NOW() - INTERVAL '3 days');
