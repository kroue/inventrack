import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ProcurementService } from '../../services/procurement.service';
import { InventoryLogicService } from '../../services/inventory-logic.service';

@Component({
  selector: 'app-procurement',
  imports: [CommonModule, FormsModule, ReactiveFormsModule],
  templateUrl: './procurement.html',
  styleUrl: './procurement.css',
})
export class Procurement implements OnInit {
  private procurementService = inject(ProcurementService);
  private inventoryLogic = inject(InventoryLogicService);
  private fb = inject(FormBuilder);

  suppliers = signal<any[]>([]);
  selectedSupplierId = signal<string>(''); // Starts empty
  supplierSearchText = signal<string>('');
  isCreatingSupplier = signal<boolean>(false);
  isAddingNewSupplier = signal<boolean>(false);
  fulfillmentType = signal<'Delivery' | 'Pick-up'>('Delivery');

  isSupplierDropdownOpen = signal<boolean>(false);
  isTypeDropdownOpen = signal<boolean>(false);

  selectedSupplierName = computed(() => {
    const id = this.selectedSupplierId();
    if (!id) return 'Select Supplier...';
    const supp = this.suppliers().find(s => s.supplier_id === id);
    return supp ? supp.supplier_name : 'Select Supplier...';
  });

  // Supplier-specific restock lists (map of supplierId -> restockItems)
  supplierRestockItems = signal<Record<string, any[]>>({});
  
  pendingRequests = signal<any[]>([]);
  deliveries = signal<any[]>([]);
  selectedDeliveryIndex = signal<number>(0);
  
  isLoading = signal<boolean>(true);
  isGenerating = signal<boolean>(false);
  isReceiving = signal<boolean>(false);

  // Add Item Modal state
  isAddItemModalOpen = signal<boolean>(false);
  availableProducts = signal<any[]>([]);
  newProductId = signal<string>('');
  newQuantity = signal<number>(25);

  // Pending PO Interactive Flow State
  isPOModalOpen = signal<boolean>(false);
  selectedPO = signal<any>(null);

  // Barcode Receiving State
  isBarcodeModalOpen = signal<boolean>(false);
  barcodeError = signal<string>('');
  scannedProduct = signal<any>(null);
  isProcessingBarcode = signal<boolean>(false);
  barcodeReceiveForm: FormGroup;

  // Computed restock items for the currently selected supplier
  restockItems = computed(() => {
    const suppId = this.selectedSupplierId();
    if (!suppId) return [];
    return this.supplierRestockItems()[suppId] || [];
  });

  constructor() {
    this.barcodeReceiveForm = this.fb.group({
      barcode: ['', Validators.required],
      productName: [{ value: '', disabled: true }],
      category: [{ value: '', disabled: true }],
      quantity_received: ['', [Validators.required, Validators.min(1)]],
      batch_expiration: ['', Validators.required]
    });
  }

  async ngOnInit() {
    await this.loadData();
  }

  async loadData() {
    try {
      this.isLoading.set(true);
      
      const [supps, restock, po, deliv] = await Promise.all([
        this.procurementService.getSuppliers(),
        this.procurementService.getPendingRestockRequests(),
        this.procurementService.getPendingPurchaseOrders(),
        this.procurementService.getDeliveries()
      ]);
      
      this.suppliers.set(supps);
      // Keep selectedSupplierId as '' so it starts empty until user selects a supplier

      this.pendingRequests.set(po.map((p: any) => {
        const orderDate = new Date(p.order_date || Date.now());
        const estArrival = new Date(orderDate);
        estArrival.setDate(estArrival.getDate() + 2);

        const itemsList = (p.purchase_items || [])
          .map((i: any) => {
            const hasBeenScanned = (p.deliveries || []).flatMap((d: any) => d.delivery_items || [])
              .some((di: any) => di.product_id === i.product_id);
            
            return {
              product_id: i.product_id,
              name: i.products?.product_name || 'Product Item',
              quantity_ordered: i.quantity_ordered,
              unit_cost: i.unit_cost || ((i.products?.price || 100) * 0.7),
              subtotal: i.quantity_ordered * (i.unit_cost || ((i.products?.price || 100) * 0.7)),
              hasBeenScanned
            };
          })
          .filter((i: any) => !i.hasBeenScanned);

        const totalAmount = itemsList.reduce((sum: number, i: any) => sum + i.subtotal, 0);

        return {
          ...p,
          supplier: p.suppliers?.supplier_name || 'Unknown Supplier',
          itemsCountLabel: `${itemsList.length} Items`,
          itemsList,
          type: p.fulfillment_type || 'Delivery',
          orderDateFormatted: orderDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          estArrivalFormatted: estArrival.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          totalAmount
        };
      }).filter((p: any) => p.itemsList.length > 0));

      this.deliveries.set(deliv.map((d: any) => ({
        ...d,
        product: d.delivery_items?.[0]?.products?.product_name + (d.delivery_items?.length > 1 ? ` (+${d.delivery_items.length - 1})` : ''),
        ordered: d.delivery_items?.reduce((sum: number, i: any) => sum + (i.quantity_ordered || 0), 0) || 0,
        received: d.delivery_items?.reduce((sum: number, i: any) => sum + (i.quantity_received || 0), 0) || 0,
        dateDelivered: d.delivery_date,
        supplier: d.purchase_orders?.suppliers?.supplier_name || 'Unknown',
        fulfillment: d.purchase_orders?.fulfillment_type || 'Unknown',
      })));

    } catch (err) {
      console.error('Failed to load procurement data:', err);
    } finally {
      this.isLoading.set(false);
    }
  }

  onSupplierChange(suppId: string) {
    if (suppId === 'NEW_SUPPLIER') {
      this.isAddingNewSupplier.set(true);
      this.supplierSearchText.set('');
      this.selectedSupplierId.set('');
      return;
    }
    
    this.selectedSupplierId.set(suppId);
    if (suppId && !this.supplierRestockItems()[suppId]) {
      this.supplierRestockItems.update(map => ({
        ...map,
        [suppId]: []
      }));
    }
  }

  cancelNewSupplier() {
    this.isAddingNewSupplier.set(false);
    this.supplierSearchText.set('');
    this.selectedSupplierId.set('');
  }

  toggleSupplierDropdown(event: Event) {
    event.stopPropagation();
    this.isSupplierDropdownOpen.set(!this.isSupplierDropdownOpen());
    this.isTypeDropdownOpen.set(false);
  }

  toggleTypeDropdown(event: Event) {
    event.stopPropagation();
    this.isTypeDropdownOpen.set(!this.isTypeDropdownOpen());
    this.isSupplierDropdownOpen.set(false);
  }

  selectFulfillmentType(type: 'Delivery' | 'Pick-up') {
    this.fulfillmentType.set(type);
    this.isTypeDropdownOpen.set(false);
  }

  onCustomSupplierChange(suppId: string) {
    this.isSupplierDropdownOpen.set(false);
    this.onSupplierChange(suppId);
  }

  closeAllDropdowns() {
    this.isSupplierDropdownOpen.set(false);
    this.isTypeDropdownOpen.set(false);
  }

  async saveNewSupplier() {
    const text = this.supplierSearchText().trim();
    if (!text) return;
    const existing = this.suppliers().find(s => s.supplier_name.toLowerCase() === text.toLowerCase());
    if (existing) {
       this.isAddingNewSupplier.set(false);
       this.onSupplierChange(existing.supplier_id);
       return;
    }

    this.isCreatingSupplier.set(true);
    try {
      const newSupp = await this.procurementService.createSupplier(text);
      this.suppliers.update(s => [...s, newSupp].sort((a, b) => a.supplier_name.localeCompare(b.supplier_name)));
      this.isAddingNewSupplier.set(false);
      this.onSupplierChange(newSupp.supplier_id);
    } catch (err) {
      console.error('Failed to create new supplier', err);
      alert('Failed to save new supplier');
    } finally {
      this.isCreatingSupplier.set(false);
    }
  }

  toggleRestockItem(index: number) {
    const suppId = this.selectedSupplierId();
    if (!suppId) return;

    this.supplierRestockItems.update(map => {
      const current = [...(map[suppId] || [])];
      if (current[index]) {
        current[index] = { ...current[index], checked: !current[index].checked };
      }
      return { ...map, [suppId]: current };
    });
  }

  updateSOQ(index: number, val: number) {
    const suppId = this.selectedSupplierId();
    if (!suppId) return;

    this.supplierRestockItems.update(map => {
      const current = [...(map[suppId] || [])];
      if (current[index]) {
        current[index] = { ...current[index], soq: Math.max(1, val) };
      }
      return { ...map, [suppId]: current };
    });
  }

  async deleteRestockItem(index: number) {
    const suppId = this.selectedSupplierId();
    if (!suppId) return;

    const current = this.supplierRestockItems()[suppId] || [];
    const item = current[index];
    if (item?.request_id) {
      try {
        await this.procurementService.deleteRestockRequest(item.request_id);
      } catch (err) {
        console.error('Failed to delete restock request', err);
      }
    }

    this.supplierRestockItems.update(map => {
      const updated = (map[suppId] || []).filter((_, i) => i !== index);
      return { ...map, [suppId]: updated };
    });
  }

  async openAddItemModal() {
    if (!this.selectedSupplierId()) {
      alert('Please select a supplier first.');
      return;
    }
    try {
      const prods = await this.procurementService.getAllProducts();
      this.availableProducts.set(prods);
      if (prods.length > 0) {
        this.newProductId.set(prods[0].product_id);
      }
      this.isAddItemModalOpen.set(true);
    } catch (err) {
      console.error('Failed to load products', err);
    }
  }

  closeAddItemModal() {
    this.isAddItemModalOpen.set(false);
  }

  async submitAddItem() {
    const suppId = this.selectedSupplierId();
    if (!suppId) return alert('Please select a supplier first.');
    if (!this.newProductId()) return alert('Please select a product.');

    try {
      const res = await this.procurementService.createRestockRequest(this.newProductId(), this.newQuantity());
      const newItem = {
        ...res,
        name: res.products?.product_name || 'New Item',
        quantity: res.products?.inventory?.[0]?.stock_quantity ?? 0,
        soq: res.suggested_quantity,
        checked: true
      };

      this.supplierRestockItems.update(map => {
        const current = map[suppId] || [];
        return { ...map, [suppId]: [...current, newItem] };
      });

      this.closeAddItemModal();
    } catch (err) {
      console.error(err);
      alert('Failed to add restock item.');
    }
  }

  async autoGenerateRestock() {
    const suppId = this.selectedSupplierId();
    if (!suppId) return alert('Please select a supplier first.');

    try {
      this.isLoading.set(true);
      const lowStockItems = await this.procurementService.autoGenerateRestockRequests();
      const mapped = lowStockItems.map((r: any) => ({
        ...r,
        name: r.products?.product_name || 'Unknown Product',
        quantity: r.products?.inventory?.[0]?.stock_quantity ?? 0,
        soq: r.suggested_quantity,
        checked: true
      }));

      this.supplierRestockItems.update(map => ({
        ...map,
        [suppId]: mapped
      }));
    } catch (err) {
      console.error('Failed auto generate restock', err);
    } finally {
      this.isLoading.set(false);
    }
  }

  selectDelivery(index: number) {
    this.selectedDeliveryIndex.set(index);
  }

  async generatePO() {
    const supplierId = this.selectedSupplierId();
    if (!supplierId) return alert('Please select a supplier first.');

    const selectedRequests = this.restockItems().filter(r => r.checked);
    if (selectedRequests.length === 0) return alert('Please select at least one item to order.');

    try {
      this.isGenerating.set(true);
      await this.procurementService.generatePurchaseOrder(supplierId, selectedRequests, this.fulfillmentType());
      
      // Clear restock list for this supplier after PO generation
      this.supplierRestockItems.update(map => ({
        ...map,
        [supplierId]: []
      }));

      await this.loadData();
    } catch (err) {
      console.error(err);
      alert('Failed to generate Purchase Order.');
    } finally {
      this.isGenerating.set(false);
    }
  }

  // --- Open Supplier Order Details Modal ---
  openPODetails(po: any) {
    this.selectedPO.set(po);
    this.isPOModalOpen.set(true);
  }

  closePOModal() {
    this.isPOModalOpen.set(false);
    this.selectedPO.set(null);
  }



  // --- Step 4: Barcode Scanning Methods ---
  openBarcodeModal() {
    this.barcodeReceiveForm.reset();
    this.barcodeError.set('');
    this.scannedProduct.set(null);
    this.isBarcodeModalOpen.set(true);
  }

  closeBarcodeModal() {
    this.isBarcodeModalOpen.set(false);
  }

  async onBarcodeScanned() {
    const barcode = this.barcodeReceiveForm.get('barcode')?.value;
    if (!barcode) return;

    this.barcodeError.set('');
    this.scannedProduct.set(null);
    this.barcodeReceiveForm.patchValue({
      productName: '',
      category: '',
      quantity_received: '',
      batch_expiration: ''
    });

    try {
      const product = await this.inventoryLogic.getProductByBarcode(barcode);
      if (product) {
        this.scannedProduct.set(product);
        this.barcodeReceiveForm.patchValue({
          productName: product.product_name,
          category: product.category_name
        });
        
        // Suggest SOQ if we have forecast/inventory, otherwise leave empty
        const inv = (product as any).inventory?.[0];
        if (inv && inv.reorder_point) {
          // Minimal suggestion
          const soq = Math.max(1, inv.reorder_point - inv.stock_quantity + (inv.safety_stock || 10));
          this.barcodeReceiveForm.patchValue({ quantity_received: soq });
        }
      } else {
        this.barcodeError.set('Barcode does not match any existing product.');
      }
    } catch (err) {
      console.error(err);
      this.barcodeError.set('Error fetching product by barcode.');
    }
  }

  async confirmBarcodeDelivery() {
    if (this.barcodeReceiveForm.invalid || !this.scannedProduct()) {
      this.barcodeReceiveForm.markAllAsTouched();
      return;
    }

    try {
      this.isProcessingBarcode.set(true);
      this.barcodeError.set('');
      
      const formValue = this.barcodeReceiveForm.getRawValue();
      await this.procurementService.processBarcodeDelivery(
        this.scannedProduct().product_id,
        formValue.quantity_received,
        formValue.batch_expiration
      );

      this.closeBarcodeModal();
      await this.loadData();
    } catch (err: any) {
      console.error('Barcode receive error', err);
      this.barcodeError.set(err.message || 'Failed to process barcode delivery.');
    } finally {
      this.isProcessingBarcode.set(false);
    }
  }
}
