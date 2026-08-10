# InvenTrack App - Security Context (Updated)

This document contains the latest context for the secured POS Checkout flow in the InvenTrack system.

## 1. Tech Stack
* **Frontend:** Angular 22
* **Backend:** Supabase (PostgreSQL)

## 2. Security Enhancements Implemented
The POS Checkout flow has been refactored to be **server-authoritative**:
1. **User Trust:** The frontend no longer sends `p_user_id`. The RPC securely infers the active user via `auth.uid()`.
2. **Atomic Inventory Deduction:** The RPC locks batch rows via `FOR UPDATE` to prevent race conditions during concurrent checkouts, verifying `quantity_remaining >= 0`.
3. **Server-Side Price Calculation:** The frontend no longer sends `unit_price`, `discount_applied`, or `total_amount`. The backend reads the unit price directly from the `products` table and recalculates the 14-day FEFO discount logic securely.
4. **RLS & Constraints:** Row Level Security strict policies are applied (Admin vs Cashier) and table constraints ensure data integrity (no negative stock, no invalid discounts).

## 3. Database Schema Updates
Relevant constraints added during the security update:
```sql
ALTER TABLE batches ADD CONSTRAINT chk_quantity_remaining_nonnegative CHECK (quantity_remaining >= 0);
ALTER TABLE sale_items ADD CONSTRAINT chk_discount_not_greater_than_price CHECK (discount_applied >= 0 AND discount_applied <= unit_price);
```

## 4. New Secure RPC (`process_pos_sale`)
This is the current active RPC in the database:
```sql
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

        -- Lock the batch row to prevent race conditions
        SELECT * INTO v_db_batch FROM batches WHERE batch_id = (v_item->>'batch_id')::UUID FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Batch % does not exist.', v_item->>'batch_id'; END IF;
        IF v_db_batch.quantity_remaining < v_qty THEN RAISE EXCEPTION 'Insufficient stock'; END IF;

        -- Fetch current authoritative product price
        SELECT * INTO v_db_product FROM products WHERE product_id = (v_item->>'product_id')::UUID;
        IF NOT FOUND THEN RAISE EXCEPTION 'Product % does not exist.', v_item->>'product_id'; END IF;

        v_unit_price := v_db_product.price;
        v_days_remaining := EXTRACT(DAY FROM (v_db_batch.batch_expiration - CURRENT_TIMESTAMP));

        -- Recalculate 14-day FEFO discount server-side
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

    -- Update the final total calculated by the server
    UPDATE sales SET total_amount = v_total_amount WHERE sale_id = v_sale_id;
    RETURN v_sale_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

## 5. Current Frontend Integration (Angular)
The frontend no longer passes sensitive parameters like user IDs, unit prices, or calculated totals to the backend. The payload only contains IDs and quantities.

```typescript
// in pos-checkout.component.ts
const itemsForRpc = this.cart.map(item => ({
  product_id: item.product.product_id,
  batch_id: item.batch.batch_id,
  quantity: item.quantity
}));

const saleId = await this.supabaseService.processPosSale(
  this.paymentMethod,
  itemsForRpc
);
```

```typescript
// in supabase.service.ts
async processPosSale(paymentMethod: 'Cash' | 'Gcash', items: any[]) {
  const { data, error } = await this.client.rpc('process_pos_sale', {
    p_payment_method: paymentMethod,
    p_items: items
  });
  if (error) throw error;
  return data;
}
```
