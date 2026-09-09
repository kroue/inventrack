import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

@Injectable({ providedIn: 'root' })
export class SupabaseService {
  private _client: SupabaseClient;

  constructor() {
    this._client = createClient(
      environment.supabaseUrl,
      environment.supabaseAnonKey,
      {
        auth: {
          storage: sessionStorage as Storage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      }
    );
  }

  get client(): SupabaseClient {
    return this._client;
  }

  /**
   * Generic error handler for Supabase responses.
   */
  handleError(error: any): never {
    console.error('Supabase Error:', error);
    throw new Error(error?.message || 'An unexpected error occurred with the database.');
  }

  /**
   * Helper to execute the POS checkout transaction via RPC
   */
  async processPosSale(
    paymentMethod: 'Cash' | 'Gcash',
    items: any[]
  ) {
    const { data, error } = await this.client.rpc('process_pos_sale', {
      p_payment_method: paymentMethod,
      p_items: items
    });
    
    if (error) {
      throw error;
    }
    return data;
  }

  /**
   * Cashier account lifecycle, via the manage-staff Edge Function.
   *
   * Creating a login needs the Supabase Admin API and therefore the service role
   * key, which must never reach the browser — so this goes through a function
   * rather than the client. Admin accounts are intentionally out of scope and
   * are provisioned in the Supabase dashboard.
   */
  async manageStaff(request: StaffRequest): Promise<{ ok: boolean; [key: string]: any }> {
    const { data, error } = await this.client.functions.invoke('manage-staff', {
      body: request
    });

    if (error) {
      // The function returns a JSON body explaining the refusal; surface that
      // rather than the generic "Edge Function returned a non-2xx status code".
      let detail = error.message;
      try {
        const ctx = (error as any).context;
        if (ctx && typeof ctx.json === 'function') {
          const body = await ctx.json();
          if (body?.error) detail = body.error;
        }
      } catch {
        // fall back to the generic message
      }
      throw new Error(detail);
    }

    if (data?.error) throw new Error(data.error);
    return data;
  }

  /**
   * Helper to commit an uploaded offline (Excel Log) sales sheet via RPC.
   * The whole sheet is imported inside one database transaction, so a bad row
   * rejects the entire file rather than leaving a half-recorded day of sales.
   */
  async importOfflineSales(rows: OfflineSaleRow[]): Promise<OfflineImportResult> {
    const { data, error } = await this.client.rpc('import_offline_sales', {
      p_rows: rows
    });

    if (error) {
      throw error;
    }
    return data as OfflineImportResult;
  }
}

export type StaffAction = 'create' | 'update' | 'delete';

export interface StaffRequest {
  action: StaffAction;
  user_id?: string;
  email?: string;
  full_name?: string;
  password?: string;
}

export interface OfflineSaleRow {
  product_name: string;
  barcode: string;
  quantity: number;
  unit_price: number;
  sale_date?: string;
}

export interface OfflineImportResult {
  sale_id: string;
  rows_imported: number;
  units_imported: number;
  total_amount: number;
}
