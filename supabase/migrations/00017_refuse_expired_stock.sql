-- =============================================================================
-- 00017 — Expired stock is never sold
--
-- Found while testing the POS before handover: a batch that expired 23 days
-- earlier was still offered for sale, and because the Expiry Risk Formula only
-- defines >30, 15-30 and <=14 days, a negative day count fell through to the
-- markdown tier. The system was therefore discounting expired goods onto a
-- customer, which is the opposite of what the expiry monitoring exists to do.
--
-- Both sale paths now skip expired batches entirely. The stock stays on the
-- books until an admin writes it off through record_stock_adjustment, so the
-- loss stays visible rather than being quietly sold on.
--
-- record_stock_adjustment deliberately still reaches expired batches: writing
-- off expired stock is exactly how it leaves the system.
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
    v_expired INT;
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

        SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_available
        FROM batches
        WHERE product_id = v_db_product.product_id
          AND quantity_remaining > 0
          AND batch_expiration >= CURRENT_TIMESTAMP;

        IF v_available < v_qty THEN
            SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_expired
            FROM batches
            WHERE product_id = v_db_product.product_id
              AND quantity_remaining > 0
              AND batch_expiration < CURRENT_TIMESTAMP;

            IF v_expired > 0 THEN
                RAISE EXCEPTION 'Insufficient sellable stock for %: % unit(s) available, % requested. A further % unit(s) are past their expiry date and cannot be sold — write them off in Inventory.',
                    v_db_product.product_name, v_available, v_qty, v_expired;
            ELSE
                RAISE EXCEPTION 'Insufficient stock for %: % unit(s) available across all batches, % requested.',
                    v_db_product.product_name, v_available, v_qty;
            END IF;
        END IF;

        v_remaining := v_qty;

        FOR v_batch IN
            SELECT * FROM batches
            WHERE product_id = v_db_product.product_id
              AND quantity_remaining > 0
              AND batch_expiration >= CURRENT_TIMESTAMP
            ORDER BY batch_expiration ASC
            FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;

            v_take := LEAST(v_batch.quantity_remaining, v_remaining);

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

        INSERT INTO sales_history (sales_id, product_id, quantity_sold)
        VALUES (v_sale_id, v_db_product.product_id, v_qty);
    END LOOP;

    UPDATE sales SET total_amount = v_total_amount WHERE sale_id = v_sale_id;
    RETURN v_sale_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- The offline import records sales that already happened at the till, so it
-- applies the same rule: an expired batch could not legitimately have been sold.
CREATE OR REPLACE FUNCTION import_offline_sales(p_rows JSONB)
RETURNS JSONB AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_sale_id UUID;
    v_row JSONB;
    v_row_index INT := 0;
    v_product RECORD;
    v_batch RECORD;
    v_found BOOLEAN;
    v_barcode TEXT;
    v_name TEXT;
    v_qty INT;
    v_sheet_price DECIMAL(10, 2);
    v_unit_price DECIMAL(10, 2);
    v_discount DECIMAL(10, 2);
    v_remaining INT;
    v_take INT;
    v_available INT;
    v_sale_date TIMESTAMPTZ;
    v_earliest TIMESTAMPTZ := NULL;
    v_total DECIMAL(12, 2) := 0.00;
    v_rows_imported INT := 0;
    v_units_imported INT := 0;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: No active user session found.';
    END IF;

    IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
        RAISE EXCEPTION 'No offline sales rows supplied.';
    END IF;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
    LOOP
        IF v_row ? 'sale_date' AND NULLIF(v_row->>'sale_date', '') IS NOT NULL THEN
            v_sale_date := (v_row->>'sale_date')::TIMESTAMPTZ;
            IF v_earliest IS NULL OR v_sale_date < v_earliest THEN
                v_earliest := v_sale_date;
            END IF;
        END IF;
    END LOOP;

    INSERT INTO sales (user_id, total_amount, payment_method, record_type, sale_date)
    VALUES (v_user_id, 0.00, 'Cash', 'Excel Log', COALESCE(v_earliest, NOW()))
    RETURNING sale_id INTO v_sale_id;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
    LOOP
        v_row_index := v_row_index + 1;

        v_barcode := NULLIF(TRIM(COALESCE(v_row->>'barcode', '')), '');
        v_name    := NULLIF(TRIM(COALESCE(v_row->>'product_name', '')), '');
        v_qty     := (v_row->>'quantity')::INT;

        IF v_qty IS NULL OR v_qty <= 0 THEN
            RAISE EXCEPTION 'Row %: quantity must be a positive whole number.', v_row_index;
        END IF;

        IF v_barcode IS NULL THEN
            RAISE EXCEPTION 'Row %: barcode is required%.',
                v_row_index, COALESCE(' (sheet lists "' || v_name || '")', '');
        END IF;

        SELECT * INTO v_product FROM products WHERE barcode = v_barcode LIMIT 1;
        v_found := FOUND;

        IF NOT v_found THEN
            RAISE EXCEPTION 'Row %: no product has barcode "%"%.',
                v_row_index, v_barcode, COALESCE(' (sheet lists "' || v_name || '")', '');
        END IF;

        v_sheet_price := COALESCE(NULLIF(v_row->>'unit_price', '')::DECIMAL(10, 2), v_product.price);
        IF v_sheet_price < 0 THEN
            RAISE EXCEPTION 'Row %: unit price cannot be negative.', v_row_index;
        END IF;

        IF v_sheet_price < v_product.price THEN
            v_unit_price := v_product.price;
            v_discount   := v_product.price - v_sheet_price;
        ELSE
            v_unit_price := v_sheet_price;
            v_discount   := 0.00;
        END IF;

        SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_available
        FROM batches
        WHERE product_id = v_product.product_id
          AND quantity_remaining > 0
          AND batch_expiration >= CURRENT_TIMESTAMP;

        IF v_available < v_qty THEN
            RAISE EXCEPTION 'Row %: only % sellable unit(s) of % remain on hand but the sheet records % sold. Expired batches are excluded — reconcile stock before importing.',
                v_row_index, v_available, v_product.product_name, v_qty;
        END IF;

        v_remaining := v_qty;
        FOR v_batch IN
            SELECT * FROM batches
            WHERE product_id = v_product.product_id
              AND quantity_remaining > 0
              AND batch_expiration >= CURRENT_TIMESTAMP
            ORDER BY batch_expiration ASC
            FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;

            v_take := LEAST(v_batch.quantity_remaining, v_remaining);

            UPDATE batches
            SET quantity_remaining = quantity_remaining - v_take
            WHERE batch_id = v_batch.batch_id;

            INSERT INTO sale_items (sale_id, product_id, batch_id, quantity, unit_price, discount_applied)
            VALUES (v_sale_id, v_product.product_id, v_batch.batch_id, v_take, v_unit_price, v_discount);

            INSERT INTO stock_log (product_id, batch_id, user_id, sale_id, quantity, change_type, remarks)
            VALUES (v_product.product_id, v_batch.batch_id, v_user_id, v_sale_id, v_take, 'OUT',
                    'Offline sale imported from Excel log');

            v_total := v_total + ((v_unit_price - v_discount) * v_take);
            v_remaining := v_remaining - v_take;
        END LOOP;

        UPDATE inventory
        SET stock_quantity = stock_quantity - v_qty
        WHERE product_id = v_product.product_id;

        INSERT INTO sales_history (sales_id, product_id, quantity_sold, date)
        VALUES (v_sale_id, v_product.product_id, v_qty,
                COALESCE(NULLIF(v_row->>'sale_date', '')::TIMESTAMPTZ, NOW()));

        v_rows_imported := v_rows_imported + 1;
        v_units_imported := v_units_imported + v_qty;
    END LOOP;

    UPDATE sales SET total_amount = v_total WHERE sale_id = v_sale_id;

    RETURN jsonb_build_object(
        'sale_id', v_sale_id,
        'rows_imported', v_rows_imported,
        'units_imported', v_units_imported,
        'total_amount', v_total
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION import_offline_sales(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION import_offline_sales(JSONB) TO authenticated;
