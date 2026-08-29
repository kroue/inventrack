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

    // 2. If not found by user_id, fall back to matching by email. This covers a
    //    profile whose row was never linked to its auth.users id; the RLS policy
    //    added in migration 00015 permits both lookups for one's own row.
    if (!profile && user.email) {
      const { data: profileByEmail } = await this.supabase
        .from('users')
        .select('role, full_name, user_id, is_active')
        .eq('email', user.email)
        .maybeSingle();

      if (profileByEmail) {
        profile = profileByEmail;
      }
    }

    // 3. No profile means this account has not been provisioned in the system.
    //
    //    Fail closed. This previously fell back to an in-memory profile whose
    //    role was guessed from the email address — any address containing
    //    "admin" was granted the Admin role, and with it the admin navigation
    //    and every Admin-guarded route. Roles must come from the database only.
    if (!profile) {
      return 'This account is not set up in InvenTrack. Please contact an administrator.';
    }

    if (profile.is_active === false) {
      return 'This account has been deactivated. Please contact an admin.';
    }

    // The role is whatever the database says, and nothing else. An unrecognised
    // value is treated as no access rather than quietly downgraded.
    if (profile.role !== 'Admin' && profile.role !== 'Cashier') {
      return 'This account has no valid role assigned. Please contact an administrator.';
    }

    this._currentUser.set({
      id:          user.id,
      email:       user.email ?? '',
      role:        profile.role as UserRole,
      displayName: profile.full_name ?? user.email ?? 'User',
    });

    return null;
  }
}
