import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);

  // Allow access if logged in, otherwise redirect to login
  if (authService.isLoggedIn()) {
    return true;
  }

  // Optionally, you might want to wait if auth is still loading, 
  // but for simplicity we rely on the immediate signal value.
  return router.parseUrl('/login');
};
