/**
 * Echo Inventory v1.0.0 — AI-Powered Inventory Management
 * =========================================================
 * Multi-warehouse stock tracking, purchase orders, transfers,
 * stocktaking, AI demand forecasting, low-stock alerts, barcode/SKU,
 * lot tracking, inventory valuation, supplier management.
 */

import { Hono } from 'hono';

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  ECHO_API_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

function log(level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) {
  const entry = { ts: new Date().toISOString(), level, worker: 'echo-inventory', message: msg, ...data };
  if (level === 'error') console.error(JSON.stringify(entry)); else console.log(JSON.stringify(entry));
}

const id = () => crypto.randomUUID();

function pag(c: { req: { query: (k: string) => string | undefined } }) {
  return { limit: Math.min(parseInt(c.req.query('limit') || '50') || 50, 200), offset: parseInt(c.req.query('offset') || '0') || 0 };
}

// Rate limiting
interface RLState { c: number; t: number }
async function rl(kv: KVNamespace, key: string, limit: number, win: number): Promise<{ ok: boolean; rem: number }> {
  const k = `rl:${key}`;
  const now = Math.floor(Date.now() / 1000);
  const raw = await kv.get(k, 'json') as RLState | null;
  let count: number, ws: number;
  if (!raw || (now - raw.t) >= win) { count = 1; ws = now; }
  else { const d = Math.max(0, 1 - (now - raw.t) / win); count = Math.floor(raw.c * d) + 1; ws = raw.t; }
  await kv.put(k, JSON.stringify({ c: count, t: ws }), { expirationTtl: win * 2 });
  return { ok: count <= limit, rem: Math.max(0, limit - count) };
}

function san(s: string, max = 2000): string {
  if (typeof s !== 'string') return '';
  return s.slice(0, max).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function sanObj(b: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) o[k] = typeof v === 'string' ? san(v) : v;
  return o;
}

// CORS
app.use('*', async (c, next) => {
  await next();
  const o = c.req.header('Origin') || '';
  const ok = ['https://echo-ept.com', 'https://echo-op.com', 'http://localhost:3000'];
  if (o && ok.includes(o)) { c.header('Access-Control-Allow-Origin', o); c.header('Vary', 'Origin'); }
  else if (!o) c.header('Access-Control-Allow-Origin', ok[0]);
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, X-Echo-API-Key, Authorization, X-Tenant-ID');
});
app.options('*', (c) => c.body(null, 204));

// Rate limit middleware
app.use('*', async (c, next) => {
  const p = new URL(c.req.url).pathname;
  if (p === '/health' || p === '/') return next();
  const ip = c.req.header('CF-Connecting-IP') || 'x';
  const w = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method);
  const { ok: allowed, rem } = await rl(c.env.CACHE, `inv:${ip}:${w ? 'w' : 'r'}`, w ? 60 : 200, 60);
  if (!allowed) return c.json({ error: 'Rate limit exceeded' }, 429);
  c.header('X-RateLimit-Remaining', String(rem));
  return next();
});

const tid = (c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }) =>
  c.req.header('X-Tenant-ID') || c.req.query('tenant_id') || 'default';

// ─── Auth middleware ────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD' || path === '/health' || path === '/' || path.startsWith('/public/')) return next();
  const apiKey = c.req.header('X-Echo-API-Key') || '';
  const bearer = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const expected = c.env.ECHO_API_KEY;
  if (!expected || (apiKey !== expected && bearer !== expected)) {
    return c.json({ error: 'Unauthorized', message: 'Valid X-Echo-API-Key or Bearer token required for write operations' }, 401);
  }
  return next();
});

// ─── Health ─────────────────────────────────────────────────────────
app.get('/health', async (c) => {
  try { await c.env.DB.prepare('SELECT 1').first(); return c.json({ ok: true, service: 'echo-inventory', version: '1.0.0', d1: 'connected', ts: new Date().toISOString() }); }
  catch { return c.json({ ok: false, service: 'echo-inventory', d1: 'error' }, 500); }
});

// ═══ TENANTS ═════════════════════════════════════════════════════════
app.get('/tenants', async (c) => c.json({ tenants: (await c.env.DB.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all()).results }));
app.post('/tenants', async (c) => { const b = sanObj(await c.req.json()) as Record<string, unknown>; const i = id(); await c.env.DB.prepare('INSERT INTO tenants (id, name, plan, currency) VALUES (?,?,?,?)').bind(i, b.name, b.plan || 'starter', b.currency || 'USD').run(); return c.json({ id: i }, 201); });

// ═══ WAREHOUSES ══════════════════════════════════════════════════════
app.get('/warehouses', async (c) => {
  const t = tid(c);
  const rows = await c.env.DB.prepare('SELECT w.*, (SELECT COUNT(*) FROM stock_levels sl WHERE sl.warehouse_id = w.id AND sl.on_hand > 0) as product_count, (SELECT SUM(sl.on_hand) FROM stock_levels sl WHERE sl.warehouse_id = w.id) as total_units FROM warehouses w WHERE w.tenant_id = ? ORDER BY w.is_default DESC, w.name').bind(t).all();
  return c.json({ warehouses: rows.results });
});
app.post('/warehouses', async (c) => { const t = tid(c); const b = sanObj(await c.req.json()) as Record<string, unknown>; const i = id(); await c.env.DB.prepare('INSERT INTO warehouses (id, tenant_id, name, code, address, city, state, zip, country, is_default) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(i, t, b.name, b.code || null, b.address || null, b.city || null, b.state || null, b.zip || null, b.country || 'US', b.is_default ? 1 : 0).run(); return c.json({ id: i }, 201); });
app.put('/warehouses/:id', async (c) => { const t = tid(c); const b = sanObj(await c.req.json()) as Record<string, unknown>; const f: string[] = []; const v: unknown[] = []; for (const [k, val] of Object.entries(b)) { if (['name', 'code', 'address', 'city', 'state', 'zip', 'country', 'is_active', 'is_default'].includes(k)) { f.push(`${k} = ?`); v.push(val); } } if (!f.length) return c.json({ error: 'No fields' }, 400); v.push(c.req.param('id'), t); await c.env.DB.prepare(`UPDATE warehouses SET ${f.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...v).run(); return c.json({ updated: true }); });
app.delete('/warehouses/:id', async (c) => { const t = tid(c); await c.env.DB.prepare('DELETE FROM stock_levels WHERE warehouse_id = ?').bind(c.req.param('id')).run(); await c.env.DB.prepare('DELETE FROM warehouses WHERE id = ? AND tenant_id = ?').bind(c.req.param('id'), t).run(); return c.json({ deleted: true }); });

// ═══ CATEGORIES ══════════════════════════════════════════════════════
app.get('/categories', async (c) => c.json({ categories: (await c.env.DB.prepare('SELECT * FROM categories WHERE tenant_id = ? ORDER BY sort_order, name').bind(tid(c)).all()).results }));
app.post('/categories', async (c) => { const t = tid(c); const b = sanObj(await c.req.json()) as Record<string, unknown>; const i = id(); await c.env.DB.prepare('INSERT INTO categories (id, tenant_id, name, parent_id, sort_order) VALUES (?,?,?,?,?)').bind(i, t, b.name, b.parent_id || null, b.sort_order || 0).run(); return c.json({ id: i }, 201); });
app.delete('/categories/:id', async (c) => { await c.env.DB.prepare('UPDATE products SET category_id = NULL WHERE category_id = ?').bind(c.req.param('id')).run(); await c.env.DB.prepare('DELETE FROM categories WHERE id = ? AND tenant_id = ?').bind(c.req.param('id'), tid(c)).run(); return c.json({ deleted: true }); });

// ═══ PRODUCTS ════════════════════════════════════════════════════════
app.get('/products', async (c) => {
  const t = tid(c);
  const { limit, offset } = pag(c);
  const search = c.req.query('search');
  const cat = c.req.query('category_id');
  const active = c.req.query('active');
  let sql = 'SELECT p.*, c.name as category_name, (SELECT SUM(sl.on_hand) FROM stock_levels sl WHERE sl.product_id = p.id) as total_stock FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.tenant_id = ?';
  const params: unknown[] = [t];
  if (search) { sql += ' AND (p.name LIKE ? OR p.sku LIKE ? OR p.barcode LIKE ?)'; const s = `%${search}%`; params.push(s, s, s); }
  if (cat) { sql += ' AND p.category_id = ?'; params.push(cat); }
  if (active !== undefined) { sql += ' AND p.is_active = ?'; params.push(active === 'true' ? 1 : 0); }
  sql += ' ORDER BY p.name LIMIT ? OFFSET ?';
  params.push(limit, offset);
  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  const total = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM products WHERE tenant_id = ?').bind(t).first();
  return c.json({ products: rows.results, total: (total as Record<string, unknown>)?.cnt || 0, limit, offset });
});

app.post('/products', async (c) => {
  const t = tid(c);
  const b = sanObj(await c.req.json()) as Record<string, unknown>;
  const i = id();
  await c.env.DB.prepare('INSERT INTO products (id, tenant_id, sku, name, description, category_id, brand, unit, weight, weight_unit, barcode, cost_price, sell_price, min_stock, max_stock, reorder_point, reorder_qty, lead_time_days, is_serialized, tax_rate, image_url, tags, custom_fields) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(
    i, t, b.sku, b.name, b.description || null, b.category_id || null, b.brand || null, b.unit || 'each',
    b.weight || null, b.weight_unit || 'lb', b.barcode || null, b.cost_price || 0, b.sell_price || 0,
    b.min_stock || 0, b.max_stock || null, b.reorder_point || 10, b.reorder_qty || 50,
    b.lead_time_days || 7, b.is_serialized ? 1 : 0, b.tax_rate || 0, b.image_url || null,
    JSON.stringify(b.tags || []), JSON.stringify(b.custom_fields || {})
  ).run();
  return c.json({ id: i }, 201);
});

app.get('/products/:id', async (c) => {
  const t = tid(c);
  const p = await c.env.DB.prepare('SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ? AND p.tenant_id = ?').bind(c.req.param('id'), t).first();
  if (!p) return c.json({ error: 'Product not found' }, 404);
  const stock = await c.env.DB.prepare('SELECT sl.*, w.name as warehouse_name FROM stock_levels sl JOIN warehouses w ON sl.warehouse_id = w.id WHERE sl.product_id = ?').bind(p.id).all();
  const movements = await c.env.DB.prepare('SELECT * FROM stock_movements WHERE product_id = ? ORDER BY created_at DESC LIMIT 20').bind(p.id).all();
  return c.json({ ...p, stock_levels: stock.results, recent_movements: movements.results });
});

app.put('/products/:id', async (c) => {
  const t = tid(c);
  const b = sanObj(await c.req.json()) as Record<string, unknown>;
  const f: string[] = [];
  const v: unknown[] = [];
  for (const [k, val] of Object.entries(b)) {
    if (['sku', 'name', 'description', 'category_id', 'brand', 'unit', 'weight', 'weight_unit', 'barcode', 'cost_price', 'sell_price', 'min_stock', 'max_stock', 'reorder_point', 'reorder_qty', 'lead_time_days', 'is_active', 'is_serialized', 'tax_rate', 'image_url'].includes(k)) { f.push(`${k} = ?`); v.push(val); }
    if (k === 'tags' || k === 'custom_fields') { f.push(`${k} = ?`); v.push(JSON.stringify(val)); }
  }
  if (!f.length) return c.json({ error: 'No fields' }, 400);
  f.push("updated_at = datetime('now')");
  v.push(c.req.param('id'), t);
  await c.env.DB.prepare(`UPDATE products SET ${f.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...v).run();
  return c.json({ updated: true });
});

app.delete('/products/:id', async (c) => {
  const t = tid(c);
  await c.env.DB.prepare('DELETE FROM stock_levels WHERE product_id = ?').bind(c.req.param('id')).run();
  await c.env.DB.prepare('DELETE FROM stock_movements WHERE product_id = ?').bind(c.req.param('id')).run();
  await c.env.DB.prepare('DELETE FROM products WHERE id = ? AND tenant_id = ?').bind(c.req.param('id'), t).run();
  return c.json({ deleted: true });
});

// Barcode lookup
app.get('/products/barcode/:code', async (c) => {
  const p = await c.env.DB.prepare('SELECT * FROM products WHERE barcode = ?').bind(c.req.param('code')).first();
  if (!p) return c.json({ error: 'Not found' }, 404);
  return c.json(p);
});

// ═══ STOCK LEVELS ════════════════════════════════════════════════════
app.get('/stock', async (c) => {
  const t = tid(c);
  const wh = c.req.query('warehouse_id');
  const lowStock = c.req.query('low_stock');
  let sql = 'SELECT sl.*, p.name as product_name, p.sku, p.reorder_point, p.min_stock, w.name as warehouse_name FROM stock_levels sl JOIN products p ON sl.product_id = p.id JOIN warehouses w ON sl.warehouse_id = w.id WHERE sl.tenant_id = ?';
  const params: unknown[] = [t];
  if (wh) { sql += ' AND sl.warehouse_id = ?'; params.push(wh); }
  if (lowStock === 'true') { sql += ' AND sl.on_hand <= p.reorder_point'; }
  sql += ' ORDER BY p.name';
  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ stock: rows.results });
});

// Adjust stock (receive, sell, adjust, damage, return)
app.post('/stock/adjust', async (c) => {
  const t = tid(c);
  const b = await c.req.json() as Record<string, unknown>;
  const productId = b.product_id as string;
  const warehouseId = b.warehouse_id as string;
  const qty = b.quantity as number;
  const type = (b.type as string) || 'adjustment';
  const lot = (b.lot_number as string) || null;

  // Upsert stock level
  const existing = await c.env.DB.prepare('SELECT * FROM stock_levels WHERE product_id = ? AND warehouse_id = ? AND (lot_number IS ? OR lot_number = ?)').bind(productId, warehouseId, lot, lot).first();
  if (existing) {
    const newQty = (existing.on_hand as number) + qty;
    await c.env.DB.prepare("UPDATE stock_levels SET on_hand = ?, updated_at = datetime('now') WHERE id = ?").bind(Math.max(0, newQty), existing.id).run();
  } else {
    await c.env.DB.prepare('INSERT INTO stock_levels (id, tenant_id, product_id, warehouse_id, on_hand, lot_number) VALUES (?,?,?,?,?,?)').bind(id(), t, productId, warehouseId, Math.max(0, qty), lot).run();
  }

  // Record movement
  await c.env.DB.prepare('INSERT INTO stock_movements (id, tenant_id, product_id, warehouse_id, movement_type, quantity, reference_type, reference_id, lot_number, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(
    id(), t, productId, warehouseId, type, qty, b.reference_type || null, b.reference_id || null, lot, b.notes || null, b.created_by || 'api'
  ).run();

  log('info', 'Stock adjusted', { product_id: productId, warehouse_id: warehouseId, qty, type });
  return c.json({ adjusted: true, quantity: qty, type });
});

// ═══ SUPPLIERS ═══════════════════════════════════════════════════════
app.get('/suppliers', async (c) => {
  const t = tid(c);
  const rows = await c.env.DB.prepare('SELECT s.*, (SELECT COUNT(*) FROM purchase_orders po WHERE po.supplier_id = s.id) as order_count FROM suppliers s WHERE s.tenant_id = ? ORDER BY s.name').bind(t).all();
  return c.json({ suppliers: rows.results });
});
app.post('/suppliers', async (c) => {
  const t = tid(c); const b = sanObj(await c.req.json()) as Record<string, unknown>; const i = id();
  await c.env.DB.prepare('INSERT INTO suppliers (id, tenant_id, name, contact_name, email, phone, address, city, state, country, payment_terms, lead_time_days, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(i, t, b.name, b.contact_name || null, b.email || null, b.phone || null, b.address || null, b.city || null, b.state || null, b.country || null, b.payment_terms || 'net30', b.lead_time_days || 14, b.notes || null).run();
  return c.json({ id: i }, 201);
});
app.get('/suppliers/:id', async (c) => {
  const s = await c.env.DB.prepare('SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?').bind(c.req.param('id'), tid(c)).first();
  if (!s) return c.json({ error: 'Not found' }, 404);
  const orders = await c.env.DB.prepare('SELECT id, po_number, status, total, order_date FROM purchase_orders WHERE supplier_id = ? ORDER BY order_date DESC LIMIT 10').bind(s.id).all();
  return c.json({ ...s, recent_orders: orders.results });
});
app.put('/suppliers/:id', async (c) => { const t = tid(c); const b = sanObj(await c.req.json()) as Record<string, unknown>; const f: string[] = []; const v: unknown[] = []; for (const [k, val] of Object.entries(b)) { if (['name', 'contact_name', 'email', 'phone', 'address', 'city', 'state', 'country', 'payment_terms', 'lead_time_days', 'rating', 'notes', 'is_active'].includes(k)) { f.push(`${k} = ?`); v.push(val); } } if (!f.length) return c.json({ error: 'No fields' }, 400); v.push(c.req.param('id'), t); await c.env.DB.prepare(`UPDATE suppliers SET ${f.join(', ')} WHERE id = ? AND tenant_id = ?`).bind(...v).run(); return c.json({ updated: true }); });
app.delete('/suppliers/:id', async (c) => { await c.env.DB.prepare('DELETE FROM suppliers WHERE id = ? AND tenant_id = ?').bind(c.req.param('id'), tid(c)).run(); return c.json({ deleted: true }); });

// ═══ PURCHASE ORDERS ═════════════════════════════════════════════════
app.get('/purchase-orders', async (c) => {
  const t = tid(c); const { limit, offset } = pag(c);
  const status = c.req.query('status');
  let sql = 'SELECT po.*, s.name as supplier_name, w.name as warehouse_name FROM purchase_orders po JOIN suppliers s ON po.supplier_id = s.id JOIN warehouses w ON po.warehouse_id = w.id WHERE po.tenant_id = ?';
  const params: unknown[] = [t];
  if (status) { sql += ' AND po.status = ?'; params.push(status); }
  sql += ' ORDER BY po.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return c.json({ orders: (await c.env.DB.prepare(sql).bind(...params).all()).results });
});

app.post('/purchase-orders', async (c) => {
  const t = tid(c); const b = await c.req.json() as Record<string, unknown>;
  const i = id();
  const last = await c.env.DB.prepare('SELECT MAX(po_number) as m FROM purchase_orders WHERE tenant_id = ?').bind(t).first();
  const poNum = ((last as Record<string, unknown>)?.m as number || 0) + 1;
  const items = (b.items as Array<{ product_id: string; quantity: number; unit_cost: number }>) || [];
  let subtotal = 0;
  for (const item of items) subtotal += item.quantity * item.unit_cost;
  const tax = (b.tax as number) || 0;
  const shipping = (b.shipping as number) || 0;

  await c.env.DB.prepare('INSERT INTO purchase_orders (id, tenant_id, po_number, supplier_id, warehouse_id, status, expected_date, subtotal, tax, shipping, total, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(
    i, t, poNum, b.supplier_id, b.warehouse_id, 'draft', b.expected_date || null, subtotal, tax, shipping, subtotal + tax + shipping, b.notes || null
  ).run();

  for (const item of items) {
    await c.env.DB.prepare('INSERT INTO po_items (id, po_id, product_id, quantity, unit_cost, total) VALUES (?,?,?,?,?,?)').bind(id(), i, item.product_id, item.quantity, item.unit_cost, item.quantity * item.unit_cost).run();
  }
  return c.json({ id: i, po_number: poNum }, 201);
});

app.get('/purchase-orders/:id', async (c) => {
  const po = await c.env.DB.prepare('SELECT po.*, s.name as supplier_name, w.name as warehouse_name FROM purchase_orders po JOIN suppliers s ON po.supplier_id = s.id JOIN warehouses w ON po.warehouse_id = w.id WHERE po.id = ? AND po.tenant_id = ?').bind(c.req.param('id'), tid(c)).first();
  if (!po) return c.json({ error: 'Not found' }, 404);
  const items = await c.env.DB.prepare('SELECT pi.*, p.name as product_name, p.sku FROM po_items pi JOIN products p ON pi.product_id = p.id WHERE pi.po_id = ?').bind(po.id).all();
  return c.json({ ...po, items: items.results });
});

// Send PO (draft → sent)
app.post('/purchase-orders/:id/send', async (c) => {
  await c.env.DB.prepare("UPDATE purchase_orders SET status = 'sent', updated_at = datetime('now') WHERE id = ? AND status = 'draft'").bind(c.req.param('id')).run();
  return c.json({ sent: true });
});

// Receive PO items
app.post('/purchase-orders/:id/receive', async (c) => {
  const t = tid(c);
  const b = await c.req.json() as { items: Array<{ po_item_id: string; received_qty: number }> };
  const po = await c.env.DB.prepare('SELECT * FROM purchase_orders WHERE id = ? AND tenant_id = ?').bind(c.req.param('id'), t).first();
  if (!po) return c.json({ error: 'Not found' }, 404);

  for (const recv of b.items) {
    const item = await c.env.DB.prepare('SELECT * FROM po_items WHERE id = ? AND po_id = ?').bind(recv.po_item_id, po.id).first();
    if (!item) continue;
    await c.env.DB.prepare('UPDATE po_items SET received_qty = received_qty + ? WHERE id = ?').bind(recv.received_qty, recv.po_item_id).run();

    // Adjust stock
    const existing = await c.env.DB.prepare('SELECT * FROM stock_levels WHERE product_id = ? AND warehouse_id = ?').bind(item.product_id, po.warehouse_id).first();
    if (existing) {
      await c.env.DB.prepare("UPDATE stock_levels SET on_hand = on_hand + ?, incoming = MAX(0, incoming - ?), updated_at = datetime('now') WHERE id = ?").bind(recv.received_qty, recv.received_qty, existing.id).run();
    } else {
      await c.env.DB.prepare('INSERT INTO stock_levels (id, tenant_id, product_id, warehouse_id, on_hand) VALUES (?,?,?,?,?)').bind(id(), t, item.product_id, po.warehouse_id, recv.received_qty).run();
    }

    await c.env.DB.prepare('INSERT INTO stock_movements (id, tenant_id, product_id, warehouse_id, movement_type, quantity, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?)').bind(id(), t, item.product_id as string, po.warehouse_id as string, 'receive', recv.received_qty, 'purchase_order', po.id).run();
  }

  // Check if fully received
  const remaining = await c.env.DB.prepare('SELECT SUM(quantity - received_qty) as rem FROM po_items WHERE po_id = ?').bind(po.id).first();
  const newStatus = ((remaining as Record<string, unknown>)?.rem as number || 0) <= 0 ? 'received' : 'partial';
  await c.env.DB.prepare("UPDATE purchase_orders SET status = ?, received_date = CASE WHEN ? = 'received' THEN datetime('now') ELSE received_date END, updated_at = datetime('now') WHERE id = ?").bind(newStatus, newStatus, po.id).run();

  return c.json({ received: true, status: newStatus });
});

app.delete('/purchase-orders/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM po_items WHERE po_id = ?').bind(c.req.param('id')).run();
  await c.env.DB.prepare('DELETE FROM purchase_orders WHERE id = ? AND tenant_id = ?').bind(c.req.param('id'), tid(c)).run();
  return c.json({ deleted: true });
});

// ═══ TRANSFERS ═══════════════════════════════════════════════════════
app.get('/transfers', async (c) => {
  const t = tid(c);
  const rows = await c.env.DB.prepare('SELECT t.*, fw.name as from_warehouse, tw.name as to_warehouse FROM transfers t JOIN warehouses fw ON t.from_warehouse_id = fw.id JOIN warehouses tw ON t.to_warehouse_id = tw.id WHERE t.tenant_id = ? ORDER BY t.created_at DESC').bind(t).all();
  return c.json({ transfers: rows.results });
});

app.post('/transfers', async (c) => {
  const t = tid(c); const b = await c.req.json() as Record<string, unknown>;
  const i = id();
  await c.env.DB.prepare('INSERT INTO transfers (id, tenant_id, from_warehouse_id, to_warehouse_id, notes) VALUES (?,?,?,?,?)').bind(i, t, b.from_warehouse_id, b.to_warehouse_id, b.notes || null).run();
  const items = (b.items as Array<{ product_id: string; quantity: number }>) || [];
  for (const item of items) {
    await c.env.DB.prepare('INSERT INTO transfer_items (id, transfer_id, product_id, quantity) VALUES (?,?,?,?)').bind(id(), i, item.product_id, item.quantity).run();
  }
  return c.json({ id: i }, 201);
});

app.post('/transfers/:id/complete', async (c) => {
  const t = tid(c);
  const transfer = await c.env.DB.prepare('SELECT * FROM transfers WHERE id = ? AND tenant_id = ?').bind(c.req.param('id'), t).first();
  if (!transfer) return c.json({ error: 'Not found' }, 404);
  const items = await c.env.DB.prepare('SELECT * FROM transfer_items WHERE transfer_id = ?').bind(transfer.id).all();

  for (const item of (items.results || []) as Array<Record<string, unknown>>) {
    // Decrease from source
    await c.env.DB.prepare("UPDATE stock_levels SET on_hand = MAX(0, on_hand - ?), updated_at = datetime('now') WHERE product_id = ? AND warehouse_id = ?").bind(item.quantity, item.product_id, transfer.from_warehouse_id).run();
    // Increase at destination
    const existing = await c.env.DB.prepare('SELECT id FROM stock_levels WHERE product_id = ? AND warehouse_id = ?').bind(item.product_id, transfer.to_warehouse_id).first();
    if (existing) {
      await c.env.DB.prepare("UPDATE stock_levels SET on_hand = on_hand + ?, updated_at = datetime('now') WHERE id = ?").bind(item.quantity, existing.id).run();
    } else {
      await c.env.DB.prepare('INSERT INTO stock_levels (id, tenant_id, product_id, warehouse_id, on_hand) VALUES (?,?,?,?,?)').bind(id(), t, item.product_id, transfer.to_warehouse_id, item.quantity).run();
    }
    // Record movements
    await c.env.DB.prepare('INSERT INTO stock_movements (id, tenant_id, product_id, warehouse_id, movement_type, quantity, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?)').bind(id(), t, item.product_id as string, transfer.from_warehouse_id as string, 'transfer_out', -(item.quantity as number), 'transfer', transfer.id).run();
    await c.env.DB.prepare('INSERT INTO stock_movements (id, tenant_id, product_id, warehouse_id, movement_type, quantity, reference_type, reference_id) VALUES (?,?,?,?,?,?,?,?)').bind(id(), t, item.product_id as string, transfer.to_warehouse_id as string, 'transfer_in', item.quantity, 'transfer', transfer.id).run();
  }

  await c.env.DB.prepare("UPDATE transfers SET status = 'completed', completed_at = datetime('now') WHERE id = ?").bind(transfer.id).run();
  return c.json({ completed: true });
});

// ═══ STOCKTAKES ══════════════════════════════════════════════════════
app.post('/stocktakes', async (c) => {
  const t = tid(c); const b = await c.req.json() as Record<string, unknown>;
  const i = id();
  await c.env.DB.prepare('INSERT INTO stocktakes (id, tenant_id, warehouse_id, counted_by, notes) VALUES (?,?,?,?,?)').bind(i, t, b.warehouse_id, b.counted_by || null, b.notes || null).run();
  // Pre-populate with current stock
  const stock = await c.env.DB.prepare('SELECT product_id, on_hand FROM stock_levels WHERE warehouse_id = ? AND tenant_id = ?').bind(b.warehouse_id, t).all();
  for (const s of (stock.results || []) as Array<Record<string, unknown>>) {
    await c.env.DB.prepare('INSERT INTO stocktake_items (id, stocktake_id, product_id, expected_qty) VALUES (?,?,?,?)').bind(id(), i, s.product_id, s.on_hand).run();
  }
  return c.json({ id: i, items_to_count: stock.results?.length || 0 }, 201);
});

app.get('/stocktakes/:id', async (c) => {
  const st = await c.env.DB.prepare('SELECT * FROM stocktakes WHERE id = ?').bind(c.req.param('id')).first();
  if (!st) return c.json({ error: 'Not found' }, 404);
  const items = await c.env.DB.prepare('SELECT si.*, p.name as product_name, p.sku FROM stocktake_items si JOIN products p ON si.product_id = p.id WHERE si.stocktake_id = ?').bind(st.id).all();
  return c.json({ ...st, items: items.results });
});

app.put('/stocktakes/:id/count', async (c) => {
  const b = await c.req.json() as { items: Array<{ stocktake_item_id: string; counted_qty: number }> };
  for (const item of b.items) {
    await c.env.DB.prepare('UPDATE stocktake_items SET counted_qty = ?, variance = ? - expected_qty WHERE id = ?').bind(item.counted_qty, item.counted_qty, item.stocktake_item_id).run();
  }
  return c.json({ counted: true });
});

app.post('/stocktakes/:id/apply', async (c) => {
  const t = tid(c);
  const st = await c.env.DB.prepare('SELECT * FROM stocktakes WHERE id = ? AND tenant_id = ?').bind(c.req.param('id'), t).first();
  if (!st) return c.json({ error: 'Not found' }, 404);
  const items = await c.env.DB.prepare('SELECT * FROM stocktake_items WHERE stocktake_id = ? AND counted_qty IS NOT NULL AND variance != 0').bind(st.id).all();
  for (const item of (items.results || []) as Array<Record<string, unknown>>) {
    await c.env.DB.prepare("UPDATE stock_levels SET on_hand = ?, last_counted_at = datetime('now'), updated_at = datetime('now') WHERE product_id = ? AND warehouse_id = ?").bind(item.counted_qty, item.product_id, st.warehouse_id).run();
    await c.env.DB.prepare('INSERT INTO stock_movements (id, tenant_id, product_id, warehouse_id, movement_type, quantity, reference_type, reference_id, notes) VALUES (?,?,?,?,?,?,?,?,?)').bind(id(), t, item.product_id as string, st.warehouse_id as string, 'stocktake', item.variance, 'stocktake', st.id, `Variance: expected ${item.expected_qty}, counted ${item.counted_qty}`).run();
  }
  await c.env.DB.prepare("UPDATE stocktakes SET status = 'completed', completed_at = datetime('now') WHERE id = ?").bind(st.id).run();
  return c.json({ applied: true, adjustments: items.results?.length || 0 });
});

// ═══ ALERTS ══════════════════════════════════════════════════════════
app.get('/alerts', async (c) => {
  const t = tid(c); const unread = c.req.query('unread');
  let sql = 'SELECT a.*, p.name as product_name, p.sku FROM alerts a LEFT JOIN products p ON a.product_id = p.id WHERE a.tenant_id = ?';
  const params: unknown[] = [t];
  if (unread === 'true') { sql += ' AND a.is_read = 0'; }
  sql += ' ORDER BY a.created_at DESC LIMIT 50';
  return c.json({ alerts: (await c.env.DB.prepare(sql).bind(...params).all()).results });
});
app.post('/alerts/:id/read', async (c) => { await c.env.DB.prepare('UPDATE alerts SET is_read = 1 WHERE id = ?').bind(c.req.param('id')).run(); return c.json({ read: true }); });

// ═══ ANALYTICS ═══════════════════════════════════════════════════════
app.get('/analytics/overview', async (c) => {
  const t = tid(c);
  const totalProducts = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM products WHERE tenant_id = ? AND is_active = 1').bind(t).first();
  const totalStock = await c.env.DB.prepare('SELECT SUM(on_hand) as total FROM stock_levels WHERE tenant_id = ?').bind(t).first();
  const lowStock = await c.env.DB.prepare('SELECT COUNT(DISTINCT sl.product_id) as cnt FROM stock_levels sl JOIN products p ON sl.product_id = p.id WHERE sl.tenant_id = ? AND sl.on_hand <= p.reorder_point AND sl.on_hand > 0').bind(t).first();
  const outOfStock = await c.env.DB.prepare('SELECT COUNT(DISTINCT sl.product_id) as cnt FROM stock_levels sl WHERE sl.tenant_id = ? AND sl.on_hand = 0').bind(t).first();
  const totalValue = await c.env.DB.prepare('SELECT SUM(sl.on_hand * p.cost_price) as val FROM stock_levels sl JOIN products p ON sl.product_id = p.id WHERE sl.tenant_id = ?').bind(t).first();
  const pendingPOs = await c.env.DB.prepare("SELECT COUNT(*) as cnt, SUM(total) as val FROM purchase_orders WHERE tenant_id = ? AND status IN ('draft','sent','partial')").bind(t).first();

  return c.json({
    total_products: (totalProducts as Record<string, unknown>)?.cnt || 0,
    total_stock_units: (totalStock as Record<string, unknown>)?.total || 0,
    low_stock_items: (lowStock as Record<string, unknown>)?.cnt || 0,
    out_of_stock_items: (outOfStock as Record<string, unknown>)?.cnt || 0,
    inventory_value: ((totalValue as Record<string, unknown>)?.val as number || 0).toFixed(2),
    pending_purchase_orders: (pendingPOs as Record<string, unknown>)?.cnt || 0,
    pending_po_value: ((pendingPOs as Record<string, unknown>)?.val as number || 0).toFixed(2),
  });
});

app.get('/analytics/movements', async (c) => {
  const t = tid(c);
  const rows = await c.env.DB.prepare("SELECT DATE(created_at) as date, movement_type, SUM(ABS(quantity)) as total_qty, COUNT(*) as count FROM stock_movements WHERE tenant_id = ? AND created_at >= datetime('now', '-30 days') GROUP BY DATE(created_at), movement_type ORDER BY date").bind(t).all();
  return c.json({ movements: rows.results });
});

app.get('/analytics/top-movers', async (c) => {
  const t = tid(c);
  const rows = await c.env.DB.prepare("SELECT p.id, p.name, p.sku, SUM(ABS(sm.quantity)) as total_moved, COUNT(sm.id) as movement_count FROM stock_movements sm JOIN products p ON sm.product_id = p.id WHERE sm.tenant_id = ? AND sm.created_at >= datetime('now', '-30 days') GROUP BY p.id ORDER BY total_moved DESC LIMIT 20").bind(t).all();
  return c.json({ top_movers: rows.results });
});

// AI demand forecast
app.post('/analytics/forecast', async (c) => {
  const t = tid(c);
  const b = await c.req.json() as { product_id: string };
  const product = await c.env.DB.prepare('SELECT name, sku FROM products WHERE id = ? AND tenant_id = ?').bind(b.product_id, t).first();
  if (!product) return c.json({ error: 'Product not found' }, 404);

  const movements = await c.env.DB.prepare("SELECT DATE(created_at) as date, movement_type, SUM(quantity) as qty FROM stock_movements WHERE product_id = ? AND created_at >= datetime('now', '-90 days') GROUP BY DATE(created_at), movement_type ORDER BY date").bind(b.product_id).all();
  const stock = await c.env.DB.prepare('SELECT on_hand, warehouse_id FROM stock_levels WHERE product_id = ?').bind(b.product_id).all();

  try {
    const resp = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine_id: 'INV01', query: `Forecast demand for the next 30 days.\n\nProduct: ${product.name} (${product.sku})\nCurrent stock: ${JSON.stringify(stock.results)}\n90-day movement history: ${JSON.stringify(movements.results?.slice(0, 50))}\n\nReturn JSON: { "forecast_30d": number, "avg_daily_demand": number, "restock_recommended": boolean, "restock_qty": number, "days_of_stock_remaining": number, "confidence": "high"|"medium"|"low" }` })
    });
    const data = await resp.json() as Record<string, unknown>;
    return c.json({ product: product.name, forecast: data.answer });
  } catch (e) {
    log('error', 'Forecast failed', { error: (e as Error).message });
    return c.json({ error: 'Forecast failed' }, 500);
  }
});

// ═══ MOVEMENTS LOG ═══════════════════════════════════════════════════
app.get('/movements', async (c) => {
  const t = tid(c); const { limit, offset } = pag(c);
  const type = c.req.query('type');
  const productId = c.req.query('product_id');
  let sql = 'SELECT sm.*, p.name as product_name, p.sku, w.name as warehouse_name FROM stock_movements sm JOIN products p ON sm.product_id = p.id JOIN warehouses w ON sm.warehouse_id = w.id WHERE sm.tenant_id = ?';
  const params: unknown[] = [t];
  if (type) { sql += ' AND sm.movement_type = ?'; params.push(type); }
  if (productId) { sql += ' AND sm.product_id = ?'; params.push(productId); }
  sql += ' ORDER BY sm.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return c.json({ movements: (await c.env.DB.prepare(sql).bind(...params).all()).results });
});

// ═══ CRON: Daily low-stock alerts ════════════════════════════════════
async function cronHandler(env: Env) {
  log('info', 'Cron: low-stock check');
  const lowStock = await env.DB.prepare('SELECT sl.tenant_id, sl.product_id, sl.warehouse_id, sl.on_hand, p.name, p.sku, p.reorder_point, w.name as warehouse_name FROM stock_levels sl JOIN products p ON sl.product_id = p.id JOIN warehouses w ON sl.warehouse_id = w.id WHERE sl.on_hand <= p.reorder_point AND sl.on_hand > 0 AND p.is_active = 1').all();

  let alertCount = 0;
  for (const item of (lowStock.results || []) as Array<Record<string, unknown>>) {
    await env.DB.prepare('INSERT INTO alerts (id, tenant_id, alert_type, product_id, warehouse_id, message) VALUES (?,?,?,?,?,?)').bind(
      id(), item.tenant_id, 'low_stock', item.product_id, item.warehouse_id,
      `Low stock: ${item.name} (${item.sku}) at ${item.warehouse_name} — ${item.on_hand} units (reorder point: ${item.reorder_point})`
    ).run();
    alertCount++;
  }

  // Out of stock
  const oos = await env.DB.prepare('SELECT sl.tenant_id, sl.product_id, sl.warehouse_id, p.name, p.sku, w.name as warehouse_name FROM stock_levels sl JOIN products p ON sl.product_id = p.id JOIN warehouses w ON sl.warehouse_id = w.id WHERE sl.on_hand = 0 AND p.is_active = 1').all();
  for (const item of (oos.results || []) as Array<Record<string, unknown>>) {
    await env.DB.prepare('INSERT INTO alerts (id, tenant_id, alert_type, product_id, warehouse_id, message) VALUES (?,?,?,?,?,?)').bind(
      id(), item.tenant_id, 'out_of_stock', item.product_id, item.warehouse_id,
      `OUT OF STOCK: ${item.name} (${item.sku}) at ${item.warehouse_name}`
    ).run();
    alertCount++;
  }

  if (alertCount > 0) {
    try {
      await env.SHARED_BRAIN.fetch('https://brain/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: 'echo-inventory', role: 'assistant', content: `INVENTORY ALERT: ${lowStock.results?.length || 0} low-stock items, ${oos.results?.length || 0} out-of-stock items.`, importance: 6, tags: ['inventory', 'alert'] })
      });
    } catch { /* best effort */ }
  }

  log('info', 'Cron complete', { alerts: alertCount, low_stock: lowStock.results?.length || 0, out_of_stock: oos.results?.length || 0 });
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(cronHandler(env));
  },
};
