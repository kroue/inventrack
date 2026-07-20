import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, map, take } from 'rxjs';

/**
 * Waits for the auth session to finish loading (Supabase getSession is async),
 * then checks if the user is logged in. Redirects to /login if not.
 * Also enforces role-based access via route data: { role: 'Admin' }.
 */
export const authGuard: CanActivateFn = (route, _state) => {
  const auth   = inject(AuthService);
  const router = inject(Router);

  return toObservable(auth.loading).pipe(
    // Wait until loading is false (session check complete)
    filter(loading => !loading),
    take(1),
    map(() => {
      if (!auth.isLoggedIn()) {
        router.navigate(['/login']);
        return false;
      }

      // Role-based route protection
      const requiredRole = route.data?.['role'] as string | undefined;
      if (requiredRole && auth.currentUser()?.role !== requiredRole) {
        // Cashier trying to access admin page → send to POS
        router.navigate(['/pos']);
        return false;
      }

      return true;
    })
  );
};

/**
 * Prevents already-authenticated users from reaching the login page.
 */
export const guestGuard: CanActivateFn = (_route, _state) => {
  const auth   = inject(AuthService);
  const router = inject(Router);

  return toObservable(auth.loading).pipe(
    filter(loading => !loading),
    take(1),
    map(() => {
      if (auth.isLoggedIn()) {
        const dest = auth.isAdmin() ? '/dashboard' : '/pos';
        router.navigate([dest]);
        return false;
      }
      return true;
    })
  );
};
