/**
 * العميل الحارس لمعاينة «ربط الدفاتر» (L2 — العقد §10.3، D8).
 *
 * وكيل (Proxy) فوق معاملة اللقطة `REPEATABLE READ READ ONLY`: المندوبات التشغيلية (invoice، accountEntry، receipt…)
 * تمرّ إلى المعاملة كما هي — والكتابة فيها تفشل بالقاعدة نفسها — أمّا جداول الدفاتر gl* فلا تُقرأ من القاعدة أبداً:
 * الشركة غير مفعّلة، والمعاينة تبني دفاترها في الظلّ (shadowStore.ts)، فقائمة مغلقة تُخدم من الظلّ:
 *   - glSettings.findUnique({where:{tenantId}, select?}) ⇐ صفّ الإعدادات الافتراضي (LINKED عند T0)
 *   - glSourceEvent.createMany({data, skipDuplicates})  ⇐ إدراج في أحداث الظلّ (scanFutureDatedRows وfreezeOpeningSettlementSplits)
 *   - glSourceEvent.findMany({where:{tenantId, sourceType:'SETTLEMENT', payload:{path:['salesRepId'], equals}}, select?})
 *       ⇐ أحداث استلامات المندوب في الظلّ (PrismaPostingTx.loadCustodyInputs)
 * واستثناءٌ واحد يمرّ إلى القاعدة: أسماء الموردين `glVendor.findMany({where:{tenantId, id:{in}}, select:{id?, name?}})` —
 * gl_vendors سجلّ الموردين التشغيلي (L1، لا يمسحه ضبط الدفاتر ولا يحمل رصيداً)، والاسم للعرض في تعمّق R10 وحده.
 * وكل وصول gl* آخر — مباشرةً أو **متداخلاً** في وسائط مندوبٍ تشغيلي (علاقة include/select/where إلى نموذج Gl*: علاقات
 * Tenant العكسية gl*، و`vendor` ⇒ GlVendor) — وكل $executeRaw (عبارة SET الأولى تُنفَّذ على المعاملة قبل إنشاء الوكيل)،
 * وكل SQL خام يذكر جدول gl_*، يُسجَّل في الظلّ ويرمي ShadowGlAccessError: فشلٌ مغلق — المعاينة FAILED(SHADOW_GL_ACCESS)
 * لا رقمٌ كاذب. التسجيل لازم لأن المُرحِّل يبتلع أخطاء الحدث (ERROR) فلا يصل الرمي وحده إلى runPreview.
 */
import type { Prisma } from '@prisma/client';
import type { ShadowState } from './shadowStore';

export class ShadowGlAccessError extends Error {
  readonly code = 'SHADOW_GL_ACCESS' as const;
  constructor(readonly access: string) {
    super(`وصول غير مدعوم إلى جداول الدفاتر من داخل المعاينة: ${access}`);
    this.name = 'ShadowGlAccessError';
  }
}

/** مندوب Prisma لجدول دفاتر (glSettings، glMove، glSourceEvent…) */
export const GL_DELEGATE_RE = /^gl[A-Z]/;
/** جدول دفاتر في SQL خام (gl_settings، "gl_move_lines"…) */
export const GL_TABLE_SQL_RE = /\bgl_[a-z0-9_]+/i;
/**
 * حقول علاقةٍ من نموذج تشغيلي إلى نموذج Gl* لا يبدأ اسمها بـgl (علاقات Tenant العكسية كلها gl* فيلتقطها GL_DELEGATE_RE):
 * WarehouseEntry/SupplierLedgerEntry/SupplierPayment.vendor ⇒ GlVendor. والاسم لا يُستعمل لغيرها في المخطط، فالفحص لا
 * يحتاج النموذج. اختبار linking-shadow يشتقّ القائمة من schema.prisma: علاقةٌ جديدة (L4/L6) تُفشله حتى تُضاف هنا.
 */
export const GL_RELATION_FIELD_NAMES: ReadonlySet<string> = new Set(['vendor']);

type AnyFn = (...args: unknown[]) => unknown;

/** نص SQL من استدعاء خام: قالب موسوم أو Prisma.sql أو نصّ */
export function rawSqlText(args: readonly unknown[]): string {
  const a = args[0] as unknown;
  if (typeof a === 'string') return a;
  if (Array.isArray(a)) return (a as string[]).join('?');
  if (a && typeof a === 'object') {
    const o = a as { strings?: unknown; sql?: unknown };
    if (Array.isArray(o.strings)) return (o.strings as string[]).join('?');
    if (typeof o.sql === 'string') return o.sql;
  }
  return String(a);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** الشكل الوحيد المسموح لقراءة glSourceEvent: أحداث استلامات مندوب واحد */
function settlementRepOf(args: unknown, tenantId: string): string | null {
  if (!isObj(args)) return null;
  const allowedArgs = new Set(['where', 'select']);
  if (Object.keys(args).some((k) => !allowedArgs.has(k) && args[k] !== undefined)) return null;
  const w = args.where;
  if (!isObj(w)) return null;
  const keys = Object.keys(w).filter((k) => w[k] !== undefined).sort();
  if (keys.join(',') !== 'payload,sourceType,tenantId') return null;
  if (w.tenantId !== tenantId || w.sourceType !== 'SETTLEMENT') return null;
  const p = w.payload;
  if (!isObj(p) || !Array.isArray(p.path) || p.path.length !== 1 || p.path[0] !== 'salesRepId' || typeof p.equals !== 'string') return null;
  if (Object.keys(p).some((k) => k !== 'path' && k !== 'equals')) return null;
  return p.equals;
}

function selectOf(args: unknown): Record<string, unknown> | null {
  return isObj(args) && isObj(args.select) ? args.select : null;
}

/** كائنٌ حرفيّ (لا Date ولا Decimal ولا Buffer) — وحده يحمل مفاتيح حقولٍ وعلاقات في وسائط Prisma */
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * أول مسار لعلاقةٍ بجدول دفاتر في وسائط استدعاء مندوبٍ تشغيلي (select/include/where/orderBy/_count متداخلةً) أو null.
 * مفتاحٌ بنمط gl* أو من GL_RELATION_FIELD_NAMES في أي عمق = قراءة gl_* من القاعدة عبر join تتجاوز الظلّ. القيم (نصوص
 * القوائم ومسارات JSON) لا تُفحص — المفاتيح وحدها أسماء حقول.
 */
export function glRelationPath(args: unknown, path = '', depth = 0): string | null {
  if (depth > 32) return null;
  if (Array.isArray(args)) {
    for (const v of args) {
      const hit = glRelationPath(v, path, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (!isPlainRecord(args)) return null;
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const at = path ? `${path}.${k}` : k;
    if (GL_DELEGATE_RE.test(k) || GL_RELATION_FIELD_NAMES.has(k)) return at;
    const hit = glRelationPath(v, at, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** الشكل الوحيد المسموح لقراءة glVendor: أسماء موردين بمعرّفاتهم للشركة نفسها (لا أرصدة ولا علاقات) */
function vendorNamesArgsOk(args: unknown, tenantId: string): boolean {
  if (!isObj(args)) return false;
  if (Object.keys(args).some((k) => args[k] !== undefined && k !== 'where' && k !== 'select')) return false;
  const w = args.where;
  if (!isObj(w)) return false;
  const keys = Object.keys(w).filter((k) => w[k] !== undefined).sort();
  if (keys.join(',') !== 'id,tenantId' || w.tenantId !== tenantId) return false;
  const id = w.id;
  if (!isObj(id) || Object.keys(id).some((k) => k !== 'in') || !Array.isArray(id.in) || id.in.some((x) => typeof x !== 'string')) return false;
  const sel = args.select;
  if (!isObj(sel)) return false;
  const selKeys = Object.keys(sel).filter((k) => sel[k] !== undefined);
  return selKeys.length > 0 && selKeys.every((k) => (k === 'id' || k === 'name') && sel[k] === true);
}

/**
 * وكيل فوق tx: المندوبات التشغيلية كما هي (الكتابة تفشل بالقاعدة)، وgl* تُخدم من الظلّ وحده بالقائمة المغلقة أعلاه.
 */
export function createShadowClient(tx: Prisma.TransactionClient, shadow: ShadowState): Prisma.TransactionClient {
  const denial = (access: string): ShadowGlAccessError => {
    shadow.recordGlViolation(access);
    return new ShadowGlAccessError(access);
  };
  const deny = (access: string): never => {
    throw denial(access);
  };
  const glDelegates = new Map<string, object>();

  const glDelegate = (model: string): object => {
    let d = glDelegates.get(model);
    if (d) return d;
    d = new Proxy({}, {
      get(_t, method) {
        if (typeof method !== 'string') return undefined;
        if (model === 'glSettings' && method === 'findUnique') {
          return async (args: unknown) => {
            if (!isObj(args) || args.include !== undefined || !isObj(args.where)) return deny('glSettings.findUnique(include|where)');
            const w = args.where as Record<string, unknown>;
            const keys = Object.keys(w).filter((k) => w[k] !== undefined);
            if (keys.length !== 1 || keys[0] !== 'tenantId' || w.tenantId !== shadow.tenantId) return deny('glSettings.findUnique(where)');
            return shadow.settingsRowSelect(selectOf(args));
          };
        }
        if (model === 'glSourceEvent' && method === 'createMany') {
          return async (args: unknown) => {
            if (!isObj(args)) return deny('glSourceEvent.createMany(args)');
            const rows = (Array.isArray(args.data) ? args.data : [args.data]) as Record<string, unknown>[];
            if (rows.some((r) => !isObj(r) || r.tenantId !== shadow.tenantId)) return deny('glSourceEvent.createMany(tenantId)');
            return { count: shadow.insertEventRows(rows, args.skipDuplicates === true) };
          };
        }
        if (model === 'glSourceEvent' && method === 'findMany') {
          return async (args: unknown) => {
            const rep = settlementRepOf(args, shadow.tenantId);
            if (rep === null) return deny('glSourceEvent.findMany(where)');
            return shadow.settlementEventsOfRep(rep, selectOf(args));
          };
        }
        if (model === 'glVendor' && method === 'findMany') {
          return async (args: unknown) => {
            if (!vendorNamesArgsOk(args, shadow.tenantId)) return deny('glVendor.findMany(where|select)');
            shadow.noteActivity();
            return (tx as unknown as { glVendor: { findMany(a: unknown): Promise<unknown> } }).glVendor.findMany(args);
          };
        }
        // رفض غير متزامن كاستدعاءات Prisma (وعدٌ مرفوض لا رمية متزامنة)
        return (async () => deny(`${model}.${method}`)) as AnyFn;
      },
    });
    glDelegates.set(model, d);
    return d;
  };

  /** مندوبٌ تشغيلي ملفوف: كل استدعاء تُفحص وسائطه بحثاً عن علاقةٍ متداخلة بجدول دفاتر قبل أن يصل القاعدة */
  const opDelegates = new Map<string, object>();
  const opDelegate = (model: string, d: object): object => {
    let p = opDelegates.get(model);
    if (p) return p;
    p = new Proxy(d, {
      get(t, method) {
        const f = Reflect.get(t, method);
        if (typeof f !== 'function' || typeof method !== 'string') return f;
        return ((...args: unknown[]) => {
          const hit = glRelationPath(args[0]);
          if (hit) return Promise.reject(denial(`${model}.${method}(${hit})`));
          return (f as AnyFn).apply(t, args);
        }) as AnyFn;
      },
    });
    opDelegates.set(model, p);
    return p;
  };

  const proxy: Prisma.TransactionClient = new Proxy(tx as object, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      if (prop === '$executeRaw' || prop === '$executeRawUnsafe') {
        return (async (...args: unknown[]) => deny(`${prop}:${rawSqlText(args).trim().slice(0, 60)}`)) as AnyFn;
      }
      if (prop === '$queryRaw' || prop === '$queryRawUnsafe') {
        const fn = Reflect.get(target, prop) as AnyFn;
        return ((...args: unknown[]) => {
          const sql = rawSqlText(args);
          if (GL_TABLE_SQL_RE.test(sql)) return Promise.reject(denial(`${prop}:${sql.trim().slice(0, 60)}`));
          shadow.noteActivity();
          return fn.apply(target, args);
        }) as AnyFn;
      }
      if (prop === '$transaction') {
        // داخل معاملة اللقطة أصلاً: معاملة متداخلة تُنفَّذ على الوكيل نفسه (لا معاملة ثانية ولا اتصال ثانٍ)
        return (async (arg: unknown) => (typeof arg === 'function' ? (arg as (c: unknown) => unknown)(proxy) : Promise.all(arg as unknown[]))) as AnyFn;
      }
      if (GL_DELEGATE_RE.test(prop)) return glDelegate(prop);
      const v = Reflect.get(target, prop);
      if (v && typeof v === 'object') {
        shadow.noteActivity();
        // مندوبات النماذج وحدها تُلفّ (لا $… ولا الخصائص الداخلية)
        return prop.startsWith('$') || prop.startsWith('_') ? v : opDelegate(prop, v);
      }
      return typeof v === 'function' ? (v as AnyFn).bind(target) : v;
    },
  }) as Prisma.TransactionClient;
  return proxy;
}
