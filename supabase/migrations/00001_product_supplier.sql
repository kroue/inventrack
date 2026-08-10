-- 00001_product_supplier.sql

-- Make email optional for suppliers
ALTER TABLE suppliers ALTER COLUMN email DROP NOT NULL;

-- Add supplier reference to products
ALTER TABLE products ADD COLUMN supplier_id UUID REFERENCES suppliers(supplier_id) ON DELETE SET NULL;
