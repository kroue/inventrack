-- ==========================================
-- INVENTRACK PRICE HISTORY MIGRATION
-- ==========================================

CREATE TABLE IF NOT EXISTS product_price_history (
    history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
    changed_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
    old_store_price DECIMAL(10, 2),
    new_store_price DECIMAL(10, 2),
    old_supplier_price DECIMAL(10, 2),
    new_supplier_price DECIMAL(10, 2),
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE product_price_history ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated operations for simplicity (following existing patterns)
DROP POLICY IF EXISTS "Enable all operations for authenticated users" ON product_price_history;
CREATE POLICY "Enable all operations for authenticated users" 
ON product_price_history FOR ALL TO authenticated USING (true);
