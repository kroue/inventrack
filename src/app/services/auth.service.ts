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

  async signIn(email: string, password: string): Promise<{ error: string | null }> {
    const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });

    if (error) {
      return { error: 'Invalid email or password. Please try again.' };
    }

    if (data.user) {
      const loadError = await this._loadUserProfile(data.user);
      if (loadError) {
        await this.supabase.auth.signOut();
        return { error: loadError };
      }
    }

    return { error: null };
  }

  async signOut(): Promise<void> {
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
        const err = await this._loadUserProfile(session.user);
        if (err) {
          await this.signOut();
        }
      }
    } catch {
      // Silent fail — user will be redirected to login by the route guard
    } finally {
      this._loading.set(false);
    }

    // Listen for auth state changes (sign in / sign out / token refresh)
    this.supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'SIGNED_IN' && session?.user) {
        const err = await this._loadUserProfile(session.user);
        if (err) {
          await this.signOut();
        }
      } else if (event === 'SIGNED_OUT') {
        this._currentUser.set(null);
        this.router.navigate(['/login']);
      }
    });
  }

  /**
   * Fetch the user's role and display name from the `users` table.
   *
   * The users table has columns:
   *   user_id     uuid  (FK → auth.users.id)
   *   role        text  ('Admin' | 'Cashier')
   *   full_name   text
   */
  private async _loadUserProfile(user: User): Promise<string | null> {
    interface ProfileRecord {
      role?: string;
      full_name?: string;
      user_id?: string;
      is_active?: boolean;
    }

    // 1. Try fetching by user_id using maybeSingle() to avoid 406 errors when missing
    let profile: ProfileRecord | null = null;

    const { data: profileById } = await this.supabase
      .from('users')
      .select('role, full_name, user_id, is_active')
      .eq('user_id', user.id)
      .maybeSingle();

    if (profileById) {
      profile = profileById;
    }

    // 2. If not found by user_id, fallback to matching by email
    if (!profile && user.email) {
      const { data: profileByEmail } = await this.supabase
        .from('users')
        .select('role, full_name, user_id, is_active')
        .eq('email', user.email)
        .maybeSingle();

      if (profileByEmail) {
        profile = profileByEmail;
        // Sync user_id in public.users to match auth.users.id
        await this.supabase
          .from('users')
          .update({ user_id: user.id })
          .eq('email', user.email);
      }
    }

    // 3. If profile still not found in public.users, auto-create a user profile
    if (!profile && user.email) {
      const defaultRole: UserRole = user.email.toLowerCase().includes('admin') ? 'Admin' : 'Cashier';
      const fullName = user.user_metadata?.['full_name'] ?? user.email;

      const { data: newProfile, error: insertError } = await this.supabase
        .from('users')
        .insert({
          user_id: user.id,
          email: user.email,
          full_name: fullName,
          role: defaultRole,
          is_active: true
        })
        .select('role, full_name, is_active')
        .maybeSingle();

      if (!insertError && newProfile) {
        profile = newProfile;
      } else {
        // Fallback in-memory profile if insert is constrained
        profile = {
          role: defaultRole,
          full_name: fullName,
          is_active: true
        };
      }
    }

    if (profile && profile.is_active === false) {
      return 'This account has been deactivated. Please contact an admin.';
    }

    const role = (profile?.role as UserRole) ?? 'Cashier';
    const displayName = profile?.full_name ?? user.email ?? 'User';

    this._currentUser.set({
      id:          user.id,
      email:       user.email ?? '',
      role:        role,
      displayName: displayName,
    });
    
    return null;
  }
}
