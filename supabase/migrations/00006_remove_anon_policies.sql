-- Remove permissive anonymous policies leftover from the initial schema testing phase
-- These policies allowed unauthenticated users to read and insert data directly via the REST API.
DROP POLICY IF EXISTS "anon_read_products" ON products;
DROP POLICY IF EXISTS "anon_read_batches" ON batches;
DROP POLICY IF EXISTS "anon_insert_sales" ON sales;
DROP POLICY IF EXISTS "anon_insert_sale_items" ON sale_items;
DROP POLICY IF EXISTS "anon_insert_stock_log" ON stock_log;
DROP POLICY IF EXISTS "anon_insert_sales_history" ON sales_history;
