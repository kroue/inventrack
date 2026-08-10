import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SupabaseService } from '../../services/supabase.service';

@Component({
  selector: 'app-users',
  imports: [CommonModule, FormsModule],
  templateUrl: './users.html',
  styleUrl: './users.css',
})
export class Users implements OnInit {
  private supabase = inject(SupabaseService);

  users = signal<any[]>([]);
  admins = computed(() => this.users().filter(u => u.role === 'Admin'));
  cashiers = computed(() => this.users().filter(u => u.role === 'Cashier'));

  isLoading = signal<boolean>(true);
  errorMessage = signal<string | null>(null);

  // Modal State
  isAddModalOpen = signal<boolean>(false);
  isSaving = signal<boolean>(false);
  newUserForm = signal<{ full_name: string; email: string; password: string }>({
    full_name: '',
    email: '',
    password: ''
  });

  async ngOnInit() {
    try {
      this.isLoading.set(true);
      const { data, error } = await this.supabase.client
        .from('users')
        .select('*');
        
      if (error) throw error;
      
      this.users.set(data.map(u => ({
        user_id: u.user_id,
        name: u.full_name,
        email: u.email,
        role: u.role,
        status: u.is_active ? 'Active' : 'Inactive'
      })));
    } catch (err: any) {
      this.errorMessage.set(err.message || 'Error loading users');
    } finally {
      this.isLoading.set(false);
    }
  }

  openAddModal() {
    this.newUserForm.set({ full_name: '', email: '', password: '' });
    this.errorMessage.set(null);
    this.isAddModalOpen.set(true);
  }

  closeAddModal() {
    this.isAddModalOpen.set(false);
    this.errorMessage.set(null);
  }

  async saveUser() {
    const data = this.newUserForm();
    if (!data.full_name || !data.email || !data.password) {
      this.errorMessage.set('All fields are required');
      return;
    }

    try {
      this.isSaving.set(true);
      this.errorMessage.set(null);

      // Force role to Cashier
      const { error } = await this.supabase.client
        .from('users')
        .insert({
          full_name: data.full_name,
          email: data.email,
          password: data.password, // In a real app, use auth service. For this schema, we just store it.
          role: 'Cashier',
          is_active: true
        });

      if (error) throw error;
      
      this.closeAddModal();
      await this.ngOnInit(); // Refresh list
    } catch (err: any) {
      console.error(err);
      this.errorMessage.set(err.message || 'Failed to add user');
    } finally {
      this.isSaving.set(false);
    }
  }

  userToConfirm: any = null;

  confirmToggleStatus(user: any) {
    this.userToConfirm = user;
  }

  cancelToggleStatus() {
    this.userToConfirm = null;
  }

  async executeToggleStatus() {
    if (!this.userToConfirm) return;
    const user = this.userToConfirm;
    this.userToConfirm = null;
    
    const newStatus = user.status === 'Active' ? false : true; // false = Inactive, true = Active
    try {
      const { error } = await this.supabase.client
        .from('users')
        .update({ is_active: newStatus })
        .eq('user_id', user.user_id);
        
      if (error) throw error;
      
      // Optimistic update
      this.users.update(users => users.map(u => 
        u.user_id === user.user_id ? { ...u, status: newStatus ? 'Active' : 'Inactive' } : u
      ));
    } catch (err: any) {
      console.error('Failed to toggle status', err);
      alert('Failed to update status');
    }
  }
}
