import { Injectable, signal, computed } from '@angular/core';
import { Router } from '@angular/router';
import { SupabaseService } from './supabase.service';
import type { SupabaseClient, User } from '@supabase/supabase-js';

export type UserRole = 'Admin' | 'Cashier';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  displayName: string;
}

/**
 * Authentication Service — powered by Supabase Auth.
 *
 * ─────────────────────────────────────────────────────────
 * SETUP REQUIRED (one-time, in Supabase SQL editor):
 *   Run the SQL from: src/sql/setup-auth.sql
 *   https://supabase.com/dashboard/project/qkhdouoqkqwkvmpgezay/sql/new
 * ─────────────────────────────────────────────────────────
 *
 * CREDENTIALS:
 *   Add your Supabase URL + anon key to:
 *   → src/environments/environment.ts      (dev)
 *   → src/environments/environment.prod.ts (prod — gitignored)
 * ─────────────────────────────────────────────────────────
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private supabase: SupabaseClient;

  private _currentUser = signal<AuthUser | null>(null);
  private _loading     = signal<boolean>(true);

  readonly currentUser = this._currentUser.asReadonly();
  readonly loading     = this._loading.asReadonly();
  readonly isLoggedIn  = computed(() => this._currentUser() !== null);
  readonly isAdmin     = computed(() => this._currentUser()?.role === 'Admin');
  readonly isCashier   = computed(() => this._currentUser()?.role === 'Cashier');

  constructor(
    private router: Router,
    private supabaseService: SupabaseService
  ) {
    this.supabase = this.supabaseService.client;
    this._initSession();
  }

  // ─── Public API ──────────────────────────────────────────

  async login(email: string, password: string): Promise<{ error: string | null }> {
    const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });

    if (error) {
      return { error: 'Invalid email or password. Please try again.' };
    }

    if (data.user) {
      await this._loadUserProfile(data.user);
    }

    return { error: null };
  }

  async logout(): Promise<void> {
    await this.supabase.auth.signOut();
    this._currentUser.set(null);
    this.router.navigate(['/login']);
  }

  // ─── Private Helpers ─────────────────────────────────────

  /**
   * On app boot, restore session from Supabase and load profile.
   */
  private async _initSession(): Promise<void> {
    try {
      const { data: { session } } = await this.supabase.auth.getSession();

      if (session?.user) {
        await this._loadUserProfile(session.user);
      }
    } catch {
      // Silent fail — user will be redirected to login by the route guard
    } finally {
      this._loading.set(false);
    }

    // Listen for auth state changes (sign in / sign out / token refresh)
    this.supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        await this._loadUserProfile(session.user);
      } else if (event === 'SIGNED_OUT') {
        this._currentUser.set(null);
        this.router.navigate(['/login']);
      }
    });
  }

  /**
   * Fetch the user's role and display name from the `profiles` table.
   *
   * The profiles table must have columns:
   *   id          uuid  (FK → auth.users.id)
   *   role        text  ('Admin' | 'Cashier')
   *   display_name text
   *
   * See: src/sql/setup-auth.sql for the full schema.
   */
  private async _loadUserProfile(user: User): Promise<void> {
    const { data: profile, error } = await this.supabase
      .from('profiles')
      .select('role, display_name')
      .eq('id', user.id)
      .single();

    if (error || !profile) {
      // Profile not found — sign out for safety
      console.error('[AuthService] Could not load profile:', error?.message);
      await this.supabase.auth.signOut();
      this._currentUser.set(null);
      return;
    }

    this._currentUser.set({
      id:          user.id,
      email:       user.email ?? '',
      role:        profile['role'] as UserRole,
      displayName: profile['display_name'] ?? user.email ?? 'User',
    });
  }
}
