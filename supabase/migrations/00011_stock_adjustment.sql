-- =============================================================================
-- 00011 — Stock adjustment
--
-- Use Case Table 20: the Admin corrects stock quantities, choosing the category
-- (Adjust, Customer Return, or Return to Supplier) and supplying a reason, after
-- which the system updates stock and records the adjustment.
--
-- Doing this in one RPC keeps `inventory`, `batches` and `stock_log` consistent.
-- The previous client-side path moved inventory.stock_quantity without touching
-- batches, which let the POS batch pool drift away from the inventory total.
-- =============================================================================

CREATE OR REPLACE FUNCTION record_stock_adjustment(
    p_product_id  UUID,
    p_change_type change_type,
    p_quantity    INT,
    p_reason      TEXT
) RETURNS JSONB AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_product RECORD;
    v_batch RECORD;
    v_delta INT;
    v_magnitude INT;
    v_remaining INT;
    v_take INT;
    v_available INT;
    v_target_batch UUID;
    v_new_stock INT;
    v_reason TEXT;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: No active user session found.';
    END IF;

    IF p_change_type NOT IN ('ADJUST', 'Customer Return', 'Return to Supplier') THEN
        RAISE EXCEPTION 'Unsupported adjustment category: %.', p_change_type;
    END IF;

    v_reason := NULLIF(TRIM(COALESCE(p_reason, '')), '');
    IF v_reason IS NULL THEN
        RAISE EXCEPTION 'A reason is required for every stock adjustment.';
    END IF;

    SELECT * INTO v_product FROM products WHERE product_id = p_product_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Product % does not exist.', p_product_id;
    END IF;

    -- Normalise the movement into a signed delta.
    --   Customer Return       -> stock comes back in
    --   Return to Supplier    -> stock goes back out
    --   ADJUST                -> caller supplies the sign
    IF p_change_type = 'Customer Return' THEN
        IF p_quantity <= 0 THEN
            RAISE EXCEPTION 'A customer return must be a positive quantity.';
        END IF;
        v_delta := p_quantity;
    ELSIF p_change_type = 'Return to Supplier' THEN
        IF p_quantity <= 0 THEN
            RAISE EXCEPTION 'A return to supplier must be a positive quantity.';
        END IF;
        v_delta := -p_quantity;
    ELSE
        IF p_quantity = 0 THEN
            RAISE EXCEPTION 'An adjustment of zero changes nothing.';
        END IF;
        v_delta := p_quantity;
    END IF;

    v_magnitude := ABS(v_delta);

    IF v_delta < 0 THEN
        -- Outbound: deplete batches First Expired, First Out under row locks.
        SELECT COALESCE(SUM(quantity_remaining), 0) INTO v_available
        FROM batches
        WHERE product_id = p_product_id AND quantity_remaining > 0;

        IF v_available < v_magnitude THEN
            RAISE EXCEPTION 'Only % unit(s) of % remain across its batches; cannot remove %. If the inventory total disagrees with this figure, run SELECT reconcile_batch_inventory(); to realign them.',
                v_available, v_product.product_name, v_magnitude;
        END IF;

        v_remaining := v_magnitude;

        FOR v_batch IN
            SELECT * FROM batches
            WHERE product_id = p_product_id AND quantity_remaining > 0
            ORDER BY batch_expiration ASC
            FOR UPDATE
        LOOP
            EXIT WHEN v_remaining <= 0;

            v_take := LEAST(v_batch.quantity_remaining, v_remaining);

            UPDATE batches
            SET quantity_remaining = quantity_remaining - v_take
            WHERE batch_id = v_batch.batch_id;

            INSERT INTO stock_log (product_id, batch_id, user_id, quantity, change_type, remarks)
            VALUES (p_product_id, v_batch.batch_id, v_user_id, v_take, p_change_type, v_reason);

            v_remaining := v_remaining - v_take;
        END LOOP;
    ELSE
        -- Inbound: return the units to the batch that expires LAST among those
        -- still open. Adding them to the earliest-expiring batch would push
        -- returned goods to the front of the FEFO queue and risk selling stock
        -- that is closer to expiry than the units actually being returned.
        SELECT batch_id INTO v_target_batch
        FROM batches
        WHERE product_id = p_product_id AND quantity_remaining > 0
        ORDER BY batch_expiration DESC
        LIMIT 1
        FOR UPDATE;

        IF v_target_batch IS NULL THEN
            -- No open batch left (the product had sold out) — open a fresh one.
            INSERT INTO batches (product_id, quantity_received, quantity_remaining, batch_expiration, risk_score)
            VALUES (p_product_id, v_magnitude, v_magnitude, NOW() + INTERVAL '365 days', 'Normal')
            RETURNING batch_id INTO v_target_batch;
        ELSE
            UPDATE batches
            SET quantity_remaining = quantity_remaining + v_magnitude,
                quantity_received  = quantity_received + v_magnitude
            WHERE batch_id = v_target_batch;
        END IF;

        INSERT INTO stock_log (product_id, batch_id, user_id, quantity, change_type, remarks)
        VALUES (p_product_id, v_target_batch, v_user_id, v_magnitude, p_change_type, v_reason);
    END IF;

    -- Keep the inventory total in step. Guarded so an adjustment can never drive
    -- the on-hand quantity negative.
    UPDATE inventory
    SET stock_quantity = GREATEST(0, stock_quantity + v_delta)
    WHERE product_id = p_product_id
    RETURNING stock_quantity INTO v_new_stock;

    IF v_new_stock IS NULL THEN
        INSERT INTO inventory (product_id, stock_quantity, safety_stock, lead_time, reorder_point)
        VALUES (p_product_id, GREATEST(0, v_delta), 0, 1, 0)
        RETURNING stock_quantity INTO v_new_stock;
    END IF;

    RETURN jsonb_build_object(
        'product_id',    p_product_id,
        'change_type',   p_change_type,
        'quantity',      v_magnitude,
        'direction',     CASE WHEN v_delta > 0 THEN 'IN' ELSE 'OUT' END,
        'stock_quantity', v_new_stock
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION record_stock_adjustment(UUID, change_type, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_stock_adjustment(UUID, change_type, INT, TEXT) TO authenticated;
