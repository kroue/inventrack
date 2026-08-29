import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';
import { InventoryLogicService } from './inventory-logic.service';

@Injectable({
  providedIn: 'root'
})
export class ProcurementService {
  private supabase = inject(SupabaseService);
  private authService = inject(AuthService);
  private inventoryLogic = inject(InventoryLogicService);

  async getSuppliers() {
    const { data, error } = await this.supabase.client
      .from('suppliers')
      .select('*')
      .order('supplier_name');
    if (error) throw error;
    return data || [];
  }

  async createSupplier(supplierName: string) {
    const { data, error } = await this.supabase.client
      .from('suppliers')
      .insert({
        supplier_name: supplierName,
        contact_person: '',
        phone: '',
        email: '',
        address: ''
      })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async getAllProducts(supplierId?: string) {
    let query = this.supabase.client
      .from('products')
      .select('*')
      .order('product_name');
      
    if (supplierId) {
      query = query.eq('supplier_id', supplierId);
    }
    
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async getPendingRestockRequests() {
    const { data, error } = await this.supabase.client
      .from('restock_requests')
      .select('*, products(*, inventory(*))')
      .eq('status', 'Pending');
    if (error) throw error;

    // If empty, auto-generate initial requests so the UI is immediately functional
    if (!data || data.length === 0) {
      await this.autoGenerateRestockRequests();
      const res = await this.supabase.client
        .from('restock_requests')
        .select('*, products(*, inventory(*))')
        .eq('status', 'Pending');
      return res.data || [];
    }

    return data || [];
  }

  /**
   * The Restock List — an automated report compiling every product that has hit its
   * reorder point, with the Suggested Order Quantity from the forecasting engine.
   *
   * Products are selected strictly by the alert condition A_i = 1 if Q_i <= ROP_i,
   * and the quantity is O_i = (V_i * P) - Q_i where V_i is the EMA-smoothed daily
   * velocity. Products that are not below their reorder point are not recommended.
   */
  async autoGenerateRestockRequests(supplierId?: string) {
    // 1. Fetch products with their inventory levels
    let query = this.supabase.client
      .from('products')
      .select('*, inventory(*)');

    if (supplierId) {
      query = query.eq('supplier_id', supplierId);
    }

    const { data: prods, error } = await query;

    if (error || !prods || prods.length === 0) return [];

    // 2. Run the forecasting engine per product and keep only those at or below ROP.
    const generated: any[] = [];

    for (const p of prods) {
      const inv = p.inventory?.[0];
      const stock = inv?.stock_quantity ?? 0;
      const leadTime = inv?.lead_time ?? 1;
      const safetyStock = inv?.safety_stock ?? 0;

      // V_i,t — EMA daily sales velocity over the trailing 30 days
      const dailyVelocity = await this.inventoryLogic.getSalesVelocity(
        p.product_id,
        this.inventoryLogic.EMA_WINDOW_DAYS
      );

      // ROP_i = (V_i * L_i) + ss_i   and   A_i = 1 if Q_i <= ROP_i
      const { rop, isLowStockAlert } = this.inventoryLogic.calculateROPAndTrigger(
        dailyVelocity,
        leadTime,
        safetyStock,
        stock
      );

      if (!isLowStockAlert) continue;

      // O_i = (V_i * P) - Q_i
      const suggestedQuantity = this.inventoryLogic.calculateSuggestedOrderQuantity(
        dailyVelocity,
        this.inventoryLogic.PROJECTION_PERIOD_DAYS,
        stock
      );

      if (suggestedQuantity <= 0) continue;

      // 3. Persist the request so the restock list survives a page reload and the
      //    dashboard's pending count reflects reality.
      const { data: existing } = await this.supabase.client
        .from('restock_requests')
        .select('request_id')
        .eq('product_id', p.product_id)
        .eq('status', 'Pending')
        .maybeSingle();

      let requestId: string;

      if (existing) {
        requestId = existing.request_id;
        await this.supabase.client
          .from('restock_requests')
          .update({ suggested_quantity: suggestedQuantity })
          .eq('request_id', requestId);
      } else {
        const { data: inserted, error: insertError } = await this.supabase.client
          .from('restock_requests')
          .insert({
            product_id: p.product_id,
            suggested_quantity: suggestedQuantity,
            status: 'Pending'
          })
          .select('request_id')
          .single();
        if (insertError) throw insertError;
        requestId = inserted.request_id;
      }

      generated.push({
        request_id: requestId,
        product_id: p.product_id,
        products: p,
        suggested_quantity: suggestedQuantity,
        daily_velocity: Number(dailyVelocity.toFixed(2)),
        reorder_point: rop
      });
    }

    return generated;
  }

  async createRestockRequest(productId: string, suggestedQuantity: number) {
    // Only one Pending request per product is allowed (migration 00009), so adding a
    // product that is already queued updates the existing request instead of failing.
    const { data: existing } = await this.supabase.client
      .from('restock_requests')
      .select('request_id')
      .eq('product_id', productId)
      .eq('status', 'Pending')
      .maybeSingle();

    if (existing) {
      const { data, error } = await this.supabase.client
        .from('restock_requests')
        .update({ suggested_quantity: suggestedQuantity })
        .eq('request_id', existing.request_id)
        .select('*, products(*, inventory(*))')
        .single();
      if (error) throw error;
      return data;
    }

    const { data, error } = await this.supabase.client
      .from('restock_requests')
      .insert({
        product_id: productId,
        suggested_quantity: suggestedQuantity,
        status: 'Pending'
      })
      .select('*, products(*, inventory(*))')
      .single();
    if (error) throw error;
    return data;
  }

  async deleteRestockRequest(requestId: string) {
    const { error } = await this.supabase.client
      .from('restock_requests')
      .delete()
      .eq('request_id', requestId);
    if (error) throw error;
  }

  async getPendingPurchaseOrders() {
    const { data, error } = await this.supabase.client
      .from('purchase_orders')
      .select('*, suppliers(*), purchase_items(*, products(*)), deliveries(delivery_items(*))')
      .in('status', ['Draft', 'Approved']);
    if (error) throw error;
    return data || [];
  }

  async getDeliveries() {
    const { data, error } = await this.supabase.client
      .from('deliveries')
      .select('*, purchase_orders(*, suppliers(*)), delivery_items(*, products(*)), users(full_name)')
      .order('delivery_date', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async generatePurchaseOrder(supplierId: string, requests: any[], fulfillmentType: 'Delivery' | 'Pick-up' = 'Delivery') {
    if (!requests.length) return;

    // 1. Create Purchase Order
    const { data: po, error: poError } = await this.supabase.client
      .from('purchase_orders')
      .insert({
        supplier_id: supplierId,
        fulfillment_type: fulfillmentType,
        status: 'Approved'
      })
      .select()
      .single();
    if (poError) throw poError;

    // 2. Create Purchase Items
    const itemsToInsert = requests.map(req => ({
      purchase_order_id: po.purchase_order_id,
      product_id: req.product_id,
      quantity_ordered: req.soq || req.suggested_quantity || 10,
      unit_cost: req.products?.cost_price && Number(req.products.cost_price) > 0 
        ? Number(req.products.cost_price) 
        : ((req.products?.price || 100) * 0.7)
    }));
    
    const { error: itemsError } = await this.supabase.client
      .from('purchase_items')
      .insert(itemsToInsert);
    if (itemsError) throw itemsError;

    // 3. Update Restock Requests status
    const requestIds = requests.map(r => r.request_id).filter(Boolean);
    if (requestIds.length > 0) {
      const { error: updateError } = await this.supabase.client
        .from('restock_requests')
        .update({ status: 'Approved' })
        .in('request_id', requestIds);
      if (updateError) throw updateError;
    }
  }

  async receivePurchaseOrder(poId: string, itemQuantitiesReceived?: { product_id: string, quantity_received: number }[]) {
    // Fetch the PO and items first
    const { data: poData, error: fetchPoError } = await this.supabase.client
      .from('purchase_orders')
      .select('*, purchase_items(*)')
      .eq('purchase_order_id', poId)
      .single();
    if (fetchPoError) throw fetchPoError;

    // 1. Update PO Status
    await this.supabase.client
      .from('purchase_orders')
      .update({ status: 'Received' })
      .eq('purchase_order_id', poId);

    // 1.1 Update associated restock_requests to 'Completed'
    const productIds = (poData.purchase_items || []).map((i: any) => i.product_id);
    if (productIds.length > 0) {
      await this.supabase.client
        .from('restock_requests')
        .update({ status: 'Completed' })
        .in('product_id', productIds)
        .neq('status', 'Completed');
    }

    // 2. Create Delivery
    const { data: delivery, error: deliveryError } = await this.supabase.client
      .from('deliveries')
      .insert({
        purchase_order_id: poId,
        status: 'Received',
        received_by: this.authService.currentUser()?.id || null
      })
      .select()
      .single();
    if (deliveryError) throw deliveryError;

    const customQtyMap = new Map<string, number>();
    if (itemQuantitiesReceived) {
      itemQuantitiesReceived.forEach(iq => customQtyMap.set(iq.product_id, iq.quantity_received));
    }

    // 3. Loop through items to update inventory, create delivery items, batches, and logs
    for (const item of poData.purchase_items) {
      const qtyReceived = customQtyMap.has(item.product_id) 
        ? customQtyMap.get(item.product_id)! 
        : item.quantity_ordered;

      // Delivery Item
      const { data: deliveryItem, error: delItemErr } = await this.supabase.client
        .from('delivery_items')
        .insert({
          delivery_id: delivery.delivery_id,
          product_id: item.product_id,
          quantity_ordered: item.quantity_ordered,
          quantity_received: qtyReceived
        })
        .select()
        .single();
      if (delItemErr) throw delItemErr;

      // Batch (365 days expiry default)
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 365);
      const { data: batch, error: batchErr } = await this.supabase.client
        .from('batches')
        .insert({
          product_id: item.product_id,
          delivery_item_id: deliveryItem.delivery_item_id,
          quantity_received: qtyReceived,
          quantity_remaining: qtyReceived,
          batch_expiration: expiryDate.toISOString(),
          risk_score: 'Normal'
        })
        .select()
        .single();
      if (batchErr) throw batchErr;

      // Stock Log
      await this.supabase.client
        .from('stock_log')
        .insert({
          product_id: item.product_id,
          batch_id: batch.batch_id,
          delivery_id: delivery.delivery_id,
          quantity: qtyReceived,
          change_type: 'IN',
          remarks: poData.fulfillment_type === 'Pick-up' 
            ? 'Stock Received via Supplier Pick-up' 
            : 'Stock Received via Supplier Delivery',
          user_id: this.authService.currentUser()?.id || null
        });

      // Update Inventory
      const { data: invData } = await this.supabase.client
        .from('inventory')
        .select('stock_quantity')
        .eq('product_id', item.product_id)
        .single();
      
      if (invData) {
        await this.supabase.client
          .from('inventory')
          .update({ stock_quantity: invData.stock_quantity + qtyReceived })
          .eq('product_id', item.product_id);
      } else {
        await this.supabase.client
          .from('inventory')
          .insert({
            product_id: item.product_id,
            stock_quantity: qtyReceived,
            safety_stock: 10,
            lead_time: 1,
            reorder_point: 20
          });
      }
    }
  }

  async processBarcodeDelivery(productId: string, quantityReceived: number, batchExpiration: Date | string) {
    // 1. Check for a pending Purchase Order item for this product
    const { data: pendingPOItems, error: fetchErr } = await this.supabase.client
      .from('purchase_items')
      .select('*, purchase_orders!inner(*)')
      .eq('product_id', productId)
      .eq('purchase_orders.status', 'Approved');

    if (fetchErr) throw fetchErr;

    if (!pendingPOItems || pendingPOItems.length === 0) {
      throw new Error('No pending purchase order / delivery found for this product. Cannot receive.');
    }

    // Use the first pending PO item found
    const poItem = pendingPOItems[0];
    const po = (poItem as any).purchase_orders;

    // 2. Check if a delivery already exists for this PO
    let { data: delivery } = await this.supabase.client
      .from('deliveries')
      .select('*')
      .eq('purchase_order_id', po.purchase_order_id)
      .single();

    if (!delivery) {
      // Create the delivery
      const { data: newDelivery, error: deliveryErr } = await this.supabase.client
        .from('deliveries')
        .insert({
          purchase_order_id: po.purchase_order_id,
          status: 'Received',
          received_by: this.authService.currentUser()?.id || null
        })
        .select()
        .single();
      if (deliveryErr) throw deliveryErr;
      delivery = newDelivery;
    }

    // 3. Check if a delivery_item exists for this product in this delivery
    let { data: deliveryItem } = await this.supabase.client
      .from('delivery_items')
      .select('*')
      .eq('delivery_id', delivery.delivery_id)
      .eq('product_id', productId)
      .single();

    if (!deliveryItem) {
      // Create it
      const { data: newDeliveryItem, error: delItemErr } = await this.supabase.client
        .from('delivery_items')
        .insert({
          delivery_id: delivery.delivery_id,
          product_id: productId,
          quantity_ordered: poItem.quantity_ordered,
          quantity_received: 0
        })
        .select()
        .single();
      if (delItemErr) throw delItemErr;
      deliveryItem = newDeliveryItem;
    }

    // 4. Create Batch
    const { data: batch, error: batchErr } = await this.supabase.client
      .from('batches')
      .insert({
        product_id: productId,
        delivery_item_id: deliveryItem.delivery_item_id,
        quantity_received: quantityReceived,
        quantity_remaining: quantityReceived,
        batch_expiration: new Date(batchExpiration).toISOString(),
        risk_score: 'Normal'
      })
      .select()
      .single();
    if (batchErr) throw batchErr;

    // 5. Insert Stock Log
    await this.supabase.client
      .from('stock_log')
      .insert({
        product_id: productId,
        batch_id: batch.batch_id,
        delivery_id: delivery.delivery_id,
        quantity: quantityReceived,
        change_type: 'IN',
        remarks: 'Stock Received via Barcode Scanner',
        user_id: this.authService.currentUser()?.id || null
      });

    // 6. Increment Inventory Stock Quantity
    const { data: invData, error: invErr } = await this.supabase.client
      .from('inventory')
      .select('stock_quantity')
      .eq('product_id', productId)
      .maybeSingle();
      
    if (invErr) throw invErr;
      
    const qtyToAdd = Number(quantityReceived);

    if (invData) {
      const { error: updateErr } = await this.supabase.client
        .from('inventory')
        .update({ stock_quantity: Number(invData.stock_quantity || 0) + qtyToAdd })
        .eq('product_id', productId);
      if (updateErr) throw updateErr;
    } else {
      const { error: insertErr } = await this.supabase.client
        .from('inventory')
        .insert({
          product_id: productId,
          stock_quantity: qtyToAdd,
          safety_stock: 10,
          lead_time: 1,
          reorder_point: 20
        });
      if (insertErr) throw insertErr;
    }

    // 7. Update Delivery Item Quantity
    const newQtyReceived = (deliveryItem.quantity_received || 0) + quantityReceived;
    await this.supabase.client
      .from('delivery_items')
      .update({ quantity_received: newQtyReceived })
      .eq('delivery_item_id', deliveryItem.delivery_item_id);

    // 8. Mark Restock Request as Completed for this specific product
    await this.supabase.client
      .from('restock_requests')
      .update({ status: 'Completed' })
      .eq('product_id', productId)
      .neq('status', 'Completed');

    // 9. Check if the entire PO is fully received
    const { data: allPoItems } = await this.supabase.client
      .from('purchase_items')
      .select('product_id, quantity_ordered')
      .eq('purchase_order_id', po.purchase_order_id);

    const { data: allDelItems } = await this.supabase.client
      .from('delivery_items')
      .select('product_id, quantity_received')
      .eq('delivery_id', delivery.delivery_id);

    let isFullyReceived = true;
    if (allPoItems && allDelItems) {
      for (const pItem of allPoItems) {
        const hasBeenScanned = allDelItems.some(d => d.product_id === pItem.product_id);
        if (!hasBeenScanned) {
          isFullyReceived = false;
          break;
        }
      }
    } else {
      isFullyReceived = false;
    }

    if (isFullyReceived) {
      await this.supabase.client
        .from('purchase_orders')
        .update({ status: 'Received' })
        .eq('purchase_order_id', po.purchase_order_id);
    }
  }
}
