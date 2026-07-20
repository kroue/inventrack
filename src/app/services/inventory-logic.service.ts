import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class InventoryLogicService {

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
    const rop = (salesVelocity * leadTimeDays) + safetyStock;
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
   * Calculate line item subtotal
   */
  calculateLineSubtotal(retailPrice: number, discountApplied: number, quantitySold: number): number {
    return (retailPrice - discountApplied) * quantitySold;
  }
}
