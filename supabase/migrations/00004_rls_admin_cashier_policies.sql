-- 0. Drop old policies from the initial schema to avoid conflicts
DROP POLICY IF EXISTS "admin_all" ON users;
DROP POLICY IF EXISTS "admin_all" ON products;
DROP POLICY IF EXISTS "admin_all" ON inventory;
DROP POLICY IF EXISTS "admin_all" ON sales;
DROP POLICY IF EXISTS "admin_all" ON sale_items;
DROP POLICY IF EXISTS "admin_all" ON stock_log;
DROP POLICY IF EXISTS "admin_all" ON batches;
DROP POLICY IF EXISTS "admin_all" ON suppliers;
DROP POLICY IF EXISTS "admin_all" ON purchase_orders;

DROP POLICY IF EXISTS "cashier_read_products" ON products;
DROP POLICY IF EXISTS "cashier_read_inventory" ON inventory;
DROP POLICY IF EXISTS "cashier_read_batches" ON batches;
DROP POLICY IF EXISTS "cashier_insert_sales" ON sales;
DROP POLICY IF EXISTS "cashier_insert_sale_items" ON sale_items;
DROP POLICY IF EXISTS "cashier_insert_stock_log" ON stock_log;
DROP POLICY IF EXISTS "cashier_select_sales" ON sales;
DROP POLICY IF EXISTS "cashier_select_sale_items" ON sale_items;
DROP POLICY IF EXISTS "cashier_select_stock_log" ON stock_log;

-- 1. Enable Row Level Security (RLS) on all relevant tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;

-- 2. Create a helper function to get the current user's role
CREATE OR REPLACE FUNCTION get_user_role() 
RETURNS text 
LANGUAGE sql 
STABLE SECURITY DEFINER 
AS $$
  SELECT role::text FROM public.users WHERE user_id = auth.uid();
$$;

-- 3. ADMIN POLICIES: Full CRUD Access across all tables
DROP POLICY IF EXISTS "Admin Full Access - users" ON users;
CREATE POLICY "Admin Full Access - users" ON users FOR ALL TO authenticated USING (get_user_role() = 'Admin');

DROP POLICY IF EXISTS "Admin Full Access - products" ON products;
CREATE POLICY "Admin Full Access - products" ON products FOR ALL TO authenticated USING (get_user_role() = 'Admin');

DROP POLICY IF EXISTS "Admin Full Access - inventory" ON inventory;
CREATE POLICY "Admin Full Access - inventory" ON inventory FOR ALL TO authenticated USING (get_user_role() = 'Admin');

DROP POLICY IF EXISTS "Admin Full Access - sales" ON sales;
CREATE POLICY "Admin Full Access - sales" ON sales FOR ALL TO authenticated USING (get_user_role() = 'Admin');

DROP POLICY IF EXISTS "Admin Full Access - sale_items" ON sale_items;
CREATE POLICY "Admin Full Access - sale_items" ON sale_items FOR ALL TO authenticated USING (get_user_role() = 'Admin');

DROP POLICY IF EXISTS "Admin Full Access - stock_log" ON stock_log;
CREATE POLICY "Admin Full Access - stock_log" ON stock_log FOR ALL TO authenticated USING (get_user_role() = 'Admin');

DROP POLICY IF EXISTS "Admin Full Access - batches" ON batches;
CREATE POLICY "Admin Full Access - batches" ON batches FOR ALL TO authenticated USING (get_user_role() = 'Admin');

DROP POLICY IF EXISTS "Admin Full Access - suppliers" ON suppliers;
CREATE POLICY "Admin Full Access - suppliers" ON suppliers FOR ALL TO authenticated USING (get_user_role() = 'Admin');

DROP POLICY IF EXISTS "Admin Full Access - purchase_orders" ON purchase_orders;
CREATE POLICY "Admin Full Access - purchase_orders" ON purchase_orders FOR ALL TO authenticated USING (get_user_role() = 'Admin');

-- 4. CASHIER POLICIES
-- SELECT access on Product, Inventory, and Batches
DROP POLICY IF EXISTS "Cashier Select - products" ON products;
CREATE POLICY "Cashier Select - products" ON products FOR SELECT TO authenticated USING (get_user_role() = 'Cashier');

DROP POLICY IF EXISTS "Cashier Select - inventory" ON inventory;
CREATE POLICY "Cashier Select - inventory" ON inventory FOR SELECT TO authenticated USING (get_user_role() = 'Cashier');

DROP POLICY IF EXISTS "Cashier Select - batches" ON batches;
CREATE POLICY "Cashier Select - batches" ON batches FOR SELECT TO authenticated USING (get_user_role() = 'Cashier');

-- INSERT access on Sales, Sale_Items, and Stock_log
DROP POLICY IF EXISTS "Cashier Insert - sales" ON sales;
CREATE POLICY "Cashier Insert - sales" ON sales FOR INSERT TO authenticated WITH CHECK (get_user_role() = 'Cashier');

DROP POLICY IF EXISTS "Cashier Insert - sale_items" ON sale_items;
CREATE POLICY "Cashier Insert - sale_items" ON sale_items FOR INSERT TO authenticated WITH CHECK (get_user_role() = 'Cashier');

DROP POLICY IF EXISTS "Cashier Insert - stock_log" ON stock_log;
CREATE POLICY "Cashier Insert - stock_log" ON stock_log FOR INSERT TO authenticated WITH CHECK (get_user_role() = 'Cashier');

-- Allow Cashiers SELECT access on the tables they INSERT into
DROP POLICY IF EXISTS "Cashier Select - sales" ON sales;
CREATE POLICY "Cashier Select - sales" ON sales FOR SELECT TO authenticated USING (get_user_role() = 'Cashier');

DROP POLICY IF EXISTS "Cashier Select - sale_items" ON sale_items;
CREATE POLICY "Cashier Select - sale_items" ON sale_items FOR SELECT TO authenticated USING (get_user_role() = 'Cashier');

DROP POLICY IF EXISTS "Cashier Select - stock_log" ON stock_log;
CREATE POLICY "Cashier Select - stock_log" ON stock_log FOR SELECT TO authenticated USING (get_user_role() = 'Cashier');
