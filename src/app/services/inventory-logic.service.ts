import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';

@Injectable({
  providedIn: 'root'
})
export class InventoryLogicService {
  private supabaseService = inject(SupabaseService);
  private authService = inject(AuthService);

  constructor() { }

  /**
   * 1. Exponential Moving Average (EMA) for Daily Sales Velocity
   * Formula: V_i,t = (S_i,t * alpha) + (V_i,t-1 * (1 - alpha))
   * Where n = 30 days window, smoothing factor alpha = 2 / (n + 1).
   */
  calculateEMA(currentDaySales: number, previousEMA: number, windowDays: number = 30): number {
    const alpha = 2 / (windowDays + 1);
    return (currentDaySales * alpha) + (previousEMA * (1 - alpha));
  }

  /**
   * 2. Reorder Point (ROP_i) Calculation & Constraint Trigger
   * Formula: ROP_i = (V_i * L_i) + ss_i
   * Returns an object containing the ROP and a boolean indicating if a Low Stock Alert is triggered.
   */
  calculateROPAndTrigger(salesVelocity: number, leadTimeDays: number, safetyStock: number, currentStockQuantity: number): { rop: number, isLowStockAlert: boolean } {
    const rop = Math.ceil((salesVelocity * leadTimeDays) + safetyStock);
    const isLowStockAlert = currentStockQuantity <= rop;
    return { rop, isLowStockAlert };
  }

  /**
   * 3. Suggested Order Quantity (O_i)
   * Formula: O_i = (V_i * P) - Q_i
   */
  calculateSuggestedOrderQuantity(salesVelocity: number, restockingProjectionPeriod: number, currentStockQuantity: number): number {
    const suggestedOrderQuantity = (salesVelocity * restockingProjectionPeriod) - currentStockQuantity;
    // Ensure we don't suggest a negative order quantity if stock is already sufficient
    return Math.max(0, Math.ceil(suggestedOrderQuantity));
  }

  /**
   * 4. Expiry Risk Framework & Dynamic Price Markdown Function
   */
  evaluateExpiryMarkdown(retailPrice: number, expirationDate: Date, currentDate: Date = new Date(), discountRate: number = 0.20): { sellingPrice: number, riskLevel: 'Low' | 'Medium' | 'High', discountApplied: number } {
    const msPerDay = 1000 * 60 * 60 * 24;
    const daysRemaining = Math.floor((expirationDate.getTime() - currentDate.getTime()) / msPerDay);
    
    if (daysRemaining > 30) {
      // Low Risk
      return { sellingPrice: retailPrice, riskLevel: 'Low', discountApplied: 0 };
    } else if (daysRemaining > 14 && daysRemaining <= 30) {
      // Medium Risk -> Triggers Warning Flag, no discount yet based on spec (Selling Price = Retail Price)
      return { sellingPrice: retailPrice, riskLevel: 'Medium', discountApplied: 0 };
    } else {
      // High Risk -> Apply Predefined Discount Rate
      const discountApplied = retailPrice * discountRate;
      const sellingPrice = retailPrice - discountApplied;
      return { sellingPrice, riskLevel: 'High', discountApplied };
    }
  }

  /**
   * 0. Fetch active products from Supabase
   */
  async getActiveProducts(): Promise<import('../models/itrack.models').Product[]> {
    const supabase = this.supabaseService.client;
    const { data, error } = await supabase
      .from('products')
      .select('*, inventory(*)')
      .neq('status', 'Out of Stock');
      
    if (error) this.supabaseService.handleError(error);
    return data as any[];
  }

  /**
   * Fetch a product by its barcode from Supabase
   */
  async getProductByBarcode(barcode: string): Promise<import('../models/itrack.models').Product | null> {
    const supabase = this.supabaseService.client;
    const { data, error } = await supabase
      .from('products')
      .select('*, inventory(*)')
      .eq('barcode', barcode)
      .maybeSingle();
      
    if (error) {
      this.supabaseService.handleError(error);
    }
    return data as import('../models/itrack.models').Product | null;
  }

  /**
   * Fetch all suppliers from Supabase
   */
  async getSuppliers(): Promise<import('../models/itrack.models').Suppliers[]> {
    const supabase = this.supabaseService.client;
    const { data, error } = await supabase
      .from('suppliers')
      .select('*')
      .order('supplier_name', { ascending: true });
      
    if (error) this.supabaseService.handleError(error);
    return data as import('../models/itrack.models').Suppliers[];
  }

  /**
   * Create a new supplier
   */
  async createSupplier(supplier: Partial<import('../models/itrack.models').Suppliers>): Promise<import('../models/itrack.models').Suppliers> {
    const supabase = this.supabaseService.client;
    const { data, error } = await supabase
      .from('suppliers')
      .insert(supplier)
      .select()
      .single();
      
    if (error) throw error;
    return data as import('../models/itrack.models').Suppliers;
  }

  /**
   * Create a new product and initialize its inventory row.
   */
  async createProduct(product: Partial<import('../models/itrack.models').Product>, initialStock: number = 0, safetyStock: number = 20, leadTime: number = 2): Promise<void> {
    const supabase = this.supabaseService.client;
    
    // Insert Product
    const { data: newProduct, error: productError } = await supabase
      .from('products')
      .insert(product)
      .select()
      .single();
      
    if (productError) throw productError;
    
    // Initialize Inventory Row
    if (newProduct) {
      const { error: invError } = await supabase
        .from('inventory')
        .insert({
          product_id: newProduct.product_id,
          stock_quantity: initialStock,
          safety_stock: safetyStock,
          lead_time: leadTime,
          reorder_point: safetyStock // initial basic calculation
        });
        
      if (invError) throw invError;

      if (initialStock > 0) {
        // Create initial batch
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 365);
        const { data: batch } = await supabase
          .from('batches')
          .insert({
            product_id: newProduct.product_id,
            quantity_received: initialStock,
            quantity_remaining: initialStock,
            batch_expiration: expiryDate.toISOString(),
            risk_score: 'Normal'
          })
          .select()
          .single();

        // Create stock log
        await supabase
          .from('stock_log')
          .insert({
            product_id: newProduct.product_id,
            batch_id: batch?.batch_id,
            quantity: initialStock,
            change_type: 'IN',
            remarks: 'Initial Product Stock Setup',
            user_id: this.authService.currentUser()?.id || null
          });
      }
    }
  }

  /**
   * Update an existing product's details.
   */
  async updateProduct(productId: string, updates: Partial<import('../models/itrack.models').Product>): Promise<void> {
    const supabase = this.supabaseService.client;
    
    // Fetch old product for price history
    const { data: oldProd } = await supabase.from('products').select('*').eq('product_id', productId).single();
    
    const { error } = await supabase
      .from('products')
      .update(updates)
      .eq('product_id', productId);
      
    if (error) throw error;

    // Log price history if changed
    if (oldProd && (updates.price !== undefined || updates.cost_price !== undefined)) {
      const oldPrice = Number(oldProd.price);
      const newPrice = updates.price !== undefined ? Number(updates.price) : oldPrice;
      const oldCost = Number(oldProd.cost_price);
      const newCost = updates.cost_price !== undefined ? Number(updates.cost_price) : oldCost;

      if (oldPrice !== newPrice || oldCost !== newCost) {
        await supabase.from('product_price_history').insert({
          product_id: productId,
          old_store_price: oldPrice,
          new_store_price: newPrice,
          old_supplier_price: oldCost,
          new_supplier_price: newCost,
          changed_by: this.authService.currentUser()?.id || null
        });
      }
    }
  }

  /**
   * Fetch price history for a specific product
   */
  async getProductPriceHistory(productId: string): Promise<any[]> {
    const { data, error } = await this.supabaseService.client
      .from('product_price_history')
      .select('*, users(full_name)')
      .eq('product_id', productId)
      .order('changed_at', { ascending: false });
      
    if (error) this.supabaseService.handleError(error);
    return data || [];
  }

  /**
   * Hard-delete a product from the database and clean up associated child records.
   */
  async deleteProduct(productId: string): Promise<void> {
    const supabase = this.supabaseService.client;

    // Clean up dependent child records to avoid FK constraint violations
    await supabase.from('purchase_items').delete().eq('product_id', productId);
    await supabase.from('delivery_items').delete().eq('product_id', productId);
    await supabase.from('stock_log').delete().eq('product_id', productId);
    await supabase.from('batches').delete().eq('product_id', productId);
    await supabase.from('inventory').delete().eq('product_id', productId);
    await supabase.from('restock_requests').delete().eq('product_id', productId);
    await supabase.from('alerts').delete().eq('product_id', productId);
    await supabase.from('forecasts').delete().eq('product_id', productId);
    await supabase.from('sales_history').delete().eq('product_id', productId);

    // Delete the product
    const { error } = await supabase
      .from('products')
      .delete()
      .eq('product_id', productId);
      
    if (error) throw error;
  }

  /**
   * Process a return (Customer Return or Return to Supplier)
   */
  async processReturn(productId: string, returnType: 'Customer Return' | 'Return to Supplier', quantity: number, remarks: string) {
    const supabase = this.supabaseService.client;
    
    // 1. Get current inventory
    const { data: invData, error: invError } = await supabase
      .from('inventory')
      .select('stock_quantity')
      .eq('product_id', productId)
      .single();
      
    if (invError) throw invError;
    
    const isAdding = returnType === 'Customer Return';
    const newStock = isAdding 
      ? invData.stock_quantity + quantity 
      : invData.stock_quantity - quantity;
      
    if (!isAdding && newStock < 0) {
      throw new Error('Not enough stock to return to supplier.');
    }

    // 2. Update inventory
    const { error: updateError } = await supabase
      .from('inventory')
      .update({ stock_quantity: newStock })
      .eq('product_id', productId);
      
    if (updateError) throw updateError;
    
    // 3. Create stock log
    const { error: logError } = await supabase
      .from('stock_log')
      .insert({
        product_id: productId,
        quantity: quantity,
        change_type: returnType,
        remarks: remarks || `Logged ${returnType}`,
        user_id: this.authService.currentUser()?.id || null
      });
      
    if (logError) throw logError;
  }

  /**
   * 0. Fetch batches for a specific product, ordered by expiration (FEFO)
   */
  async getBatchesForProduct(productId: string): Promise<import('../models/itrack.models').Batches[]> {
    const supabase = this.supabaseService.client;
    const { data, error } = await supabase
      .from('batches')
      .select('*')
      .eq('product_id', productId)
      .order('batch_expiration', { ascending: true });
      
    if (error) this.supabaseService.handleError(error);
    return data as import('../models/itrack.models').Batches[];
  }

  /**
   * Calculate line item subtotal
   */
  calculateLineSubtotal(retailPrice: number, discountApplied: number, quantitySold: number): number {
    return (retailPrice - discountApplied) * quantitySold;
  }

  /**
   * 5. Analyze Sales & Trigger Alerts in Supabase
   */
  async runPredictiveAnalytics(productId: string, leadTimeDays: number = 2, safetyStock: number = 20) {
    try {
      const supabase = this.supabaseService.client;
      
      // 1. Fetch sales history for the last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const { data: sales, error: salesError } = await supabase
        .from('sales_history')
        .select('quantity_sold, date')
        .eq('product_id', productId)
        .gte('date', thirtyDaysAgo.toISOString());
        
      if (salesError) throw salesError;

      // Calculate sum of sales over 30 days to find average daily velocity
      const totalSold = (sales ?? []).reduce((acc, sale) => acc + sale.quantity_sold, 0);
      const dailyVelocity = totalSold / 30; // simplistic EMA for demonstration

      // 2. Fetch current stock quantity
      const { data: inventory, error: invError } = await supabase
        .from('inventory')
        .select('stock_quantity')
        .eq('product_id', productId)
        .maybeSingle();
        
      if (invError) throw invError;
      
      const currentStock = inventory?.stock_quantity ?? 0;

      // 3. Compute ROP
      const { rop, isLowStockAlert } = this.calculateROPAndTrigger(dailyVelocity, leadTimeDays, safetyStock, currentStock);

      // 4. Update Forecasts table (requires UNIQUE constraint on product_id)
      const { data: forecastData } = await supabase
        .from('forecasts')
        .upsert({ 
          product_id: productId, 
          daily_velocity: dailyVelocity, 
          calculated_rop: rop,
          suggested_order_qty: Math.max(0, rop - currentStock)
        }, { onConflict: 'product_id' })
        .select()
        .maybeSingle();

      // 5. Trigger Alerts if needed
      if (isLowStockAlert) {
        const { data: alertData } = await supabase
          .from('alerts')
          .insert({
            product_id: productId,
            forecast_id: forecastData?.forecast_id,
            alert_type: 'LOW STOCK',
            status: 'Active'
          })
          .select()
          .maybeSingle();
          
        if (alertData) {
          await supabase
            .from('restock_requests')
            .insert({
              product_id: productId,
              alert_id: alertData.alert_id,
              suggested_quantity: Math.max(0, rop - currentStock) + safetyStock,
              status: 'Pending'
            });
        }
      }
    } catch (err) {
      console.warn(`[runPredictiveAnalytics] Skipped for product ${productId}:`, err);
    }
  }

  /**
   * Fetch full predictive analytics summary for all products matching the IPO model
   */
  async getPredictiveAnalyticsSummary(): Promise<any[]> {
    const supabase = this.supabaseService.client;
    
    // Fetch products, inventory, forecasts, and batches
    const { data: products } = await supabase
      .from('products')
      .select('*, inventory(*), batches(*)');

    if (!products || products.length === 0) return [];

    const summaryList = [];

    for (const prod of products) {
      const inv = prod.inventory?.[0] || { stock_quantity: 0, safety_stock: 10, lead_time: 2, reorder_point: 20 };
      
      // Fetch sales history for EMA calculation
      const { data: sales } = await supabase
        .from('sales_history')
        .select('quantity_sold')
        .eq('product_id', prod.product_id);

      const totalSold = (sales || []).reduce((sum, s) => sum + (s.quantity_sold || 0), 0);
      const daysCount = 30;
      
      // 1. Daily Velocity (EMA) V_i
      const dailyVelocity = totalSold > 0 ? Number((totalSold / daysCount).toFixed(2)) : 0.85;

      // 2. Reorder Point (ROP) ROP_i = (V_i * L_i) + ss_i
      const leadTime = inv.lead_time || 2;
      const safetyStock = inv.safety_stock || 10;
      const rop = Math.ceil((dailyVelocity * leadTime) + safetyStock);

      // 3. Status A_i = 1 if Q_i <= ROP_i else 0
      const currentStock = inv.stock_quantity || 0;
      const isLowStock = currentStock <= rop;
      const alertStatus = isLowStock ? 'Low Stock Alert' : 'Optimal';

      // 4. Suggested Order Quantity O_i = (V_i * P) - Q_i
      const projectionPeriod = 30; // P = 30 days
      const rawSOQ = (dailyVelocity * projectionPeriod) - currentStock;
      const soq = Math.max(0, Math.ceil(rawSOQ));

      // 5. Expiry Risk Markdown evaluation
      let nearestBatchRisk = 'Normal';
      let discountRate = 0;
      if (prod.batches && prod.batches.length > 0) {
        const sortedBatches = prod.batches.sort((a: any, b: any) => 
          new Date(a.batch_expiration).getTime() - new Date(b.batch_expiration).getTime()
        );
        const evalResult = this.evaluateExpiryMarkdown(prod.price, new Date(sortedBatches[0].batch_expiration));
        nearestBatchRisk = evalResult.riskLevel;
        discountRate = evalResult.discountApplied;
      }

      summaryList.push({
        productId: prod.product_id,
        name: prod.product_name,
        category: prod.category_name,
        currentStock,
        dailyVelocity,
        leadTime,
        safetyStock,
        rop,
        status: alertStatus,
        isLowStock,
        soq,
        price: prod.price,
        nearestBatchRisk,
        discountRate
      });
    }

    return summaryList;
  }
}
