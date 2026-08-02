import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';

@Injectable({
  providedIn: 'root'
})
export class ProcurementService {
  private supabase = inject(SupabaseService);

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

  async getAllProducts() {
    const { data, error } = await this.supabase.client
      .from('products')
      .select('*')
      .order('product_name');
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

  async autoGenerateRestockRequests() {
    // 1. Fetch products with their inventory levels
    const { data: prods } = await this.supabase.client
      .from('products')
      .select('*, inventory(*)');
      
    if (!prods || prods.length === 0) return [];

    // 2. Filter for items that are Low Stock or Out of Stock
    // Low Stock condition: current stock <= reorder_point OR status is Low Stock/Out of Stock
    const lowOrOutProds = prods.filter(p => {
      const inv = p.inventory?.[0];
      const stock = inv?.stock_quantity ?? 0;
      const rop = inv?.reorder_point ?? 20;
      return stock <= rop || stock <= 0 || p.status === 'Low Stock' || p.status === 'Out of Stock';
    });

    // Fallback: If no items are low stock, pick items with the lowest stock so user always gets recommendations
    const targetProds = lowOrOutProds.length > 0 
      ? lowOrOutProds 
      : prods.slice().sort((a, b) => (a.inventory?.[0]?.stock_quantity ?? 0) - (b.inventory?.[0]?.stock_quantity ?? 0)).slice(0, 5);

    // 3. Map into restock items with calculated SOQ: (target stock 30 days) - current stock
    return targetProds.map(p => {
      const stock = p.inventory?.[0]?.stock_quantity ?? 0;
      const rop = p.inventory?.[0]?.reorder_point ?? 20;
      const targetStock = Math.max(30, rop * 2);
      const calculatedSOQ = Math.max(10, targetStock - stock);

      return {
        product_id: p.product_id,
        products: p,
        suggested_quantity: calculatedSOQ,
        request_id: p.product_id
      };
    });
  }

  async createRestockRequest(productId: string, suggestedQuantity: number) {
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
      .select('*, purchase_orders(*, suppliers(*)), delivery_items(*, products(*))')
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
        received_by: null
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
            : 'Stock Received via Supplier Delivery'
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
          received_by: null
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
        remarks: 'Stock Received via Barcode Scanner'
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
