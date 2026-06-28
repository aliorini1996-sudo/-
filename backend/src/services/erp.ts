import prisma from '../config/database';

type ErpIntegration = Awaited<ReturnType<typeof prisma.erpIntegration.findUnique>>;
type Resource = 'customers' | 'products' | 'invoices' | 'receipts';

const endpointField: Record<Resource, 'customersEndpoint' | 'productsEndpoint' | 'invoicesEndpoint' | 'receiptsEndpoint'> = {
  customers: 'customersEndpoint',
  products: 'productsEndpoint',
  invoices: 'invoicesEndpoint',
  receipts: 'receiptsEndpoint',
};

const syncField: Record<Resource, 'syncCustomers' | 'syncProducts' | 'syncInvoices' | 'syncReceipts'> = {
  customers: 'syncCustomers',
  products: 'syncProducts',
  invoices: 'syncInvoices',
  receipts: 'syncReceipts',
};

function joinUrl(baseUrl: string, endpoint?: string | null) {
  if (!endpoint) return baseUrl;
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
}

function headers(config: NonNullable<ErpIntegration>) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.authType === 'API_KEY' && config.apiKey) h['X-API-Key'] = config.apiKey;
  if (config.authType === 'BEARER' && config.bearerToken) h.Authorization = `Bearer ${config.bearerToken}`;
  if (config.authType === 'BASIC' && config.basicUsername && config.basicPassword) {
    h.Authorization = `Basic ${Buffer.from(`${config.basicUsername}:${config.basicPassword}`).toString('base64')}`;
  }
  return h;
}

async function readData(tenantId: string, resource: Resource) {
  if (resource === 'customers') {
    return prisma.customer.findMany({ where: { tenantId }, orderBy: { updatedAt: 'desc' }, take: 500 });
  }
  if (resource === 'products') {
    return prisma.product.findMany({ where: { tenantId }, include: { category: true, priceTiers: true }, orderBy: { updatedAt: 'desc' }, take: 500 });
  }
  if (resource === 'invoices') {
    return prisma.invoice.findMany({
      where: { tenantId },
      include: { customer: true, salesRep: { select: { id: true, name: true, phone: true } }, items: { include: { product: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 300,
    });
  }
  return prisma.receipt.findMany({
    where: { tenantId },
    include: { customer: true, salesRep: { select: { id: true, name: true, phone: true } }, invoiceItems: { include: { invoice: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 300,
  });
}

export async function testErpConnection(config: NonNullable<ErpIntegration>) {
  if (!config.baseUrl) throw new Error('رابط ERP مطلوب');
  const startedAt = new Date();
  const response = await fetch(config.baseUrl, { method: 'GET', headers: headers(config) });
  return {
    ok: response.ok,
    status: response.status,
    message: response.ok ? 'تم الاتصال بنجاح' : `فشل الاتصال: ${response.status}`,
    startedAt,
    finishedAt: new Date(),
  };
}

export async function syncErpResource(tenantId: string, resource: Resource) {
  const config = await prisma.erpIntegration.findUnique({ where: { tenantId } });
  if (!config?.enabled) throw new Error('تكامل ERP غير مفعل');
  if (!config.baseUrl) throw new Error('رابط ERP مطلوب');
  if (!config[syncField[resource]]) throw new Error('مزامنة هذا القسم غير مفعلة');

  const url = joinUrl(config.baseUrl, config[endpointField[resource]]);
  const data = await readData(tenantId, resource);
  const startedAt = new Date();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers(config),
      body: JSON.stringify({
        source: 'field-sales',
        resource,
        exportedAt: new Date().toISOString(),
        count: data.length,
        data,
      }),
    });
    const text = await response.text().catch(() => '');
    const ok = response.ok;
    const message = ok ? 'تمت المزامنة بنجاح' : `فشل ERP: ${response.status}${text ? ` - ${text.slice(0, 300)}` : ''}`;

    await prisma.erpSyncLog.create({
      data: { tenantId, resource, status: ok ? 'SUCCESS' : 'FAILED', count: ok ? data.length : 0, message, startedAt, finishedAt: new Date() },
    });
    if (ok) await prisma.erpIntegration.update({ where: { tenantId }, data: { lastSyncAt: new Date() } });
    if (!ok) throw new Error(message);
    return { resource, count: data.length, message };
  } catch (err) {
    const message = (err as Error).message || 'تعذّرت المزامنة';
    await prisma.erpSyncLog.create({
      data: { tenantId, resource, status: 'FAILED', count: 0, message, startedAt, finishedAt: new Date() },
    });
    throw err;
  }
}

export async function syncErpAll(tenantId: string) {
  const resources: Resource[] = ['customers', 'products', 'invoices', 'receipts'];
  const results = [];
  for (const resource of resources) {
    try {
      results.push(await syncErpResource(tenantId, resource));
    } catch (err) {
      results.push({ resource, count: 0, message: (err as Error).message, failed: true });
    }
  }
  return results;
}
