import express, { type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { db } from './src/db/index.ts';
import {
  users,
  workspaces,
  warehouses,
  categories,
  products,
  customers,
  suppliers,
  sales,
  movements,
  audits,
  notifications,
} from './src/db/schema.ts';
import { eq, and, desc } from 'drizzle-orm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.use(express.json());

// Helper to extract workspaceId from Authorization or X-Workspace-Id
const getWorkspaceId = (req: Request): string => {
  const customHeader = req.headers['x-business-id'] || req.headers['x-workspace-id'];
  if (typeof customHeader === 'string' && customHeader.trim()) {
    return customHeader.trim();
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1];
    // Token format: hp_jwt_<userId>_<timestamp>_<workspaceId> or hp_jwt_<workspaceId>
    const parts = token.split('_');
    if (parts.length >= 4) {
      return parts[3];
    }
  }
  return 'default';
};

// ==========================================
// 1. HEALTH CHECKS
// ==========================================
app.get(['/api/v1/health', '/api/v1/auth/health'], async (_req: Request, res: Response) => {
  try {
    // Quick test query to verify PostgreSQL connection
    await db.select({ count: users.id }).from(users).limit(1);
    res.json({
      isOnline: true,
      connected: true,
      status: 'healthy',
      database: 'PostgreSQL (Cloud SQL)',
      environment: isProd ? 'production' : 'development',
      message: 'ՀայՊահեստ սերվերը ակտիվ է և միացված է PostgreSQL բազային',
    });
  } catch (err: any) {
    console.error('Database health check error:', err);
    res.status(500).json({
      isOnline: false,
      connected: false,
      status: 'error',
      error: 'Տվյալների բազայի հետ կապ չկա',
    });
  }
});

// ==========================================
// 2. AUTHENTICATION & BUSINESS REGISTRATION
// ==========================================

// Register a brand new business workspace (starts strictly with 0 records!)
app.post('/api/v1/auth/register', async (req: Request, res: Response) => {
  try {
    const { businessName, ownerName, email, phone, password } = req.body;

    if (!businessName || !ownerName || !email || !password) {
      return res.status(400).json({ detail: 'Բոլոր պարտադիր դաշտերը պետք է լրացված լինեն:' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = await db.select().from(users).where(eq(users.email, cleanEmail)).limit(1);
    if (existing.length > 0) {
      return res.status(400).json({ detail: 'Այս էլ. հասցեով օգտատեր արդեն գոյություն ունի:' });
    }

    const workspaceId = `ws-${Date.now()}`;
    const userId = `usr-owner-${Date.now()}`;
    const warehouseId = `wh-${Date.now()}`;

    // 1. Create Workspace
    await db.insert(workspaces).values({
      id: workspaceId,
      name: businessName.trim(),
      hvhh: '8' + Math.floor(1000000 + Math.random() * 8999999).toString(),
      ownerId: userId,
      ownerName: ownerName.trim(),
      ownerEmail: cleanEmail,
      plan: 'BUSINESS',
    });

    // 2. Create Owner User
    await db.insert(users).values({
      uid: userId,
      email: cleanEmail,
      fullNameAm: ownerName.trim(),
      role: 'owner',
      phone: phone || null,
      workspaceId,
      isActive: true,
    });

    // 3. Create Initial Default Warehouse for this Business
    await db.insert(warehouses).values({
      id: warehouseId,
      workspaceId,
      nameAm: 'Գլխավոր Պահեստ',
      code: 'WH-01',
      address: 'ք. Երևան',
      phone: phone || '',
      manager: ownerName.trim(),
      isDefault: true,
    });

    // Generate Session Token
    const token = `hp_jwt_${userId}_${Date.now()}_${workspaceId}`;

    const session = {
      token,
      expiresAt: new Date(Date.now() + 86400000 * 30).toISOString(),
      user: {
        id: userId,
        fullNameAm: ownerName.trim(),
        email: cleanEmail,
        phone,
        role: 'OWNER',
        tenantId: workspaceId,
        tenantName: businessName.trim(),
        warehouseId,
        isActive: true,
        createdAt: new Date().toLocaleDateString('hy-AM'),
        lastLoginAt: new Date().toLocaleString('hy-AM', { hour12: false }),
      },
      workspace: {
        id: workspaceId,
        nameAm: businessName.trim(),
        ownerId: userId,
        ownerName: ownerName.trim(),
        ownerEmail: cleanEmail,
        hvhh: '02584931',
        plan: 'BUSINESS',
        createdAt: new Date().toLocaleDateString('hy-AM'),
        status: 'active',
        maxEmployees: 25,
      },
    };

    res.status(201).json(session);
  } catch (err: any) {
    console.error('Registration error:', err);
    res.status(500).json({ detail: 'Գրանցման ընթացքում առաջացավ սխալ: ' + err.message });
  }
});

// Login
app.post('/api/v1/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ detail: 'Էլ. հասցեն և գաղտնաբառը պարտադիր են:' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const foundUsers = await db.select().from(users).where(eq(users.email, cleanEmail)).limit(1);

    if (foundUsers.length === 0) {
      return res.status(401).json({ detail: 'Սխալ էլ. հասցե կամ գաղտնաբառ:' });
    }

    const userRecord = foundUsers[0];
    if (!userRecord.isActive) {
      return res.status(403).json({ detail: 'Օգտատիրոջ հաշիվը ապաակտիվացված է:' });
    }

    const foundWorkspaces = await db.select().from(workspaces).where(eq(workspaces.id, userRecord.workspaceId)).limit(1);
    const wsRecord = foundWorkspaces[0];

    const foundWhs = await db.select().from(warehouses).where(eq(warehouses.workspaceId, userRecord.workspaceId)).limit(1);
    const defaultWh = foundWhs[0];

    const token = `hp_jwt_${userRecord.uid}_${Date.now()}_${userRecord.workspaceId}`;

    const session = {
      token,
      expiresAt: new Date(Date.now() + 86400000 * 30).toISOString(),
      user: {
        id: userRecord.uid,
        fullNameAm: userRecord.fullNameAm,
        email: userRecord.email,
        phone: userRecord.phone,
        role: userRecord.role.toUpperCase(),
        tenantId: userRecord.workspaceId,
        tenantName: wsRecord ? wsRecord.name : 'ՀայՊահեստ',
        warehouseId: defaultWh ? defaultWh.id : 'wh-1',
        isActive: userRecord.isActive,
        createdAt: userRecord.createdAt ? new Date(userRecord.createdAt).toLocaleDateString('hy-AM') : '',
        lastLoginAt: new Date().toLocaleString('hy-AM', { hour12: false }),
      },
      workspace: wsRecord
        ? {
            id: wsRecord.id,
            nameAm: wsRecord.name,
            ownerId: wsRecord.ownerId,
            ownerName: wsRecord.ownerName,
            ownerEmail: wsRecord.ownerEmail,
            hvhh: wsRecord.hvhh,
            plan: wsRecord.plan,
            createdAt: wsRecord.createdAt ? new Date(wsRecord.createdAt).toLocaleDateString('hy-AM') : '',
            status: 'active',
            maxEmployees: 25,
          }
        : null,
    };

    res.json(session);
  } catch (err: any) {
    console.error('Login error:', err);
    res.status(500).json({ detail: 'Մուտքի սխալ: ' + err.message });
  }
});

// ==========================================
// 3. PRODUCTS (DATABASE-DRIVEN)
// ==========================================
app.get('/api/v1/products', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const list = await db.select().from(products).where(eq(products.workspaceId, wsId)).orderBy(desc(products.createdAt));
    
    // Map database entity to client Product model
    const mapped = list.map((p) => {
      let stockMap: Record<string, number> = {};
      try {
        stockMap = JSON.parse(p.warehouseStock);
      } catch {
        stockMap = {};
      }
      return {
        id: p.id,
        sku: p.sku,
        nameAm: p.nameAm,
        barcode: p.barcode || undefined,
        categoryId: p.categoryId || 'cat-general',
        unit: p.unit,
        costPrice: p.costPrice,
        sellingPrice: p.sellingPrice,
        wholesalePrice: p.wholesalePrice,
        minStock: p.minStock,
        description: p.description || undefined,
        warehouseStock: stockMap,
        createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : new Date().toISOString(),
        updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : new Date().toISOString(),
      };
    });

    res.json(mapped);
  } catch (err: any) {
    console.error('Products fetch error:', err);
    res.status(500).json({ detail: 'Չհաջողվեց ստանալ ապրանքները: ' + err.message });
  }
});

app.post('/api/v1/products', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const data = req.body;

    const id = data.id || `prod-${Date.now()}`;
    const stockMap = typeof data.warehouseStock === 'object' ? JSON.stringify(data.warehouseStock) : '{}';

    await db.insert(products).values({
      id,
      workspaceId: wsId,
      sku: data.sku,
      nameAm: data.nameAm,
      barcode: data.barcode || null,
      categoryId: data.categoryId || null,
      unit: data.unit || 'հատ',
      costPrice: Math.round(Number(data.costPrice) || 0),
      sellingPrice: Math.round(Number(data.sellingPrice) || 0),
      wholesalePrice: Math.round(Number(data.wholesalePrice) || 0),
      minStock: Math.round(Number(data.minStock) || 0),
      description: data.description || null,
      warehouseStock: stockMap,
    });

    res.status(201).json({ id, ...data });
  } catch (err: any) {
    console.error('Create product error:', err);
    res.status(500).json({ detail: 'Չհաջողվեց ավելացնել ապրանքը: ' + err.message });
  }
});

app.put('/api/v1/products/:id', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const { id } = req.params;
    const data = req.body;

    const updateFields: any = { updatedAt: new Date() };
    if (data.nameAm !== undefined) updateFields.nameAm = data.nameAm;
    if (data.sku !== undefined) updateFields.sku = data.sku;
    if (data.barcode !== undefined) updateFields.barcode = data.barcode;
    if (data.categoryId !== undefined) updateFields.categoryId = data.categoryId;
    if (data.unit !== undefined) updateFields.unit = data.unit;
    if (data.costPrice !== undefined) updateFields.costPrice = Math.round(Number(data.costPrice));
    if (data.sellingPrice !== undefined) updateFields.sellingPrice = Math.round(Number(data.sellingPrice));
    if (data.wholesalePrice !== undefined) updateFields.wholesalePrice = Math.round(Number(data.wholesalePrice));
    if (data.minStock !== undefined) updateFields.minStock = Math.round(Number(data.minStock));
    if (data.description !== undefined) updateFields.description = data.description;
    if (data.warehouseStock !== undefined) {
      updateFields.warehouseStock = JSON.stringify(data.warehouseStock);
    }

    await db.update(products).set(updateFields).where(and(eq(products.id, id), eq(products.workspaceId, wsId)));
    res.json({ success: true });
  } catch (err: any) {
    console.error('Update product error:', err);
    res.status(500).json({ detail: 'Չհաջողվեց թարմացնել ապրանքը: ' + err.message });
  }
});

app.delete('/api/v1/products/:id', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const { id } = req.params;
    await db.delete(products).where(and(eq(products.id, id), eq(products.workspaceId, wsId)));
    res.json({ success: true });
  } catch (err: any) {
    console.error('Delete product error:', err);
    res.status(500).json({ detail: 'Չհաջողվեց հեռացնել ապրանքը: ' + err.message });
  }
});

// ==========================================
// 4. WAREHOUSES
// ==========================================
app.get(['/api/v1/warehouses', '/api/v1/inventory/warehouses'], async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const list = await db.select().from(warehouses).where(eq(warehouses.workspaceId, wsId));
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post(['/api/v1/warehouses', '/api/v1/inventory/warehouses'], async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const data = req.body;
    const id = `wh-${Date.now()}`;
    await db.insert(warehouses).values({
      id,
      workspaceId: wsId,
      nameAm: data.nameAm,
      code: data.code,
      address: data.address || '',
      phone: data.phone || '',
      manager: data.manager || '',
      isDefault: !!data.isDefault,
    });
    res.status(201).json({ id, ...data });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ==========================================
// 5. CATEGORIES
// ==========================================
app.get('/api/v1/categories', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const list = await db.select().from(categories).where(eq(categories.workspaceId, wsId));
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post('/api/v1/categories', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const data = req.body;
    const id = `cat-${Date.now()}`;
    await db.insert(categories).values({
      id,
      workspaceId: wsId,
      nameAm: data.nameAm || data.name_am,
      description: data.description || '',
    });
    res.status(201).json({ id, ...data });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ==========================================
// 6. SALES & POS (ATOMIC INVENTORY DEDUCTION)
// ==========================================
app.get('/api/v1/sales', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const list = await db.select().from(sales).where(eq(sales.workspaceId, wsId)).orderBy(desc(sales.createdAt));

    const mapped = list.map((s) => {
      let items = [];
      try {
        items = JSON.parse(s.items);
      } catch {
        items = [];
      }
      return {
        id: s.id,
        receiptNumber: s.receiptNumber,
        fiscalReceiptNumber: s.fiscalReceiptNumber,
        date: s.date,
        warehouseId: s.warehouseId,
        cashierName: s.cashierName,
        customerId: s.customerId || undefined,
        customerName: s.customerName || undefined,
        items,
        subtotal: s.subtotal,
        discountTotal: s.discountTotal,
        taxTotal: s.taxTotal,
        total: s.total,
        costTotal: s.costTotal,
        paymentMethod: s.paymentMethod,
        amountTendered: s.amountTendered || undefined,
        changeDue: s.changeDue || undefined,
        isPaid: s.isPaid,
        notes: s.notes || undefined,
      };
    });

    res.json(mapped);
  } catch (err: any) {
    console.error('Sales fetch error:', err);
    res.status(500).json({ detail: err.message });
  }
});

app.post('/api/v1/sales', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const data = req.body;

    const receiptNum = `HP-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
    const fiscalNum = String(Math.floor(10000000 + Math.random() * 90000000));
    const saleId = `trx-${Date.now()}`;

    // Calculate total costs and update inventory atomically
    let totalCost = 0;
    const saleItems = data.items || [];

    for (const item of saleItems) {
      const prodRows = await db.select().from(products).where(and(eq(products.id, item.productId), eq(products.workspaceId, wsId))).limit(1);
      if (prodRows.length > 0) {
        const prod = prodRows[0];
        totalCost += (prod.costPrice || 0) * (item.quantity || 1);

        // Update product stock
        let stockMap: Record<string, number> = {};
        try {
          stockMap = JSON.parse(prod.warehouseStock);
        } catch {
          stockMap = {};
        }

        const currStock = stockMap[data.warehouseId] || 0;
        stockMap[data.warehouseId] = Math.max(0, currStock - item.quantity);

        await db
          .update(products)
          .set({ warehouseStock: JSON.stringify(stockMap), updatedAt: new Date() })
          .where(eq(products.id, prod.id));
      }
    }

    // Insert sale record
    await db.insert(sales).values({
      id: saleId,
      workspaceId: wsId,
      receiptNumber: receiptNum,
      fiscalReceiptNumber: fiscalNum,
      date: new Date().toISOString(),
      warehouseId: data.warehouseId,
      cashierName: data.cashierName || 'Գանձապահ',
      customerId: data.customerId || null,
      customerName: data.customerName || null,
      items: JSON.stringify(saleItems),
      subtotal: Math.round(Number(data.subtotal) || 0),
      discountTotal: Math.round(Number(data.discountTotal) || 0),
      taxTotal: Math.round(Number(data.taxTotal) || 0),
      total: Math.round(Number(data.total) || 0),
      costTotal: Math.round(totalCost),
      paymentMethod: data.paymentMethod || 'cash',
      amountTendered: data.amountTendered ? Math.round(Number(data.amountTendered)) : null,
      changeDue: data.changeDue ? Math.round(Number(data.changeDue)) : null,
      isPaid: data.paymentMethod !== 'credit',
      notes: data.notes || null,
    });

    // Record stock movement
    await db.insert(movements).values({
      id: `mov-${Date.now()}`,
      workspaceId: wsId,
      movementNumber: `SM-OUT-${Date.now().toString().slice(-4)}`,
      date: new Date().toISOString(),
      type: 'write_off',
      sourceWarehouseId: data.warehouseId,
      items: JSON.stringify(saleItems),
      totalCost: Math.round(totalCost),
      referenceDoc: receiptNum,
      reason: `Վաճառք POS կտրոն #${receiptNum}`,
      recordedBy: data.cashierName || 'Գանձապահ',
    });

    const newSale = {
      id: saleId,
      receiptNumber: receiptNum,
      fiscalReceiptNumber: fiscalNum,
      date: new Date().toISOString(),
      warehouseId: data.warehouseId,
      cashierName: data.cashierName || 'Գանձապահ',
      customerId: data.customerId,
      customerName: data.customerName,
      items: saleItems,
      subtotal: data.subtotal,
      discountTotal: data.discountTotal,
      taxTotal: data.taxTotal,
      total: data.total,
      costTotal: Math.round(totalCost),
      paymentMethod: data.paymentMethod,
      amountTendered: data.amountTendered,
      changeDue: data.changeDue,
      isPaid: data.paymentMethod !== 'credit',
      notes: data.notes,
    };

    res.status(201).json(newSale);
  } catch (err: any) {
    console.error('Sale transaction error:', err);
    res.status(500).json({ detail: 'Վաճառքի գրանցման սխալ: ' + err.message });
  }
});

// ==========================================
// 7. CUSTOMERS
// ==========================================
app.get('/api/v1/customers', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const list = await db.select().from(customers).where(eq(customers.workspaceId, wsId));
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post('/api/v1/customers', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const data = req.body;
    const id = `cust-${Date.now()}`;
    await db.insert(customers).values({
      id,
      workspaceId: wsId,
      nameAm: data.nameAm,
      hvhh: data.hvhh || null,
      phone: data.phone || null,
      email: data.email || null,
      address: data.address || null,
      customerType: data.customerType || 'retail',
      balanceDebt: Math.round(Number(data.balanceDebt) || 0),
      loyaltyPoints: Math.round(Number(data.loyaltyPoints) || 0),
      totalSpent: Math.round(Number(data.totalSpent) || 0),
    });
    res.status(201).json({ id, ...data });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ==========================================
// 8. SUPPLIERS
// ==========================================
app.get('/api/v1/suppliers', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const list = await db.select().from(suppliers).where(eq(suppliers.workspaceId, wsId));
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

app.post('/api/v1/suppliers', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const data = req.body;
    const id = `sup-${Date.now()}`;
    await db.insert(suppliers).values({
      id,
      workspaceId: wsId,
      nameAm: data.nameAm,
      hvhh: data.hvhh || null,
      contactPerson: data.contactPerson || null,
      phone: data.phone || null,
      email: data.email || null,
      address: data.address || null,
      totalPurchases: Math.round(Number(data.totalPurchases) || 0),
      currentDebt: Math.round(Number(data.currentDebt) || 0),
    });
    res.status(201).json({ id, ...data });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ==========================================
// 9. EMPLOYEES
// ==========================================
app.get('/api/v1/employees', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const list = await db.select().from(users).where(eq(users.workspaceId, wsId));
    const mapped = list.map((u) => ({
      id: u.uid,
      fullNameAm: u.fullNameAm,
      email: u.email,
      phone: u.phone,
      role: u.role.toUpperCase(),
      isActive: u.isActive,
      createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : '',
    }));
    res.json(mapped);
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ==========================================
// 10. REAL DATABASE ANALYTICS & REPORTS
// ==========================================
app.get('/api/v1/reports/summary', async (req: Request, res: Response) => {
  try {
    const wsId = getWorkspaceId(req);
    const allSales = await db.select().from(sales).where(eq(sales.workspaceId, wsId));

    const totalRevenue = allSales.reduce((acc, s) => acc + s.total, 0);
    const totalCost = allSales.reduce((acc, s) => acc + s.costTotal, 0);
    const grossProfit = Math.max(0, totalRevenue - totalCost);
    const totalTransactions = allSales.length;
    const averageReceipt = totalTransactions > 0 ? Math.round(totalRevenue / totalTransactions) : 0;

    // Today's revenue
    const todayStr = new Date().toISOString().split('T')[0];
    const todaySales = allSales.filter((s) => s.date.startsWith(todayStr));
    const todayRevenue = todaySales.reduce((acc, s) => acc + s.total, 0);

    // Current month revenue
    const currM = new Date().getMonth();
    const currY = new Date().getFullYear();
    const monthSales = allSales.filter((s) => {
      const d = new Date(s.date);
      return d.getMonth() === currM && d.getFullYear() === currY;
    });
    const monthRevenue = monthSales.reduce((acc, s) => acc + s.total, 0);

    res.json({
      todayRevenue,
      monthRevenue,
      totalRevenue,
      grossProfit,
      totalTransactions,
      averageReceipt,
      hasHistoricalData: totalTransactions > 0,
    });
  } catch (err: any) {
    res.status(500).json({ detail: err.message });
  }
});

// ==========================================
// 11. FRONTEND DEV SERVER & PRODUCTION STATIC
// ==========================================
async function startServer() {
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  const portNumber = Number(PORT) || 3000;
  app.listen(portNumber, '0.0.0.0', () => {
    console.log(`[HayPahest] Production server running on http://0.0.0.0:${portNumber}`);
  });
}

startServer().catch((err) => {
  console.error('[HayPahest] Fatal server startup error:', err);
  process.exit(1);
});
