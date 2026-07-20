import { Injectable } from '@angular/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { environment } from '../../environments/environment';

/**
 * Provides a single shared Supabase client instance for the entire app.
 *
 * Fill in your credentials in:
 *   src/environments/environment.ts       ← development
 *   src/environments/environment.prod.ts  ← production (gitignored)
 *
 * Get your values from:
 *   https://supabase.com/dashboard/project/qkhdouoqkqwkvmpgezay/settings/api
 */
@Injectable({ providedIn: 'root' })
export class SupabaseService {
  readonly client: SupabaseClient;

  constructor() {
    this.client = createClient(
      environment.supabaseUrl,
      environment.supabaseAnonKey,
      {
        auth: {
          // Store session in sessionStorage so it clears on tab close
          storage: sessionStorage as Storage,
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: false,
        },
      }
    );
  }
}
