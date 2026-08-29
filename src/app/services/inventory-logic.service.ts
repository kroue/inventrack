import { Injectable, inject } from '@angular/core';
import { SupabaseService } from './supabase.service';
import { AuthService } from './auth.service';

@Injectable({
  providedIn: 'root'
})
export class InventoryLogicService {
  private supabaseService = inject(SupabaseService);
  private authService = inject(AuthService);

  /** n — the moving average window, fixed at 30 days of historical data. */
  readonly EMA_WINDOW_DAYS = 30;

  /** P — the projection period used by the Suggested Order Quantity. */
  readonly PROJECTION_PERIOD_DAYS = 30;

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
   * 1a. Build a dense daily sales series (S_i,t) for the trailing window.
   * Days with no transactions are explicitly zero — a missing day is a day the
   * product did not sell, and dropping it would inflate the velocity.
   */
  buildDailySalesSeries(
    salesRows: { date: Date | string; quantity_sold: number }[],
    windowDays: number = 30,
    endDate: Date = new Date()
  ): number[] {
    const msPerDay = 1000 * 60 * 60 * 24;
    const series = new Array<number>(windowDays).fill(0);

    // Index 0 is the oldest day in the window, index windowDays-1 is `endDate`.
    const endMidnight = new Date(endDate);
    endMidnight.setHours(0, 0, 0, 0);

    for (const row of salesRows) {
      const rowDate = new Date(row.date);
      if (isNaN(rowDate.getTime())) continue;
      rowDate.setHours(0, 0, 0, 0);

      const daysAgo = Math.round((endMidnight.getTime() - rowDate.getTime()) / msPerDay);
      if (daysAgo < 0 || daysAgo >= windowDays) continue;

      const idx = windowDays - 1 - daysAgo;
      series[idx] += Number(row.quantity_sold) || 0;
    }

    return series;
  }

  /**
   * 1b. Daily Sales Velocity (V_i,t) by folding the EMA recurrence over the series.
   *
   * V_i,t = (S_i,t * alpha) + (V_i,t-1 * (1 - alpha))
   *
   * The recurrence needs a seed for V_i,t-1. The simple mean of the window is used,
   * which is the standard initialisation for exponential smoothing and keeps the
   * estimate stable for the sparse, zero-heavy series typical of retail SKUs.
   */
  calculateVelocityEMA(dailySales: number[], windowDays: number = 30): number {
    if (!dailySales || dailySales.length === 0) return 0;

    const seed = dailySales.reduce((sum, qty) => sum + qty, 0) / dailySales.length;

    let velocity = seed;
    for (const daySales of dailySales) {
      velocity = this.calculateEMA(daySales, velocity, windowDays);
    }

    return velocity;
  }

  /**
   * 1c. Convenience wrapper: fetch the trailing sales history for a product and
   * return its EMA-smoothed daily velocity.
   */
  async getSalesVelocity(productId: string, windowDays: number = 30): Promise<number> {
    const supabase = this.supabaseService.client;

    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - (windowDays - 1));
    windowStart.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
      .from('sales_history')
      .select('quantity_sold, date')
      .eq('product_id', productId)
      .gte('date', windowStart.toISOString());

    if (error) throw error;

    const series = this.buildDailySalesSeries(data ?? [], windowDays);
    return this.calculateVelocityEMA(series, windowDays);
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
   * Record a stock adjustment (Use Case Table 20).
   *
   * Handles all three categories the Admin can pick — Adjust, Customer Return and
   * Return to Supplier. Delegates to the `record_stock_adjustment` RPC so that
   * `inventory`, `batches` and `stock_log` all move inside one transaction; an
   * adjustment that touched only the inventory total would leave the batch pool
   * the POS reads from out of step.
   *
   * For 'ADJUST' the quantity is signed: positive increases stock, negative
   * decreases it. The two return types always take a positive magnitude.
   */
  async recordStockAdjustment(
    productId: string,
    changeType: 'ADJUST' | 'Customer Return' | 'Return to Supplier',
    quantity: number,
    reason: string
  ): Promise<StockAdjustmentResult> {
    const { data, error } = await this.supabaseService.client.rpc('record_stock_adjustment', {
      p_product_id: productId,
      p_change_type: changeType,
      p_quantity: quantity,
      p_reason: reason
    });

    if (error) throw error;
    return data as StockAdjustmentResult;
  }

  /**
   * Process a return (Customer Return or Return to Supplier).
   * Thin wrapper kept for the Stock Log screen's reversal flow.
   */
  async processReturn(productId: string, returnType: 'Customer Return' | 'Return to Supplier', quantity: number, remarks: string) {
    return this.recordStockAdjustment(
      productId,
      returnType,
      quantity,
      remarks || `Logged ${returnType}`
    );
  }

  /**
   * Update an existing supplier's contact details.
   */
  async updateSupplier(supplierId: string, updates: Partial<import('../models/itrack.models').Suppliers>): Promise<import('../models/itrack.models').Suppliers> {
    const { data, error } = await this.supabaseService.client
      .from('suppliers')
      .update(updates)
      .eq('supplier_id', supplierId)
      .select()
      .single();

    if (error) throw error;
    return data as import('../models/itrack.models').Suppliers;
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
  async runPredictiveAnalytics(productId: string, leadTimeDays?: number, safetyStock?: number) {
    try {
      const supabase = this.supabaseService.client;

      // 1. Fetch the product's own inventory parameters. The caller may override them,
      //    but the stored lead time / safety stock are the authoritative values.
      const { data: inventory, error: invError } = await supabase
        .from('inventory')
        .select('stock_quantity, safety_stock, lead_time')
        .eq('product_id', productId)
        .maybeSingle();

      if (invError) throw invError;

      const currentStock = inventory?.stock_quantity ?? 0;
      const effectiveLeadTime = leadTimeDays ?? inventory?.lead_time ?? 1;
      const effectiveSafetyStock = safetyStock ?? inventory?.safety_stock ?? 0;

      // 2. Daily Sales Velocity V_i,t via EMA over the trailing 30-day series
      const dailyVelocity = await this.getSalesVelocity(productId, this.EMA_WINDOW_DAYS);

      // 3. Reorder Point ROP_i = (V_i * L_i) + ss_i, and the alert condition A_i
      const { rop, isLowStockAlert } = this.calculateROPAndTrigger(
        dailyVelocity,
        effectiveLeadTime,
        effectiveSafetyStock,
        currentStock
      );

      // 4. Suggested Order Quantity O_i = (V_i * P) - Q_i
      const suggestedOrderQty = this.calculateSuggestedOrderQuantity(
        dailyVelocity,
        this.PROJECTION_PERIOD_DAYS,
        currentStock
      );

      // 5. Persist the forecast (forecasts.product_id is UNIQUE — see migration 00009)
      const { data: forecastData, error: forecastError } = await supabase
        .from('forecasts')
        .upsert({
          product_id: productId,
          daily_velocity: Number(dailyVelocity.toFixed(4)),
          calculated_rop: rop,
          suggested_order_qty: suggestedOrderQty
        }, { onConflict: 'product_id' })
        .select()
        .maybeSingle();

      if (forecastError) throw forecastError;

      // 6. Keep the inventory row's stored reorder point in step with the forecast so
      //    every other screen reads the same threshold.
      await supabase
        .from('inventory')
        .update({ reorder_point: rop })
        .eq('product_id', productId);

      // 7. Raise or resolve the LOW STOCK alert. Only one Active alert per product/type
      //    is kept so the notification service does not spam on every sale.
      if (isLowStockAlert) {
        await this.raiseAlert(productId, 'LOW STOCK', forecastData?.forecast_id);
        await this.upsertRestockRequest(productId, suggestedOrderQty);
      } else {
        await this.resolveAlerts(productId, 'LOW STOCK');
      }

      return { dailyVelocity, rop, suggestedOrderQty, isLowStockAlert };
    } catch (err) {
      console.warn(`[runPredictiveAnalytics] Skipped for product ${productId}:`, err);
      return null;
    }
  }

  /**
   * 5a. Insert an Active alert unless one of the same type is already open.
   * A row landing in `alerts` is what the database webhook listens for, so
   * de-duplicating here is what keeps the email notifications sane.
   */
  private async raiseAlert(productId: string, alertType: 'LOW STOCK' | 'NEAR EXPIRY', forecastId?: string) {
    const supabase = this.supabaseService.client;

    const { data: existing } = await supabase
      .from('alerts')
      .select('alert_id')
      .eq('product_id', productId)
      .eq('alert_type', alertType)
      .eq('status', 'Active')
      .maybeSingle();

    if (existing) return existing.alert_id as string;

    const { data, error } = await supabase
      .from('alerts')
      .insert({
        product_id: productId,
        forecast_id: forecastId ?? null,
        alert_type: alertType,
        status: 'Active'
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    return data?.alert_id as string | undefined;
  }

  /**
   * 5b. Close out Active alerts once the condition that raised them has cleared.
   */
  private async resolveAlerts(productId: string, alertType: 'LOW STOCK' | 'NEAR EXPIRY') {
    await this.supabaseService.client
      .from('alerts')
      .update({ status: 'Resolved' })
      .eq('product_id', productId)
      .eq('alert_type', alertType)
      .eq('status', 'Active');
  }

  /**
   * 5c. Keep exactly one Pending restock request per product, refreshing its
   * suggested quantity as the forecast moves.
   */
  private async upsertRestockRequest(productId: string, suggestedQuantity: number) {
    const supabase = this.supabaseService.client;
    if (suggestedQuantity <= 0) return;

    const { data: existing } = await supabase
      .from('restock_requests')
      .select('request_id')
      .eq('product_id', productId)
      .eq('status', 'Pending')
      .maybeSingle();

    if (existing) {
      await supabase
        .from('restock_requests')
        .update({ suggested_quantity: suggestedQuantity })
        .eq('request_id', existing.request_id);
      return;
    }

    await supabase
      .from('restock_requests')
      .insert({
        product_id: productId,
        suggested_quantity: suggestedQuantity,
        status: 'Pending'
      });
  }

  /**
   * 6. Automated expiry monitoring.
   * Re-classifies every open batch against the Expiry Risk Formula and raises a
   * NEAR EXPIRY alert for products holding high-risk stock.
   *
   *   Days Remaining > 30       -> Normal
   *   15 <= Days Remaining <= 30 -> Warning     (dashboard warning flag)
   *   Days Remaining <= 14      -> Near-Expiry  (markdown applies)
   */
  async refreshExpiryRisk(): Promise<{ scanned: number; nearExpiry: number }> {
    const supabase = this.supabaseService.client;

    const { data: batches, error } = await supabase
      .from('batches')
      .select('batch_id, product_id, batch_expiration, risk_score')
      .gt('quantity_remaining', 0);

    if (error) throw error;
    if (!batches || batches.length === 0) return { scanned: 0, nearExpiry: 0 };

    const now = new Date();
    const msPerDay = 1000 * 60 * 60 * 24;
    const productsAtRisk = new Set<string>();
    const productsScanned = new Set<string>();

    for (const batch of batches) {
      productsScanned.add(batch.product_id);

      const daysRemaining = Math.floor(
        (new Date(batch.batch_expiration).getTime() - now.getTime()) / msPerDay
      );

      let risk: 'Normal' | 'Warning' | 'Near-Expiry';
      if (daysRemaining > 30) {
        risk = 'Normal';
      } else if (daysRemaining > 14) {
        risk = 'Warning';
      } else {
        risk = 'Near-Expiry';
        productsAtRisk.add(batch.product_id);
      }

      // Only write when the classification actually changed.
      if (risk !== batch.risk_score) {
        await supabase
          .from('batches')
          .update({ risk_score: risk })
          .eq('batch_id', batch.batch_id);
      }
    }

    for (const productId of productsScanned) {
      if (productsAtRisk.has(productId)) {
        await this.raiseAlert(productId, 'NEAR EXPIRY');
      } else {
        await this.resolveAlerts(productId, 'NEAR EXPIRY');
      }
    }

    return { scanned: productsScanned.size, nearExpiry: productsAtRisk.size };
  }

  /**
   * 7. Run the full engine across every product. Used by the dashboard on load and
   * after procurement events so forecasts, alerts and restock requests stay current.
   */
  async runPredictiveAnalyticsForAll(): Promise<void> {
    const supabase = this.supabaseService.client;
    const { data: products, error } = await supabase.from('products').select('product_id');
    if (error) throw error;

    for (const product of products ?? []) {
      await this.runPredictiveAnalytics(product.product_id);
    }

    await this.refreshExpiryRisk();
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

    // One query for the whole trailing window, then bucket per product in memory —
    // far cheaper than a sales_history round trip per product.
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - (this.EMA_WINDOW_DAYS - 1));
    windowStart.setHours(0, 0, 0, 0);

    const { data: salesRows } = await supabase
      .from('sales_history')
      .select('product_id, quantity_sold, date')
      .gte('date', windowStart.toISOString());

    const salesByProduct = new Map<string, { date: Date | string; quantity_sold: number }[]>();
    for (const row of salesRows ?? []) {
      const bucket = salesByProduct.get(row.product_id) ?? [];
      bucket.push({ date: row.date, quantity_sold: row.quantity_sold });
      salesByProduct.set(row.product_id, bucket);
    }

    const summaryList = [];

    for (const prod of products) {
      const inv = prod.inventory?.[0] || { stock_quantity: 0, safety_stock: 0, lead_time: 1, reorder_point: 0 };

      // 1. Daily Velocity V_i,t — EMA over the dense 30-day series.
      //    No sales in the window means a velocity of zero; inventing a floor
      //    would fabricate demand the business never saw.
      const series = this.buildDailySalesSeries(
        salesByProduct.get(prod.product_id) ?? [],
        this.EMA_WINDOW_DAYS
      );
      const dailyVelocity = Number(this.calculateVelocityEMA(series, this.EMA_WINDOW_DAYS).toFixed(2));

      const totalSold = series.reduce((sum, qty) => sum + qty, 0);

      // 2. Reorder Point ROP_i = (V_i * L_i) + ss_i, and 3. status A_i
      const leadTime = inv.lead_time ?? 1;
      const safetyStock = inv.safety_stock ?? 0;
      const currentStock = inv.stock_quantity || 0;
      const { rop, isLowStockAlert: isLowStock } = this.calculateROPAndTrigger(
        dailyVelocity,
        leadTime,
        safetyStock,
        currentStock
      );
      const alertStatus = isLowStock ? 'Low Stock Alert' : 'Optimal';

      // 4. Suggested Order Quantity O_i = (V_i * P) - Q_i
      const soq = this.calculateSuggestedOrderQuantity(
        dailyVelocity,
        this.PROJECTION_PERIOD_DAYS,
        currentStock
      );

      // 5. Expiry Risk Markdown evaluation against the product's own discount rate
      let nearestBatchRisk = 'Low';
      let discountApplied = 0;
      let daysToExpiry: number | null = null;
      const openBatches = (prod.batches || []).filter((b: any) => b.quantity_remaining > 0);
      if (openBatches.length > 0) {
        const sortedBatches = [...openBatches].sort((a: any, b: any) =>
          new Date(a.batch_expiration).getTime() - new Date(b.batch_expiration).getTime()
        );
        const nearestExpiry = new Date(sortedBatches[0].batch_expiration);
        const evalResult = this.evaluateExpiryMarkdown(
          prod.price,
          nearestExpiry,
          new Date(),
          prod.discount_rate ?? 0
        );
        nearestBatchRisk = evalResult.riskLevel;
        discountApplied = evalResult.discountApplied;
        daysToExpiry = Math.floor((nearestExpiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      }

      summaryList.push({
        productId: prod.product_id,
        name: prod.product_name,
        category: prod.category_name,
        currentStock,
        dailyVelocity,
        totalSold,
        leadTime,
        safetyStock,
        rop,
        status: alertStatus,
        isLowStock,
        soq,
        price: prod.price,
        discountRate: prod.discount_rate ?? 0,
        nearestBatchRisk,
        discountApplied,
        daysToExpiry
      });
    }

    return summaryList;
  }

  /**
   * 8. Product movement ranking — fast moving to slow moving.
   * Ranks every product by units sold across the window so the admin can see the
   * most sold products down to the least, per Specific Objective #4.
   */
  async getProductMovementRanking(windowDays: number = 30): Promise<any[]> {
    const supabase = this.supabaseService.client;

    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - (windowDays - 1));
    windowStart.setHours(0, 0, 0, 0);

    const { data: products, error: prodError } = await supabase
      .from('products')
      .select('product_id, product_name, category_name, price');
    if (prodError) throw prodError;
    if (!products || products.length === 0) return [];

    const { data: salesRows, error: salesError } = await supabase
      .from('sales_history')
      .select('product_id, quantity_sold, date')
      .gte('date', windowStart.toISOString());
    if (salesError) throw salesError;

    const soldByProduct = new Map<string, number>();
    for (const row of salesRows ?? []) {
      soldByProduct.set(
        row.product_id,
        (soldByProduct.get(row.product_id) ?? 0) + (Number(row.quantity_sold) || 0)
      );
    }

    const ranked = products
      .map(prod => {
        const unitsSold = soldByProduct.get(prod.product_id) ?? 0;
        return {
          productId: prod.product_id,
          name: prod.product_name,
          category: prod.category_name,
          unitsSold,
          revenue: unitsSold * Number(prod.price || 0),
          dailyAverage: Number((unitsSold / windowDays).toFixed(2))
        };
      })
      .sort((a, b) => b.unitsSold - a.unitsSold);

    // Classify against the mean so "fast" and "slow" are relative to this catalogue
    // rather than an arbitrary hard-coded threshold.
    const totalUnits = ranked.reduce((sum, r) => sum + r.unitsSold, 0);
    const meanUnits = ranked.length > 0 ? totalUnits / ranked.length : 0;

    return ranked.map((row, index) => ({
      ...row,
      rank: index + 1,
      movement:
        row.unitsSold === 0 ? 'No Movement'
        : row.unitsSold >= meanUnits ? 'Fast Moving'
        : 'Slow Moving'
    }));
  }
}

export interface StockAdjustmentResult {
  product_id: string;
  change_type: 'ADJUST' | 'Customer Return' | 'Return to Supplier';
  quantity: number;
  direction: 'IN' | 'OUT';
  stock_quantity: number;
}
