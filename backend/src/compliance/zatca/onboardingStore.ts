// ============================================================================
// ZATCA المرحلة الثانية (Z4) — مخزن وحدات EGS للربط: الواجهة ومحوّل Prisma ومخزن ذاكرة للاختبار
// ----------------------------------------------------------------------------
// design §3 Z4 + §1.3 (النماذج ZatcaEgsUnit وZatcaApiLog وحقول البائع في CompanySettings):
//   • EgsUnitStore يغطّي ما يحتاجه onboarding.ts فقط — لا أكثر.
//   • الانتقالات compare-and-set: updateMany حيث (id، الحالة المتوقَّعة[، updatedAt المتوقَّع]) ويُعاد هل طُبِّق.
//     updatedAt يُكتب صراحةً بقيمة يحسبها المستدعي (أكبر تماماً من السابقة) فيصير رمز نسخة: عمليتا ربط متزامنتان
//     قرأتا النسخة نفسها لا تتقدّمان معاً أبداً، ومنفّذ متعطّل عاد بعد استيلاء غيره لا يكتب فوقه.
//   • القراءة العامة (loadUnit/listUnits) لا تختار أبداً privateKeyEnc ولا الأسرار ولا الرموز؛ loadUnitCredentials
//     وحدها تختارها، ولا يستدعيها إلا من يستعملها فوراً.
//   • لا OTP في أي عمود أو واجهة هنا إطلاقاً؛ صفوف السجلّ تصل منقّحة من onboarding.ts.
//   • فخّ Prisma (§1.3 قاعدة 6): { col: { not: 'X' } } يُسقط صفوف NULL. لا مرشّح «not» هنا على عمود قابل للإفراغ؛
//     و{ zatcaPhase2StartedAt: null } يُترجَم IS NULL (صحيح).
//   • محوّل Prisma يُفحص نوعياً فقط ولا يُنفَّذ في الاختبارات (لا اتصال بقاعدة البيانات إطلاقاً). الاستيراد نوعي
//     (import type) فلا يُحمَّل @prisma/client في وقت التشغيل من هذا الملف؛ ولا يُكتب JSON null (بلا Prisma.JsonNull).
//   • «وحدة واحدة قيد الربط أو مفعّلة لكل شركة وبيئة» (design Z5.3) يُفرض داخل المخزن: createUnitIfNone يفحص ويُدرج
//     ذرّياً (معاملة Serializable في المحوّل؛ خطوة متزامنة واحدة في مخزن الذاكرة) — لا فحص-ثم-إدراج في الخدمة.
//   • complianceSteps (JSON عام للواجهة) قد يحمل علامتَي «طلب جارٍ» و«مرحلة التجديد» (onboarding.ts) — نصوصاً ومعرّفات
//     فقط، لا مفتاحاً ولا سرّاً (مشفّراً أو صريحاً).
// ============================================================================

import type { Prisma, PrismaClient } from '@prisma/client';

// ─── الأنواع ───

/** design §3 Z4 «Unit state machine». DRAFT لا يُكتب من createUnit (الصفّ يُنشأ مكتملاً في CSR_READY). */
export const EGS_UNIT_STATUSES = Object.freeze([
  'DRAFT', 'CSR_READY', 'CCSID_ISSUED', 'CHECKS_RUNNING', 'CHECKS_PASSED', 'ERROR_NEEDS_OTP',
  'ACTIVE', 'RENEWING', 'AUTH_FAILED', 'EXPIRED', 'REVOKED',
] as const);
export type EgsUnitStatus = (typeof EGS_UNIT_STATUSES)[number];

/** حقول CompanySettings التي يحتاجها الربط (بائع + دولة + عملة + مزوّد + تاريخ التفعيل). */
export interface SellerSettingsRecord {
  tenantId: string;
  legalName: string | null;
  taxNumber: string | null;
  commercialReg: string | null;
  sellerIdScheme: string | null;
  sellerIdValue: string | null;
  addrStreet: string | null;
  addrBuildingNo: string | null;
  addrAdditionalNo: string | null;
  addrDistrict: string | null;
  addrCity: string | null;
  addrPostalCode: string | null;
  vatGroupTin: string | null;
  countryCode: string;
  currency: string;
  currencyOverride: string | null;
  einvoiceProvider: string;
  zatcaPhase2StartedAt: Date | null;
}

/** صفّ الوحدة بلا مفتاح خاص ولا أسرار ولا رموز. updatedAt = رمز النسخة لـCAS. */
export interface EgsUnitRecord {
  id: string;
  tenantId: string;
  kind: string;
  environment: string;
  commonName: string;
  serialNumber: string;
  functionMap: string;
  orgName: string;
  orgUnit: string;
  vatNumber: string;
  locationAddress: string;
  industry: string;
  status: string;
  keyVersion: number;
  publicKeyPem: string | null;
  csrPem: string | null;
  complianceRequestId: string | null;
  complianceSteps: unknown;
  certSerial: string | null;
  certNotBefore: Date | null;
  certNotAfter: Date | null;
  lastIcv: number;
  lastInvoiceHash: string | null;
  activatedAt: Date | null;
  revokedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** ما يُقرأ فقط لحظة الاستعمال: المفتاح المشفّر، والرمزان (شهادتان)، والسرّان المشفّران. */
export interface EgsUnitCredentials {
  privateKeyEnc: string | null;
  complianceToken: string | null;
  complianceSecretEnc: string | null;
  productionToken: string | null;
  productionSecretEnc: string | null;
}

/** وحدة جديدة مكتملة (المفتاح مشفّر مسبقاً — المخزن لا يرى نصاً صريحاً أبداً). */
export interface NewEgsUnit {
  id: string;
  tenantId: string;
  kind: 'SERVER';
  environment: string;
  commonName: string;
  serialNumber: string;
  functionMap: string;
  orgName: string;
  orgUnit: string;
  vatNumber: string;
  locationAddress: string;
  industry: string;
  status: EgsUnitStatus;
  keyVersion: number;
  privateKeyEnc: string;
  publicKeyPem: string;
  csrPem: string;
  complianceSteps: Record<string, unknown>;
}

/** الحقول التي يكتبها الربط والتجديد. undefined = لا تغيير؛ null = إفراغ (أعمدة نصّية/زمنية فقط). */
export interface EgsUnitPatch {
  status?: EgsUnitStatus;
  keyVersion?: number;
  orgName?: string;
  orgUnit?: string;
  locationAddress?: string;
  industry?: string;
  privateKeyEnc?: string;
  publicKeyPem?: string;
  csrPem?: string;
  complianceRequestId?: string | null;
  complianceToken?: string | null;
  complianceSecretEnc?: string | null;
  /** كائن تقدّم الفحوص (لا null: الإفراغ = كائن تقدّم فارغ). */
  complianceSteps?: Record<string, unknown>;
  productionToken?: string | null;
  productionSecretEnc?: string | null;
  certSerial?: string | null;
  certNotBefore?: Date | null;
  certNotAfter?: Date | null;
  activatedAt?: Date | null;
  /** يُضبط مع REVOKED (retireUnit). */
  revokedAt?: Date | null;
  lastError?: string | null;
}

/** نتيجة createUnitIfNone: أُنشئت الوحدة، أو وُجدت وحدة مانعة (الأقدم) فلم يُكتب شيء. */
export type CreateUnitIfNoneResult = { created: true; unit: EgsUnitRecord } | { created: false; existing: EgsUnitRecord };

export interface CasExpectation {
  status: string;
  /** إن وُجد: updatedAt يجب أن يساويه بالضبط (رمز نسخة). غيابه = CAS على الحالة وحدها (مطالبة من حالة ساكنة). */
  updatedAt?: Date;
}

export interface UnitFilter {
  environment?: string;
  statuses?: readonly string[];
}

/** صفّ ZatcaApiLog كما يُكتب (منقّح مسبقاً). */
export interface ApiLogRow {
  tenantId: string;
  egsUnitId: string | null;
  actorId: string | null;
  endpoint: string;
  httpStatus: number | null;
  outcome: string;
  durationMs: number | null;
  response: Record<string, unknown> | null;
  errorText: string | null;
  at: Date;
}

export interface EgsUnitStore {
  loadSellerSettings(tenantId: string): Promise<SellerSettingsRecord | null>;
  /**
   * يُنشئ الوحدة فقط إن لم توجد للشركة في البيئة نفسها وحدة بإحدى blockingStatuses — فحصاً وإدراجاً ذرّياً
   * (طلبا إنشاء متزامنان لا يُنتجان وحدتين: المعرّف التسلسلي فريد لكل وحدة فلا يلتقطهما القيد الفريد).
   */
  createUnitIfNone(unit: NewEgsUnit, at: Date, blockingStatuses: readonly string[]): Promise<CreateUnitIfNoneResult>;
  loadUnit(unitId: string): Promise<EgsUnitRecord | null>;
  loadUnitCredentials(unitId: string): Promise<EgsUnitCredentials | null>;
  listUnits(tenantId: string, filter?: UnitFilter): Promise<EgsUnitRecord[]>;
  /** يطبّق patch ويكتب updatedAt = at فقط إن طابق الصفّ التوقّعات؛ يعيد هل طُبِّق (صفّ واحد بالضبط). */
  compareAndSetUnit(unitId: string, expect: CasExpectation, patch: EgsUnitPatch, at: Date): Promise<boolean>;
  countUnitDocuments(unitId: string, statuses: readonly string[]): Promise<number>;
  writeApiLog(row: ApiLogRow): Promise<void>;
  /** يضبط zatcaPhase2StartedAt مرة واحدة (حيث هو NULL)؛ يعيد القيمة الفعلية بعد المحاولة. */
  setPhase2StartedAtOnce(tenantId: string, at: Date): Promise<{ applied: boolean; startedAt: Date | null }>;
}

// ─── محوّل Prisma (يُفحص نوعياً ولا يُنفَّذ في الاختبارات) ───

type PrismaLike = Pick<PrismaClient, 'companySettings' | 'zatcaEgsUnit' | 'zatcaDocument' | 'zatcaApiLog' | '$transaction'>;

/** إعادات createUnitIfNone عند فشل التسلسل (Postgres 40001 ⇒ Prisma P2034) قبل رمي الخطأ. */
const CREATE_SERIALIZATION_ATTEMPTS = 3;

const SELLER_SELECT = {
  tenantId: true, legalName: true, taxNumber: true, commercialReg: true, sellerIdScheme: true, sellerIdValue: true,
  addrStreet: true, addrBuildingNo: true, addrAdditionalNo: true, addrDistrict: true, addrCity: true, addrPostalCode: true,
  vatGroupTin: true, countryCode: true, currency: true, currencyOverride: true, einvoiceProvider: true, zatcaPhase2StartedAt: true,
} satisfies Prisma.CompanySettingsSelect;

/** كل أعمدة الوحدة العامة — privateKeyEnc والرموز والأسرار غائبة عمداً. */
const UNIT_PUBLIC_SELECT = {
  id: true, tenantId: true, kind: true, environment: true, commonName: true, serialNumber: true, functionMap: true, orgName: true,
  orgUnit: true, vatNumber: true, locationAddress: true, industry: true, status: true, keyVersion: true, publicKeyPem: true, csrPem: true,
  complianceRequestId: true, complianceSteps: true, certSerial: true, certNotBefore: true, certNotAfter: true, lastIcv: true,
  lastInvoiceHash: true, activatedAt: true, revokedAt: true, lastError: true, createdAt: true, updatedAt: true,
} satisfies Prisma.ZatcaEgsUnitSelect;

const UNIT_CREDENTIALS_SELECT = {
  privateKeyEnc: true, complianceToken: true, complianceSecretEnc: true, productionToken: true, productionSecretEnc: true,
} satisfies Prisma.ZatcaEgsUnitSelect;

function prismaPatch(patch: EgsUnitPatch, at: Date): Prisma.ZatcaEgsUnitUpdateManyMutationInput {
  const data: Prisma.ZatcaEgsUnitUpdateManyMutationInput = { updatedAt: at };
  const keys: Array<Exclude<keyof EgsUnitPatch, 'complianceSteps'>> = [
    'status', 'keyVersion', 'orgName', 'orgUnit', 'locationAddress', 'industry', 'privateKeyEnc', 'publicKeyPem', 'csrPem',
    'complianceRequestId', 'complianceToken', 'complianceSecretEnc', 'productionToken', 'productionSecretEnc', 'certSerial',
    'certNotBefore', 'certNotAfter', 'activatedAt', 'revokedAt', 'lastError',
  ];
  const out = data as Record<string, unknown>;
  for (const k of keys) if (patch[k] !== undefined) out[k] = patch[k];
  if (patch.complianceSteps !== undefined) data.complianceSteps = patch.complianceSteps as Prisma.InputJsonObject;
  return data;
}

/** EgsUnitStore فوق نماذج Prisma الملتزَمة. لا يتصل بشيء عند الإنشاء؛ كل دالة استعلام واحد (أو اثنان لـsetPhase2StartedAtOnce). */
export function prismaEgsUnitStore(prisma: PrismaLike): EgsUnitStore {
  return {
    async loadSellerSettings(tenantId) {
      return prisma.companySettings.findUnique({ where: { tenantId }, select: SELLER_SELECT });
    },
    async createUnitIfNone(unit, at, blockingStatuses) {
      // Serializable: معاملتان تقرآن «لا وحدة مانعة» ثم تُدرجان تتعارضان (SSI) فيفشل إحداهما بـP2034 وتُعاد فترى
      // الأخرى. لا استعلام خام ولا قفل بكتابة صورية على company_settings (كانت ستغيّر updatedAt للإعدادات).
      for (let attempt = 1; ; attempt++) {
        try {
          return await prisma.$transaction(async tx => {
            const existing = await tx.zatcaEgsUnit.findFirst({
              where: { tenantId: unit.tenantId, environment: unit.environment, status: { in: [...blockingStatuses] } },
              select: UNIT_PUBLIC_SELECT,
              orderBy: { createdAt: 'asc' },
            });
            if (existing) return { created: false as const, existing };
            const created = await tx.zatcaEgsUnit.create({
              data: {
                id: unit.id, tenantId: unit.tenantId, kind: unit.kind, environment: unit.environment, commonName: unit.commonName,
                serialNumber: unit.serialNumber, functionMap: unit.functionMap, orgName: unit.orgName, orgUnit: unit.orgUnit,
                vatNumber: unit.vatNumber, locationAddress: unit.locationAddress, industry: unit.industry, status: unit.status,
                keyVersion: unit.keyVersion, privateKeyEnc: unit.privateKeyEnc, publicKeyPem: unit.publicKeyPem, csrPem: unit.csrPem,
                complianceSteps: unit.complianceSteps as Prisma.InputJsonObject, createdAt: at, updatedAt: at,
              },
              select: UNIT_PUBLIC_SELECT,
            });
            return { created: true as const, unit: created };
          }, { isolationLevel: 'Serializable' });
        } catch (e) {
          const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
          if (code === 'P2034' && attempt < CREATE_SERIALIZATION_ATTEMPTS) continue;
          throw e;
        }
      }
    },
    async loadUnit(unitId) {
      return prisma.zatcaEgsUnit.findUnique({ where: { id: unitId }, select: UNIT_PUBLIC_SELECT });
    },
    async loadUnitCredentials(unitId) {
      return prisma.zatcaEgsUnit.findUnique({ where: { id: unitId }, select: UNIT_CREDENTIALS_SELECT });
    },
    async listUnits(tenantId, filter = {}) {
      return prisma.zatcaEgsUnit.findMany({
        where: {
          tenantId,
          ...(filter.environment !== undefined ? { environment: filter.environment } : {}),
          ...(filter.statuses !== undefined ? { status: { in: [...filter.statuses] } } : {}),
        },
        select: UNIT_PUBLIC_SELECT,
        orderBy: { createdAt: 'asc' },
      });
    },
    async compareAndSetUnit(unitId, expect, patch, at) {
      // UPDATE … WHERE id AND status [AND "updatedAt"] — ذرّي في عبارة واحدة؛ صفّ واحد أو لا شيء
      const r = await prisma.zatcaEgsUnit.updateMany({
        where: { id: unitId, status: expect.status, ...(expect.updatedAt !== undefined ? { updatedAt: expect.updatedAt } : {}) },
        data: prismaPatch(patch, at),
      });
      return r.count === 1;
    },
    async countUnitDocuments(unitId, statuses) {
      return prisma.zatcaDocument.count({ where: { egsUnitId: unitId, status: { in: [...statuses] } } });
    },
    async writeApiLog(row) {
      await prisma.zatcaApiLog.create({
        data: {
          tenantId: row.tenantId, egsUnitId: row.egsUnitId, documentId: null, actorId: row.actorId, endpoint: row.endpoint,
          httpStatus: row.httpStatus, outcome: row.outcome, durationMs: row.durationMs,
          // null ⇒ يُترك العمود على قيمته الافتراضية (NULL) بدل Prisma.JsonNull
          response: row.response === null ? undefined : (row.response as Prisma.InputJsonObject),
          errorText: row.errorText, createdAt: row.at,
        },
      });
    },
    async setPhase2StartedAtOnce(tenantId, at) {
      const r = await prisma.companySettings.updateMany({ where: { tenantId, zatcaPhase2StartedAt: null }, data: { zatcaPhase2StartedAt: at } });
      if (r.count === 1) return { applied: true, startedAt: at };
      const s = await prisma.companySettings.findUnique({ where: { tenantId }, select: { zatcaPhase2StartedAt: true } });
      return { applied: false, startedAt: s?.zatcaPhase2StartedAt ?? null };
    },
  };
}

// ─── مخزن الذاكرة (للاختبارات) ───

/** الصفّ كما يحفظه مخزن الذاكرة (كل الأعمدة، ومنها المشفّرة) — للفحص في الاختبارات فقط. */
export interface MemoryUnitRow extends EgsUnitRecord, EgsUnitCredentials {}

export interface MemoryStoreHooks {
  /** يُستدعى قبل كل CAS (لمحاكاة تداخل عامل آخر). */
  beforeCompareAndSet?: (unitId: string, expect: CasExpectation, patch: EgsUnitPatch) => void | Promise<void>;
}

export interface MemoryEgsUnitStore extends EgsUnitStore {
  readonly settings: Map<string, SellerSettingsRecord>;
  readonly units: Map<string, MemoryUnitRow>;
  readonly apiLogs: ApiLogRow[];
  /** كل حمولة وصلت المخزن (نسخ عميقة) — لإثبات أن المخزن لم يستلم نصاً صريحاً أو OTP. */
  readonly received: Array<{ op: string; payload: unknown }>;
  /** مستندات الوحدات (للانتظار أثناء التجديد): حالة لكل مستند. */
  readonly documents: Array<{ egsUnitId: string; status: string }>;
  readonly hooks: MemoryStoreHooks;
  /** عدد مرّات قراءة بيانات الاعتماد (لإثبات أن القراءة العامة لا تمسّها). */
  credentialReads: number;
}

function cloneValue<T>(v: T): T {
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T;
  if (Array.isArray(v)) return v.map(cloneValue) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = cloneValue(x);
    return out as T;
  }
  return v;
}

const PUBLIC_KEYS: ReadonlyArray<keyof EgsUnitRecord> = [
  'id', 'tenantId', 'kind', 'environment', 'commonName', 'serialNumber', 'functionMap', 'orgName', 'orgUnit', 'vatNumber',
  'locationAddress', 'industry', 'status', 'keyVersion', 'publicKeyPem', 'csrPem', 'complianceRequestId', 'complianceSteps',
  'certSerial', 'certNotBefore', 'certNotAfter', 'lastIcv', 'lastInvoiceHash', 'activatedAt', 'revokedAt', 'lastError', 'createdAt', 'updatedAt',
];

function publicView(row: MemoryUnitRow): EgsUnitRecord {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_KEYS) out[k] = cloneValue(row[k]);
  return out as unknown as EgsUnitRecord;
}

/** مخزن في الذاكرة بدلالات المحوّل نفسها (CAS بالحالة والنسخة، ضبط مرة واحدة، لا أسرار في القراءة العامة). */
export function memoryEgsUnitStore(init: { settings?: SellerSettingsRecord[] } = {}): MemoryEgsUnitStore {
  const settings = new Map<string, SellerSettingsRecord>();
  for (const s of init.settings ?? []) settings.set(s.tenantId, cloneValue(s));
  const units = new Map<string, MemoryUnitRow>();
  const apiLogs: ApiLogRow[] = [];
  const received: Array<{ op: string; payload: unknown }> = [];
  const documents: Array<{ egsUnitId: string; status: string }> = [];
  const hooks: MemoryStoreHooks = {};
  // تنازل لحلقة الأحداث كقاعدة بيانات حقيقية (يسمح بتداخل الاستدعاءات المتزامنة في الاختبار)
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));

  const store: MemoryEgsUnitStore = {
    settings, units, apiLogs, received, documents, hooks, credentialReads: 0,
    async loadSellerSettings(tenantId) {
      await tick();
      const s = settings.get(tenantId);
      return s ? cloneValue(s) : null;
    },
    async createUnitIfNone(unit, at, blockingStatuses) {
      received.push({ op: 'createUnitIfNone', payload: cloneValue(unit) });
      await tick();
      // الفحص والإدراج في خطوة متزامنة واحدة بلا تنازل بينهما = ذرّي (كمعاملة Serializable في المحوّل)
      const blocking = [...units.values()]
        .filter(u => u.tenantId === unit.tenantId && u.environment === unit.environment && blockingStatuses.includes(u.status))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (blocking.length) return { created: false, existing: publicView(blocking[0]) };
      if (units.has(unit.id)) throw new Error('unique constraint: id');
      for (const u of units.values()) {
        if (u.tenantId === unit.tenantId && u.environment === unit.environment && u.serialNumber === unit.serialNumber) {
          throw new Error('unique constraint: tenantId, environment, serialNumber');
        }
      }
      const row: MemoryUnitRow = {
        id: unit.id, tenantId: unit.tenantId, kind: unit.kind, environment: unit.environment, commonName: unit.commonName,
        serialNumber: unit.serialNumber, functionMap: unit.functionMap, orgName: unit.orgName, orgUnit: unit.orgUnit,
        vatNumber: unit.vatNumber, locationAddress: unit.locationAddress, industry: unit.industry, status: unit.status,
        keyVersion: unit.keyVersion, publicKeyPem: unit.publicKeyPem, csrPem: unit.csrPem, complianceRequestId: null,
        complianceSteps: cloneValue(unit.complianceSteps), certSerial: null, certNotBefore: null, certNotAfter: null, lastIcv: 0,
        lastInvoiceHash: null, activatedAt: null, revokedAt: null, lastError: null, createdAt: new Date(at.getTime()),
        updatedAt: new Date(at.getTime()), privateKeyEnc: unit.privateKeyEnc, complianceToken: null, complianceSecretEnc: null,
        productionToken: null, productionSecretEnc: null,
      };
      units.set(unit.id, row);
      return { created: true, unit: publicView(row) };
    },
    async loadUnit(unitId) {
      await tick();
      const row = units.get(unitId);
      return row ? publicView(row) : null;
    },
    async loadUnitCredentials(unitId) {
      await tick();
      store.credentialReads++;
      const row = units.get(unitId);
      return row
        ? { privateKeyEnc: row.privateKeyEnc, complianceToken: row.complianceToken, complianceSecretEnc: row.complianceSecretEnc, productionToken: row.productionToken, productionSecretEnc: row.productionSecretEnc }
        : null;
    },
    async listUnits(tenantId, filter = {}) {
      await tick();
      return [...units.values()]
        .filter(u => u.tenantId === tenantId
          && (filter.environment === undefined || u.environment === filter.environment)
          && (filter.statuses === undefined || filter.statuses.includes(u.status)))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map(publicView);
    },
    async compareAndSetUnit(unitId, expect, patch, at) {
      received.push({ op: 'compareAndSetUnit', payload: cloneValue({ unitId, expect, patch, at }) });
      if (hooks.beforeCompareAndSet) await hooks.beforeCompareAndSet(unitId, cloneValue(expect), cloneValue(patch));
      await tick();
      const row = units.get(unitId);
      if (!row || row.status !== expect.status) return false;
      if (expect.updatedAt !== undefined && row.updatedAt.getTime() !== expect.updatedAt.getTime()) return false;
      const target = row as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) target[k] = cloneValue(v);
      row.updatedAt = new Date(at.getTime());
      return true;
    },
    async countUnitDocuments(unitId, statuses) {
      await tick();
      return documents.filter(d => d.egsUnitId === unitId && statuses.includes(d.status)).length;
    },
    async writeApiLog(row) {
      received.push({ op: 'writeApiLog', payload: cloneValue(row) });
      await tick();
      apiLogs.push(cloneValue(row));
    },
    async setPhase2StartedAtOnce(tenantId, at) {
      received.push({ op: 'setPhase2StartedAtOnce', payload: cloneValue({ tenantId, at }) });
      await tick();
      const s = settings.get(tenantId);
      if (!s) return { applied: false, startedAt: null };
      if (s.zatcaPhase2StartedAt === null) {
        s.zatcaPhase2StartedAt = new Date(at.getTime());
        return { applied: true, startedAt: new Date(at.getTime()) };
      }
      return { applied: false, startedAt: new Date(s.zatcaPhase2StartedAt.getTime()) };
    },
  };
  return store;
}
