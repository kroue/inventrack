-- =============================================================================
-- 00014 — Offline import resolves products by barcode only
--
-- import_offline_sales previously fell back to matching on product name when the
-- barcode column was blank. Name matching is exact, so a typo, a trailing space
-- or an abbreviation aborted the whole file — and worse, two similarly named
-- products could let a mistyped row resolve to the wrong item and deduct stock
-- from it. A barcode is scanned rather than typed, so it is the safer key.
--
-- Product Name is still accepted in the payload, but only to make the error
-- messages readable. It no longer decides which product is sold.
-- =============================================================================

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

        -- Barcode is the only key. No name fallback.
        IF v_barcode IS NULL THEN
            RAISE EXCEPTION 'Row %: barcode is required%.',
                v_row_index,
                COALESCE(' (sheet lists "' || v_name || '")', '');
        END IF;

        SELECT * INTO v_product FROM products WHERE barcode = v_barcode LIMIT 1;
        v_found := FOUND;

        IF NOT v_found THEN
            RAISE EXCEPTION 'Row %: no product has barcode "%"%.',
                v_row_index,
                v_barcode,
                COALESCE(' (sheet lists "' || v_name || '")', '');
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
        WHERE product_id = v_product.product_id AND quantity_remaining > 0;

        IF v_available < v_qty THEN
            RAISE EXCEPTION 'Row %: only % unit(s) of % remain on hand but the sheet records % sold. Reconcile stock before importing.',
                v_row_index, v_available, v_product.product_name, v_qty;
        END IF;

        v_remaining := v_qty;
        FOR v_batch IN
            SELECT * FROM batches
            WHERE product_id = v_product.product_id AND quantity_remaining > 0
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
        VALUES (
            v_sale_id,
            v_product.product_id,
            v_qty,
            COALESCE(NULLIF(v_row->>'sale_date', '')::TIMESTAMPTZ, NOW())
        );

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
