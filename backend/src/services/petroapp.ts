import crypto from 'crypto';
import prisma from '../config/database';

/**
 * تكامل بترو آب — عميل API + مزامنة دورية لكل شركة ربطت حسابها.
 *
 * نقاط الخدمة الثماني مأخوذة من موصل Odoo الرسميّ لبترو آب (المصدر العمليّ الوحيد
 * الموثوق قبل تسليم الوثائق الرسمية): bills · service_bills · washing_bills ·
 * vehicles · delegates · updated_trips · branches · petroapp_locations.
 *
 * تصميم دفاعيّ عمداً: صيغة الاستجابة غير موثّقة علنياً، فالمحلّل يقبل عدّة
 * أشكال شائعة ({data:[]} | [] | {data:{items:[]}}) وأسماء حقول مرشّحة متعدّدة.
 * حين تصل الوثائق الرسمية يضيق التطابق في مكان واحد (خرائط الحقول أدناه).
 */

// ═══ عميل HTTP ═══

export interface PetroappConfig {
  baseUrl: string;
  apiKey: string;
}

const TIMEOUT_MS = 30_000;

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function fetchList(config: PetroappConfig, path: string): Promise<Record<string, unknown>[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(joinUrl(config.baseUrl, path), {
      headers: {
        Accept: 'application/json',
        // نرسل المفتاح بالصيغتين الشائعتين — الخادم يقرأ ما يعرفه ويتجاهل الآخر
        Authorization: `Bearer ${config.apiKey}`,
        'X-API-Key': config.apiKey,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    const body: unknown = await res.json();
    return extractArray(body);
  } finally {
    clearTimeout(timer);
  }
}

/** يستخرج المصفوفة من أشكال الاستجابة الشائعة دون افتراض شكل واحد (مُصدَّر للاختبار) */
export function extractArray(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const k of ['data', 'result', 'results', 'items', 'bills', 'vehicles', 'delegates']) {
      const v = o[k];
      if (Array.isArray(v)) return v as Record<string, unknown>[];
      if (v && typeof v === 'object') {
        const inner = (v as Record<string, unknown>).items ?? (v as Record<string, unknown>).data;
        if (Array.isArray(inner)) return inner as Record<string, unknown>[];
      }
    }
  }
  return [];
}

// ═══ قراءة الحقول بأسماء مرشّحة (الوثائق غير علنية) ═══

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    // شكل متداخل شائع: {vehicle:{id,plate}}
    const [head, tail] = k.split('.');
    if (tail && o[head] && typeof o[head] === 'object') {
      const v = (o[head] as Record<string, unknown>)[tail];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

const str = (v: unknown): string | undefined => (v === undefined ? undefined : String(v));
const num = (v: unknown): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
const when = (v: unknown): Date | undefined => {
  if (v === undefined) return undefined;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const ID_KEYS = ['id', 'uuid', 'external_id'];
const F = {
  vehicleId: [...ID_KEYS, 'vehicle_id'],
  plate: ['plate', 'plate_number', 'car_number', 'number_plate', 'plateNumber'],
  model: ['model', 'car_model', 'vehicle_model', 'name'],
  delegateName: ['name', 'delegate_name', 'driver_name', 'full_name'],
  phone: ['phone', 'mobile', 'phone_number'],
  billVehicle: ['vehicle_id', 'vehicle.id', 'car_id', 'vehicle'],
  billDelegate: ['delegate_id', 'delegate.id', 'driver_id', 'delegate'],
  amount: ['amount', 'total', 'total_amount', 'price', 'cost', 'value'],
  liters: ['liters', 'litres', 'quantity', 'qty', 'fuel_quantity'],
  odometer: ['odometer', 'meter', 'km', 'mileage', 'odometer_reading'],
  station: ['station_name', 'station', 'location_name', 'station.name', 'location.name'],
  date: ['date', 'created_at', 'bill_date', 'transaction_date', 'createdAt', 'time'],
  tripBalance: ['balance', 'remaining', 'remaining_balance', 'current_balance'],
  tripVehicle: ['vehicle_id', 'vehicle.id'],
  tripDelegate: ['delegate_id', 'delegate.id'],
};

// ═══ اختبار الاتصال ═══

export async function testPetroappConnection(config: PetroappConfig): Promise<{ ok: boolean; message: string; count?: number }> {
  try {
    const rows = await fetchList(config, '/vehicles');
    return { ok: true, message: `الاتصال ناجح — ${rows.length} مركبة`, count: rows.length };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ═══ المزامنة ═══

type Integration = NonNullable<Awaited<ReturnType<typeof prisma.petroappIntegration.findUnique>>>;

/**
 * بصمة إزالة التكرار: من المعرّف الخارجي إن وُجد، وإلا من الحقول الثابتة.
 * فريدة داخل الشركة فقط (tenantId في القيد الفريد لا في البصمة) — درس العزل.
 */
export function billContentHash(kind: string, row: Record<string, unknown>): string {
  const ext = str(pick(row, ID_KEYS));
  const basis = ext
    ? `${kind}:${ext}`
    : `${kind}:${str(pick(row, F.date)) ?? ''}:${num(pick(row, F.amount)) ?? ''}:${str(pick(row, F.billVehicle)) ?? ''}:${str(pick(row, F.station)) ?? ''}`;
  return crypto.createHash('sha1').update(basis).digest('hex');
}

interface StepResult { step: string; count: number; error?: string }

async function syncVehicles(cfg: PetroappConfig, integ: Integration): Promise<StepResult> {
  const rows = await fetchList(cfg, '/vehicles');
  let count = 0;
  for (const row of rows) {
    const externalId = str(pick(row, F.vehicleId));
    if (!externalId) continue;
    await prisma.petroappVehicle.upsert({
      where: { tenantId_externalId: { tenantId: integ.tenantId, externalId } },
      create: {
        tenantId: integ.tenantId, integrationId: integ.id, externalId,
        plate: str(pick(row, F.plate)), model: str(pick(row, F.model)),
      },
      update: { plate: str(pick(row, F.plate)), model: str(pick(row, F.model)) },
    });
    count++;
  }
  return { step: 'vehicles', count };
}

async function syncDelegates(cfg: PetroappConfig, integ: Integration): Promise<StepResult> {
  const rows = await fetchList(cfg, '/delegates');
  let count = 0;
  for (const row of rows) {
    const externalId = str(pick(row, ID_KEYS));
    if (!externalId) continue;
    await prisma.petroappDelegate.upsert({
      where: { tenantId_externalId: { tenantId: integ.tenantId, externalId } },
      create: {
        tenantId: integ.tenantId, integrationId: integ.id, externalId,
        name: str(pick(row, F.delegateName)), phone: str(pick(row, F.phone)),
      },
      update: { name: str(pick(row, F.delegateName)), phone: str(pick(row, F.phone)) },
    });
    count++;
  }
  return { step: 'delegates', count };
}

/** أرصدة الرحلات الحيّة على المركبة/السائق — يقرأها تبويب الوقود عند المندوب */
async function syncTrips(cfg: PetroappConfig, integ: Integration): Promise<StepResult> {
  const rows = await fetchList(cfg, '/updated_trips');
  let count = 0;
  const now = new Date();
  for (const row of rows) {
    const balance = num(pick(row, F.tripBalance));
    if (balance === undefined) continue;
    const vehicleExt = str(pick(row, F.tripVehicle));
    const delegateExt = str(pick(row, F.tripDelegate));
    if (vehicleExt) {
      await prisma.petroappVehicle.updateMany({
        where: { tenantId: integ.tenantId, externalId: vehicleExt },
        data: { balance, balanceAt: now },
      });
      count++;
    }
    if (delegateExt) {
      await prisma.petroappDelegate.updateMany({
        where: { tenantId: integ.tenantId, externalId: delegateExt },
        data: { balance, balanceAt: now },
      });
      count++;
    }
  }
  return { step: 'trips', count };
}

async function syncBills(cfg: PetroappConfig, integ: Integration, path: string, kind: 'FUEL' | 'SERVICE' | 'WASH'): Promise<StepResult> {
  const rows = await fetchList(cfg, path);
  // خرائط الربط تُحمَّل مرة واحدة لكل دفعة — نسب الفاتورة لمندوبها لحظة الإدخال
  const [vehicles, delegates] = await Promise.all([
    prisma.petroappVehicle.findMany({ where: { tenantId: integ.tenantId, salesRepId: { not: null } }, select: { externalId: true, salesRepId: true } }),
    prisma.petroappDelegate.findMany({ where: { tenantId: integ.tenantId, salesRepId: { not: null } }, select: { externalId: true, salesRepId: true } }),
  ]);
  const vehRep = new Map(vehicles.map(v => [v.externalId, v.salesRepId]));
  const delRep = new Map(delegates.map(d => [d.externalId, d.salesRepId]));

  let count = 0;
  for (const row of rows) {
    const contentHash = billContentHash(kind, row);
    const vehicleExternalId = str(pick(row, F.billVehicle));
    const delegateExternalId = str(pick(row, F.billDelegate));
    const salesRepId = (delegateExternalId && delRep.get(delegateExternalId)) || (vehicleExternalId && vehRep.get(vehicleExternalId)) || null;
    const created = await prisma.fuelTransaction.upsert({
      where: { tenantId_contentHash: { tenantId: integ.tenantId, contentHash } },
      create: {
        tenantId: integ.tenantId, integrationId: integ.id, kind, contentHash,
        externalId: str(pick(row, ID_KEYS)),
        vehicleExternalId, delegateExternalId, salesRepId,
        stationName: str(pick(row, F.station)),
        liters: kind === 'FUEL' ? num(pick(row, F.liters)) : undefined,
        amount: num(pick(row, F.amount)) ?? 0,
        odometer: num(pick(row, F.odometer)) !== undefined ? Math.round(num(pick(row, F.odometer)) as number) : undefined,
        occurredAt: when(pick(row, F.date)) ?? new Date(),
        raw: JSON.stringify(row).slice(0, 4000),
      },
      update: {}, // الفاتورة الموجودة لا تُعدَّل — سجلّ مالي
    });
    if (created) count++;
  }
  return { step: path.replace(/^\//, ''), count };
}

/** كاش المحطات — قائمة كبيرة تتغيّر نادراً؛ تُجدَّد كل ٢٤ ساعة */
const STATIONS_TTL_MS = 24 * 3600_000;

async function syncStations(cfg: PetroappConfig, integ: Integration): Promise<StepResult> {
  if (integ.stationsAt && Date.now() - integ.stationsAt.getTime() < STATIONS_TTL_MS) {
    return { step: 'stations', count: 0 };
  }
  const rows = await fetchList(cfg, '/petroapp_locations');
  const slim = rows.map(r => ({
    name: str(pick(r, ['name', 'station_name', 'title'])),
    lat: num(pick(r, ['lat', 'latitude'])),
    lng: num(pick(r, ['lng', 'lon', 'longitude'])),
    services: str(pick(r, ['services', 'service_types', 'type'])),
    city: str(pick(r, ['city', 'region'])),
  })).filter(s => s.lat !== undefined && s.lng !== undefined);
  await prisma.petroappIntegration.update({
    where: { id: integ.id },
    data: { stationsJson: JSON.stringify(slim), stationsAt: new Date() },
  });
  return { step: 'stations', count: slim.length };
}

/**
 * مزامنة شركة واحدة — كل خطوة مستقلّة الفشل (كموصل Odoo): تعطّل نقطة لا يُسقط البقية،
 * والحالة النهائية OK إن نجحت أي خطوة، وERROR فقط إن فشل كل شيء.
 */
export async function syncPetroappTenant(tenantId: string): Promise<{ ok: boolean; steps: StepResult[] }> {
  const integ = await prisma.petroappIntegration.findUnique({ where: { tenantId } });
  if (!integ || !integ.enabled || !integ.apiKey) return { ok: false, steps: [{ step: 'config', count: 0, error: 'غير مفعّل أو بلا مفتاح' }] };
  const cfg: PetroappConfig = { baseUrl: integ.baseUrl, apiKey: integ.apiKey };

  const steps: StepResult[] = [];
  const run = async (fn: () => Promise<StepResult>, label: string) => {
    try { steps.push(await fn()); }
    catch (e) { steps.push({ step: label, count: 0, error: e instanceof Error ? e.message : String(e) }); }
  };

  await run(() => syncVehicles(cfg, integ), 'vehicles');
  await run(() => syncDelegates(cfg, integ), 'delegates');
  await run(() => syncTrips(cfg, integ), 'trips');
  if (integ.syncFuel) await run(() => syncBills(cfg, integ, '/bills', 'FUEL'), 'bills');
  if (integ.syncService) await run(() => syncBills(cfg, integ, '/service_bills', 'SERVICE'), 'service_bills');
  if (integ.syncWash) await run(() => syncBills(cfg, integ, '/washing_bills', 'WASH'), 'washing_bills');
  await run(() => syncStations(cfg, integ), 'stations');

  const failures = steps.filter(s => s.error);
  const ok = failures.length < steps.length;
  await prisma.petroappIntegration.update({
    where: { id: integ.id },
    data: {
      status: ok ? 'OK' : 'ERROR',
      lastSyncAt: new Date(),
      lastError: failures.length ? failures.map(f => `${f.step}: ${f.error}`).join(' | ').slice(0, 900) : null,
    },
  });
  return { ok, steps };
}

/** إعادة نسب الفواتير بعد تغيير ربط مركبة/سائق بمندوب */
export async function reattributeFuel(tenantId: string): Promise<number> {
  const [vehicles, delegates] = await Promise.all([
    prisma.petroappVehicle.findMany({ where: { tenantId }, select: { externalId: true, salesRepId: true } }),
    prisma.petroappDelegate.findMany({ where: { tenantId }, select: { externalId: true, salesRepId: true } }),
  ]);
  let changed = 0;
  // السائق أدقّ من المركبة (المركبة قد يتناوب عليها سائقون) — لذا يُطبَّق أخيراً ليغلب
  for (const v of vehicles) {
    const r = await prisma.fuelTransaction.updateMany({
      where: { tenantId, vehicleExternalId: v.externalId, delegateExternalId: null },
      data: { salesRepId: v.salesRepId },
    });
    changed += r.count;
  }
  for (const d of delegates) {
    const r = await prisma.fuelTransaction.updateMany({
      where: { tenantId, delegateExternalId: d.externalId },
      data: { salesRepId: d.salesRepId },
    });
    changed += r.count;
  }
  return changed;
}

// ═══ المجدول — كل ٣٠ دقيقة لكل الشركات المفعّلة، تسلسلياً بقفل ضد التداخل ═══

const SYNC_INTERVAL_MS = 30 * 60_000;
let syncing = false;

async function syncAllTenants() {
  if (syncing) return; // دورة سابقة ما زالت تعمل
  syncing = true;
  try {
    const integrations = await prisma.petroappIntegration.findMany({
      where: { enabled: true, apiKey: { not: null } },
      select: { tenantId: true },
    });
    for (const { tenantId } of integrations) {
      try { await syncPetroappTenant(tenantId); }
      catch (e) { console.error(`petroapp sync (${tenantId}):`, e); }
    }
  } catch (e) {
    console.error('petroapp scheduler error:', e);
  } finally {
    syncing = false;
  }
}

export function startPetroappScheduler() {
  setInterval(() => { void syncAllTenants(); }, SYNC_INTERVAL_MS);
  console.log('⛽ PetroApp scheduler started (sync every 30min for linked tenants)');
}
