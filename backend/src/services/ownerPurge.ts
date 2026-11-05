/**
 * «الحذف النهائي» لمالك المنصة وحده (أمر المالك ٥ نوفمبر ٢٠٢٦): «صلاحية حذف اي فاتورة او اي مستند مهما كان السبب بدون اي استثناء
 * ابدا فقط مالك المنصة… حتى اللوكيشن وكل شي بلا استثناء»، وقراره: حذفٌ نهائي من القاعدة (لا إلغاء)، وسند القبض المرتبط بفاتورةٍ
 * محذوفة يُحذف معها.
 *
 * محرّكٌ عامّ على نموذج Prisma نفسه (Prisma.dmmf) فيشمل كل جدولٍ فيه `tenantId` — الفاتورة والسند والتحميل والوارد واللوكيشن
 * والعميل والصنف والمندوب وغيرها — بلا قائمة يدوية تتقادم:
 * - كل صفٍّ يشير إلى المحذوف بمفتاحٍ **إلزامي** يُحذف معه (تتابعياً)؛ وبمفتاحٍ **اختياري** يُفرَّغ مفتاحه (null) ويبقى الصف —
 *   فحذف لوكيشن لا يمحو فواتيرها، بل يرفع وسمها. والاستثناء قيود كشف الحساب (AccountEntry) فتُحذف مع فاتورتها/سندها.
 * - الفاتورة المحذوفة تسحب معها كل سند قبضٍ خُصّص لها (قرار المالك)، والسند المحذوف (القائم) يعيد مبالغ تخصيصه لفواتيرٍ باقية.
 * - الأرصدة المخزَّنة تُصحَّح بعد الحذف: رصيد العميل من مجموع قيوده الباقية (currentBalance)، و«إجمالي المبيعات/التحصيل» بأثر
 *   المستندات القائمة المحذوفة (الملغاة عُكس أثرها يوم إلغائها). ورصيد السيارة والمستودع واللوط مشتقّةٌ من الصفوف فتتبعها وحدها.
 * - المعاينة (dry run) تعدّ ما سيُحذف وما يُفرَّغ قبل التنفيذ، والتنفيذ معاملةٌ واحدة: كله أو لا شيء.
 */
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { clean, currentBalance } from './accounting';
import { restoreAllocations } from './docCancel';

type Tx = Prisma.TransactionClient;
type DmmfModel = (typeof Prisma.dmmf.datamodel.models)[number];
type DmmfField = DmmfModel['fields'][number];

const MODELS: readonly DmmfModel[] = Prisma.dmmf.datamodel.models;
const byName = new Map(MODELS.map((m) => [m.name, m]));

/** مفاتيح اختيارية تُحذف صفوفها مع المحذوف بدل تفريغها: قيود كشف الحساب أثرُ الفاتورة/السند نفسه */
const DELETE_ON_OPTIONAL = new Set(['AccountEntry.invoiceId', 'AccountEntry.receiptId']);

/** لا يُستهدف مباشرة: الشركة نفسها (لها مسارها في لوحة المالك) وجداول المنصة بلا شركة */
const NOT_TARGETABLE = new Set(['Tenant']);

export const delegateOf = (model: string): string => model.charAt(0).toLowerCase() + model.slice(1);

/** مفاتيح الصف الأساسية: @id أو @@id */
function pkFields(m: DmmfModel): string[] {
  const single = m.fields.filter((f) => f.isId).map((f) => f.name);
  if (single.length) return single;
  return m.primaryKey?.fields ? [...m.primaryKey.fields] : [];
}

/** كل علاقةٍ واردة إلى `target`: نموذجٌ آخر يحمل مفتاحاً أجنبياً (حقلاً واحداً) يشير إليه */
interface Inbound { child: DmmfModel; fk: string; ref: string; required: boolean }
const inboundCache = new Map<string, Inbound[]>();
export function inboundOf(target: string): Inbound[] {
  const hit = inboundCache.get(target);
  if (hit) return hit;
  const out: Inbound[] = [];
  for (const m of MODELS) {
    for (const f of m.fields as DmmfField[]) {
      if (f.kind !== 'object' || f.type !== target) continue;
      const from = f.relationFromFields ?? [];
      const to = f.relationToFields ?? [];
      if (from.length !== 1 || to.length !== 1) continue; // المفاتيح المركّبة غير مستعملة لمستندات الشركة
      const fkField = m.fields.find((x) => x.name === from[0]);
      out.push({ child: m, fk: from[0], ref: to[0], required: !!fkField?.isRequired });
    }
  }
  inboundCache.set(target, out);
  return out;
}

export const hasTenantId = (m: DmmfModel | undefined): boolean => !!m?.fields.some((f) => f.name === 'tenantId' && f.kind === 'scalar');

/** النماذج القابلة للاستهداف: كل نموذجٍ فيه tenantId عدا NOT_TARGETABLE */
export function targetableModels(): string[] {
  return MODELS.filter((m) => hasTenantId(m) && !NOT_TARGETABLE.has(m.name)).map((m) => m.name).sort();
}

/** الحقول التي تصلح وصفاً/بحثاً للصف */
const LABEL_FIELDS = ['number', 'name', 'title', 'code', 'username', 'phone', 'email', 'label', 'type', 'status'];
export function labelFieldsOf(model: string): string[] {
  const m = byName.get(model);
  if (!m) return [];
  return LABEL_FIELDS.filter((n) => m.fields.some((f) => f.name === n && f.kind === 'scalar' && f.type === 'String'));
}

export interface PurgePlan {
  model: string;
  /** دفعات الحذف بترتيب الاكتشاف (الأب قبل ابنه) — التنفيذ بالعكس */
  batches: Array<{ model: string; keys: Array<Record<string, unknown>> }>;
  nullify: Array<{ model: string; fk: string; values: unknown[]; count: number }>;
  counts: Record<string, number>;
  nullCounts: Record<string, number>;
  invoiceIds: string[];
  receiptIds: string[];
}

const keyOf = (pk: string[], row: Record<string, unknown>) => JSON.stringify(pk.map((k) => row[k]));

/**
 * يبني خطة الحذف لصفٍّ واحد (أو أكثر) من `model` داخل الشركة `tenantId`. يقرأ فقط.
 * يرمي PurgeRefused إن لم يوجد الصف في هذه الشركة.
 */
export class PurgeRefused extends Error {}

export async function buildPurgePlan(db: Tx | typeof prisma, tenantId: string, model: string, id: string): Promise<PurgePlan> {
  const root = byName.get(model);
  if (!root || !hasTenantId(root) || NOT_TARGETABLE.has(model)) throw new PurgeRefused('نوع غير معروف');
  const pk = pkFields(root);
  if (pk.length !== 1) throw new PurgeRefused('نوع غير مدعوم');
  const d = (db as unknown as Record<string, { findMany(a: unknown): Promise<Array<Record<string, unknown>>>; count(a: unknown): Promise<number> }>);
  const first = await d[delegateOf(model)].findMany({ where: { [pk[0]]: id, tenantId }, select: { [pk[0]]: true } });
  if (!first.length) throw new PurgeRefused('السجل غير موجود في هذه الشركة');

  const plan: PurgePlan = { model, batches: [], nullify: [], counts: {}, nullCounts: {}, invoiceIds: [], receiptIds: [] };
  const seen = new Map<string, Set<string>>();
  const seenOf = (m: string) => { let s = seen.get(m); if (!s) { s = new Set(); seen.set(m, s); } return s; };

  // طابور: (نموذج، شرط) — كل دفعةٍ تُقرأ بمفاتيحها الأساسية والحقول المُشار إليها
  const queue: Array<{ model: string; where: Record<string, unknown> }> = [{ model, where: { [pk[0]]: id, tenantId } }];
  let guard = 0;
  while (queue.length) {
    if (++guard > 5000) throw new PurgeRefused('سلسلة الحذف أطول من المسموح');
    const { model: mName, where } = queue.shift()!;
    const m = byName.get(mName)!;
    const mpk = pkFields(m);
    if (!mpk.length) continue;
    const inbound = inboundOf(mName);
    const refs = [...new Set(inbound.map((r) => r.ref))];
    const select: Record<string, true> = {};
    for (const f of [...mpk, ...refs]) select[f] = true;
    const rows = await d[delegateOf(mName)].findMany({ where, select });
    const s = seenOf(mName);
    const fresh = rows.filter((r) => { const k = keyOf(mpk, r); if (s.has(k)) return false; s.add(k); return true; });
    if (!fresh.length) continue;
    plan.batches.push({ model: mName, keys: fresh.map((r) => Object.fromEntries(mpk.map((k) => [k, r[k]]))) });
    plan.counts[mName] = (plan.counts[mName] ?? 0) + fresh.length;
    if (mName === 'Invoice') plan.invoiceIds.push(...fresh.map((r) => String(r.id)));
    if (mName === 'Receipt') plan.receiptIds.push(...fresh.map((r) => String(r.id)));

    for (const r of inbound) {
      const values = [...new Set(fresh.map((x) => x[r.ref]).filter((v) => v !== null && v !== undefined))];
      if (!values.length) continue;
      const cw = { [r.fk]: { in: values } };
      if (r.required || DELETE_ON_OPTIONAL.has(`${r.child.name}.${r.fk}`)) {
        queue.push({ model: r.child.name, where: cw });
      } else {
        const count = await d[delegateOf(r.child.name)].count({ where: cw });
        if (count) {
          plan.nullify.push({ model: r.child.name, fk: r.fk, values, count });
          plan.nullCounts[r.child.name] = (plan.nullCounts[r.child.name] ?? 0) + count;
        }
      }
    }
    // قرار المالك: الفاتورة المحذوفة تسحب معها سندات القبض المخصَّصة لها
    if (mName === 'Invoice') {
      const ids = fresh.map((x) => x.id);
      const links = await (db as typeof prisma).receiptInvoice.findMany({ where: { invoiceId: { in: ids as string[] } }, select: { receiptId: true } });
      const rids = [...new Set(links.map((l) => l.receiptId))];
      if (rids.length) queue.push({ model: 'Receipt', where: { id: { in: rids } } });
    }
  }
  return plan;
}

/** أثر المستندات القائمة المحذوفة على «إجمالي المبيعات/التحصيل» لكل عميل — يُقرأ قبل الحذف */
async function totalsDelta(tx: Tx, plan: PurgePlan): Promise<Map<string, { sales: number; collected: number }>> {
  const out = new Map<string, { sales: number; collected: number }>();
  const add = (cid: string, sales: number, collected: number) => {
    const cur = out.get(cid) ?? { sales: 0, collected: 0 };
    cur.sales = clean(cur.sales + sales); cur.collected = clean(cur.collected + collected);
    out.set(cid, cur);
  };
  if (plan.invoiceIds.length) {
    const invs = await tx.invoice.findMany({ where: { id: { in: plan.invoiceIds }, status: 'CONFIRMED' }, select: { customerId: true, type: true, total: true } });
    for (const i of invs) {
      const t = Number(i.total);
      if (i.type === 'RETURN') add(i.customerId, t, 0);
      else if (i.type === 'CASH') add(i.customerId, -t, -t);
      else add(i.customerId, -t, 0);
    }
  }
  if (plan.receiptIds.length) {
    const recs = await tx.receipt.findMany({ where: { id: { in: plan.receiptIds }, status: 'ACTIVE' }, select: { customerId: true, amount: true } });
    for (const r of recs) add(r.customerId, 0, -Number(r.amount));
  }
  return out;
}

/** عملاء تمسّهم الخطة (أصحاب الفواتير والسندات وقيود الحساب المحذوفة) */
async function touchedCustomers(tx: Tx, plan: PurgePlan): Promise<Set<string>> {
  const ids = new Set<string>();
  if (plan.invoiceIds.length) for (const i of await tx.invoice.findMany({ where: { id: { in: plan.invoiceIds } }, select: { customerId: true } })) ids.add(i.customerId);
  if (plan.receiptIds.length) for (const r of await tx.receipt.findMany({ where: { id: { in: plan.receiptIds } }, select: { customerId: true } })) ids.add(r.customerId);
  const ae = plan.batches.filter((b) => b.model === 'AccountEntry').flatMap((b) => b.keys.map((k) => String(k.id)));
  if (ae.length) for (const a of await tx.accountEntry.findMany({ where: { id: { in: ae } }, select: { customerId: true } })) ids.add(a.customerId);
  return ids;
}

export interface PurgeResult { counts: Record<string, number>; nullCounts: Record<string, number> }

/** مفاتيح كل نموذجٍ في الخطة مجموعةً من دفعاته */
function mergedKeys(plan: PurgePlan): Map<string, Array<Record<string, unknown>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const b of plan.batches) out.set(b.model, [...(out.get(b.model) ?? []), ...b.keys]);
  return out;
}

/**
 * ترتيب الحذف على مستوى النماذج: كل نموذجٍ يُحذف قبل كل نموذجٍ يشير إليه بمفتاحٍ يُحذف به (إلزامي أو DELETE_ON_OPTIONAL) —
 * الأبناء قبل الآباء أياً كان ترتيب اكتشافهم (صفٌّ يصله أبوان يُكتشف تحت أولهما). والعلاقة الذاتية الاختيارية فُرّغت قبله.
 * ودورةٌ بين نماذج (نادرة) تُكمَل بترتيب الاكتشاف المعكوس.
 */
export function deletionOrder(plan: PurgePlan): string[] {
  const models = [...new Set(plan.batches.map((b) => b.model))];
  const inPlan = new Set(models);
  // must[P] = أبناء P في الخطة (يُحذفون قبله)
  const must = new Map<string, Set<string>>(models.map((m) => [m, new Set<string>()]));
  for (const p of models) {
    for (const r of inboundOf(p)) {
      if (r.child.name === p || !inPlan.has(r.child.name)) continue;
      if (r.required || DELETE_ON_OPTIONAL.has(`${r.child.name}.${r.fk}`)) must.get(p)!.add(r.child.name);
    }
  }
  const out: string[] = [];
  const done = new Set<string>();
  const discovery = [...models].reverse();
  while (out.length < models.length) {
    const ready = discovery.find((m) => !done.has(m) && [...must.get(m)!].every((c) => done.has(c)));
    const next = ready ?? discovery.find((m) => !done.has(m))!;
    out.push(next); done.add(next);
  }
  return out;
}

/** ينفّذ الخطة في معاملة واحدة: إعادة مبالغ تخصيص السندات القائمة، ثم التفريغ، ثم الحذف من الأبناء إلى الآباء، ثم تصحيح الأرصدة */
export async function executePurge(tenantId: string, model: string, id: string): Promise<PurgeResult> {
  return prisma.$transaction(async (tx) => {
    const plan = await buildPurgePlan(tx, tenantId, model, id);
    const deltas = await totalsDelta(tx, plan);
    const customers = await touchedCustomers(tx, plan);

    // السند القائم المحذوف: مبالغ تخصيصه لفواتير **باقية** تعود إليها (المحذوفة لا يعنيها)
    if (plan.receiptIds.length) {
      const goneInv = new Set(plan.invoiceIds);
      const allocs = await tx.receiptInvoice.findMany({
        where: { receiptId: { in: plan.receiptIds }, receipt: { status: 'ACTIVE' } },
        select: { invoiceId: true, amount: true },
      });
      await restoreAllocations(tx as never, tenantId, allocs.filter((a) => !goneInv.has(a.invoiceId)));
    }

    const d = tx as unknown as Record<string, { updateMany(a: unknown): Promise<unknown>; deleteMany(a: unknown): Promise<{ count: number }> }>;
    for (const n of plan.nullify) {
      await d[delegateOf(n.model)].updateMany({ where: { [n.fk]: { in: n.values } }, data: { [n.fk]: null } });
    }
    const keysOf = mergedKeys(plan);
    for (const m of deletionOrder(plan)) {
      const rows = keysOf.get(m) ?? [];
      const keys = Object.keys(rows[0] ?? {});
      if (keys.length === 1) {
        const k = keys[0];
        for (let i = 0; i < rows.length; i += 1000) {
          await d[delegateOf(m)].deleteMany({ where: { [k]: { in: rows.slice(i, i + 1000).map((x) => x[k]) } } });
        }
      } else {
        for (const key of rows) await d[delegateOf(m)].deleteMany({ where: key });
      }
    }

    // الأرصدة المخزَّنة للعملاء الباقين
    for (const cid of customers) {
      const exists = await tx.customer.findUnique({ where: { id: cid }, select: { id: true } });
      if (!exists) continue;
      const dl = deltas.get(cid) ?? { sales: 0, collected: 0 };
      await tx.customer.update({
        where: { id: cid },
        data: {
          balance: await currentBalance(tx as never, cid),
          ...(dl.sales && { totalSales: { increment: dl.sales } }),
          ...(dl.collected && { totalCollected: { increment: dl.collected } }),
        },
      });
    }
    return { counts: plan.counts, nullCounts: plan.nullCounts };
  }, { timeout: 120_000, maxWait: 15_000 });
}
