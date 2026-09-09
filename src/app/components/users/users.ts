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
  newUserForm = signal<{ full_name: string; email: string; role: 'Admin' | 'Cashier'; password: string }>({
    full_name: '',
    email: '',
    role: 'Cashier',
    password: ''
  });

  // Edit Modal State (Use Case Table 18)
  isEditModalOpen = signal<boolean>(false);
  editingUserId = signal<string | null>(null);
  editUserForm = signal<{ full_name: string; email: string }>({ full_name: '', email: '' });
  editingUserRole = signal<'Admin' | 'Cashier'>('Cashier');
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
    this.newUserForm.set({ full_name: '', email: '', role: 'Cashier', password: '' });
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
    if (data.role === 'Cashier' && (data.password ?? '').length < 8) {
      this.errorMessage.set('Set a temporary password of at least 8 characters for the cashier to sign in with.');
      return;
    }

    try {
      this.isSaving.set(true);
      this.errorMessage.set(null);

      if (data.role === 'Cashier') {
        // Cashiers are created end to end here — the Edge Function holds the
        // service role key and makes the Supabase Auth login as well as the
        // staff record, so the admin never leaves InvenTrack.
        await this.supabase.manageStaff({
          action: 'create',
          email: data.email,
          full_name: data.full_name,
          password: data.password
        });
      } else {
        // Administrator logins are provisioned in the Supabase dashboard on
        // purpose, so this only links the existing account to a staff record.
        // The RPC derives user_id from auth.users and refuses if none exists.
        const { error } = await this.supabase.client.rpc('create_staff_profile', {
          p_email: data.email,
          p_full_name: data.full_name,
          p_role: data.role
        });
        if (error) throw error;
      }
      
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
    this.editingUserRole.set(user.role);
    this.editUserForm.set({ full_name: user.name, email: user.email });
    this.editError.set(null);
    this.isEditModalOpen.set(true);
  }

  closeEditModal() {
    this.isEditModalOpen.set(false);
    this.editingUserId.set(null);
    this.editError.set(null);
  }

  updateNewField<K extends 'full_name' | 'email' | 'role' | 'password'>(field: K, value: string) {
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

      if (this.editingUserRole() === 'Cashier') {
        // Goes through the function so a changed address updates the Supabase
        // Auth login too — otherwise they would sign in with the old email.
        await this.supabase.manageStaff({
          action: 'update',
          user_id: userId,
          full_name: form.full_name.trim(),
          email: form.email.trim()
        });
      } else {
        const { error } = await this.supabase.client
          .from('users')
          .update({
            full_name: form.full_name.trim(),
            email: form.email.trim()
          })
          .eq('user_id', userId);
        if (error) throw error;
      }

      this.closeEditModal();
      await this.ngOnInit(); // Refresh list
    } catch (err: any) {
      console.error('Failed to update user', err);
      this.editError.set(err.message || 'Failed to update the user.');
    } finally {
      this.isSaving.set(false);
    }
  }

  // ─── Delete cashier (Use Case Table 18 — "remove user") ─────────────────

  userToDelete = signal<any>(null);
  isDeleting = signal<boolean>(false);
  deleteError = signal<string | null>(null);

  confirmDeleteUser(user: any) {
    this.userToDelete.set(user);
    this.deleteError.set(null);
  }

  cancelDeleteUser() {
    this.userToDelete.set(null);
    this.deleteError.set(null);
  }

  async executeDeleteUser() {
    const user = this.userToDelete();
    if (!user) return;

    try {
      this.isDeleting.set(true);
      this.deleteError.set(null);

      // Removes the staff record and the Supabase Auth login together. The
      // function refuses when the cashier has recorded transactions, so the
      // audit trail can never be orphaned by a deletion.
      await this.supabase.manageStaff({ action: 'delete', user_id: user.user_id });

      this.userToDelete.set(null);
      await this.ngOnInit();
    } catch (err: any) {
      console.error('Failed to delete user', err);
      this.deleteError.set(err.message || 'Failed to delete the account.');
    } finally {
      this.isDeleting.set(false);
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
