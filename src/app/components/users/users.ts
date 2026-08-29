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
  newUserForm = signal<{ full_name: string; email: string; role: 'Admin' | 'Cashier' }>({
    full_name: '',
    email: '',
    role: 'Cashier'
  });

  // Edit Modal State (Use Case Table 18)
  isEditModalOpen = signal<boolean>(false);
  editingUserId = signal<string | null>(null);
  editUserForm = signal<{ full_name: string; email: string }>({ full_name: '', email: '' });
  editError = signal<string | null>(null);

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
    this.newUserForm.set({ full_name: '', email: '', role: 'Cashier' });
    this.errorMessage.set(null);
    this.isAddModalOpen.set(true);
  }

  closeAddModal() {
    this.isAddModalOpen.set(false);
    this.errorMessage.set(null);
  }

  async saveUser() {
    const data = this.newUserForm();
    if (!data.full_name || !data.email) {
      this.errorMessage.set('Name and email are both required');
      return;
    }

    try {
      this.isSaving.set(true);
      this.errorMessage.set(null);

      // Provisioning goes through the RPC rather than a direct insert. A plain
      // insert leaves user_id defaulted to a random UUID, which never matches the
      // account's auth.users id — the profile then fails every RLS check that
      // resolves the role by user_id. The RPC derives it from auth.users, and
      // refuses outright when no login exists yet.
      //
      // No password passes through here: sign-in is delegated to Supabase Auth.
      const { error } = await this.supabase.client.rpc('create_staff_profile', {
        p_email: data.email,
        p_full_name: data.full_name,
        p_role: data.role
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

  // ─── Edit user (Use Case Table 18) ───────────────────────────────────────

  openEditModal(user: any) {
    this.editingUserId.set(user.user_id);
    this.editUserForm.set({ full_name: user.name, email: user.email });
    this.editError.set(null);
    this.isEditModalOpen.set(true);
  }

  closeEditModal() {
    this.isEditModalOpen.set(false);
    this.editingUserId.set(null);
    this.editError.set(null);
  }

  updateNewField<K extends 'full_name' | 'email' | 'role'>(field: K, value: string) {
    this.newUserForm.update(form => ({ ...form, [field]: value }));
    this.errorMessage.set(null);
  }

  updateEditField(field: 'full_name' | 'email', value: string) {
    this.editUserForm.update(form => ({ ...form, [field]: value }));
    this.editError.set(null);
  }

  async saveEditedUser() {
    const userId = this.editingUserId();
    const form = this.editUserForm();
    if (!userId) return;

    if (!form.full_name.trim() || !form.email.trim()) {
      this.editError.set('Name and email are both required.');
      return;
    }

    try {
      this.isSaving.set(true);
      this.editError.set(null);

      const { error } = await this.supabase.client
        .from('users')
        .update({
          full_name: form.full_name.trim(),
          email: form.email.trim()
        })
        .eq('user_id', userId);

      if (error) throw error;

      this.closeEditModal();
      await this.ngOnInit(); // Refresh list
    } catch (err: any) {
      console.error('Failed to update user', err);
      this.editError.set(err.message || 'Failed to update the user.');
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
