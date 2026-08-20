import { Routes } from '@angular/router';
import { PosCheckoutComponent } from './components/pos-checkout/pos-checkout.component';
import { Dashboard } from './components/dashboard/dashboard';
import { Inventory } from './components/inventory/inventory';
import { Users } from './components/users/users';
import { Procurement } from './components/procurement/procurement';
import { StockLog } from './components/stock-log/stock-log';
import { OfflineSync } from './components/offline-sync/offline-sync';
import { Login } from './components/login/login';
import { SalesHistory } from './components/sales-history/sales-history';
import { authGuard, guestGuard } from './guards/auth-guard';

export const routes: Routes = [
  // Public — redirect already-logged-in users away
  { path: 'login', component: Login, canActivate: [guestGuard] },

  // Redirect root based on auth state (guard handles the actual check)
  { path: '', redirectTo: 'login', pathMatch: 'full' },

  // Admin + Cashier shared
  { path: 'pos', component: PosCheckoutComponent, canActivate: [authGuard] },

  // Admin-only
  { path: 'dashboard',   component: Dashboard,            canActivate: [authGuard], data: { role: 'Admin' } },
  { path: 'inventory',   component: Inventory,            canActivate: [authGuard], data: { role: 'Admin' } },
  { path: 'users',       component: Users,                canActivate: [authGuard], data: { role: 'Admin' } },
  { path: 'procurement', component: Procurement,          canActivate: [authGuard], data: { role: 'Admin' } },
  { path: 'stock-log',   component: StockLog,             canActivate: [authGuard], data: { role: 'Admin' } },
  { path: 'sales-history', component: SalesHistory,       canActivate: [authGuard], data: { role: 'Admin' } },
  { path: 'offline-sync',component: OfflineSync,          canActivate: [authGuard], data: { role: 'Admin' } },

  // Catch-all
  { path: '**', redirectTo: 'login' },
];
