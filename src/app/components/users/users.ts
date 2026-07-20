import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-users',
  imports: [CommonModule],
  templateUrl: './users.html',
  styleUrl: './users.css',
})
export class Users {
  users = [
    { name: 'User 1', email: 'user1@gmail.com', role: 'Admin',   status: 'Active'   },
    { name: 'User 2', email: 'user2@gmail.com', role: 'Admin',   status: 'Inactive' },
    { name: 'User 3', email: 'user3@gmail.com', role: 'Cashier', status: 'Active'   },
    { name: 'User 4', email: 'user4@gmail.com', role: 'Cashier', status: 'Inactive' },
  ];
}
