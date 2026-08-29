import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { CommonModule } from '@angular/common';
import { AuthService } from './services/auth.service';
import { ConnectivityService } from './services/connectivity.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  showLogoutModal = signal<boolean>(false);

  readonly connectivity = inject(ConnectivityService);

  constructor(public auth: AuthService) {}

  confirmLogout() {
    this.showLogoutModal.set(true);
  }

  cancelLogout() {
    this.showLogoutModal.set(false);
  }

  executeLogout() {
    this.showLogoutModal.set(false);
    this.auth.signOut();
  }
}
