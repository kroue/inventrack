import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule, CommonModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  email    = '';
  password = '';
  showPass = false;
  error    = signal('');
  loading  = signal(false);

  constructor(private auth: AuthService, private router: Router) {}

  async submit() {
    this.error.set('');

    if (!this.email || !this.password) {
      this.error.set('Please enter your email and password.');
      return;
    }

    this.loading.set(true);
    const { error } = await this.auth.login(this.email, this.password);
    this.loading.set(false);

    if (error) {
      this.error.set(error);
      return;
    }

    // AuthService handles navigation after login
    const dest = this.auth.isAdmin() ? '/dashboard' : '/pos';
    this.router.navigate([dest]);
  }
}
