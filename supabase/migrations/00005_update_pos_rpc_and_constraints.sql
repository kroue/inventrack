CREATE OR REPLACE FUNCTION process_pos_sale(
    p_payment_method payment_method,
    p_items JSONB
) RETURNS UUID AS $$
DECLARE
    v_user_id UUID := auth.uid(); 
    v_sale_id UUID;
    v_item JSONB;
    v_db_product RECORD;
    v_db_batch RECORD;
    v_qty INT;
    v_days_remaining INT;
    v_unit_price DECIMAL(10, 2);
    v_discount_applied DECIMAL(10, 2);
    v_calculated_subtotal DECIMAL(12, 2);
    v_total_amount DECIMAL(12, 2) := 0.00;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: No active user session found.';
    END IF;

    INSERT INTO sales (user_id, total_amount, payment_method, record_type)
    VALUES (v_user_id, 0.00, p_payment_method, 'POS')
    RETURNING sale_id INTO v_sale_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
    LOOP
        v_qty := (v_item->>'quantity')::INT;

        SELECT * INTO v_db_batch 
        FROM batches 
        WHERE batch_id = (v_item->>'batch_id')::UUID 
        FOR UPDATE;

        IF NOT FOUND THEN RAISE EXCEPTION 'Batch % does not exist.', v_item->>'batch_id'; END IF;
        IF v_db_batch.quantity_remaining < v_qty THEN RAISE EXCEPTION 'Insufficient stock'; END IF;

        SELECT * INTO v_db_product 
        FROM products 
        WHERE product_id = (v_item->>'product_id')::UUID;

        IF NOT FOUND THEN RAISE EXCEPTION 'Product % does not exist.', v_item->>'product_id'; END IF;

        v_unit_price := v_db_product.price;
        v_days_remaining := EXTRACT(DAY FROM (v_db_batch.batch_expiration - CURRENT_TIMESTAMP));

        IF v_days_remaining <= 14 THEN
            v_discount_applied := v_unit_price * v_db_product.discount_rate;
        ELSE
            v_discount_applied := 0.00;
        END IF;

        v_calculated_subtotal := (v_unit_price - v_discount_applied) * v_qty;
        v_total_amount := v_total_amount + v_calculated_subtotal;

        UPDATE batches SET quantity_remaining = quantity_remaining - v_qty WHERE batch_id = v_db_batch.batch_id;

        INSERT INTO sale_items (sale_id, product_id, batch_id, quantity, unit_price, discount_applied)
        VALUES (v_sale_id, v_db_product.product_id, v_db_batch.batch_id, v_qty, v_unit_price, v_discount_applied);

        INSERT INTO stock_log (product_id, batch_id, user_id, sale_id, quantity, change_type)
        VALUES (v_db_product.product_id, v_db_batch.batch_id, v_user_id, v_sale_id, v_qty, 'OUT');
    END LOOP;

    UPDATE sales SET total_amount = v_total_amount WHERE sale_id = v_sale_id;
    RETURN v_sale_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER TABLE batches DROP CONSTRAINT IF EXISTS chk_quantity_remaining_nonnegative;
ALTER TABLE batches ADD CONSTRAINT chk_quantity_remaining_nonnegative CHECK (quantity_remaining >= 0);

ALTER TABLE sale_items DROP CONSTRAINT IF EXISTS chk_discount_not_greater_than_price;
ALTER TABLE sale_items ADD CONSTRAINT chk_discount_not_greater_than_price CHECK (discount_applied >= 0 AND discount_applied <= unit_price);
