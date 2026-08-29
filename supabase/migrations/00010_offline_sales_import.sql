-- =============================================================================
-- 00010 — Offline sales import
--
-- Use Case Table 31: the cashier records sales on the prepared Excel form during
-- a power or internet interruption, then uploads the file once the system is
-- available again. Its post-condition is that those transactions are recorded in
-- the database — this RPC is what makes that true.
--
-- Mirrors process_pos_sale: server-authoritative product lookup, FEFO batch
-- depletion under row locks, and full stock_log / sales_history trails. The one
-- deliberate difference is pricing — an offline row is a historical record of
-- what the customer was actually charged, so the sheet's price is honoured and
-- any shortfall against the current retail price is stored as the discount.
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

    -- Determine the sale timestamp up front so the parent record carries the
    -- earliest date the sheet covers rather than the moment of upload.
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

        -- Resolve the product: barcode is authoritative, name is the fallback.
        -- FOUND is checked explicitly rather than testing the RECORD for NULL,
        -- which would only be true when every column happens to be null.
        v_found := FALSE;

        IF v_barcode IS NOT NULL THEN
            SELECT * INTO v_product FROM products WHERE barcode = v_barcode LIMIT 1;
            v_found := FOUND;
        END IF;

        IF NOT v_found AND v_name IS NOT NULL THEN
            SELECT * INTO v_product FROM products WHERE LOWER(product_name) = LOWER(v_name) LIMIT 1;
            v_found := FOUND;
        END IF;

        IF NOT v_found THEN
            RAISE EXCEPTION 'Row %: no product matches barcode "%" or name "%".',
                v_row_index, COALESCE(v_barcode, '-'), COALESCE(v_name, '-');
        END IF;

        -- Price actually charged offline; fall back to current retail if blank.
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

        -- Refuse the import rather than silently driving stock negative.
        SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_available
        FROM batches
        WHERE product_id = v_product.product_id AND quantity_remaining > 0;

        IF v_available < v_qty THEN
            RAISE EXCEPTION 'Row %: only % unit(s) of % remain on hand but the sheet records % sold. Reconcile stock before importing.',
                v_row_index, v_available, v_product.product_name, v_qty;
        END IF;

        -- Deplete batches First Expired, First Out, locking each row.
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

        -- One sales_history row per sheet line, carrying that line's own date so
        -- the EMA velocity reflects when the sale actually happened.
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
