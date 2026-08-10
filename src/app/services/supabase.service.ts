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
}
