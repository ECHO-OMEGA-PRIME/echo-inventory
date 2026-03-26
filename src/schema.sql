-- Echo Inventory v1.0.0 Schema

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT DEFAULT 'starter',
  currency TEXT DEFAULT 'USD',
  settings TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  country TEXT DEFAULT 'US',
  is_active INTEGER DEFAULT 1,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX idx_wh_tenant ON warehouses(tenant_id);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX idx_cat_tenant ON categories(tenant_id);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category_id TEXT,
  brand TEXT,
  unit TEXT DEFAULT 'each',
  weight REAL,
  weight_unit TEXT DEFAULT 'lb',
  dimensions TEXT,
  barcode TEXT,
  cost_price REAL DEFAULT 0,
  sell_price REAL DEFAULT 0,
  min_stock INTEGER DEFAULT 0,
  max_stock INTEGER,
  reorder_point INTEGER DEFAULT 10,
  reorder_qty INTEGER DEFAULT 50,
  lead_time_days INTEGER DEFAULT 7,
  is_active INTEGER DEFAULT 1,
  is_serialized INTEGER DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  image_url TEXT,
  tags TEXT DEFAULT '[]',
  custom_fields TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
);
CREATE INDEX idx_prod_tenant ON products(tenant_id);
CREATE INDEX idx_prod_sku ON products(tenant_id, sku);
CREATE INDEX idx_prod_barcode ON products(barcode);
CREATE INDEX idx_prod_category ON products(category_id);
CREATE INDEX idx_prod_active ON products(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS stock_levels (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  on_hand INTEGER DEFAULT 0,
  reserved INTEGER DEFAULT 0,
  incoming INTEGER DEFAULT 0,
  bin_location TEXT,
  lot_number TEXT,
  expiry_date TEXT,
  last_counted_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  UNIQUE(product_id, warehouse_id, lot_number)
);
CREATE INDEX idx_stock_product ON stock_levels(product_id);
CREATE INDEX idx_stock_warehouse ON stock_levels(warehouse_id);
CREATE INDEX idx_stock_tenant ON stock_levels(tenant_id);
CREATE INDEX idx_stock_low ON stock_levels(tenant_id, on_hand);

CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  payment_terms TEXT DEFAULT 'net30',
  lead_time_days INTEGER DEFAULT 14,
  rating REAL,
  notes TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX idx_sup_tenant ON suppliers(tenant_id);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  po_number INTEGER,
  supplier_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  order_date TEXT DEFAULT (datetime('now')),
  expected_date TEXT,
  received_date TEXT,
  subtotal REAL DEFAULT 0,
  tax REAL DEFAULT 0,
  shipping REAL DEFAULT 0,
  total REAL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
);
CREATE INDEX idx_po_tenant ON purchase_orders(tenant_id);
CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_po_status ON purchase_orders(tenant_id, status);
CREATE INDEX idx_po_number ON purchase_orders(tenant_id, po_number);

CREATE TABLE IF NOT EXISTS po_items (
  id TEXT PRIMARY KEY,
  po_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  received_qty INTEGER DEFAULT 0,
  unit_cost REAL NOT NULL,
  total REAL NOT NULL,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);
CREATE INDEX idx_poi_po ON po_items(po_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  movement_type TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  reference_type TEXT,
  reference_id TEXT,
  lot_number TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_mov_tenant ON stock_movements(tenant_id, created_at);
CREATE INDEX idx_mov_product ON stock_movements(product_id);
CREATE INDEX idx_mov_warehouse ON stock_movements(warehouse_id);
CREATE INDEX idx_mov_type ON stock_movements(tenant_id, movement_type);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  from_warehouse_id TEXT NOT NULL,
  to_warehouse_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id)
);
CREATE INDEX idx_xfer_tenant ON transfers(tenant_id);

CREATE TABLE IF NOT EXISTS transfer_items (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  FOREIGN KEY (transfer_id) REFERENCES transfers(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);
CREATE INDEX idx_xfi_transfer ON transfer_items(transfer_id);

CREATE TABLE IF NOT EXISTS stocktakes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  warehouse_id TEXT NOT NULL,
  status TEXT DEFAULT 'in_progress',
  started_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  counted_by TEXT,
  notes TEXT
);
CREATE INDEX idx_st_tenant ON stocktakes(tenant_id);

CREATE TABLE IF NOT EXISTS stocktake_items (
  id TEXT PRIMARY KEY,
  stocktake_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  expected_qty INTEGER NOT NULL,
  counted_qty INTEGER,
  variance INTEGER,
  FOREIGN KEY (stocktake_id) REFERENCES stocktakes(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);
CREATE INDEX idx_sti_stocktake ON stocktake_items(stocktake_id);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  product_id TEXT,
  warehouse_id TEXT,
  message TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_alert_tenant ON alerts(tenant_id, is_read);

CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT,
  details TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_alog_tenant ON activity_log(tenant_id, created_at);
CREATE INDEX idx_alog_entity ON activity_log(entity_type, entity_id);
