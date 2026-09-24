// ============================================================================
// ZATCA المرحلة الثانية (Z5.8) — مخزن التفعيل: «تسليح» التفعيل، جاهزية المناديب، وطابور مراجعة الانتقال (D11)
// ----------------------------------------------------------------------------
// مفصول عن المسارات عمداً كبقيّة مخازن Z5: الواجهة + مخزن ذاكرة هنا (بلا قاعدة بيانات)، والمحوّل في goLiveStore.prisma.ts.
//   • setArmedAtOnce يضبط CompanySettings.zatcaGoLiveArmedAt مرّة واحدة (حيث NULL) — كـ setPhase2StartedAtOnce.
//   • loadRepSync يقرأ أعمدة نبضة المندوب (Z5.0) لجاهزية التفعيل — لا يقرؤها مسار آخر.
//   • طابور المراجعة (ZatcaCutoverReview): إدراجٌ ذرّيّ بمفتاح (tenantId, clientRef)، وحسمٌ CAS من PENDING.
// لا يستورد services/gl ولا قاعدة البيانات (الواجهة نقيّة؛ المحوّل يستورد Prisma نوعياً فقط).
// ============================================================================

import type { CutoverRecordInput, CutoverStatus, RepSyncRow } from './goLive';

export interface CutoverReviewRow {
  id: string;
  tenantId: string;
  clientRef: string | null;
  clientCreatedAt: Date | null;
  reason: string;
  status: CutoverStatus;
  payload: unknown;
  salesRepId: string | null;
  customerId: string | null;
  amount: number | null;
  note: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  resultInvoiceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CutoverResolvePatch {
  status: CutoverStatus;
  reviewedBy: string | null;
  reviewedAt: Date;
  note?: string | null;
  resultInvoiceId?: string | null;
}

export interface GoLiveStore {
  /** CompanySettings.zatcaGoLiveArmedAt. */
  loadArmedAt(tenantId: string): Promise<Date | null>;
  /** يضبط التسليح مرّة واحدة (حيث NULL)؛ يعيد القيمة الفعلية. applied=false إن سبق أو لا صفّ إعدادات. */
  setArmedAtOnce(tenantId: string, at: Date): Promise<{ applied: boolean; armedAt: Date | null }>;
  /**
   * ينزع التسليح (zatcaGoLiveArmedAt=null) للتعافي من تسليحٍ خاطئ — لكن **لا** بعد التفعيل الحيّ: يشترط zatcaPhase2StartedAt
   * NULL (CAS ذرّيّ في المحوّل). applied=false إن لم يكن مُسلَّحاً أو كانت الشركة قد فُعّلت (لا يُنزع تسليح شركةٍ حيّة).
   */
  clearArmedAt(tenantId: string): Promise<{ applied: boolean; armedAt: Date | null }>;
  /** أعمدة نبضة المناديب لجاهزية التفعيل. */
  loadRepSync(tenantId: string): Promise<RepSyncRow[]>;
  /** يحفظ مستنداً انتقالياً للمراجعة؛ إدراجٌ ذرّيّ بمفتاح (tenantId, clientRef) — رفعٌ مكرَّر لا يُنشئ صفّاً ثانياً. */
  recordCutover(input: CutoverRecordInput): Promise<{ created: boolean; row: CutoverReviewRow }>;
  listCutover(tenantId: string, filter?: { status?: CutoverStatus; limit?: number }): Promise<CutoverReviewRow[]>;
  getCutover(tenantId: string, id: string): Promise<CutoverReviewRow | null>;
  /** مستند مراجعة انتقال بمفتاح (tenantId, clientRef) — لقرار إعادة الرفع بعد حسم الإدارة (D11، نقد 3). null = لا مستند. */
  findCutoverByClientRef(tenantId: string, clientRef: string): Promise<CutoverReviewRow | null>;
  /** حسمٌ CAS من PENDING؛ null = غير موجود؛ applied=false إن سبق حسمه (يعيد صفّه كما هو). */
  resolveCutover(tenantId: string, id: string, patch: CutoverResolvePatch): Promise<{ applied: boolean; row: CutoverReviewRow } | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// مخزن ذاكرة للاختبار
// ─────────────────────────────────────────────────────────────────────────────

export interface MemoryGoLiveStore extends GoLiveStore {
  readonly rows: CutoverReviewRow[];
  readonly armed: Map<string, Date | null>;
  readonly reps: Map<string, RepSyncRow[]>;
}

let memSeq = 0;

function clone<T>(v: T): T {
  if (v instanceof Date) return new Date(v.getTime()) as unknown as T;
  if (v === null || typeof v !== 'object') return v;
  return JSON.parse(JSON.stringify(v), (_k, x) => x) as T;
}

function cloneRow(r: CutoverReviewRow): CutoverReviewRow {
  return {
    ...r,
    clientCreatedAt: r.clientCreatedAt ? new Date(r.clientCreatedAt.getTime()) : null,
    reviewedAt: r.reviewedAt ? new Date(r.reviewedAt.getTime()) : null,
    createdAt: new Date(r.createdAt.getTime()),
    updatedAt: new Date(r.updatedAt.getTime()),
    payload: clone(r.payload),
  };
}

/**
 * مخزن ذاكرة بدلالات المحوّل نفسها. init:
 *   armed: تسليح مبدئيّ لكل شركة؛ reps: صفوف نبضة المناديب؛ knownTenants: الشركات التي لها صفّ إعدادات (لغيرها setArmedAtOnce
 *   يعيد applied=false، armedAt=null — كـ updateMany count 0). غياب knownTenants ⇒ كلّ الشركات موجودة.
 */
export function memoryGoLiveStore(init: {
  armed?: Record<string, Date | null>;
  reps?: Record<string, RepSyncRow[]>;
  knownTenants?: readonly string[] | null;
} = {}): MemoryGoLiveStore {
  const rows: CutoverReviewRow[] = [];
  const armed = new Map<string, Date | null>(Object.entries(init.armed ?? {}));
  const reps = new Map<string, RepSyncRow[]>(Object.entries(init.reps ?? {}));
  const known = init.knownTenants == null ? null : new Set(init.knownTenants);

  const store: MemoryGoLiveStore = {
    rows, armed, reps,
    async loadArmedAt(tenantId) {
      const v = armed.get(tenantId);
      return v ? new Date(v.getTime()) : null;
    },
    async setArmedAtOnce(tenantId, at) {
      if (known && !known.has(tenantId)) return { applied: false, armedAt: null };
      const cur = armed.get(tenantId) ?? null;
      if (cur) return { applied: false, armedAt: new Date(cur.getTime()) };
      const v = new Date(at.getTime());
      armed.set(tenantId, v);
      return { applied: true, armedAt: new Date(v.getTime()) };
    },
    async clearArmedAt(tenantId) {
      // الذاكرة لا تعرف startedAt (المسار يحرسه)؛ تكتفي بنزع التسليح إن وُجد
      if (known && !known.has(tenantId)) return { applied: false, armedAt: null };
      const cur = armed.get(tenantId) ?? null;
      if (!cur) return { applied: false, armedAt: null };
      armed.set(tenantId, null);
      return { applied: true, armedAt: null };
    },
    async loadRepSync(tenantId) {
      return (reps.get(tenantId) ?? []).map(r => ({
        ...r,
        lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt.getTime()) : null,
        outboxReportedAt: r.outboxReportedAt ? new Date(r.outboxReportedAt.getTime()) : null,
      }));
    },
    async recordCutover(input) {
      if (input.clientRef) {
        const existing = rows.find(r => r.tenantId === input.tenantId && r.clientRef === input.clientRef);
        if (existing) return { created: false, row: cloneRow(existing) };
      }
      const now = new Date(input.at.getTime());
      const row: CutoverReviewRow = {
        id: `cut-${++memSeq}`,
        tenantId: input.tenantId,
        clientRef: input.clientRef,
        clientCreatedAt: input.clientCreatedAt ? new Date(input.clientCreatedAt.getTime()) : null,
        reason: input.reason,
        status: 'PENDING',
        payload: clone(input.payload),
        salesRepId: input.salesRepId ?? null,
        customerId: input.customerId ?? null,
        amount: input.amount ?? null,
        note: null,
        reviewedBy: null,
        reviewedAt: null,
        resultInvoiceId: null,
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return { created: true, row: cloneRow(row) };
    },
    async listCutover(tenantId, filter = {}) {
      let out = rows.filter(r => r.tenantId === tenantId && (filter.status === undefined || r.status === filter.status));
      out = out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (typeof filter.limit === 'number') out = out.slice(0, filter.limit);
      return out.map(cloneRow);
    },
    async getCutover(tenantId, id) {
      const r = rows.find(x => x.tenantId === tenantId && x.id === id);
      return r ? cloneRow(r) : null;
    },
    async findCutoverByClientRef(tenantId, clientRef) {
      const r = rows.find(x => x.tenantId === tenantId && x.clientRef === clientRef);
      return r ? cloneRow(r) : null;
    },
    async resolveCutover(tenantId, id, patch) {
      const r = rows.find(x => x.tenantId === tenantId && x.id === id);
      if (!r) return null;
      if (r.status !== 'PENDING') return { applied: false, row: cloneRow(r) };
      r.status = patch.status;
      r.reviewedBy = patch.reviewedBy;
      r.reviewedAt = new Date(patch.reviewedAt.getTime());
      if (patch.note !== undefined) r.note = patch.note;
      if (patch.resultInvoiceId !== undefined) r.resultInvoiceId = patch.resultInvoiceId;
      r.updatedAt = new Date(patch.reviewedAt.getTime());
      return { applied: true, row: cloneRow(r) };
    },
  };
  return store;
}
