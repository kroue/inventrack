import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const roleGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Check if user is logged in
  if (!authService.isLoggedIn()) {
    return router.parseUrl('/login');
  }

  // Read expected role from route data (e.g., data: { expectedRole: 'Admin' })
  const expectedRole = route.data['expectedRole'];

  // If user is Admin, they have access
  if (authService.isAdmin()) {
    return true;
  }

  // If the route expects Admin but user is Cashier, block access
  if (expectedRole === 'Admin' && authService.isCashier()) {
    // Redirect to a safe route, e.g., POS checkout
    return router.parseUrl('/pos-checkout');
  }

  // Otherwise grant access
  return true;
};
