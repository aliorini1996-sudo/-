/**
 * لقطة القراءة الثابتة لمعاينة «ربط الدفاتر» (L2 — العقد §10.1، D8).
 *
 * كل قراءات المعاينة (المحرّك والمصادر والمطابقة والـpreflight) ترى صورة واحدة للقاعدة مهما طالت، والقاعدة نفسها تمنع أي
 * كتابة (خطأ 25006) فلا يُعتمد على انضباط الكود وحده. يُتحقّق من `transaction_read_only = on` قبل أي قراءة (Prisma قد يغيّر
 * سلوكه؛ الفشل المغلق أولى من معاينة بلا ضمان)، و`SELECT now()` = ساعة القاعدة داخل اللقطة (لا ساعة التطبيق).
 *
 * **لا تُمسك أقفال الجداول طوال التشغيل** (المعاينة قد تمتدّ دقائق): في Postgres يبقى قفل AccessShare على كل جدولٍ قرأته
 * المعاملة حتى نهايتها، فمعاملةٌ واحدة لأربع عشرة دقيقة كانت تحجز invoices وaccount_entries وreceipts… كلها — ونشرٌ فيه DDL
 * (`prisma db push` يضيف عموداً والنسخة القديمة تخدم) ينتظر AccessExclusive خلفها، ويصطفّ خلفه كل SELECT/INSERT جديد على الجدول
 * (طابور الأقفال)، فتتعلّق الفواتير ثم يُستنفد المجمّع (P2024) حتى تنتهي المعاينة. لذلك:
 *  - **معاملة مُصدِّرة** (اتصال ١): `SET TRANSACTION … REPEATABLE READ, READ ONLY` ⇒ التحقّق ⇒ `SELECT now()` ⇒
 *    `SELECT pg_export_snapshot()` — لا تقرأ جدولاً فلا تمسك قفل جدول، وتبقى مفتوحة لتبقى اللقطة قابلة للاستيراد.
 *  - **معاملات قراءة دوّارة قصيرة** (اتصال ٢): كل واحدة `SET TRANSACTION … READ ONLY` ⇒ `SET TRANSACTION SNAPSHOT '<id>'` ⇒
 *    التحقّق، فترى الصورة نفسها حرفياً، وتُغلق بعد SNAPSHOT_LEASE_MS (بعد انتهاء ما يجري عليها) فتتحرّر أقفالها — DDL منتظرٌ يمرّ
 *    بين معاملتين، والإمساك محدودٌ بمدّة المعاملة الدوّارة أو أطول استعلام منفرد، لا بمدّة المعاينة.
 *  العميل المُمرَّر إلى fn وكيلٌ بشكل Prisma.TransactionClient يوجّه كل استدعاء إلى المعاملة الدوّارة الحالية.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { PREVIEW_TX_TIMEOUT_MS } from './types';

/** انتظار اتصال المجمّع قبل بدء المعاملة */
export const SNAPSHOT_MAX_WAIT_MS = 10_000;
/** عمر المعاملة الدوّارة: أقصى إمساكٍ لأقفال الجداول (عدا استعلامٍ منفرد أطول) — والكلفة ٤ عبارات قصيرة لكل دورة */
export const SNAPSHOT_LEASE_MS = 2_000;
/** معرّف لقطة مُصدَّرة (مثل 00000003-0000001B-1) — يُتحقَّق منه قبل وضعه في SET TRANSACTION SNAPSHOT (لا يقبل معاملاً) */
const SNAPSHOT_ID_RE = /^[0-9A-F]+-[0-9A-F]+(-[0-9]+)?$/i;

/** المعاملة لم تصِر للقراءة فقط — لا تُكمَل المعاينة */
export class ReadOnlySnapshotError extends Error {
  readonly code = 'SNAPSHOT_NOT_READ_ONLY' as const;
  constructor(readonly observed: string | null) {
    super(`معاملة المعاينة ليست للقراءة فقط (transaction_read_only=${observed ?? 'null'})`);
    this.name = 'ReadOnlySnapshotError';
  }
}

export interface ReadOnlySnapshotOptions {
  /** المهلة الكلية (الافتراضي PREVIEW_TX_TIMEOUT_MS): تجاوزها ⇒ خطأ P2028 (TIMEOUT) كمهلة معاملة Prisma */
  timeoutMs?: number;
  /** عمر المعاملة الدوّارة (الافتراضي SNAPSHOT_LEASE_MS) */
  leaseMs?: number;
  /** ساعة أحادية (للاختبار) */
  clock?: () => number;
}

type Db = { $transaction: PrismaClient['$transaction'] };
type AnyFn = (...args: unknown[]) => unknown;

/** مهلة اللقطة الكلية — بالرمز نفسه الذي يُعلَّم به تجاوز مهلة معاملة Prisma (TIMEOUT في previewErrorCodeOf) */
function snapshotTimeout(): Error {
  return Object.assign(new Error('تجاوزت لقطة المعاينة مهلتها'), { code: 'P2028' });
}

async function assertReadOnly(tx: Prisma.TransactionClient): Promise<void> {
  const ro = await tx.$queryRaw<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
  const observed = ro[0]?.transaction_read_only ?? null;
  if (observed !== 'on') throw new ReadOnlySnapshotError(observed);
}

interface Lease {
  tx: Prisma.TransactionClient;
  startedAt: number;
  inflight: number;
  closing: boolean;
  idle: ReturnType<typeof setTimeout> | null;
  release(): void;
  /** يُحلّ حين تُغلق المعاملة (ويُرفض إن فشلت) */
  done: Promise<void>;
}

/**
 * المعاملات الدوّارة القصيرة على اللقطة المُصدَّرة — واحدة في كل لحظة (اتصالٌ واحد): تُغلق حين يبلغ عمرها leaseMs وقد فرغ
 * ما يجري عليها، **أو حين تخمل** (مؤقّت حتى نهاية عمرها) — فالأطوار الحسابية الطويلة في الذاكرة (المُرحِّل) لا تمسك أقفالاً.
 */
class SnapshotLeases {
  private cur: Lease | null = null;
  private opening: Promise<Lease> | null = null;
  private closed = false;
  /** عدد المعاملات الدوّارة التي فُتحت (للاختبار والسجلّ) */
  opened = 0;

  constructor(
    private readonly db: Db,
    private readonly snapshotId: string,
    private readonly o: { leaseMs: number; deadline: number; clock: () => number },
  ) {}

  async run<R>(op: (tx: Prisma.TransactionClient) => Promise<R>): Promise<R> {
    // acquire يحجز المعاملة (inflight) متزامناً قبل أن يعود — فلا تُغلقها نهايةُ استدعاءٍ آخر بين الحجز والاستعمال
    const lease = await this.acquire();
    try {
      return await op(lease.tx);
    } finally {
      lease.inflight -= 1;
      if (lease.inflight === 0) {
        const left = lease.startedAt + this.o.leaseMs - this.o.clock();
        if (lease.closing || left <= 0) this.retire(lease);
        else if (!lease.idle) {
          lease.idle = setTimeout(() => { lease.idle = null; if (lease.inflight === 0) this.retire(lease); }, left);
          lease.idle.unref?.();
        }
      }
    }
  }

  /** يُغلق المعاملة الدوّارة بعد ما يجري عليها — بلا انتظار لها */
  private retire(lease: Lease): void {
    lease.closing = true;
    if (lease.idle) { clearTimeout(lease.idle); lease.idle = null; }
    if (lease.inflight === 0) lease.release();
  }

  private async acquire(): Promise<Lease> {
    for (;;) {
      if (this.closed) throw new Error('لقطة المعاينة أُغلقت');
      if (this.o.clock() >= this.o.deadline) throw snapshotTimeout();
      const c = this.cur;
      if (c) {
        if (!c.closing && this.o.clock() - c.startedAt < this.o.leaseMs) {
          c.inflight += 1;
          if (c.idle) { clearTimeout(c.idle); c.idle = null; }
          return c;
        }
        // انتهى عمرها: الاستدعاءات الجديدة تنتظر معاملةً جديدة، وهذه تُغلق بعد ما يجري عليها (اتصالٌ واحد للدوّارة)
        this.retire(c);
        await c.done.catch(() => undefined);
        if (this.cur === c) this.cur = null;
        continue;
      }
      if (!this.opening) {
        this.opening = this.open().then((l) => { this.cur = l; return l; }).finally(() => { this.opening = null; });
      }
      await this.opening;
    }
  }

  private open(): Promise<Lease> {
    const timeout = Math.max(1_000, this.o.deadline - this.o.clock());
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let isReady = false;
    let resolveReady!: (tx: Prisma.TransactionClient) => void;
    let rejectReady!: (e: unknown) => void;
    const ready = new Promise<Prisma.TransactionClient>((res, rej) => { resolveReady = res; rejectReady = rej; });
    const done: Promise<void> = this.db.$transaction(async (tx) => {
      // أول عبارتين: العزل للقراءة فقط ثم استيراد اللقطة (يجب أن يسبقا أي استعلام في المعاملة)
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await tx.$executeRawUnsafe(`SET TRANSACTION SNAPSHOT '${this.snapshotId}'`);
      await assertReadOnly(tx);
      isReady = true;
      resolveReady(tx);
      await released;
    }, { timeout, maxWait: SNAPSHOT_MAX_WAIT_MS }).then(() => undefined);
    done.catch((e) => { if (!isReady) rejectReady(e); });
    return ready.then((tx) => {
      this.opened += 1;
      return { tx, startedAt: this.o.clock(), inflight: 0, closing: false, idle: null, release, done };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    const c = this.cur ?? (this.opening ? await this.opening.catch(() => null) : null);
    this.cur = null;
    if (c) {
      this.retire(c);
      await c.done.catch(() => undefined);
    }
  }
}

/**
 * وكيلٌ بشكل Prisma.TransactionClient: كل استدعاء مندوبٍ (findMany، count…) وكل SQL خام يُنفَّذ على المعاملة الدوّارة الحالية.
 * `$transaction` المتداخلة تُنفَّذ على الوكيل نفسه (لا معاملة ثالثة) — كالعميل الحارس.
 */
function leasedClient(leases: SnapshotLeases): Prisma.TransactionClient {
  const delegates = new Map<string, object>();
  const delegate = (model: string): object => {
    let d = delegates.get(model);
    if (d) return d;
    d = new Proxy({}, {
      get(_t, method) {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return (...args: unknown[]) => leases.run((tx) => {
          const m = (tx as unknown as Record<string, Record<string, AnyFn>>)[model];
          if (!m || typeof m[method] !== 'function') throw new TypeError(`${model}.${method} غير معروف`);
          return Promise.resolve(m[method](...args));
        });
      },
    });
    delegates.set(model, d);
    return d;
  };
  const proxy: Prisma.TransactionClient = new Proxy({}, {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop === '$transaction') {
        return (async (arg: unknown) => (typeof arg === 'function' ? (arg as (c: unknown) => unknown)(proxy) : Promise.all(arg as unknown[]))) as AnyFn;
      }
      if (prop.startsWith('$')) {
        return ((...args: unknown[]) => leases.run((tx) => {
          const f = (tx as unknown as Record<string, AnyFn>)[prop];
          if (typeof f !== 'function') throw new TypeError(`${prop} غير معروف`);
          return Promise.resolve(f.apply(tx, args));
        })) as AnyFn;
      }
      return delegate(prop);
    },
  }) as Prisma.TransactionClient;
  return proxy;
}

export async function withReadOnlySnapshot<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient, dbNow: Date) => Promise<T>,
  opts: ReadOnlySnapshotOptions = {},
): Promise<T> {
  const clock = opts.clock ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? PREVIEW_TX_TIMEOUT_MS;
  const deadline = clock() + timeoutMs;
  return db.$transaction(async (tx) => {
    // يجب أن تكون أول عبارة في المعاملة (Postgres يرفض SET TRANSACTION بعد أي استعلام)
    await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    await assertReadOnly(tx);
    const rows = await tx.$queryRaw<{ now: Date | string }[]>`SELECT now() AS "now"`;
    const raw = rows[0]?.now;
    const dbNow = raw instanceof Date ? raw : new Date(raw ?? Number.NaN);
    if (Number.isNaN(dbNow.getTime())) throw new Error('تعذّرت قراءة ساعة القاعدة داخل لقطة المعاينة');
    const exp = await tx.$queryRaw<{ snapshot: string }[]>`SELECT pg_export_snapshot() AS "snapshot"`;
    const snapshotId = String(exp[0]?.snapshot ?? '');
    if (!SNAPSHOT_ID_RE.test(snapshotId)) throw new Error(`معرّف لقطة غير صالح: ${snapshotId.slice(0, 40)}`);
    const leases = new SnapshotLeases(db, snapshotId, { leaseMs: opts.leaseMs ?? SNAPSHOT_LEASE_MS, deadline, clock });
    try {
      return await fn(leasedClient(leases), dbNow);
    } finally {
      await leases.close();
    }
  }, { timeout: timeoutMs, maxWait: SNAPSHOT_MAX_WAIT_MS });
}
