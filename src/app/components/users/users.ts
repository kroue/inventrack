import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SupabaseService } from '../../services/supabase.service';

@Component({
  selector: 'app-users',
  imports: [CommonModule],
  templateUrl: './users.html',
  styleUrl: './users.css',
})
export class Users implements OnInit {
  private supabase = inject(SupabaseService);

  users = signal<any[]>([]);
  isLoading = signal<boolean>(true);
  errorMessage = signal<string | null>(null);

  async ngOnInit() {
    try {
      this.isLoading.set(true);
      const { data, error } = await this.supabase.client
        .from('users')
        .select('*');
        
      if (error) throw error;
      
      this.users.set(data.map(u => ({
        name: u.full_name,
        email: u.email,
        role: u.role,
        status: 'Active' // We don't have a status in DB, defaulting to Active
      })));
    } catch (err: any) {
      this.errorMessage.set(err.message || 'Error loading users');
    } finally {
      this.isLoading.set(false);
    }
  }
}
