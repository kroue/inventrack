-- =============================================================================
-- 00013 — POS checkout depletes across batches (true FEFO)
--
-- Until now process_pos_sale took a single batch_id per cart line and rejected
-- the sale if that one batch could not cover the quantity:
--
--     IF v_db_batch.quantity_remaining < v_qty THEN RAISE EXCEPTION 'Insufficient stock';
--
-- The storefront meanwhile showed, and validated against, the inventory total
-- across every batch. A product with 60 units split 20/40 therefore displayed
-- "60 in stock", allowed 47 into the cart, and failed at checkout — the sale
-- never rolled over into the next batch.
--
-- This rewrite walks the batches in expiry order per line, exactly as
-- import_offline_sales and record_stock_adjustment already do, so a single line
-- can consume several batches.
--
-- Pricing stays per batch: each segment is marked down according to the shelf
-- life of the batch those particular units came from, which is the honest FEFO
-- answer when a line straddles a near-expiry batch and a fresh one. One
-- sale_items row is written per batch segment, so the receipt and the audit
-- trail both show which units came from where.
--
-- `batch_id` is no longer read from the payload. It is tolerated if present so
-- an older client cannot break, but the server chooses the batches.
-- =============================================================================

CREATE OR REPLACE FUNCTION process_pos_sale(
    p_payment_method payment_method,
    p_items JSONB
) RETURNS UUID AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_sale_id UUID;
    v_item JSONB;
    v_db_product RECORD;
    v_batch RECORD;
    v_qty INT;
    v_remaining INT;
    v_take INT;
    v_available INT;
    v_days_remaining INT;
    v_unit_price DECIMAL(10, 2);
    v_discount_applied DECIMAL(10, 2);
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

        IF v_qty IS NULL OR v_qty <= 0 THEN
            RAISE EXCEPTION 'Quantity must be a positive whole number.';
        END IF;

        SELECT * INTO v_db_product
        FROM products
        WHERE product_id = (v_item->>'product_id')::UUID;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Product % does not exist.', v_item->>'product_id';
        END IF;

        v_unit_price := v_db_product.price;

        -- Check against everything on the shelf, not just the front batch.
        SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_available
        FROM batches
        WHERE product_id = v_db_product.product_id AND quantity_remaining > 0;

        IF v_available < v_qty THEN
            RAISE EXCEPTION 'Insufficient stock for %: % unit(s) available across all batches, % requested.',
                v_db_product.product_name, v_available, v_qty;
        END IF;

        -- Deplete First Expired, First Out, locking each batch as it is taken.
        v_remaining := v_qty;

        FOR v_batch IN
            SELECT * FROM batches
            WHERE product_id = v_db_product.product_id AND quantity_remaining > 0
            ORDER BY batch_expiration ASC
            FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;

            v_take := LEAST(v_batch.quantity_remaining, v_remaining);

            -- Markdown is decided by the shelf life of THIS batch.
            v_days_remaining := EXTRACT(DAY FROM (v_batch.batch_expiration - CURRENT_TIMESTAMP));

            IF v_days_remaining <= 14 THEN
                v_discount_applied := v_unit_price * v_db_product.discount_rate;
            ELSE
                v_discount_applied := 0.00;
            END IF;

            UPDATE batches
            SET quantity_remaining = quantity_remaining - v_take
            WHERE batch_id = v_batch.batch_id;

            INSERT INTO sale_items (sale_id, product_id, batch_id, quantity, unit_price, discount_applied)
            VALUES (v_sale_id, v_db_product.product_id, v_batch.batch_id, v_take, v_unit_price, v_discount_applied);

            INSERT INTO stock_log (product_id, batch_id, user_id, sale_id, quantity, change_type)
            VALUES (v_db_product.product_id, v_batch.batch_id, v_user_id, v_sale_id, v_take, 'OUT');

            v_total_amount := v_total_amount + ((v_unit_price - v_discount_applied) * v_take);
            v_remaining := v_remaining - v_take;
        END LOOP;

        UPDATE inventory
        SET stock_quantity = stock_quantity - v_qty
        WHERE product_id = v_db_product.product_id;

        -- One history row per product line, carrying the full quantity, so the
        -- EMA daily series is not fragmented by how the batches happened to split.
        INSERT INTO sales_history (sales_id, product_id, quantity_sold)
        VALUES (v_sale_id, v_db_product.product_id, v_qty);
    END LOOP;

    UPDATE sales SET total_amount = v_total_amount WHERE sale_id = v_sale_id;
    RETURN v_sale_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
