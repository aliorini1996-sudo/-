/**
 * «سجلّ العميل» الثابت — اختبارات سلوكية (QA) فوق اختبارات الحرّاس في customerActivity.test.ts:
 *
 *   ١) العقد مع الخادم **بالاستيراد الحقيقي** لا بالتعابير النمطية: كل إجراءٍ في CUSTOMER_ACTIONS، وكل نوع فاعلٍ في ACTOR_KINDS،
 *      والأقسام وتطابق قسم كل إجراء، ومعاملات الطلب كما يحلّلها parseActivityQuery.
 *   ٢) خطّ الأنابيب كاملاً: بُناة الأحداث في الخادم (customerActivityEvents/customerActivityDocs) ⇐ activityRow (التنظيف) ⇐
 *      القارئ loadCustomerActivity بقاعدةٍ في الذاكرة (والتاريخ المشتقّ من الجداول) ⇐ JSON ⇐ normalizePage ⇐ رسم ActivityList.
 *   ٣) فروق التعديل لكل حقلٍ يتتبّعه customerDiff، وإخفاء المال حين يُطفأ النظام المحاسبي في كل موضع، وعلامة «سجل تاريخي»،
 *      وتجميع الأيام بالتقويم الميلادي وبحدود يوم الجهاز (Asia/Riyadh)، ودمج الصفحات بلا تكرار.
 *
 * لا قاعدة ولا شبكة: الخادم يُستورد ملفّاتٍ وحده، وDATABASE_URL يُضبط لعنوانٍ لا يصل (لا يُنفَّذ استعلامٌ أصلاً).
 * يُتخطّى قسم الخادم حين لا تتوفّر حزم الخادم (بيئة بناء الواجهة وحدها).
 *
 * الاختبارات التي تبدأ بـ«BUG» تكشف عيباً قائماً — تُترك فاشلةً دليلاً حتى يُصلح.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ACTION_LABELS, ACTIVITY_CATEGORIES, ACTIVITY_FILTERS, ACTOR_KIND_LABELS, CATEGORY_LABELS, CUSTOMER_ACTIONS, FIELD_LABELS,
  actionLabel, activityQuery, actorDisplay, actorKindLabel, categoryOf, changeValue, changesOf, dayKeyOf, describeChange, detailsOf,
  groupByDay, itemsOf, mergeItems, normalizeItem, normalizePage, type ActivityItem,
} from './customerActivity';
import { BUYER_ID_SCHEME_LABELS_AR } from './zatca/buyerForm';
import { formatCurrency, formatNumber, formatTime, setActiveNumerals } from '../utils/format';
import { useLang } from '../i18n/lang';
import ActivityList from '../components/customerActivity/ActivityList';

// حدود اليوم كجهاز المندوب والإداري في السعودية — Node يطبّق TZ لحظة ضبطه
process.env.TZ = 'Asia/Riyadh';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_SRC = path.resolve(SRC, '..', '..', 'backend', 'src');
const BACKEND_READY = fs.existsSync(path.join(BACKEND_SRC, 'services', 'customerActivity.ts'))
  && fs.existsSync(path.resolve(BACKEND_SRC, '..', 'node_modules', '@prisma', 'client'))
  && fs.existsSync(path.resolve(BACKEND_SRC, '..', 'node_modules', 'express'));
const NO_BACKEND = !BACKEND_READY && 'حزم الخادم غير متوفّرة';

const AR = /[؀-ۿ]/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** رمزٌ لاتيني بأحرفٍ كبيرة (CRN، NORMAL، SOME_CODE) — لا يصحّ أن يراه القارئ */
const LATIN_CODE_RE = /(?<![\w.#-])[A-Z][A-Z0-9_]{1,}(?![\w.-])/;
/** تقويمٌ هجري متسرّب (فبراير–مارس ٢٠٢٦ تقع في رمضان ١٤٤٧) */
const HIJRI = /هـ|محرم|صفر|ربيع|جمادى|رجب|شعبان|رمضان|شوال|ذو القعدة|ذو الحجة/;

/** نصّ المرسوم بلا وسوم — للبحث في ما يراه القارئ لا في الصنوف والسمات */
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
const render = (items: ActivityItem[], accountingOn: boolean, taxOff = false) =>
  renderToStaticMarkup(h(ActivityList, { items, accountingOn, taxOff }));
const item = (over: Partial<ActivityItem> & { id: string; action: string }): ActivityItem => ({
  at: '2026-03-01T09:00:00Z', category: categoryOf(over.action), actor: { kind: 'ADMIN', name: 'سارة' }, refType: null, refId: null,
  refNo: null, amount: null, data: null, historical: false, ...over,
});

// ═══════════════════ الخادم: استيرادٌ حقيقي (بلا قاعدة) ═══════════════════

type AnyMod = Record<string, any>;
interface Backend { svc: AnyMod; events: AnyMod; docs: AnyMod; route: AnyMod; prisma: AnyMod }
let backendP: Promise<Backend> | null = null;
function backend(): Promise<Backend> {
  if (!backendP) {
    // لا اتصال بالقاعدة أبداً: لا استعلام يُنفَّذ، وإن نُفِّذ خطأً فهذا العنوان لا يصل
    process.env.DATABASE_URL = 'postgresql://qa-offline:qa-offline@127.0.0.1:1/qa_offline';
    const load = (...p: string[]) => import(pathToFileURL(path.join(BACKEND_SRC, ...p)).href) as Promise<AnyMod>;
    backendP = (async () => ({
      svc: await load('services', 'customerActivity.ts'),
      events: await load('services', 'customerActivityEvents.ts'),
      docs: await load('services', 'customerActivityDocs.ts'),
      route: await load('routes', 'customerActivity.ts'),
      prisma: await import(pathToFileURL(path.resolve(BACKEND_SRC, '..', 'node_modules', '@prisma', 'client', 'index.js')).href) as AnyMod,
    }))();
  }
  return backendP;
}

// قاعدةٌ في الذاكرة بقدر ما يقرؤه loadCustomerActivity (where/orderBy/take)
type Row = Record<string, any>;
const isPlain = (v: unknown): v is Row => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
const val = (v: unknown) => (v instanceof Date ? v.getTime() : v);
const eq = (a: unknown, b: unknown) => val(a) === val(b) || (a == null && b == null);
const lt = (a: unknown, b: unknown) => a != null && b != null && (val(a) as number) < (val(b) as number);
function matchOps(v: unknown, ops: Row): boolean {
  for (const [op, x] of Object.entries(ops)) {
    if (op === 'in') { if (!(x as unknown[]).some((y) => eq(v, y))) return false; }
    else if (op === 'not') { if (x === null ? v == null : (v == null || eq(v, x))) return false; }
    else if (op === 'lt') { if (!lt(v, x)) return false; }
    else if (op === 'lte') { if (!(lt(v, x) || eq(v, x))) return false; }
    else if (op === 'gt') { if (!lt(x, v)) return false; }
    else throw new Error(`op ${op}`);
  }
  return true;
}
function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, w] of Object.entries(where)) {
    if (k === 'AND') { if (!(w as Row[]).every((x) => matchWhere(row, x))) return false; continue; }
    if (k === 'OR') { if (!(w as Row[]).some((x) => matchWhere(row, x))) return false; continue; }
    if (isPlain(w)) { if (!matchOps(row[k], w)) return false; continue; }
    if (!eq(row[k], w)) return false;
  }
  return true;
}
function sortRows(rows: Row[], orderBy: Row[] | Row | undefined): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).map((o) => Object.entries(o)[0] as [string, string]);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of keys) {
      const x = val(a[k]) as number | string; const y = val(b[k]) as number | string;
      if (x === y) continue;
      return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
function memDb(tables: Record<string, Row[]>) {
  return new Proxy({}, {
    get(_t, model: string) {
      const rows = () => tables[model] ?? [];
      return {
        findMany: async (args: Row = {}) => {
          const hit = sortRows(rows().filter((r) => matchWhere(r, args.where)), args.orderBy);
          return args.take ? hit.slice(0, args.take) : hit;
        },
        findFirst: async (args: Row = {}) => rows().find((r) => matchWhere(r, args.where)) ?? null,
      };
    },
  });
}

const T = 't1';
const CUSTOMER = {
  id: 'c1', tenantId: T, name: 'بقالة النور', businessName: null, phone: '0501234567', number: 7, createdAt: new Date('2025-06-01T08:00:00Z'),
  clientRef: null, createdBySalesRepId: null, createdBySalesRep: null,
};
const ADMIN_REQ = { user: { id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T } };
const META = { actor: { kind: 'ADMIN', id: 'a1', name: 'سارة' }, source: 'web' };

/**
 * ما يراه المتصفّح: مدخلات الأحداث كما تبنيها الخدمات ⇐ activityRow ⇐ صفوف السجلّ (data عبر JSON كعمود Json) ⇐
 * loadCustomerActivity (مع جداول التاريخ) ⇐ JSON الردّ ⇐ normalizePage — بالضبط ما يصل ActivityTimeline
 */
async function served(log: Row[], tables: Record<string, Row[]> = {}, opts: { category?: string; req?: Row } = {}): Promise<ActivityItem[]> {
  const be = await backend();
  const rows = log.map((input, i) => {
    const r = be.svc.activityRow(input);
    assert.ok(r, `activityRow أسقط مُدخلاً: ${JSON.stringify(input).slice(0, 120)}`);
    return {
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, ...r,
      at: r.at ?? new Date(Date.UTC(2026, 2, 1, 6, 0, 0) + i * 60_000),
      data: r.data == null ? null : JSON.parse(JSON.stringify(r.data)),
    };
  });
  const db = memDb({ customer: [CUSTOMER], customerActivity: rows, ...tables });
  const page = await be.route.loadCustomerActivity(
    { db, customerScope: async () => ({}) }, opts.req ?? ADMIN_REQ, T, 'c1', be.route.parseActivityQuery({ category: opts.category }),
  );
  assert.ok(page, 'العميل غير موجود في القاعدة المؤقّتة');
  return normalizePage(JSON.parse(JSON.stringify(page))).items;
}

// ═══════════════════ ١) العقد مع الخادم ═══════════════════

test('كل إجراءٍ في CUSTOMER_ACTIONS بالخادم: عنوانٌ عربي غير فارغ وغير «إجراء آخر»، وقسمٌ يطابق ACTION_CATEGORY، وزرّ قسمه موجود', { skip: NO_BACKEND }, async () => {
  const { svc } = await backend();
  assert.ok(Array.isArray(svc.CUSTOMER_ACTIONS) && svc.CUSTOMER_ACTIONS.length >= 40, 'قائمة الخادم');
  assert.deepEqual([...svc.CUSTOMER_ACTIONS].sort(), [...CUSTOMER_ACTIONS].sort(), 'قائمة الواجهة ليست مرآة الخادم');
  for (const a of svc.CUSTOMER_ACTIONS as string[]) {
    const title = actionLabel(a);
    assert.ok(title.trim().length > 0 && AR.test(title), `${a}: عنوانٌ فارغ أو غير عربي`);
    assert.doesNotMatch(title, /[A-Za-z]/, `${a}: حرفٌ لاتيني في العنوان`);
    if (a !== 'OTHER') assert.notEqual(title, ACTION_LABELS.OTHER, `${a}: يرتدّ إلى «إجراء آخر»`);
    const cat = categoryOf(a);
    assert.equal(cat, svc.ACTION_CATEGORY[a], `${a}: قسم الواجهة ${cat} ≠ قسم الخادم ${svc.ACTION_CATEGORY[a]}`);
    assert.equal(cat, svc.categoryOfAction(a));
    assert.ok((ACTIVITY_FILTERS as readonly string[]).includes(cat) && AR.test(CATEGORY_LABELS[cat]), `${a}: لا زرّ لقسمه`);
  }
  // عنوانان متطابقان لإجراءين مختلفين يُضلّلان القارئ
  const titles = (svc.CUSTOMER_ACTIONS as string[]).map((a) => actionLabel(a));
  assert.equal(new Set(titles).size, titles.length, 'عنوانان متطابقان');
});

test('الأقسام: قائمة الواجهة = قائمة الخادم، وactionsOfCategory لكل قسم = ما تصنّفه الواجهة فيه، وقسم الطلب يحلّله الخادم كما هو', { skip: NO_BACKEND }, async () => {
  const { svc, route } = await backend();
  assert.deepEqual([...ACTIVITY_CATEGORIES], [...svc.ACTIVITY_CATEGORIES]);
  assert.deepEqual([...ACTIVITY_FILTERS], ['all', ...svc.ACTIVITY_CATEGORIES]);
  for (const c of ACTIVITY_CATEGORIES) {
    assert.deepEqual([...svc.actionsOfCategory(c)].sort(), CUSTOMER_ACTIONS.filter((a) => categoryOf(a) === c).sort(), c);
    // زرّ القسم ⇐ activityQuery ⇐ ‎?category=‎ ⇐ parseActivityQuery: القسم نفسه، لا «الكل» بصمت
    const q = activityQuery({ category: c });
    assert.equal(q.category, c);
    assert.equal(route.parseActivityQuery(q).category, c, `${c}: الخادم لا يعرف القسم فيعيد الكل`);
  }
  // «الكل» لا يُرسل، والخادم يفهم غيابه «الكل»
  assert.equal('category' in activityQuery({ category: 'all' }), false);
  assert.equal(route.parseActivityQuery(activityQuery({ category: 'all' })).category, 'all');
  // مؤشّر الصفحة التالية كما يعيده الخادم يرجع إليه كما هو (لحظة~رتبة~معرّف)
  const cursor = route.encodeActivityCursor({ at: new Date('2026-03-01T06:00:00.000Z'), rank: 60, id: 'h:invoice:x' });
  const back = route.parseActivityQuery(activityQuery({ before: cursor })).cursor;
  assert.deepEqual({ at: back.at.toISOString(), rank: back.rank, id: back.id }, { at: '2026-03-01T06:00:00.000Z', rank: 60, id: 'h:invoice:x' });
  // سقف الصفحة: الواجهة لا تطلب أكثر مما يقبله الخادم
  assert.equal(activityQuery({ limit: 10_000 }).limit, route.ACTIVITY_MAX_LIMIT);
});

test('قسم كل بندٍ يعيده الخادم لكل زرّ قسم (من السجلّ والتاريخ معاً) هو القسم نفسه في الواجهة', { skip: NO_BACKEND }, async () => {
  const { docs } = await backend();
  const log = [
    docs.invoiceIssuedInput({ tenantId: T, meta: META, invoice: { id: 'i-live', number: 'INV-L', customerId: 'c1', type: 'CASH', total: 50 } }),
    docs.receiptEventInput({ tenantId: T, action: 'RECEIPT_ISSUED', meta: META, receipt: { id: 'r-live', number: 'RC-L', customerId: 'c1', amount: 20 } }),
    { tenantId: T, customerId: 'c1', action: 'DOCUMENT_ADDED', actor: META.actor, refType: 'DOCUMENT', refId: 'd-live', data: { kind: 'CR' } },
    { tenantId: T, customerId: 'c1', action: 'VISIT_RECORDED', actor: META.actor, refType: 'VISIT', refId: 'v-live', data: { durationSec: 60 } },
    { tenantId: T, customerId: 'c1', action: 'CUSTOMER_UPDATED', actor: META.actor, refType: 'CUSTOMER', refId: 'c1', data: { changes: [{ field: 'city', from: null, to: 'جدة' }] } },
    { tenantId: T, customerId: 'c1', action: 'FUTURE_THING', actor: META.actor },
  ];
  const tables = {
    invoice: [
      { id: 'i-h', tenantId: T, customerId: 'c1', number: 'INV-H', type: 'CREDIT', status: 'CONFIRMED', documentKind: null, invoiceDate: new Date('2026-02-01T08:00:00Z'), total: 10, _count: { items: 1 } },
      { id: 'r-h', tenantId: T, customerId: 'c1', number: 'RET-H', type: 'RETURN', status: 'CONFIRMED', documentKind: null, invoiceDate: new Date('2026-02-02T08:00:00Z'), total: 5, _count: { items: 1 } },
    ],
    repVisit: [{ id: 'v-h', tenantId: T, customerId: 'c1', createdAt: new Date('2026-02-03T08:00:00Z'), startedAt: null, endedAt: null, durationSec: 30, note: null, lat: null, lng: null, salesRepId: 'r1', salesRep: { name: 'أحمد' }, photos: [] }],
  };
  for (const c of ACTIVITY_CATEGORIES) {
    const items = await served(log, tables, { category: c });
    for (const it of items) {
      assert.equal(it.category, c, `${c}: بندٌ من قسمٍ آخر (${it.action} ⇒ ${it.category})`);
      assert.equal(categoryOf(it.action), c, `${c}: الواجهة تصنّف ${it.action} في ${categoryOf(it.action)}`);
    }
  }
  const all = await served(log, tables);
  const seen = new Set(all.map((x) => x.category));
  for (const c of ['sales', 'returns', 'money', 'docs', 'visits', 'edits', 'other']) assert.ok(seen.has(c as never), `لا بند في ${c}`);
});

// ═══════════════════ ٢) الإجراءات المجهولة (إصدارٌ أحدث من الخادم) ═══════════════════

test('إجراءٌ مستقبليّ لا تعرفه الواجهة: عنوان «إجراء آخر» وقسم «أخرى» ودور «النظام» — بلا رمزٍ لاتيني ولا JSON خام في الرسم', () => {
  const raw = {
    items: [{
      id: 'x1', at: '2026-03-01T09:00:00Z', action: 'LOYALTY_POINTS_GRANTED', category: 'loyalty', actor: { kind: 'ROBOT', name: '' },
      refType: 'LOYALTY', refId: 'l1', refNo: null, amount: 'not-a-number',
      data: { points: 120, tier: 'GOLD', reason: 'BIRTHDAY_BONUS', via: 'NEW_CHANNEL', status: 'GRANTED', changes: [{ field: 'loyaltyTier', from: 'SILVER', to: 'GOLD' }], nested: { a: 1 } },
      historical: 'yes',
    }],
    nextBefore: 42,
  };
  const page = normalizePage(raw);
  assert.equal(page.items.length, 1);
  assert.equal(page.nextBefore, null, 'مؤشّرٌ ليس نصّاً');
  const it = page.items[0];
  assert.equal(it.category, 'other', 'قسمٌ مجهول من الخادم ⇒ قسم الإجراء (أخرى)');
  assert.equal(it.amount, null);
  assert.equal(it.historical, false, '«سجل تاريخي» لا يُعلَّم إلا بـtrue صريحة');
  assert.equal(actionLabel(it.action), 'إجراء آخر');
  assert.deepEqual(actorDisplay(it.actor), { text: 'النظام', translate: true });
  assert.equal(describeChange('loyaltyTier'), 'حقل آخر');
  const html = render([it], true);
  const text = textOf(html);
  assert.ok(text.includes('إجراء آخر') && text.includes('النظام') && text.includes('حقل آخر'));
  for (const leak of ['LOYALTY_POINTS_GRANTED', 'ROBOT', 'BIRTHDAY_BONUS', 'NEW_CHANNEL', 'GRANTED', 'loyaltyTier', 'nested', '{']) {
    assert.ok(!text.includes(leak), `«${leak}» ظاهرٌ للقارئ`);
  }
});

test('إجراءٌ مجهول يكتبه الخادم: activityRow يحفظه OTHER واسمه في data.action — والواجهة لا تُظهر الاسم', { skip: NO_BACKEND }, async () => {
  const items = await served([{ tenantId: T, customerId: 'c1', action: 'SOMETHING_NEW', actor: { kind: 'MARTIAN', id: 'z', name: null }, data: { note: 'تجربة' } }]);
  const it = items.find((x) => x.action === 'OTHER');
  assert.ok(it, 'السطر لم يُحفظ OTHER');
  assert.equal(it!.data?.action, 'SOMETHING_NEW');
  assert.equal(it!.actor.kind, 'SYSTEM', 'فاعلٌ مجهول ⇒ النظام');
  const text = textOf(render([it!], true));
  assert.ok(text.includes('إجراء آخر') && text.includes('تجربة') && text.includes('النظام'));
  assert.ok(!text.includes('SOMETHING_NEW') && !text.includes('MARTIAN'));
});

// ═══════════════════ ٣) الفاعل ═══════════════════

test('كل نوع فاعلٍ في ACTOR_KINDS بالخادم: اسم دورٍ عربي مميّز — بلا اسم يُعرض الدور، وباسمٍ يُعرض الاسم وشارة الدور', { skip: NO_BACKEND }, async () => {
  const { svc } = await backend();
  assert.deepEqual([...svc.ACTOR_KINDS].sort(), Object.keys(ACTOR_KIND_LABELS).sort());
  // عرف المنصّة (العقد المشترك): المالك وموظفه دورٌ واحد «الدعم الفني» للشركة — وما سواهما أدوارٌ مميّزة
  const labels = (svc.ACTOR_KINDS as string[]).filter((k) => k !== 'STAFF').map((k) => actorKindLabel(k));
  assert.equal(new Set(labels).size, labels.length, 'دوران بالاسم نفسه');
  assert.equal(actorKindLabel('OWNER'), 'الدعم الفني');
  assert.equal(actorKindLabel('STAFF'), 'الدعم الفني');
  for (const kind of svc.ACTOR_KINDS as string[]) {
    const role = actorKindLabel(kind);
    assert.ok(AR.test(role), kind);
    const anon = textOf(render([item({ id: `a-${kind}`, action: 'VISIT_RECORDED', actor: { kind, name: null } })], true));
    assert.ok(anon.includes(role), `${kind}: الدور غائب`);
    const named = textOf(render([item({ id: `n-${kind}`, action: 'VISIT_RECORDED', actor: { kind, name: 'خالد' } })], true));
    assert.ok(named.includes('خالد') && named.includes(role), `${kind}: الاسم أو شارة الدور غائبة`);
  }
});

test('الفاعل من الطلب حتى الشاشة: المندوب والإداري والمفتاح البرمجي والمالك والموظف — والمالك والموظف بدورهما وحده لقارئ الشركة', { skip: NO_BACKEND }, async () => {
  const { svc } = await backend();
  const reqs: [Row, string, string | null][] = [
    [{ user: { id: 'r1', role: 'SALES_REP', name: 'أحمد', tenantId: T } }, 'مندوب', 'أحمد'],
    [{ user: { id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T } }, 'إداري', 'سارة'],
    [{ user: { id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T, apiKeyId: 'k1', apiKeyName: 'أودو' } }, 'الربط البرمجي', 'أودو'],
    // المالك وموظفه «الدعم الفني» للشركة (عرف المنصّة — العقد المشترك)
    [{ user: { id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T, impersonated: true, by: 'o1' } }, 'الدعم الفني', null],
    [{ user: { id: 'a1', role: 'ADMIN', name: 'سارة', tenantId: T, impersonated: true, byKind: 'STAFF', by: 's1', byName: 'موظف الدعم' } }, 'الدعم الفني', null],
    [{}, 'النظام', null],
  ];
  const log = reqs.map(([req], i) => ({ tenantId: T, customerId: 'c1', action: 'VISIT_RECORDED', actor: svc.actorFromReq(req), refType: 'VISIT', refId: `v${i}` }));
  const items = await served(log);
  for (let i = 0; i < reqs.length; i++) {
    const it = items.find((x) => x.refId === `v${i}`)!;
    const [, role, name] = reqs[i];
    const text = textOf(render([it], true));
    assert.ok(text.includes(role), `${role}: الدور غائب`);
    if (name) assert.ok(text.includes(name), `${role}: الاسم غائب`);
    // «لا يدخل حسابك إلا مديره»: لا اسم مدير الشركة الذي وُقّع به توكن الدخول، ولا اسم الموظف لقارئ الشركة
    if (role === 'الدعم الفني') assert.ok(!text.includes('سارة') && !text.includes('موظف الدعم'), `${role}: اسمٌ مكشوف`);
  }
});

// ═══════════════════ ٤) فروق التعديل لكل حقلٍ يتتبّعه customerDiff ═══════════════════

const BEFORE: Row = {
  id: 'c1', name: 'بقالة', businessName: null, phone: '0500000000', altPhone: null, email: null, address: 'شارع ١', city: 'الرياض',
  district: 'العليا', status: 'ACTIVE', creditLimit: 0, paymentDays: 0, priceListId: null, channel: 'TT', outletType: 'GROCERY',
  taxNumber: null, commercialReg: null, buyerType: 'INDIVIDUAL', buyerIdScheme: null, buyerIdValue: null, addrStreet: null,
  addrBuildingNo: null, addrAdditionalNo: null, addrPostalCode: null, countryCode: null, createdBySalesRepId: null, lat: null, lng: null,
};
const AFTER: Row = {
  ...BEFORE, name: 'بقالة النور', businessName: 'مؤسسة النور', phone: '0511111111', altPhone: '+966 55 123 4567', email: 'noor@example.sa',
  address: 'شارع الملك فهد', city: 'جدة', district: 'الروضة', status: 'BLOCKED', creditLimit: 5000, paymentDays: 30,
  priceListId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', channel: 'WHOLESALE', outletType: 'SUPERMARKET', taxNumber: '300000000000003',
  commercialReg: '1010101010', buyerType: 'BUSINESS', buyerIdScheme: 'CRN', buyerIdValue: '1010101010', addrStreet: 'التحلية',
  addrBuildingNo: '1234', addrAdditionalNo: '5678', addrPostalCode: '12345', countryCode: 'SA',
  createdBySalesRepId: '6fa459ea-ee8a-3ca4-894e-db77e160355e', lat: 24.7136, lng: 46.6753,
};

test('كل حقلٍ يتتبّعه customerDiff موجودٌ في نموذج العميل وليس تاريخاً (قيمة التاريخ تُعرض نصّ ISO خاماً لو تُتُبّع)', { skip: NO_BACKEND }, async () => {
  const { svc, prisma } = await backend();
  const P = prisma.Prisma ?? prisma.default?.Prisma;
  const model = (P.dmmf.datamodel.models as { name: string; fields: { name: string; type: string }[] }[]).find((m) => m.name === 'Customer');
  assert.ok(model, 'نموذج Customer');
  const types = new Map(model!.fields.map((f) => [f.name, f.type]));
  const missing = (svc.TRACKED_CUSTOMER_FIELDS as string[]).filter((f) => !types.has(f));
  // حقولٌ بلا عمود لا تتغيّر أبداً — تُذكر للعلم (لا تُفشل): مرادفاتٌ قديمة في القائمة
  if (missing.length) console.log(`[QA] حقول مُتتبَّعة بلا عمود في Customer: ${missing.join(', ')}`);
  for (const f of svc.TRACKED_CUSTOMER_FIELDS as string[]) {
    if (!types.has(f)) continue;
    assert.notEqual(types.get(f), 'DateTime', `${f}: حقل تاريخ — changeValue يعرضه ISO خاماً`);
    assert.notEqual(describeChange(f), 'حقل آخر', `${f}: بلا اسم عربي`);
  }
});

test('تعديل العميل من الخادم حتى الشاشة: كل حقلٍ يُعرض باسمه العربي وقيمتين مقروءتين — والحالة والموقع وقائمة الأسعار بأحداثها', { skip: NO_BACKEND }, async () => {
  const { svc, events } = await backend();
  const diff = svc.customerDiff(BEFORE, AFTER) as { field: string }[];
  // كل حقلٍ متتبَّع له عمود غيّرناه يظهر في الفرق، والإحداثيان حقلٌ واحد
  const changedCols = (svc.TRACKED_CUSTOMER_FIELDS as string[]).filter((f) => f in AFTER && AFTER[f] !== BEFORE[f]);
  assert.deepEqual(diff.map((c) => c.field).sort(), [...changedCols, 'location'].sort());
  const inputs = events.customerUpdateEvents(BEFORE, AFTER, {
    tenantId: T, customerId: 'c1', meta: META, priceListNames: new Map([[AFTER.priceListId, 'قائمة الجملة']]),
  }) as Row[];
  assert.deepEqual(inputs.map((e) => e.action).sort(),
    ['CUSTOMER_LOCATION_SET', 'CUSTOMER_PRICE_LIST_CHANGED', 'CUSTOMER_STATUS_CHANGED', 'CUSTOMER_TAX_DATA_UPDATED', 'CUSTOMER_UPDATED']);
  const items = await served(inputs);
  const html = render(items, true);
  const text = textOf(html);
  assert.doesNotMatch(text, UUID_RE, 'معرّفٌ آلي ظاهر للقارئ');
  assert.ok(!text.includes('حقل آخر'), 'حقلٌ بلا اسم');

  // ما يجب أن يراه القارئ لكل حقل: اسمه وقيمته الجديدة مقروءة
  const expectShown: [string, string][] = [
    ['اسم العميل', 'بقالة النور'], ['الاسم التجاري', 'مؤسسة النور'], ['الجوال', '0511111111'], ['جوال إضافي', '+966 55 123 4567'],
    ['البريد الإلكتروني', 'noor@example.sa'], ['العنوان', 'شارع الملك فهد'], ['المدينة', 'جدة'], ['الحي', 'الروضة'],
    ['قناة البيع', 'الجملة'], ['نوع المنفذ', 'سوبرماركت'], ['مدة السداد بالأيام', '30'],
    ['الرقم الضريبي', '300000000000003'], ['السجل التجاري', '1010101010'], ['نوع المشتري', 'منشأة'], ['رقم هوية المشتري', '1010101010'],
    ['الشارع', 'التحلية'], ['رقم المبنى', '1234'], ['الرقم الإضافي', '5678'], ['الرمز البريدي', '12345'],
    ['الحالة الجديدة', 'محظور'], ['الحالة السابقة', 'نشط'], ['القائمة الجديدة', 'قائمة الجملة'], ['القائمة السابقة', 'السعر الأساسي'],
    ['الموقع على الخريطة', '24.71360, 46.67530'],
  ];
  for (const [label, value] of expectShown) {
    assert.ok(text.includes(label), `«${label}» غائب`);
    assert.ok(text.includes(value), `«${label}»: القيمة «${value}» غائبة`);
  }
  // القيم الرقمية والرموز باتجاه LTR داخل السطر العربي
  for (const v of ['0511111111', 'noor@example.sa', '12345', '24.71360, 46.67530']) {
    assert.ok(html.includes(`<bdi dir="ltr" class="[overflow-wrap:anywhere]">${v}</bdi>`), `${v}: بلا اتجاه LTR`);
  }
  // الأحداث المنفصلة لا تتكرّر حقولها داخل «تعديل بيانات العميل»
  const upd = items.find((x) => x.action === 'CUSTOMER_UPDATED')!;
  const updFields = changesOf(upd, { accountingOn: true }).map((c) => c.field);
  for (const f of ['status', 'priceListId', 'location', 'lat', 'lng', 'taxNumber', 'buyerType']) assert.ok(!updFields.includes(f), `${f} مكرّر`);
});

test('BUG(readability): «نوع هوية المشتري» (buyerIdScheme) يُعرض رمزاً لاتينياً خاماً «CRN» مع أن أسماءه العربية موجودة (BUYER_ID_SCHEME_LABELS_AR)', () => {
  // المسار الحقيقي: customerUpdateEvents ⇒ CUSTOMER_TAX_DATA_UPDATED { changes: [{ field: 'buyerIdScheme', from: null, to: 'CRN' }] }
  const it = item({ id: 's1', action: 'CUSTOMER_TAX_DATA_UPDATED', data: { changes: [{ field: 'buyerIdScheme', from: 'NAT', to: 'CRN' }] } });
  const text = textOf(render([it], true));
  assert.ok(text.includes('نوع هوية المشتري'));
  for (const [code, ar] of [['CRN', BUYER_ID_SCHEME_LABELS_AR.CRN], ['NAT', BUYER_ID_SCHEME_LABELS_AR.NAT]] as const) {
    assert.ok(text.includes(ar), `«${code}» لا يُعرض باسمه العربي «${ar}»`);
    assert.ok(!text.includes(code), `الرمز الخام «${code}» ظاهر للقارئ`);
  }
  // كل المخطّطات: قيمةٌ مترجمة لا رمز
  for (const [code, ar] of Object.entries(BUYER_ID_SCHEME_LABELS_AR)) {
    assert.deepEqual(changeValue('buyerIdScheme', code), { text: ar, translate: true, ltr: false }, code);
  }
});

test('BUG(minor, readability): «الدولة» (countryCode) تُعرض رمز ISO خاماً «SA/AE» لا اسم الدولة', () => {
  const it = item({ id: 'cc', action: 'CUSTOMER_TAX_DATA_UPDATED', data: { changes: [{ field: 'countryCode', from: 'AE', to: 'SA' }] } });
  const text = textOf(render([it], true));
  assert.ok(text.includes('الدولة'));
  assert.ok(text.includes('السعودية') && text.includes('الإمارات'), `القيمتان رمزان خامان: «${text}»`);
});

test('BUG(minor, consistency): تعديل «الحد الائتماني» يُعرض رقماً خاماً «5000» لا بعملة الشركة وترقيمها كسائر المبالغ في البطاقة', () => {
  const it = item({ id: 'cl', action: 'CUSTOMER_UPDATED', data: { changes: [{ field: 'creditLimit', from: 1500, to: 5000 }] } });
  const html = render([it], true);
  assert.ok(textOf(html).includes('الحد الائتماني'));
  assert.ok(html.includes(formatCurrency(5000)) && html.includes(formatCurrency(1500)),
    `القيمتان ليستا بعملة الشركة (${formatCurrency(5000)}): ${textOf(html)}`);
});

test('BUG(minor, rendering): طرفٌ قيمته معرّفٌ آلي يُرسم خانةً فارغة بجوار السهم («الكود:  ← C-001» من ربط الاستيراد، و«— ← » لمعرّف المندوب)', () => {
  // changeValue يعيد null للمعرّف الآلي (uuid/cuid) — وActivityCard يرسم السطر بسهمٍ متى كان أحد الطرفين غير null، فيبقى الآخر خانةً فارغة.
  // الوصول: routes/import.ts (ربط الكود: from = الكود الآلي cuid) — وcustomerDiff لـcreatedBySalesRepId (null ⇒ uuid)
  const lineOf = (html: string, label: string) => html.slice(html.indexOf(label), html.indexOf('</li>', html.indexOf(label)));
  const imported = item({ id: 'code', action: 'CUSTOMER_UPDATED', data: { changes: [{ field: 'code', from: 'ckx9q2w3e4r5t6y7u8i9o0p1a', to: 'C-001' }], via: 'import' } });
  const rep = item({ id: 'rep', action: 'CUSTOMER_UPDATED', data: { changes: [{ field: 'createdBySalesRepId', from: null, to: '6fa459ea-ee8a-3ca4-894e-db77e160355e' }] } });
  const codeLine = lineOf(render([imported], true), 'الكود');
  const repLine = lineOf(render([rep], true), 'المندوب الذي أضاف العميل');
  const emptySlot = /<span class="(?:text-\[#9A8F7E\] line-through decoration-\[#D9CDB8\]|font-semibold)"><\/span>/;
  assert.doesNotMatch(codeLine, emptySlot, `طرفٌ فارغ في سطر الكود: ${codeLine}`);
  assert.doesNotMatch(repLine, emptySlot, `طرفٌ فارغ في سطر المندوب: ${repLine}`);
});

test('فرق الموقع: من الخادم {from:null,to:{lat,lng}} وإحداثيان بخمس خانات LTR — وإزالة الموقع «—» — وlat/lng في changes سطرٌ واحد', { skip: NO_BACKEND }, async () => {
  const { events } = await backend();
  const set = events.customerUpdateEvents({ ...BEFORE }, { ...BEFORE, lat: 21.4858, lng: 39.1925 }, { tenantId: T, customerId: 'c1', meta: META });
  const cleared = events.customerUpdateEvents({ ...BEFORE, lat: 21.4858, lng: 39.1925 }, { ...BEFORE, lat: null, lng: null }, { tenantId: T, customerId: 'c1', meta: META });
  const items = await served([...set, ...cleared]);
  const locs = items.filter((x) => x.action === 'CUSTOMER_LOCATION_SET');
  assert.equal(locs.length, 2);
  const lines = locs.map((x) => changesOf(x, { accountingOn: true }).map((c) => [c.label, c.from?.text, c.to?.text]));
  assert.deepEqual(lines.sort(), [
    [['الموقع على الخريطة', '—', '21.48580, 39.19250']],
    [['الموقع على الخريطة', '21.48580, 39.19250', '—']],
  ].sort());
  // مسار بيانات الفوترة (taxOnly) يضمّ الإحداثيين إلى changes بحقل location
  const taxOnly = events.customerUpdateEvents({ ...BEFORE }, { ...BEFORE, lat: 21.4858, lng: 39.1925, buyerType: 'BUSINESS' }, { tenantId: T, customerId: 'c1', meta: META, taxOnly: true });
  assert.equal(taxOnly.length, 1);
  const [tx] = await served(taxOnly);
  assert.deepEqual(changesOf(tx, { accountingOn: true }).map((c) => [c.field, c.to?.text]), [['buyerType', 'منشأة'], ['location', '21.48580, 39.19250']]);
});

test('رموز الحالات بالعربية: حالة العميل وحالة طلب المنيو (قديمة/جديدة) — ولا رمز لاتيني', () => {
  const cases: [string, Row][] = [
    ['CUSTOMER_STATUS_CHANGED', { oldStatus: 'ACTIVE', newStatus: 'INACTIVE' }],
    ['CUSTOMER_STATUS_CHANGED', { oldStatus: 'BLOCKED', newStatus: 'ACTIVE' }],
    ['CATALOG_ORDER_UPDATED', { oldStatus: 'NEW', newStatus: 'DONE' }],
    ['CATALOG_ORDER_UPDATED', { oldStatus: 'SEEN', newStatus: 'CANCELLED' }],
  ];
  for (const [action, data] of cases) {
    const text = textOf(render([item({ id: `${action}-${data.newStatus}`, action, data })], true));
    assert.ok(text.includes('الحالة السابقة') && text.includes('الحالة الجديدة'), action);
    assert.doesNotMatch(text, LATIN_CODE_RE, `${action}: رمزٌ لاتيني «${text.match(LATIN_CODE_RE)?.[0]}»`);
  }
});

// ═══════════════════ ٥) المال خلف النظام المحاسبي — كل موضع ═══════════════════

/** مبالغ مميّزة لا تتكرّر صدفةً في غيرها */
const M = { inv: 4321.75, tax: 563.71, disc: 98.65, rcpt: 2468.13, alloc1: 1357.91, alloc2: 1110.22, card: 777.31, link: 652.19,
  linkPaid: 641.07, price: 12.34, priceConvFrom: 48.96, priceConvTo: 4.08, batchFrom: 3.17, batchTo: 3.29, order: 86.43,
  opening: 9876.54, adj: 1212.12, credit: 7531.59, creditOld: 2581.47, removed: 15.55 };

test('النظام المحاسبي مطفأ: لا مبلغ في أي موضع (المبلغ الرئيسي، الخصم، الضريبة، السعر قبل/بعد، توزيع السند، أصناف الدفعة، الحد الائتماني، قائمة الأسعار) — ومفعّلاً تظهر كلها', { skip: NO_BACKEND }, async () => {
  const { docs, events, svc } = await backend();
  const priceTx = (price: number) => ({
    customerActivity: { createMany: async () => undefined },
    customerPrice: { findMany: async () => [{ customerId: 'c1', price }] },
    product: { findFirst: async () => ({ name: 'ماء ٣٣٠', unit: 'حبة' }) },
  });
  const log: Row[] = [
    docs.invoiceIssuedInput({ tenantId: T, meta: META, invoice: {
      id: 'i1', number: 'INV-2603-000001', customerId: 'c1', type: 'CREDIT', total: M.inv, taxAmt: M.tax, discountAmt: M.disc, items: [{}, {}],
      installments: [{}, {}, {}],
    } }),
    docs.receiptEventInput({ tenantId: T, action: 'RECEIPT_ISSUED', meta: META, receipt: { id: 'r1', number: 'RC-1', customerId: 'c1', amount: M.rcpt, paymentMethod: 'CASH' },
      allocations: [{ invoiceId: 'i1', invoiceNo: 'INV-2603-000001', amount: M.alloc1, settled: true }, { invoiceId: 'i0', invoiceNo: 'INV-0', amount: M.alloc2 }] }),
    docs.cardPaymentEventInput({ action: 'CARD_PAYMENT_COMPLETED', meta: META, payment: { id: 'cp1', tenantId: T, customerId: 'c1', amount: M.card, reference: 'INV-2603-000001' }, data: { status: 'approved' } }),
    docs.paylinkEventInput({ action: 'PAYLINK_CREATED', meta: META, link: { id: 'pl1', tenantId: T, customerId: 'c1', amount: M.link, expiresAt: new Date('2026-03-08T00:00:00Z') }, invoiceNo: 'INV-2603-000001' }),
    docs.paylinkEventInput({ action: 'PAYLINK_PAID', meta: docs.customerMeta('بقالة النور'), link: { id: 'pl2', tenantId: T, customerId: 'c1', amount: M.linkPaid }, invoiceNo: 'INV-X' }),
    ...await events.productCustomerPriceEvents(priceTx(M.removed), T, 'p1', META, { action: 'CUSTOMER_PRICE_REMOVED', reason: 'PRODUCT_DELETED' }),
    ...await events.productCustomerPriceEvents(priceTx(M.priceConvFrom), T, 'p2', META, { action: 'CUSTOMER_PRICE_SET', reason: 'BASE_UNIT_CONVERTED', factor: 12, fromUnit: 'حبة', toUnit: 'كرتون' }),
    { tenantId: T, customerId: 'c1', action: 'CUSTOMER_PRICE_SET', actor: META.actor, refType: 'PRICE', refId: 'p3', data: { productName: 'عصير', unitPrice: M.price } },
    { tenantId: T, customerId: 'c1', action: 'CUSTOMER_PRICE_SET', actor: META.actor, refType: 'PRICE',
      data: { count: 2, items: [{ productId: 'p4', productName: 'شاي', from: M.batchFrom, to: M.batchTo }, { productId: 'p5', productName: 'قهوة', from: null, to: M.batchTo }] } },
    { tenantId: T, customerId: 'c1', action: 'CATALOG_ORDER_PLACED', actor: svc.customerActor('بقالة النور'), refType: 'CATALOG_ORDER', refId: 'o1', amount: M.order,
      data: { itemsCount: 1, items: [{ productName: 'شاي', unitName: 'كرتون', qty: 3 }] } },
    { tenantId: T, customerId: 'c1', action: 'OPENING_BALANCE_SET', actor: META.actor, refType: 'ADJUSTMENT', refId: 'ob1', amount: M.opening, data: { side: 'DEBIT' } },
    { tenantId: T, customerId: 'c1', action: 'ADJUSTMENT_CREATED', actor: META.actor, refType: 'ADJUSTMENT', refId: 'adj1', amount: M.adj, data: { kind: 'BAD_DEBT_WRITEOFF' } },
    ...events.customerUpdateEvents({ ...BEFORE, creditLimit: M.creditOld }, { ...BEFORE, creditLimit: M.credit, priceListId: 'pl-x' },
      { tenantId: T, customerId: 'c1', meta: META, priceListNames: new Map([['pl-x', 'قائمة كبار العملاء']]) }),
  ];
  const items = await served(log);
  assert.ok(items.length >= log.length, 'بنودٌ ضاعت في الطريق');
  const shownOn = [M.inv, M.tax, M.disc, M.rcpt, M.alloc1, M.alloc2, M.card, M.link, M.linkPaid, M.removed, M.priceConvFrom, M.price,
    M.batchFrom, M.batchTo, M.order, M.opening, M.adj];
  const on = render(items, true);
  for (const v of shownOn) assert.ok(on.includes(formatCurrency(v)), `${v}: غائبٌ والنظام المحاسبي مفعّل`);
  assert.ok(on.includes(formatCurrency(M.priceConvFrom / 12)), 'السعر بعد التحويل غائب');
  assert.ok(textOf(on).includes('قائمة كبار العملاء') && textOf(on).includes('الحد الائتماني'));

  const off = render(items, false);
  const offText = textOf(off);
  const all = [...shownOn, M.priceConvFrom / 12, M.credit, M.creditOld];
  for (const v of all) {
    assert.ok(!off.includes(formatCurrency(v)), `${v}: ظاهرٌ بعملةٍ والنظام المحاسبي مطفأ`);
    assert.ok(!offText.includes(formatNumber(v)), `${v}: ظاهرٌ رقماً والنظام المحاسبي مطفأ`);
    assert.ok(!offText.includes(String(v)), `${v}: ظاهرٌ رقماً خاماً والنظام المحاسبي مطفأ`);
  }
  assert.ok(formatCurrency(1).includes('ر.س') && !offText.includes('ر.س'), 'رمز العملة ظاهر والنظام المحاسبي مطفأ');
  for (const label of ['الضريبة', 'الخصم', 'السعر', 'السعر السابق', 'السعر الجديد', 'الحد الائتماني', 'القائمة السابقة', 'القائمة الجديدة', 'قائمة كبار العملاء']) {
    assert.ok(!offText.includes(label), `«${label}» ظاهرٌ والنظام المحاسبي مطفأ`);
  }
  // البنود نفسها تبقى (العنوان والرقم والأصناف بلا أسعارها)
  for (const keep of ['إصدار فاتورة بيع', 'INV-2603-000001', 'إصدار سند قبض', 'سداد الفواتير', 'شاي', 'قهوة', '× ٣', 'كرتون', 'حذف الصنف']) {
    assert.ok(offText.includes(keep), `«${keep}» اختفى مع المال`);
  }
});

test('النظام المحاسبي مطفأ في البنود التاريخية المشتقّة من الجداول (فاتورة، سند بتوزيعه، رابط، بطاقة، تسوية، سعر خاص)', { skip: NO_BACKEND }, async () => {
  const tables = {
    invoice: [{ id: 'hi', tenantId: T, customerId: 'c1', number: 'INV-H1', type: 'CREDIT', status: 'CONFIRMED', documentKind: null, invoiceDate: new Date('2026-02-01T08:00:00Z'),
      total: 3141.59, taxAmt: 409.77, paidAmt: 0, remainingAmt: 3141.59, salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { items: 2 } }],
    receipt: [{ id: 'hr', tenantId: T, customerId: 'c1', number: 'RC-H1', amount: 2718.28, paymentMethod: 'CHEQUE', status: 'CONFIRMED', receiptDate: new Date('2026-02-02T08:00:00Z'),
      salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { photos: 0 }, invoiceItems: [{ amount: 1414.21, invoice: { number: 'INV-H1' } }] }],
    customerPaymentLink: [{ id: 'hl', tenantId: T, customerId: 'c1', amount: 1732.05, status: 'paid', createdAt: new Date('2026-02-03T08:00:00Z'), paidAt: new Date('2026-02-04T08:00:00Z'),
      expiresAt: null, salesRepId: null, createdById: 'a1', invoice: { number: 'INV-H1' } }],
    cardPayment: [{ id: 'hc', tenantId: T, customerId: 'c1', amount: 2236.07, status: 'declined', statusDetail: 'رصيد غير كاف', createdAt: new Date('2026-02-05T08:00:00Z'),
      salesRepId: 'r1', salesRep: { name: 'أحمد' }, invoice: { number: 'INV-H1' } }],
    accountEntry: [{ id: 'he', tenantId: T, customerId: 'c1', type: 'ADJUSTMENT_DEBIT', debit: 1618.03, credit: 0, description: 'رصيد', entryDate: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-02-06T08:00:00Z'), invoiceId: null, receiptId: null }],
    customerPrice: [{ id: 'hp', customerId: 'c1', productId: 'p9', price: 19.87, updatedAt: new Date('2026-02-07T08:00:00Z'), product: { name: 'حليب' } }],
  };
  const items = await served([], tables);
  assert.ok(items.length >= 7 && items.every((x) => x.historical), 'البنود التاريخية');
  const amounts = [3141.59, 409.77, 2718.28, 1414.21, 1732.05, 2236.07, 1618.03, 19.87];
  const on = render(items, true);
  for (const v of amounts) assert.ok(on.includes(formatCurrency(v)), `${v}: غائبٌ والنظام المحاسبي مفعّل`);
  const off = render(items, false);
  for (const v of amounts) {
    assert.ok(!off.includes(formatCurrency(v)) && !textOf(off).includes(formatNumber(v)) && !textOf(off).includes(String(v)), `${v}: ظاهرٌ والنظام المحاسبي مطفأ`);
  }
});

// ═══════════════════ ٦) التاريخ المشتقّ: علامة «سجل تاريخي» وتفاصيله ═══════════════════

test('«سجل تاريخي»: شارةٌ لكل بندٍ مشتقٍّ من الجداول وحده — لا لبند السجلّ الثابت، والمرجع الذي له سطر ميلادٍ لا يظهر مرّتين', { skip: NO_BACKEND }, async () => {
  const { docs } = await backend();
  const invRow = (id: string, day: string) => ({ id, tenantId: T, customerId: 'c1', number: `INV-${id}`, type: 'CASH', status: 'CONFIRMED', documentKind: null,
    invoiceDate: new Date(`2026-02-${day}T08:00:00Z`), total: 10, salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { items: 1 } });
  const log = [docs.invoiceIssuedInput({ tenantId: T, meta: META, invoice: { id: 'born', number: 'INV-born', customerId: 'c1', type: 'CASH', total: 10 } })];
  const items = await served(log, { invoice: [invRow('old', '01'), invRow('born', '02')] });
  const invoices = items.filter((x) => x.action === 'INVOICE_ISSUED');
  assert.deepEqual(invoices.map((x) => [x.refNo, x.historical]).sort(), [['INV-born', false], ['INV-old', true]], 'الفاتورة المسجّلة ظهرت مرّتين');
  const html = render(items, true);
  const badges = [...html.matchAll(/سجل تاريخي/g)].length;
  assert.equal(badges, items.filter((x) => x.historical).length, 'عدد الشارات ≠ عدد البنود التاريخية');
  assert.ok(html.includes('title="مستخرج من سجلات النظام السابقة لبدء السجل الثابت"'), 'شرح الشارة');
  const liveCard = render([invoices.find((x) => !x.historical)!], true);
  assert.ok(!liveCard.includes('سجل تاريخي'), 'بند السجلّ الثابت موسومٌ تاريخياً');
});

test('BUG(contract): سبب إرجاع المرتجع التاريخي يضيع — القارئ يضع رمز returnReason في data.reason والواجهة تُسقط الرموز المجهولة', { skip: NO_BACKEND }, async () => {
  // routes/customerActivity.ts (مصدر invoices): reason: clip(r.returnReason) ?? clip(r.noteReason) — والسجلّ الحيّ يكتب returnReason
  const items = await served([], {
    invoice: [{ id: 'ret', tenantId: T, customerId: 'c1', number: 'RET-9', type: 'RETURN', status: 'CONFIRMED', documentKind: null,
      invoiceDate: new Date('2026-02-01T08:00:00Z'), total: 40, returnReason: 'DAMAGED', salesRepId: 'r1', salesRep: { name: 'أحمد' }, _count: { items: 1 } }],
  });
  const ret = items.find((x) => x.action === 'RETURN_ISSUED');
  assert.ok(ret && ret.historical, 'المرتجع التاريخي');
  const text = textOf(render([ret!], true));
  assert.ok(text.includes('بضاعة تالفة'), `سبب الإرجاع (DAMAGED) لا يظهر في البند التاريخي — data=${JSON.stringify(ret!.data)}`);
  // والسجلّ الحيّ يُظهره (المرجع للمقارنة)
  const live = textOf(render([item({ id: 'lr', action: 'RETURN_ISSUED', data: { returnReason: 'DAMAGED' } })], true));
  assert.ok(live.includes('بضاعة تالفة'));
});

test('BUG(minor, consistency): «إنشاء العميل» التاريخي يعرض رقم العميل شارةً خاماً «7» والحيّ يعرضه «رقم العميل #7»', { skip: NO_BACKEND }, async () => {
  const { events } = await backend();
  const hist = (await served([])).find((x) => x.action === 'CUSTOMER_CREATED');
  assert.ok(hist && hist.historical, 'بند الإنشاء المشتقّ من صفّ العميل');
  const live = (await served([events.customerCreatedInput(T, { ...CUSTOMER, id: 'c1' }, META)])).find((x) => x.action === 'CUSTOMER_CREATED' && !x.historical)!;
  const liveText = textOf(render([live], true));
  assert.ok(liveText.includes('رقم العميل') && liveText.includes('#7'));
  const histText = textOf(render([hist!], true));
  assert.ok(histText.includes('#7'), `البند التاريخي لا يعرض الرقم بصيغته «#7»: «${histText}»`);
});

test('تفاصيل البنود التاريخية مقروءة: زيارة بمدّتها وصورها وملاحظتها، سندٌ بطريقته وتوزيعه، رابطٌ ملغى بشارته، بطاقةٌ مرفوضة، مكالمة، خط سير، إسناد', { skip: NO_BACKEND }, async () => {
  const items = await served([], {
    repVisit: [{ id: 'hv', tenantId: T, customerId: 'c1', createdAt: new Date('2026-02-10T08:20:00Z'), startedAt: new Date('2026-02-10T08:00:00Z'),
      endedAt: new Date('2026-02-10T08:20:00Z'), durationSec: 1200, note: 'وعد بالسداد', lat: 24.7, lng: 46.6, salesRepId: 'r1', salesRep: { name: 'أحمد' },
      photos: [{ id: 'ph1' }, { id: 'ph2' }] }],
    receipt: [{ id: 'hr', tenantId: T, customerId: 'c1', number: 'RC-H', amount: 100, paymentMethod: 'BANK_TRANSFER', status: 'CANCELLED', receiptDate: new Date('2026-02-11T08:00:00Z'),
      salesRepId: null, deletedSalesRepId: 'r9', salesRep: null, _count: { photos: 1 }, invoiceItems: [{ amount: 100, invoice: { number: 'INV-7' } }] }],
    customerPaymentLink: [{ id: 'hl', tenantId: T, customerId: 'c1', amount: 30, status: 'canceled', createdAt: new Date('2026-02-12T08:00:00Z'), paidAt: null,
      expiresAt: new Date('2026-02-19T08:00:00Z'), salesRepId: 'r1', salesRep: { name: 'أحمد' }, invoice: { number: 'INV-7' } }],
    cardPayment: [{ id: 'hc', tenantId: T, customerId: 'c1', amount: 30, status: 'declined', statusDetail: 'رصيد غير كاف', createdAt: new Date('2026-02-13T08:00:00Z'),
      salesRepId: 'r1', salesRep: { name: 'أحمد' }, invoice: { number: 'INV-7' } }],
    callLog: [{ id: 'hcall', tenantId: T, customerId: 'c1', direction: 'OUT', durationSec: 95, startedAt: new Date('2026-02-14T08:00:00Z'), salesRepId: null, aiSummary: 'طلب عرض سعر' }],
    repRouteStop: [{ id: 'hs', tenantId: T, customerId: 'c1', routeId: 'rt1', seq: 3, createdAt: new Date('2026-02-15T08:00:00Z'), route: { name: 'خط الأحد', isActive: true, isPermanent: true, salesRep: { name: 'أحمد' } } }],
    customerAssignment: [{ id: 'ha', tenantId: T, customerId: 'c1', salesRepId: 'r1', source: 'MANUAL', createdAt: new Date('2026-02-16T08:00:00Z'), salesRep: { name: 'أحمد' } }],
  });
  const byAction = (a: string) => items.find((x) => x.action === a)!;
  const t = (a: string) => textOf(render([byAction(a)], true));
  const visit = t('VISIT_RECORDED');
  assert.ok(visit.includes('مدة الزيارة') && visit.includes('٢٠:٠٠') === false && visit.includes('20:00'), `مدة الزيارة: ${visit}`);
  assert.ok(visit.includes('الصور') && visit.includes('٢') && visit.includes('وعد بالسداد'), visit);
  const rc = t('RECEIPT_ISSUED');
  assert.ok(rc.includes('تحويل بنكي') && rc.includes('INV-7') && rc.includes('ملغى'), rc);
  const pl = t('PAYLINK_CREATED');
  assert.ok(pl.includes('ملغى') && pl.includes('ينتهي في'), pl);
  // لحظة الانتهاء (١٩ فبراير ٢٠٢٦ = رمضان ١٤٤٧) بالتقويم الميلادي كسائر التواريخ
  assert.ok(pl.includes('فبراير') && pl.includes('٢٠٢٦'), `تاريخ الانتهاء ليس ميلادياً: ${pl}`);
  assert.doesNotMatch(pl, HIJRI, pl);
  assert.ok(!pl.includes('الحالة'), 'الحالة مكرّرةٌ مع الشارة');
  const card = t('CARD_PAYMENT_FAILED');
  assert.ok(card.includes('مرفوضة') && card.includes('رصيد غير كاف'), card);
  const call = t('CALL_LOGGED');
  assert.ok(call.includes('صادرة') && call.includes('مدة المكالمة') && call.includes('1:35') && call.includes('طلب عرض سعر'), call);
  const route = t('ROUTE_STOP_ADDED');
  assert.ok(route.includes('خط الأحد') && route.includes('أحمد'), route);
  const asg = t('CUSTOMER_ASSIGNED');
  assert.ok(asg.includes('أحمد'), asg);
  for (const it of items) {
    const text = textOf(render([it], true));
    assert.doesNotMatch(text, LATIN_CODE_RE, `${it.action}: رمزٌ لاتيني «${text.match(LATIN_CODE_RE)?.[0]}» في «${text}»`);
    assert.doesNotMatch(text, UUID_RE, `${it.action}: معرّفٌ آلي ظاهر`);
  }
});

// ═══════════════════ ٧) «إزالة الضريبة» ═══════════════════

test('BUG(minor, taxOff): «إزالة الضريبة» — إبطال فاتورة بسبب REJECTED يُظهر «رفض هيئة الزكاة والضريبة»', () => {
  const voided = item({ id: 'vz', action: 'INVOICE_VOIDED', refNo: 'INV-1', data: { invoiceType: 'CASH', reason: 'REJECTED' } });
  const text = textOf(render([voided], true, true));
  assert.ok(text.includes('إبطال فاتورة'));
  assert.doesNotMatch(text, /ضريب/, `ذكر الضريبة تحت «إزالة الضريبة»: «${text}»`);
});

test('«إزالة الضريبة»: لا ذكر للضريبة في العنوان ولا التفاصيل ولا التغييرات ولا نوع الوثيقة', () => {
  const items = [
    item({ id: 't1', action: 'CUSTOMER_TAX_DATA_UPDATED', data: { changes: [{ field: 'taxNumber', from: null, to: '300000000000003' }, { field: 'buyerType', from: null, to: 'BUSINESS' }] } }),
    item({ id: 't2', action: 'INVOICE_ISSUED', amount: 115, data: { paymentType: 'CASH', taxTotal: 15, total: 115 } }),
    item({ id: 't3', action: 'DOCUMENT_ADDED', data: { kind: 'VAT_CERT' } }),
  ];
  const text = textOf(render(items, true, true));
  assert.doesNotMatch(text, /ضريب/, text);
  assert.ok(text.includes('تحديث بيانات الفوترة للعميل') && text.includes('منشأة'));
});

// ═══════════════════ ٨) تجميع الأيام: ميلادي وبحدود يوم الجهاز ═══════════════════

const dayHeaders = (html: string) => [...html.matchAll(/<div class="sticky[^"]*"><span[^>]*>([^<]*)<\/span><\/div>/g)].map((m) => m[1]);

test('حدود اليوم بتوقيت الرياض (جهاز القارئ): ٢١:٠٠Z بداية اليوم التالي — والبند في يوم ساعته المعروضة نفسها', () => {
  assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Riyadh', 'TZ لم يُطبَّق');
  // فبراير–مارس ٢٠٢٦ في رمضان ١٤٤٧: تقويمٌ هجري متسرّب يظهر «رمضان»
  const items = [
    item({ id: 'a', at: '2026-02-28T21:30:00Z', action: 'VISIT_RECORDED' }), // ١ مارس ٠٠:٣٠
    item({ id: 'b', at: '2026-02-28T20:59:59Z', action: 'INVOICE_ISSUED' }), // ٢٨ فبراير ٢٣:٥٩
    item({ id: 'c', at: '2026-02-27T21:00:00Z', action: 'RECEIPT_ISSUED' }), // ٢٨ فبراير ٠٠:٠٠
    item({ id: 'd', at: '2026-02-27T20:59:00Z', action: 'CALL_LOGGED' }), // ٢٧ فبراير ٢٣:٥٩
  ];
  const groups = groupByDay(mergeItems([], items));
  assert.deepEqual(groups.map((g) => g.items.map((x) => x.id)), [['a'], ['b', 'c'], ['d']]);
  assert.deepEqual(groups.map((g) => g.key), ['2026-3-1', '2026-2-28', '2026-2-27']);
  assert.equal(dayKeyOf('2026-02-28T21:00:00Z'), '2026-3-1');
  assert.equal(dayKeyOf('2026-02-28T20:59:59.999Z'), '2026-2-28');
  const html = render(mergeItems([], items), true);
  const heads = dayHeaders(html);
  assert.equal(heads.length, 3, 'عنوان يومٍ لكل مجموعة');
  assert.ok(heads[0].includes('١') && heads[0].includes('مارس') && heads[0].includes('٢٠٢٦'), heads[0]);
  assert.ok(heads[1].includes('٢٨') && heads[1].includes('فبراير'), heads[1]);
  assert.ok(heads[2].includes('٢٧') && heads[2].includes('فبراير'), heads[2]);
  for (const hd of heads) assert.doesNotMatch(hd, HIJRI, `تاريخٌ هجري: ${hd}`);
  assert.doesNotMatch(textOf(html), HIJRI);
  // الساعة على البطاقة من يوم عنوانها: ١٢:٣٠ ص تحت ١ مارس، و١١:٥٩ م تحت ٢٨ فبراير
  assert.equal(formatTime(items[0].at), formatTime(new Date(2026, 2, 1, 0, 30)));
  const firstSection = html.slice(0, html.indexOf('</section>'));
  assert.ok(firstSection.includes(formatTime(items[0].at)) && !firstSection.includes(formatTime(items[1].at)));
});

test('العنوان ميلاديٌّ بكل لغة وترقيم: الإنجليزية، والعربية بأرقام لاتينية — و«اليوم» و«أمس» نسبةً لساعة الجهاز', () => {
  const at = '2026-02-28T21:30:00Z';
  try {
    useLang.setState({ lang: 'en' });
    const en = dayHeaders(render([item({ id: 'e', at, action: 'VISIT_RECORDED' })], true))[0];
    assert.match(en, /March 1, 2026/, en);
    useLang.setState({ lang: 'ar' });
    setActiveNumerals('latin');
    const latn = dayHeaders(render([item({ id: 'l', at, action: 'VISIT_RECORDED' })], true))[0];
    assert.match(latn, /1 مارس 2026/, latn);
  } finally {
    useLang.setState({ lang: 'ar' });
    setActiveNumerals('arabic');
  }
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0).toISOString();
  const heads = dayHeaders(render(mergeItems([], [
    item({ id: 'n', at: now.toISOString(), action: 'VISIT_RECORDED' }), item({ id: 'y', at: yesterday, action: 'VISIT_RECORDED' }),
  ]), true));
  assert.ok(heads[0].startsWith('اليوم · '), heads[0]);
  assert.ok(heads[1].startsWith('أمس · '), heads[1]);
});

test('جهازٌ بمنطقةٍ أخرى: التجميع وعنوان اليوم وساعة البطاقة كلها بمنطقة الجهاز نفسها — لا يتناقض العنوان والساعة', () => {
  try {
    process.env.TZ = 'Europe/London';
    const items = mergeItems([], [item({ id: 'a', at: '2026-02-28T21:30:00Z', action: 'VISIT_RECORDED' }), item({ id: 'b', at: '2026-02-28T20:59:59Z', action: 'VISIT_RECORDED' })]);
    assert.deepEqual(groupByDay(items).map((g) => g.items.map((x) => x.id)), [['a', 'b']], 'لندن: اليوم نفسه');
    const heads = dayHeaders(render(items, true));
    assert.equal(heads.length, 1);
    assert.ok(heads[0].includes('٢٨') && heads[0].includes('فبراير'), heads[0]);
  } finally {
    process.env.TZ = 'Asia/Riyadh';
  }
  assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Riyadh');
});

// ═══════════════════ ٩) دمج الصفحات ═══════════════════

test('دمج الصفحات: بلا تكرار بالمعرّف (بين الصفحتين وداخل الصفحة نفسها)، والأحدث أولاً، والتساوي ثابت، ولا يُعدَّل الأصل', () => {
  const p1 = [
    item({ id: 'k3', at: '2026-03-01T10:00:00Z', action: 'VISIT_RECORDED' }),
    item({ id: 'k2', at: '2026-03-01T09:00:00Z', action: 'VISIT_RECORDED' }),
    item({ id: 'k1', at: '2026-03-01T09:00:00Z', action: 'INVOICE_ISSUED' }),
  ];
  const p1Copy = JSON.parse(JSON.stringify(p1));
  // الصفحة التالية تعيد بند الحدّ (k1) بنسخةٍ أخرى، وتكرّر بنداً داخلها
  const p2 = [
    item({ id: 'k1', at: '2026-03-01T09:00:00Z', action: 'INVOICE_ISSUED', refNo: 'DUP' }),
    item({ id: 'k0', at: '2026-02-28T09:00:00Z', action: 'RECEIPT_ISSUED' }),
    item({ id: 'k0', at: '2026-02-28T09:00:00Z', action: 'RECEIPT_ISSUED' }),
    item({ id: 'k9', at: '2026-02-27T09:00:00Z', action: 'CALL_LOGGED' }),
  ];
  const merged = mergeItems(p1, p2);
  // ترتيب الخادم داخل اللحظة الواحدة يبقى كما أرسله (k2 قبل k1) — الواجهة لا تعيد فرز التساوي (العقد المشترك، C21)
  assert.deepEqual(merged.map((x) => x.id), ['k3', 'k2', 'k1', 'k0', 'k9']);
  assert.equal(merged.find((x) => x.id === 'k1')!.refNo, null, 'النسخة المعروضة أولاً هي الباقية');
  assert.deepEqual(p1, p1Copy, 'الدمج عدّل الصفحة الأولى');
  assert.deepEqual(mergeItems(merged, p2).map((x) => x.id), merged.map((x) => x.id), 'إعادة الصفحة نفسها تكرّر');
  assert.deepEqual(mergeItems([], []), []);
  // ترتيب ثابت مهما كان ترتيب الوصول
  assert.deepEqual(mergeItems([], [...p2].reverse()).map((x) => x.id), mergeItems([], p2).map((x) => x.id));
  // صفحاتٌ كبيرة: ٦٠٠ بندٍ بتداخل ١٠٠ ⇒ ٥٠٠ فريدة بلا تكرار في الرسم
  const big = Array.from({ length: 300 }, (_, i) => item({ id: `b${i}`, at: new Date(Date.UTC(2026, 1, 1) + i * 3_600_000).toISOString(), action: 'VISIT_RECORDED' }));
  const next = Array.from({ length: 300 }, (_, i) => item({ id: `b${i + 200}`, at: new Date(Date.UTC(2026, 1, 1) + (i + 200) * 3_600_000).toISOString(), action: 'VISIT_RECORDED' }));
  const m2 = mergeItems(big, next);
  assert.equal(m2.length, 500);
  assert.equal(new Set(m2.map((x) => x.id)).size, 500);
  for (let i = 1; i < m2.length; i++) assert.ok(new Date(m2[i - 1].at) >= new Date(m2[i].at), 'ليس الأحدث أولاً');
  const html = render(m2, true);
  // كل يومٍ عنوانٌ واحد (المجموعات متجاورة بعد الدمج)
  const heads = dayHeaders(html);
  assert.equal(heads.length, new Set(heads).size, 'عنوان يومٍ مكرّر');
});

test('صفحتان من الخادم الحقيقي بحدٍّ صغير: «تحميل المزيد» بالمؤشّر يكمل بلا تكرارٍ ولا ضياع', { skip: NO_BACKEND }, async () => {
  const be = await backend();
  const log = Array.from({ length: 9 }, (_, i) => ({
    tenantId: T, customerId: 'c1', action: 'VISIT_RECORDED', actor: META.actor, refType: 'VISIT', refId: `lv${i}`,
    // ثلاثة أسطر في كل لحظة (معاملةٌ واحدة) — الحدّ يقع داخل اللحظة
    at: new Date(Date.UTC(2026, 2, 1, 6, Math.floor(i / 3))),
  }));
  const rows = log.map((input, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, ...be.svc.activityRow(input) }));
  const db = memDb({ customer: [CUSTOMER], customerActivity: rows });
  const deps = { db, customerScope: async () => ({}) };
  let before: string | undefined;
  let shown: ActivityItem[] = [];
  for (let guard = 0; guard < 20; guard++) {
    const q = { ...activityQuery({ before, limit: 4 }) };
    const page = normalizePage(JSON.parse(JSON.stringify(await be.route.loadCustomerActivity(deps, ADMIN_REQ, T, 'c1', be.route.parseActivityQuery(q)))));
    shown = mergeItems(shown, page.items);
    if (!page.nextBefore) break;
    before = page.nextBefore;
  }
  const visits = shown.filter((x) => x.action === 'VISIT_RECORDED').map((x) => x.refId).sort();
  assert.deepEqual(visits, log.map((x) => x.refId).sort(), 'زيارةٌ ضاعت أو تكرّرت');
  assert.ok(shown.some((x) => x.action === 'CUSTOMER_CREATED'), 'بند الإنشاء التاريخي في آخر الصفحات');
});

// ═══════════════════ ١٠) الأصناف وأسماء الحقول ═══════════════════

test('أصناف البند: كمية ووحدة طلب المنيو تبقى بلا نظام محاسبي، وأسعار الدفعة تختفي — وأكثر من ٣٠ صنفاً يُقصّ', () => {
  const data = { items: Array.from({ length: 35 }, (_, i) => ({ productName: `صنف ${i}`, qty: i + 1, unitName: 'كرتون', from: i, to: i + 1, price: 9 })) };
  const on = itemsOf({ data }, { accountingOn: true });
  const off = itemsOf({ data }, { accountingOn: false });
  assert.equal(on.length, 30);
  assert.ok(off.every((l) => l.from === null && l.to === null && l.price === null));
  assert.deepEqual(off.map((l) => [l.qty, l.unit]), on.map((l) => [l.qty, l.unit]));
});

test('كل اسم حقلٍ في FIELD_LABELS عربي، وقيم التعديل الرقمية والمنطقية والفارغة مقروءة', () => {
  for (const [f, label] of Object.entries(FIELD_LABELS)) assert.ok(AR.test(label), f);
  assert.deepEqual(changeValue('returnToStock', true), { text: 'نعم', translate: true, ltr: false });
  assert.deepEqual(changeValue('returnToStock', false), { text: 'لا', translate: true, ltr: false });
  assert.deepEqual(changeValue('paymentDays', 0), { text: '0', translate: false, ltr: true });
  assert.deepEqual(changeValue('address', '   '), { text: '—', translate: false, ltr: false });
  assert.equal(changeValue('creditLimit', Number.NaN), null);
  assert.deepEqual(changeValue('location', { lat: 'x', lng: 1 }), { text: '—', translate: false, ltr: false });
  assert.equal(normalizeItem({ id: 'q', at: '2026-03-01T00:00:00Z', action: 'VISIT_RECORDED', data: { changes: [{ field: 'phone', from: 1, to: 2 }] } })?.data?.changes !== undefined, true);
  // detailsOf لبطاقة الإنشاء: الجوال رمزٌ LTR، والرقم «#N»
  assert.deepEqual(detailsOf({ action: 'CUSTOMER_CREATED', amount: null, data: { number: 12, phone: '0500000000' } }, { accountingOn: true })
    .map((d) => [d.label, d.value, d.kind]), [['رقم العميل', '#12', 'code'], ['الجوال', '0500000000', 'code']]);
});
