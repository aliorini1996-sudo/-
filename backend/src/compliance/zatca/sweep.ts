// ============================================================================
// ZATCA المرحلة الثانية (Z5.3) — المسح الدوري: استيلاء عادل على المستندات المستحقّة، وإرسالها بحصص متزامنة، وتنبيهات التأخّر
// ----------------------------------------------------------------------------
// z5_plan §3 «Z5.3» + نقد الخطة (16، 17):
//   • **استعلام واحد حين لا عمل**: الدورة الخاملة = استيلاء جماعي واحد (فهرس status/nextAttemptAt) يعود فارغاً، ولا شيء
//     بعده. جولة التأخّر لا تُستعلم إلا إن رأى هذا الخادم مستنداً فعلاً (sawDocuments) وكل N دورة أو بعد دفعة غير فارغة —
//     فمنصّةٌ بلا مستندات مرحلة ثانية (الواقع اليوم) لا تدفع إلا استعلاماً واحداً في الدقيقة.
//   • العدل بين الشركات (نقد 16): الاستيلاء نفسه يحدّ لكل وحدة (perUnit بترتيب ICV) ويرتّب بالأقرب مهلةً، ويستبعد
//     الشركات الموقوفة والوحدات خارج حالات الإرسال في SQL. تراكم شركة واحدة لا يُفوِّت غيرها نافذة الـ24 ساعة.
//   • حصص التزامن (نقد 17): سقف عامّ للمنصّة، ومقعد محجوز دائماً للطلب الحيّ (اعتماد B2B في Z5.4) — فلا يأكل المسحُ
//     ميزانيةَ العشرين ثانية التي ينتظرها المندوب. المنتظرون بالدور، والحيّ يسبق المسح.
//   • تشغيل واحد في كل لحظة (علم في الذاكرة): دورة بطيئة لا تتراكب مع التالية.
//   • مفتاح إطفاء: ZATCA_SWEEP_ENABLED=false (والقيم الافتراضية كلها آمنة بلا أي متغيّر بيئة).
// لا شبكة هنا مباشرة (الإرسال في submit.ts) ولا services/gl ولا config/database.
// ============================================================================

import type { OverdueDocument, ZatcaDocumentStore } from './documentStore';
import { FINAL_DOCUMENT_STATUSES, REPORT_WINDOW_MS, subtypeOfTypeName } from './status';
import {
  DEFAULT_SUBMIT_LEASE_MS, DEFAULT_SUBMIT_TIMEOUT_MS, SUBMIT_UNIT_STATUSES, submitClaimedDocument,
  type SubmitDeps, type SubmitDocumentStore, type SubmitNotification, type SubmitResult, type TenantSubmitGate,
} from './submit';

// ─── الحصص (سقف عامّ + مقعد محجوز للطلب الحيّ) ───

export const DEFAULT_SUBMIT_SLOTS_TOTAL = 3;

interface SlotWaiter {
  resolve: () => void;
}

/**
 * سقف استدعاءات الهيئة المتزامنة في هذه النسخة من الخادم. `sweep` لا يتجاوز total − 1 أبداً، فيبقى مقعد للطلب الحيّ،
 * والمنتظر الحيّ يُخدَم قبل المسح مهما طال طابور المسح.
 */
export class SubmitSlots {
  readonly total: number;
  readonly sweepMax: number;
  private used = 0;
  private sweepUsed = 0;
  private readonly inlineQ: SlotWaiter[] = [];
  private readonly sweepQ: SlotWaiter[] = [];

  constructor(opts: { total?: number; sweepMax?: number } = {}) {
    this.total = Math.max(1, Math.trunc(opts.total ?? DEFAULT_SUBMIT_SLOTS_TOTAL));
    const reserved = this.total > 1 ? this.total - 1 : 1;
    this.sweepMax = Math.max(1, Math.min(Math.trunc(opts.sweepMax ?? reserved), reserved));
  }

  get inFlight(): number {
    return this.used;
  }

  get sweepInFlight(): number {
    return this.sweepUsed;
  }

  private canTake(kind: 'inline' | 'sweep'): boolean {
    if (this.used >= this.total) return false;
    return kind === 'inline' || this.sweepUsed < this.sweepMax;
  }

  private take(kind: 'inline' | 'sweep'): void {
    this.used++;
    if (kind === 'sweep') this.sweepUsed++;
  }

  private release(kind: 'inline' | 'sweep'): void {
    this.used--;
    if (kind === 'sweep') this.sweepUsed--;
    // الحيّ أولاً دائماً
    for (const [k, q] of [['inline', this.inlineQ], ['sweep', this.sweepQ]] as const) {
      while (q.length > 0 && this.canTake(k)) {
        const w = q.shift() as SlotWaiter;
        this.take(k);
        w.resolve();
      }
    }
  }

  async run<T>(kind: 'inline' | 'sweep', fn: () => Promise<T>): Promise<T> {
    if (this.canTake(kind)) this.take(kind);
    else await new Promise<void>(resolve => { (kind === 'inline' ? this.inlineQ : this.sweepQ).push({ resolve }); });
    try {
      return await fn();
    } finally {
      this.release(kind);
    }
  }
}

// ─── درجات تنبيه التأخّر ───

/** المهلة 24 ساعة: الدرجة 1 قبلها بـ12 ساعة (مدير الشركة)، 2 قبلها بـ4 ساعات (+ المالك)، 3 بعد فواتها. */
export const OVERDUE_LEVEL_1_BEFORE_MS = 12 * 60 * 60 * 1000;
export const OVERDUE_LEVEL_2_BEFORE_MS = 4 * 60 * 60 * 1000;
export const MAX_OVERDUE_LEVEL = 3;

export function overdueLevelFor(reportDeadline: Date, now: Date): 0 | 1 | 2 | 3 {
  const left = reportDeadline.getTime() - now.getTime();
  if (left <= 0) return 3;
  if (left <= OVERDUE_LEVEL_2_BEFORE_MS) return 2;
  if (left <= OVERDUE_LEVEL_1_BEFORE_MS) return 1;
  return 0;
}

const HOURS = (ms: number): number => Math.max(0, Math.round(ms / 3_600_000));

/**
 * وصف المستند المتأخّر: المبسّطة (02) أو القياسية (01) التي تحوّلت إلى الإبلاغ بعد أن أوقفت الهيئة الاعتماد (303،
 * نقد 10) — فلها مهلة 24 ساعة أيضاً. نصٌّ ثابت يقول «مبسّطة» كان يرسل المديرَ يبحث في المكان الخطأ.
 */
export function overdueDocumentLabel(typeName: string): string {
  return subtypeOfTypeName(typeName) === '01' ? 'فاتورة ضريبية (منشأة) بانتظار الإبلاغ بعد إيقاف الاعتماد' : 'فاتورة مبسّطة';
}

export function overdueNotification(doc: OverdueDocument, level: number, now: Date): SubmitNotification {
  const left = doc.reportDeadline.getTime() - now.getTime();
  const what = overdueDocumentLabel(doc.typeName);
  const body = level >= MAX_OVERDUE_LEVEL
    ? `مضت 24 ساعة على إصدار ${what} ولم تُبلَّغ بها الهيئة — بلّغ الإدارة فوراً (مخالفة نظامية)`
    : `تبقّى ${HOURS(left)} ساعة على انتهاء مهلة إبلاغ الهيئة بـ${what} ولم تُرسل بعد — تحقّق من الاتصال وإعدادات الفوترة`;
  return {
    kind: 'OVERDUE', tenantId: doc.tenantId, documentId: doc.id, invoiceId: doc.invoiceId, egsUnitId: doc.egsUnitId, level,
    owner: level >= 2, titleAr: level >= MAX_OVERDUE_LEVEL ? 'فاتورة لم تُبلَّغ خلال 24 ساعة' : 'اقتراب مهلة إبلاغ الهيئة',
    bodyAr: body,
    data: { icv: doc.icv, status: doc.status, reportDeadline: doc.reportDeadline.toISOString(), level },
  };
}

// ─── الاعتماديات والخيارات ───

export type SweepDocumentStore<Tx> = SubmitDocumentStore<Tx>
  & Pick<ZatcaDocumentStore<Tx>, 'claimBatch' | 'listOverdue' | 'bumpOverdueAlertLevel'>;

export interface SweepDeps<Tx = unknown> extends SubmitDeps<Tx> {
  documents: SweepDocumentStore<Tx>;
  slots?: SubmitSlots;
}

export interface SweepOptions {
  limit?: number;
  perUnit?: number;
  leaseMs?: number;
  timeoutMs?: number;
  /** أقصى زمن لدورة واحدة (تتوقّف بعده عن طلب دفعة جديدة). */
  deadlineMs?: number;
  overdueLimit?: number;
  /** كل كم دورة تُفحص التنبيهات حين لا دفعة (بعد أن يرى الخادم مستنداً واحداً على الأقل). */
  overdueEveryTicks?: number;
  /** أقصى عدد دفعات في الدورة الواحدة (حارس إضافي). */
  maxBatches?: number;
  now?: Date;
}

export const SWEEP_DEFAULTS = Object.freeze({
  limit: 20,
  perUnit: 5,
  leaseMs: DEFAULT_SUBMIT_LEASE_MS,
  timeoutMs: DEFAULT_SUBMIT_TIMEOUT_MS,
  deadlineMs: 45_000,
  overdueLimit: 50,
  overdueEveryTicks: 10,
  maxBatches: 20,
  intervalMs: 60_000,
});

export interface SweepReport {
  batches: number;
  claimed: number;
  /** حُسم (نتيجة هيئة أو حسم محلّي). */
  submitted: number;
  /** أُجِّل بلا استدعاء (إيقاف 429 أو إيقاف الشركة). */
  deferred: number;
  skipped: number;
  failed: number;
  overdueAlerts: number;
  overdueChecked: boolean;
  queries: number;
  tookMs: number;
  byStatus: Record<string, number>;
}

function emptyReport(): SweepReport {
  return { batches: 0, claimed: 0, submitted: 0, deferred: 0, skipped: 0, failed: 0, overdueAlerts: 0, overdueChecked: false, queries: 0, tookMs: 0, byStatus: {} };
}

export interface SweepState {
  tick: number;
  /** رأى هذا الخادم مستنداً مرحلة ثانية فعلاً (تشخيصيّ فقط — جولة التأخّر لا تُعلَّق عليه: يُمحى مع كل إعادة نشر). */
  sawDocuments: boolean;
}

export function newSweepState(): SweepState {
  return { tick: 0, sawDocuments: false };
}

// ─── جولة التأخّر ───

export async function runOverduePass<Tx>(
  deps: SweepDeps<Tx>, opts: { now: Date; limit: number },
): Promise<{ alerts: number; scanned: number }> {
  const docs = await deps.documents.listOverdue({
    now: opts.now, withinMs: OVERDUE_LEVEL_1_BEFORE_MS, maxLevel: MAX_OVERDUE_LEVEL, limit: Math.max(0, Math.trunc(opts.limit)),
  });
  let alerts = 0;
  for (const d of docs) {
    if ((FINAL_DOCUMENT_STATUSES as readonly string[]).includes(d.status)) continue;
    const level = overdueLevelFor(d.reportDeadline, opts.now);
    if (level <= d.overdueAlertLevel) continue;
    // CAS على الدرجة السابقة: التنبيه يُطلق مرّة واحدة لكل درجة ولو تسابق عاملان
    if (!(await deps.documents.bumpOverdueAlertLevel(d.id, d.overdueAlertLevel, level))) continue;
    alerts++;
    if (deps.notify) {
      try {
        await deps.notify(overdueNotification(d, level, opts.now));
      } catch { /* الإشعار لا يوقف الجولة */ }
    }
  }
  return { alerts, scanned: docs.length };
}

// ─── الدورة ───

/** دورة واحدة: استيلاء ⇒ إرسال بحصص ⇒ (عند اللزوم) جولة تأخّر. لا ترمي: الأخطاء تُعدّ وتُسجَّل. */
export async function runZatcaSweep<Tx>(
  deps: SweepDeps<Tx>, opts: SweepOptions = {}, state: SweepState = newSweepState(),
): Promise<SweepReport> {
  const started = Date.now();
  const report = emptyReport();
  const limit = Math.max(1, Math.trunc(opts.limit ?? SWEEP_DEFAULTS.limit));
  const perUnit = Math.max(1, Math.trunc(opts.perUnit ?? SWEEP_DEFAULTS.perUnit));
  const leaseMs = Math.max(1000, Math.trunc(opts.leaseMs ?? SWEEP_DEFAULTS.leaseMs));
  const timeoutMs = Math.max(1000, Math.trunc(opts.timeoutMs ?? SWEEP_DEFAULTS.timeoutMs));
  const deadlineMs = Math.max(1000, Math.trunc(opts.deadlineMs ?? SWEEP_DEFAULTS.deadlineMs));
  const maxBatches = Math.max(1, Math.trunc(opts.maxBatches ?? SWEEP_DEFAULTS.maxBatches));
  const slots = deps.slots ?? new SubmitSlots();
  // الوعد نفسه يُخزَّن لا نتيجته: مستندات شركة واحدة تُرسل معاً فلا يُستعلم عن بوّابتها مرّة لكل مستند
  const gates = new Map<string, Promise<TenantSubmitGate | undefined>>();
  const until = started + deadlineMs;
  state.tick++;

  const gateOf = (tenantId: string): Promise<TenantSubmitGate | undefined> => {
    const hit = gates.get(tenantId);
    if (hit) return hit;
    report.queries++;
    const p = deps.gate.loadSubmitGate(tenantId).then(g => g ?? undefined);
    gates.set(tenantId, p);
    return p;
  };

  /* حجم الدفعة لا يتجاوز ما يمكن إرساله قبل انقضاء عقده (مراجعة عدائية): المقاعد محدودة (sweepMax) وكلّ استدعاء قد
   * يستغرق المهلة كاملة، فدفعةٌ بعشرين مستنداً كانت تترك آخرَها ينتظر دوره وعقدُه منتهٍ — فيُستولى عليه مرّتين أو
   * يُسحب من تحت عاملٍ يرسله. الحلقة تستمرّ بدفعاتٍ متتالية حتى مهلة الدورة، فلا يقلّ الإنتاج. */
  const perBatch = Math.max(1, Math.min(limit, slots.sweepMax * Math.max(1, Math.floor(leaseMs / timeoutMs))));

  for (let b = 0; b < maxBatches; b++) {
    report.queries++;
    const batch = await deps.documents.claimBatch({
      limit: perBatch, perUnit, leaseMs, unitStatuses: SUBMIT_UNIT_STATUSES, excludePausedTenants: true,
    });
    if (batch.length === 0) break;
    state.sawDocuments = true;
    report.batches++;
    report.claimed += batch.length;
    const now = opts.now ?? deps.now();
    await Promise.all(batch.map(async claimed => {
      try {
        const gate = await gateOf(claimed.tenantId);
        const res: SubmitResult = await slots.run('sweep', () => submitClaimedDocument(deps, claimed, {
          timeoutMs, ...(gate ? { gate } : {}), now,
        }));
        if (res.kind === 'done') {
          report.submitted++;
          report.byStatus[res.status] = (report.byStatus[res.status] ?? 0) + 1;
        } else if (res.reason === 'RATE_PAUSED' || res.reason === 'PAUSED') report.deferred++;
        else report.skipped++;
      } catch (e) {
        report.failed++;
        console.error(`[zatca:sweep] document ${claimed.id}: ${(e as Error).name} ${(e as Error).message?.slice(0, 200) ?? ''}`);
      }
    }));
    // لا تُوقف الدورةَ دفعةٌ أصغر من الحدّ: العدل يحدّ المستندات لكل وحدة لا لكل دورة (نقد 16 «استمرّ حتى المهلة»).
    // ولا حلقة لا تنتهي: كل مستند مُستولى عليه صار SUBMITTING ثم انتقل لحالة غير مستحقّة الآن، ودفعة فارغة تكسر الحلقة.
    if (Date.now() >= until) break;
  }

  /* جولة التأخّر لا تُعلَّق على ما رآه هذا الخادم (مراجعة عدائية): المستند المحجوب أو الموقوفة شركتُه لا يُستولى
   * عليه أصلاً، وعلمُ الذاكرة يُمحى مع كلّ إعادة نشر — فكان التنبيه يصمت تماماً في الحالة الوحيدة التي وُضع لها.
   * الكلفة حين لا عمل: استعلامٌ مفهرس واحد كلّ عشر دورات (عشر دقائق) على جدولٍ فارغ لشركات المرحلة الأولى. */
  const everyTicks = Math.max(1, Math.trunc(opts.overdueEveryTicks ?? SWEEP_DEFAULTS.overdueEveryTicks));
  if (report.claimed > 0 || state.tick % everyTicks === 0) {
    report.overdueChecked = true;
    report.queries++;
    try {
      const o = await runOverduePass(deps, { now: opts.now ?? deps.now(), limit: Math.max(0, Math.trunc(opts.overdueLimit ?? SWEEP_DEFAULTS.overdueLimit)) });
      report.overdueAlerts = o.alerts;
    } catch (e) {
      report.failed++;
      console.error(`[zatca:sweep] overdue pass: ${(e as Error).message?.slice(0, 200) ?? ''}`);
    }
  }
  report.tookMs = Date.now() - started;
  return report;
}

// ─── المشغّل (تشغيل واحد + مؤقّت داخل العملية) ───

export const SWEEP_ENABLED_VAR = 'ZATCA_SWEEP_ENABLED';
export const SWEEP_INTERVAL_VAR = 'ZATCA_SWEEP_INTERVAL_MS';
export const MIN_SWEEP_INTERVAL_MS = 10_000;

export function sweepEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const v = (env[SWEEP_ENABLED_VAR] ?? '').trim().toLowerCase();
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no');
}

export function sweepIntervalMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = Number.parseInt((env[SWEEP_INTERVAL_VAR] ?? '').trim(), 10);
  return Number.isFinite(raw) && raw >= MIN_SWEEP_INTERVAL_MS ? raw : SWEEP_DEFAULTS.intervalMs;
}

export type SweepRunOutcome = SweepReport | { busy: true };

export function isBusy(r: SweepRunOutcome): r is { busy: true } {
  return (r as { busy?: boolean }).busy === true;
}

/** دورة المسح داخل العملية: تشغيل واحد في كل لحظة، ومؤقّت اختياري بفترة ثابتة. */
export class ZatcaSweepRunner<Tx = unknown> {
  readonly state: SweepState = newSweepState();
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: SweepReport | null = null;

  constructor(private readonly deps: SweepDeps<Tx>, private readonly opts: SweepOptions = {}) {}

  get isRunning(): boolean {
    return this.running;
  }

  get lastReport(): SweepReport | null {
    return this.last;
  }

  /** يعيد {busy:true} إن كانت دورة سابقة ما تزال تعمل (لا تراكب). */
  async runOnce(over: SweepOptions = {}): Promise<SweepRunOutcome> {
    if (this.running) return { busy: true };
    this.running = true;
    try {
      const r = await runZatcaSweep(this.deps, { ...this.opts, ...over }, this.state);
      this.last = r;
      return r;
    } finally {
      this.running = false;
    }
  }

  start(intervalMs: number = SWEEP_DEFAULTS.intervalMs): void {
    if (this.timer) return;
    const ms = Math.max(MIN_SWEEP_INTERVAL_MS, Math.trunc(intervalMs));
    this.timer = setInterval(() => {
      void this.runOnce().catch(e => console.error('[zatca:sweep] tick error:', (e as Error).message));
    }, ms);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

export { REPORT_WINDOW_MS };
