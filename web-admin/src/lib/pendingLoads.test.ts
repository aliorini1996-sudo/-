/**
 * «قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦) — جانب الإدارة: اللوحة (صفحة مخزون السيارات) و/m وإعداد الشركة والإشعار
 * المطبوع، فوق العقد المشترك lib/pendingLoads.ts.
 *
 * ١) ردّ الإرسال: pending:true وحده «أُرسل للمندوب» (ومنه إعادة المرجع نفسه)، وما سواه حركةٌ كُتبت كما كان.
 * ٢) قراءة ردود الخادم متسامحةً (عقد pendingLoadView)، وأقسام «تحميلات بانتظار القبول»، ونصّ الرفض برمزه مترجماً، والعميل.
 * ٣) الإشعار المطبوع: إقرار المندوب وتوقيعه ولحظة قبوله (ميلادية) للتحميل المقبول وحده — وغيره **حرفاً بحرف** كما كان.
 * ٤) حالات القسم مرسومةً (اللوحة و/m)، ومفتاح الإعداد مرسوماً، وربطهما بالشاشات على المصدر: المطفأة لا قسم ولا جلب ولا تلميح.
 * ٥) الترجمة: كل نصٍّ وحالةٍ ورسالة خادم بالأربع، ورسائل الخادم حرفاً كما يرسلها (متى وُجد الخادم في الشجرة).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  PENDING_LOADS_KEY, PENDING_LOAD_MESSAGES, PENDING_LOAD_TEXT, PENDING_STATUS_LABELS, acceptanceOf, acceptanceSentence, fetchPendingDetail,
  fetchPendingList, isPendingLoadResponse, noticeMovementOf, normalizePendingList, normalizePendingLoad, pendingChangedProductIds, pendingEditLines,
  pendingEditStaleText, pendingErrorText, pendingLoadErrorOf, pendingLoadsClient, pendingRefusalText, pendingSections, safeSignature, vanLoadAcceptanceOn,
  type HttpLike,
  type PendingLoadList,
  type PendingVanLoadView,
} from './pendingLoads';
import { PrintableLoadNotice, loadNoticeAcceptance, loadNoticeDocFromData, type LoadNoticeDoc } from '../rep/RepDocuments';
import { PHRASES } from '../i18n/strings';
import { useLang, type Lang } from '../i18n/lang';
import { formatDate, formatTime } from '../utils/format';

const SRC = path.resolve(process.cwd(), 'src');
const read = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const id = (s: string) => s;
const en = (ar: string) => PHRASES[ar]?.en ?? ar;

/**
 * الرسم على الخادم بلغةٍ أخرى: مخزن اللغة (zustand 4) يقرأ في renderToStaticMarkup حالته الأولى (getInitialState) لا الحيّة، والتنسيق
 * (formatDate) يقرأ الحيّة — فتُضبط الاثنتان طوال الدالة ثم تُعادان كما كانتا
 */
function inLang<T>(lang: Lang, fn: () => T): T {
  const initial = useLang.getInitialState() as { lang: Lang };
  const prev = useLang.getState().lang;
  const prevInitial = initial.lang;
  useLang.setState({ lang });
  initial.lang = lang;
  try { return fn(); } finally { useLang.setState({ lang: prev }); initial.lang = prevInitial; }
}

const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const ACCEPTED_AT = '2026-11-24T09:15:00.000Z';

/** صفٌّ كما يردّه الخادم (pendingLoadView للإدارة: الجسم ومعرّف المرسِل، والأسطر من pendingLinesView) */
function serverRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1', salesRepId: 'r1', repName: 'أحمد', status: 'PENDING', revision: 1, note: 'تحميل الصباح', createdByName: 'مدير المبيعات',
    createdAt: '2026-11-24T06:00:00.000Z', updatedAt: '2026-11-24T06:00:00.000Z', disputeNote: null, disputedAt: null, acceptedAt: null,
    acceptedLat: null, acceptedLng: null, vanLoadId: null, cancelledAt: null, cancelledByName: null,
    lines: [
      {
        idx: 0, productId: 'pa', name: 'ماء', code: 'W1', unit: 'حبة', baseUnit: 'حبة', primaryUnitId: 'u-ctn',
        units: [{ id: 'u-ctn', name: 'كرتون', factor: 24, isActive: true }], unitId: 'u-ctn', unitName: 'كرتون', unitFactor: 24, qty: 2, baseQty: 48,
        lots: [{ lotId: 'l1', lotNumber: 'A12', expiryDate: '2026-12-01', qty: 48 }], lotNumber: null, missing: false,
      },
      {
        idx: 2, productId: 'pb', name: 'عصير', code: null, unit: 'علبة', baseUnit: 'علبة', primaryUnitId: null, units: [], unitId: null,
        unitName: 'علبة', unitFactor: 1, qty: 5, baseQty: 5, lots: [], lotNumber: null, missing: false,
      },
    ],
    lineCount: 2,
    createdById: 'u1',
    body: {
      type: 'LOAD', salesRepId: 'r1', note: 'تحميل الصباح',
      items: [
        { productId: 'pa', qty: 2, unitId: 'u-ctn', baseUnitName: 'حبة', lots: [{ lotId: 'l1', qty: 48 }] },
        { productId: 'pz', qty: 0 },
        { productId: 'pb', qty: 5, suggestedQty: 6 },
      ],
    },
    ...over,
  };
}
const viewOf = (over: Record<string, unknown> = {}): PendingVanLoadView => normalizePendingLoad(serverRow(over))!;
const accepted = (over: Record<string, unknown> = {}) => viewOf({ status: 'ACCEPTED', acceptedAt: ACCEPTED_AT, signature: SIG, vanLoadId: 'v1', ...over });

// ═══ ١) ردّ الإرسال ═══

test('ردّ POST /van-stock/loads: pending:true وحده «أُرسل للمندوب» (ومنه إعادة المرجع نفسه) — والحركة المكتوبة والاسترداد كما كانا', () => {
  assert.equal(isPendingLoadResponse({ status: 201, data: { success: true, pending: true, data: { id: 'p1' } } }), true);
  assert.equal(isPendingLoadResponse({ status: 200, data: { success: true, pending: true, data: { id: 'p1' }, replay: true, idempotent: true } }), true, 'إعادة المرجع');
  assert.equal(isPendingLoadResponse({ status: 201, data: { success: true, data: { id: 'v1', items: [] } } }), false, 'حركة كُتبت');
  // sendWithRefRecovery: ردٌّ ضاع فوُجدت الحركة بمرجعها — حركةٌ لا معلّق
  assert.equal(isPendingLoadResponse({ status: 200, data: { success: true, data: { id: 'v1' }, replay: true, recovered: true } }), false);
  for (const odd of [null, undefined, {}, { data: null }, { data: { pending: 'true' } }, { data: { pending: 1 } }, 'pending']) {
    assert.equal(isPendingLoadResponse(odd), false, JSON.stringify(odd));
  }
  // العلم من GET /company: === true وحده (خادمٌ أقدم بلا العمود = مطفأة)
  assert.equal(vanLoadAcceptanceOn({ vanLoadAcceptance: true }), true);
  for (const off of [{ vanLoadAcceptance: false }, {}, null, undefined, { vanLoadAcceptance: 'true' }, { vanLoadAcceptance: 1 }]) {
    assert.equal(vanLoadAcceptanceOn(off), false, JSON.stringify(off));
  }
});

// ═══ ٢) القراءة والأقسام والرفض والعميل ═══

test('صفّ الخادم: الأسطر بوحدتها وأساسها وتشغيلاتها وموضعها، والتوقيع PNG مضمّن وحده، والحالة المجهولة انتظار، وما ليس صفاً null', () => {
  const v = viewOf();
  assert.equal(v.id, 'p1');
  assert.equal(v.status, 'PENDING');
  assert.equal(v.repName, 'أحمد');
  assert.equal(v.revision, 1);
  assert.equal(v.signature, null);
  assert.deepEqual(v.lines.map((l) => [l.idx, l.name, l.qty, l.unitName, l.unitFactor, l.baseQty, l.baseUnit]), [
    [0, 'ماء', 2, 'كرتون', 24, 48, 'حبة'], [2, 'عصير', 5, 'علبة', 1, 5, 'علبة'],
  ]);
  assert.deepEqual(v.lines[0].lots, [{ lotId: 'l1', lotNumber: 'A12', expiryDate: '2026-12-01', qty: 48 }]);
  assert.deepEqual(v.lines[0].units, [{ id: 'u-ctn', name: 'كرتون', factor: 24, isActive: true }]);
  assert.equal(v.body?.items.length, 3, 'الجسم كما حُفظ (للتعديل)');
  // الاسم الحيّ يغلب لقطة الإرسال
  assert.equal(viewOf({ salesRep: { name: 'أحمد علي' } }).repName, 'أحمد علي');
  assert.equal(viewOf({ status: 'WHATEVER' }).status, 'PENDING');
  assert.equal(viewOf({ revision: 0 }).revision, 1);
  assert.equal(viewOf({ revision: '3' }).revision, 3);
  // التوقيع: PNG مضمّنٌ وحده — لا رابط خارجي ولا SVG (نصٌّ قابلٌ للتنفيذ) ولا نوعٌ آخر
  assert.equal(accepted().signature, SIG);
  for (const bad of ['https://evil.example/x.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,<script>', 'javascript:alert(1)', 42]) {
    assert.equal(viewOf({ signature: bad }).signature, null, String(bad));
    assert.equal(safeSignature(bad), null);
  }
  // سطرٌ بكمية صفر لا يُعرض، وصنفٌ حُذف بعد الإرسال موسوم
  const zero = viewOf({ lines: [{ productId: 'pa', name: 'ماء', qty: 0 }, { productId: 'pc', name: '', qty: 1, missing: true }] });
  assert.deepEqual(zero.lines.map((l) => [l.productId, l.missing]), [['pc', true]]);
  // خادمٌ لم يرسل الأسطر: من الجسم بلا أسماء — لا بطاقة فارغة
  assert.deepEqual(viewOf({ lines: undefined }).lines.map((l) => [l.productId, l.qty]), [['pa', 2], ['pb', 5]]);
  for (const notRow of [null, undefined, 'x', [], {}, { id: '' }, { id: 7 }]) assert.equal(normalizePendingLoad(notRow), null);
});

test('القائمة وأقسامها: المعترض عليها أولاً ثم الأحدث إرسالاً، والمقبولة بالأحدث قبولاً، والملغاة لا تُعرض — والعدّادات من الخادم وإلا من الصفوف', () => {
  const rows = [
    serverRow({ id: 'a', createdAt: '2026-11-24T05:00:00.000Z' }),
    serverRow({ id: 'b', createdAt: '2026-11-24T07:00:00.000Z' }),
    serverRow({ id: 'c', status: 'DISPUTED', createdAt: '2026-11-24T04:00:00.000Z', disputeNote: 'نقص كرتون' }),
    serverRow({ id: 'd', status: 'ACCEPTED', acceptedAt: '2026-11-23T08:00:00.000Z' }),
    serverRow({ id: 'e', status: 'ACCEPTED', acceptedAt: '2026-11-24T08:00:00.000Z' }),
    serverRow({ id: 'f', status: 'CANCELLED' }),
    { nope: true },
  ];
  const list = normalizePendingList({ success: true, data: rows, counts: { pending: 7, disputed: 1 } });
  assert.equal(list.rows.length, 6, 'ما ليس صفاً يسقط');
  assert.deepEqual(list.counts, { pending: 7, disputed: 1 }, 'عدّادات الخادم (للنطاق كله) لا طول الصفحة');
  const s = pendingSections(list.rows);
  assert.deepEqual(s.open.map((r) => r.id), ['c', 'b', 'a']);
  assert.deepEqual(s.accepted.map((r) => r.id), ['e', 'd']);
  assert.deepEqual(normalizePendingList({ data: rows }).counts, { pending: 2, disputed: 1 }, 'بلا counts: من الصفوف');
  assert.deepEqual(normalizePendingList(null), { rows: [], counts: { pending: 0, disputed: 0 } });
  assert.deepEqual(normalizePendingList({ data: 'x' }).rows, []);
});

test('نصّ الرفض: الرمز المعروف بعبارته مترجمةً، والمجهول برسالة الخادم، والانقطاع بالبديل — ورموز الإعداد معها', () => {
  const err = (status: number, data: unknown) => ({ response: { status, data } });
  const revised = err(409, { success: false, code: 'PENDING_LOAD_REVISED', message: 'نصٌّ آخر من خادمٍ أقدم' });
  assert.equal(pendingErrorText(revised, id, 'تعذر الحفظ'), PENDING_LOAD_MESSAGES.PENDING_LOAD_REVISED, 'العبارة من الرمز لا من الرسالة');
  assert.equal(pendingErrorText(revised, en, 'تعذر الحفظ'), 'Management has changed this load — review the items and sign again');
  assert.equal(pendingErrorText(err(409, { code: 'VAN_LOAD_ACCEPTANCE_OPEN_LOADS', message: 'x', count: 2 }), en, 'تعذر الحفظ'),
    'Some loads are awaiting rep acceptance or disputed — the feature cannot be turned off until the reps accept them or you cancel them');
  // عبارتا الإيقاف لمدير الشركة: لا «اقبلها» (القبول للمندوب) — المفتوح يحسمه قبول مندوبه أو إلغاء الإدارة، والمعترض عليه منه
  for (const s of [PENDING_LOAD_MESSAGES.VAN_LOAD_ACCEPTANCE_OPEN_LOADS, PENDING_LOAD_TEXT.settingOpen]) {
    assert.doesNotMatch(s, /اقبلها/, s);
    assert.match(s, /معترض/, s);
    assert.match(s, /إلغائه|تلغيها/, s);
  }
  assert.equal(pendingErrorText(err(403, { code: 'VAN_LOAD_ACCEPTANCE_ADMIN_ONLY', message: 'x' }), en, 'تعذر الحفظ'),
    'Only the company admin can change the rep load-acceptance requirement');
  assert.equal(pendingErrorText(err(422, { code: 'WAREHOUSE_INSUFFICIENT', message: 'رصيد المستودع لا يكفي' }), id, 'تعذر الحفظ'), 'رصيد المستودع لا يكفي');
  assert.equal(pendingErrorText(err(500, {}), id, 'تعذر الحفظ'), 'تعذر الحفظ');
  assert.equal(pendingErrorText(new Error('Network Error'), en, 'تعذر الحفظ'), en('تعذر الحفظ'));
  assert.equal(pendingErrorText(err(409, { code: 'toString' }), id, 'تعذر الحفظ'), 'تعذر الحفظ', 'لا رمز من نموذج الكائن');
  assert.equal(pendingLoadErrorOf(new Error('x')), null);
  assert.deepEqual(pendingLoadErrorOf(err(403, { code: 'API_KEY_FORBIDDEN', message: 'm' })), { status: 403, code: 'API_KEY_FORBIDDEN', message: 'm', body: { code: 'API_KEY_FORBIDDEN', message: 'm' } });
});

test('رفض «أسطرٌ ستتغيّر عند التسجيل»: أصناف warnings[].productId بلا تكرار تُسمّى بعد العبارة — وبلاها العبارة وحدها', () => {
  const err = (status: number, data: unknown) => ({ response: { status, data } });
  const changed = err(422, {
    success: false, code: 'PENDING_LOAD_LINES_CHANGED', message: 'x',
    warnings: [
      { code: 'UNIT_FALLBACK_BASE', index: 0, productId: 'pa' }, { code: 'LOT_CLAMPED', productId: 'pa', detail: { idx: 0 } },
      { code: 'PRODUCT_NOT_FOUND', index: 2, productId: 'pz' }, { code: 'ZERO_QTY_IGNORED', index: 3 }, 'junk', null,
    ],
  });
  assert.deepEqual(pendingChangedProductIds(changed), ['pa', 'pz']);
  const names: Record<string, string> = { pa: 'ماء', pb: 'عصير' };
  assert.equal(pendingRefusalText(changed, id, 'تعذر الحفظ', (p) => names[p]), `${PENDING_LOAD_MESSAGES.PENDING_LOAD_LINES_CHANGED} — ماء`, 'صنفٌ لا يُعرف اسمه لا يُسمّى');
  assert.equal(pendingRefusalText(changed, en, 'تعذر الحفظ', () => null),
    'The load cannot be sent to the rep because some lines would change when it is recorded — review the items, units and lots, then send again');
  // رفضٌ بلا warnings: العبارة وحدها كما pendingErrorText
  const revised = err(409, { code: 'PENDING_LOAD_REVISED' });
  assert.deepEqual(pendingChangedProductIds(revised), []);
  assert.equal(pendingRefusalText(revised, id, 'تعذر الحفظ', (p) => names[p]), PENDING_LOAD_MESSAGES.PENDING_LOAD_REVISED);
  assert.deepEqual(pendingChangedProductIds(new Error('Network Error')), []);
  assert.deepEqual(pendingChangedProductIds(err(422, { warnings: 'x' })), []);
  // الشاشتان تسمّيان الأسطر في رفض المعلّق
  assert.ok(read('pages', 'VanStockPage.tsx').includes("toast.error(pendingRefusalText(e, tr, 'تعذر الحفظ', pid => productOf(pid)?.name ?? rows.find(r => r.productId === pid)?.name), { duration: 8000 });"));
  assert.ok(read('m', 'MRepLoad.tsx').includes("toast.error(pendingRefusalText(e, tr, 'تعذر الحفظ', pid => rows.find(r => r.productId === pid)?.name), { duration: 8000 });"));
});

test('تعديل الإدارة لتحميلٍ تغيّر منذ فُتح: عبارةٌ للإدارة لا «وقّع من جديد» — والاعتراض بملاحظة المندوب، وغيره الرفض المعتاد (null)', () => {
  const err = (status: number, data: unknown) => ({ response: { status, data } });
  const revised = err(409, { code: 'PENDING_LOAD_REVISED', message: PENDING_LOAD_MESSAGES.PENDING_LOAD_REVISED });
  assert.equal(pendingEditStaleText(revised, id), PENDING_LOAD_TEXT.editStale);
  assert.doesNotMatch(pendingEditStaleText(revised, id)!, /وقّع/, 'لا عبارة المندوب');
  assert.equal(pendingEditStaleText(err(404, { code: 'PENDING_LOAD_NOT_FOUND' }), id), PENDING_LOAD_TEXT.editStale);
  assert.equal(pendingEditStaleText(err(409, { code: 'PENDING_LOAD_ACCEPTED' }), id), PENDING_LOAD_MESSAGES.PENDING_LOAD_ACCEPTED);
  assert.equal(pendingEditStaleText(err(409, { code: 'PENDING_LOAD_CANCELLED' }), id), PENDING_LOAD_MESSAGES.PENDING_LOAD_CANCELLED);
  const disputed = err(409, { code: 'PENDING_LOAD_DISPUTED', data: serverRow({ status: 'DISPUTED', disputeNote: 'الماء ناقص' }) });
  assert.equal(pendingEditStaleText(disputed, id), `${PENDING_LOAD_TEXT.editDisputed} — ${PENDING_LOAD_TEXT.disputeNote}: الماء ناقص`);
  assert.equal(PENDING_LOAD_TEXT.editDisputed, PENDING_LOAD_MESSAGES.PENDING_LOAD_DISPUTED, 'عبارة الخادم نفسها');
  assert.equal(pendingEditStaleText(err(409, { code: 'PENDING_LOAD_DISPUTED' }), id), PENDING_LOAD_TEXT.editDisputed, 'بلا صفٍّ: العبارة وحدها');
  assert.equal(pendingEditStaleText(revised, en), 'This load has changed since you opened it — reopen it from Loads awaiting acceptance');
  assert.equal(pendingEditStaleText(disputed, en), 'The rep disputed this load after you opened it — read the rep’s note, then reopen it from Loads awaiting acceptance — Rep’s note: الماء ناقص');
  // رفضٌ لا يعني «تغيّر منذ فُتح»: الرفض المعتاد ويبقى المحرّر
  for (const e of [err(422, { code: 'PENDING_LOAD_LINES_CHANGED' }), err(400, { code: 'PENDING_LOAD_QTY_NEGATIVE' }), err(422, { code: 'WAREHOUSE_INSUFFICIENT' }), new Error('Network Error')]) {
    assert.equal(pendingEditStaleText(e, id), null);
  }
  // الشاشتان: التعديل يرسل لحظة الصفّ التي فُتح عليها، والرفض «تغيّر منذ فُتح» يغلق المحرّر قبل الرفض المعتاد
  const page = read('pages', 'VanStockPage.tsx');
  assert.ok(page.includes('revision: pending.revision, updatedAt: pending.updatedAt ?? undefined,'));
  assert.ok(page.includes('const stale = pending ? pendingEditStaleText(e, tr) : null;'));
  assert.ok(page.includes('if (stale) { toast.error(stale, { duration: 10000 }); onClose(); return; }'));
  assert.ok(page.indexOf('if (stale) {') < page.indexOf("toast.error(pendingRefusalText(e, tr, 'تعذر الحفظ'"), 'قبل الرفض المعتاد');
  const m = read('m', 'MRepLoad.tsx');
  assert.ok(m.includes('revision: editing.revision, updatedAt: editing.updatedAt ?? undefined, items: out,'));
  assert.ok(m.includes('const stale = editing ? pendingEditStaleText(e, tr) : null;'));
  assert.ok(m.includes("if (stale) { toast.error(stale, { duration: 10000 }); setEditing(null); setRows([]); setNote(''); return; }"));
  assert.ok(m.indexOf('if (stale) {') < m.indexOf("toast.error(pendingRefusalText(e, tr, 'تعذر الحفظ'"));
});

test('القسم في صفحة مخزون السيارات أول ما فيها: بعد الترويسة وقبل «تصفية بالمدّة» — المعترض عليه لا يُدفن تحت الجداول', () => {
  const page = read('pages', 'VanStockPage.tsx');
  const panel = page.indexOf('{acceptanceOn && <PendingVanLoadsPanel company={companyQ.data ?? null} onEdit={setEditPending} />}');
  assert.ok(panel > page.indexOf("{tr('مخزون سيارات المناديب')}"), 'بعد الترويسة');
  assert.ok(panel < page.indexOf('{/* تصفية بالمدّة */}'), 'قبل تصفية المدّة');
  assert.ok(panel < page.indexOf('{/* ملخّص المناديب */}'));
  // الإلغاء يعيد طلب المندوب المحمَّل «تحميلاً مباشراً» معلّقاً (الخادم) — اللوحة و/m يعيدان قائمة الطلبات بعده
  for (const s of [read('components', 'PendingVanLoadsPanel.tsx'), read('m', 'MRepLoad.tsx')]) {
    const ok = s.slice(s.indexOf('pendingLoadsApi.cancel('), s.indexOf('onError', s.indexOf('pendingLoadsApi.cancel(')));
    assert.ok(ok.includes("qc.invalidateQueries({ queryKey: ['rep-stock-requests'] });"));
  }
});

test('العميل: المسارات والوسائط كما يقرؤها الخادم — والإدارة والمندوب يمرّران عميلهما', async () => {
  const calls: unknown[][] = [];
  const http: HttpLike = {
    get: async (url, config) => { calls.push(['GET', url, config?.params, ...(config?.background ? ['background'] : [])]); return { data: { success: true, data: [serverRow()], counts: { pending: 1, disputed: 0 } } }; },
    post: async (url, body) => { calls.push(['POST', url, body]); return { data: { success: true } }; },
    put: async (url, body) => { calls.push(['PUT', url, body]); return { data: { success: true } }; },
  };
  const c = pendingLoadsClient(http);
  const list = await fetchPendingList(c, { status: 'open', salesRepId: 'r1', withSignature: true, limit: 100 });
  assert.equal(list.rows[0].id, 'p1');
  await c.list();
  await fetchPendingList(c, {}, { background: true });
  await c.get('a/b');
  await c.accept('p1', { signature: SIG, revision: 2, lat: 24.7, lng: 46.6 });
  await c.dispute('p1', 'نقص');
  await c.update('p1', { type: 'LOAD', salesRepId: 'r1', revision: 1, updatedAt: '2026-11-24T06:00:00.000Z', items: [{ productId: 'pa', qty: 1 }] });
  await c.cancel('p1');
  await c.cancel('p1', 'خطأ');
  assert.deepEqual(calls, [
    ['GET', '/van-stock/pending-loads', { status: 'open', salesRepId: 'r1', withSignature: '1', limit: 100 }],
    ['GET', '/van-stock/pending-loads', {}],
    ['GET', '/van-stock/pending-loads', {}, 'background'],
    ['GET', '/van-stock/pending-loads/a%2Fb', undefined],
    ['POST', '/van-stock/pending-loads/p1/accept', { signature: SIG, revision: 2, lat: 24.7, lng: 46.6 }],
    ['POST', '/van-stock/pending-loads/p1/dispute', { note: 'نقص' }],
    ['PUT', '/van-stock/pending-loads/p1', { type: 'LOAD', salesRepId: 'r1', revision: 1, updatedAt: '2026-11-24T06:00:00.000Z', items: [{ productId: 'pa', qty: 1 }] }],
    ['POST', '/van-stock/pending-loads/p1/cancel', {}],
    ['POST', '/van-stock/pending-loads/p1/cancel', { reason: 'خطأ' }],
  ]);
  // التفصيل: الصفّ بتوقيعه والحركة التي كتبها القبول
  const detail = await fetchPendingDetail(pendingLoadsClient({ ...http, get: async () => ({ data: { success: true, data: { ...serverRow({ status: 'ACCEPTED', acceptedAt: ACCEPTED_AT, signature: SIG }), vanLoad: { id: 'v1' } } } }) }), 'p1');
  assert.equal(detail?.view.signature, SIG);
  assert.deepEqual(detail?.vanLoad, { id: 'v1' });
  assert.equal(await fetchPendingDetail(pendingLoadsClient({ ...http, get: async () => ({ data: { success: true, data: null } }) }), 'p1'), null);
});

test('أسطر التعديل: كل بندٍ موجب من الجسم كما حُفظ بموضعه (idx) واسم وحدته ووحداته وتشغيلاته — والصفريّ يسقط', () => {
  const lines = pendingEditLines(viewOf());
  assert.deepEqual(lines.map((l) => [l.productId, l.name, l.qty, l.unitId, l.unitName, l.unitFactor, l.baseUnitName]), [
    ['pa', 'ماء', 2, 'u-ctn', 'كرتون', 24, 'حبة'],
    ['pb', 'عصير', 5, null, 'علبة', 1, 'علبة'],
  ]);
  assert.deepEqual(lines[0].lots, [{ lotId: 'l1', qty: 48 }]);
  assert.equal(lines[1].suggestedQty, 6);
  assert.equal(lines[1].lots, undefined);
  assert.deepEqual(lines[0].units.map((u) => u.name), ['كرتون']);
  // صنفٌ في سطرين بوحدتين: كلٌّ باسم وحدته (لا يأخذ اسم وحدة غيره) حين لا idx
  const two = viewOf({
    lines: [
      { productId: 'pa', name: 'ماء', qty: 1, unitId: null, unitName: 'حبة' },
      { productId: 'pa', name: 'ماء', qty: 2, unitId: 'u-ctn', unitName: 'كرتون', unitFactor: 24 },
    ],
    body: { items: [{ productId: 'pa', qty: 2, unitId: 'u-ctn' }, { productId: 'pa', qty: 1 }] },
  });
  assert.deepEqual(pendingEditLines(two).map((l) => l.unitName), ['كرتون', 'حبة']);
});

// ═══ ٣) الإشعار المطبوع ═══

const company = { name: 'شركة الاختبار للتوزيع', taxNumber: '300000000000003', address: 'الرياض', phone: '0501234567', countryCode: 'SA' };
const renderNotice = (doc: LoadNoticeDoc) => renderToStaticMarkup(h(PrintableLoadNotice, { doc }));

test('الإقرار: للمقبول بتوقيعٍ صالح ولحظة قبول وحده — واسم المندوب الحيّ، وجملة الإقرار تُكتب حرفاً لا نمطاً', () => {
  assert.deepEqual(acceptanceOf(accepted()), { repName: 'أحمد', signature: SIG, acceptedAt: ACCEPTED_AT });
  assert.deepEqual(acceptanceOf(accepted(), 'أحمد علي'), { repName: 'أحمد علي', signature: SIG, acceptedAt: ACCEPTED_AT });
  assert.equal(acceptanceOf(accepted(), '   ')?.repName, 'أحمد', 'اسمٌ فارغ ⇒ اسم الصفّ');
  assert.equal(acceptanceOf(viewOf({ signature: SIG, acceptedAt: ACCEPTED_AT })), null, 'المعلّق لا إقرار له');
  assert.equal(acceptanceOf(accepted({ signature: null })), null, 'مقبولٌ بلا توقيع (قائمةٌ بلا withSignature)');
  assert.equal(acceptanceOf(accepted({ acceptedAt: null })), null);
  assert.equal(acceptanceOf(accepted({ status: 'CANCELLED' })), null);
  assert.equal(acceptanceOf(null), null);
  assert.equal(acceptanceSentence(PENDING_LOAD_TEXT.declaration, 'أحمد'), 'أقرّ أنا المندوب أحمد باستلام البضاعة الموضحة أعلاه');
  assert.equal(acceptanceSentence(PENDING_LOAD_TEXT.declaration, 'محل $& و$1'), 'أقرّ أنا المندوب محل $& و$1 باستلام البضاعة الموضحة أعلاه');
  assert.equal(acceptanceSentence(PENDING_LOAD_TEXT.declaration, ''), 'أقرّ أنا المندوب — باستلام البضاعة الموضحة أعلاه');
  assert.equal(acceptanceSentence(en(PENDING_LOAD_TEXT.declaration), 'Ahmed'), 'I, the rep Ahmed, acknowledge receipt of the goods listed above');
});

test('حركة الإشعار: من الحركة التي كتبها القبول (لقطة وحدة كل بند وتشغيلاته)، وإلا من أسطر المعلّق — والتاريخ لحظة القبول', () => {
  const v = accepted();
  const fromLoad = noticeMovementOf(v, {
    id: 'v1', createdAt: '2026-11-24T09:15:01.000Z', createdBy: 'ADMIN', note: 'تحميل الصباح',
    items: [
      { qty: 2, unitName: 'كرتون', unitFactor: 24, baseQty: 48, product: { id: 'pa', name: 'ماء', unit: 'حبة', primaryUnitId: 'u-ctn' },
        lots: [{ lotId: 'l1', qty: 48, lot: { lotNumber: 'A12', expiryDate: '2026-12-01T00:00:00.000Z' } }] },
      { qty: 5, unitName: null, unitFactor: 1, baseQty: 5, product: { id: 'pb', name: 'عصير', unit: 'علبة', primaryUnitId: null } },
    ],
  });
  assert.equal(fromLoad.date, ACCEPTED_AT);
  assert.equal(fromLoad.kind, 'LOAD');
  assert.equal(fromLoad.by, 'ADMIN');
  assert.deepEqual(fromLoad.items.map((i) => [i.name, i.qty, i.unit, i.baseQty]), [['ماء', 2, 'كرتون', 48], ['عصير', 5, 'علبة', 5]]);
  const fromLines = noticeMovementOf(v);
  assert.equal(fromLines.date, ACCEPTED_AT);
  assert.equal(fromLines.ref, 'تحميل الصباح');
  assert.deepEqual(fromLines.items.map((i) => [i.name, i.qty, i.unitName, i.baseQty]), [['ماء', 2, 'كرتون', 48], ['عصير', 5, 'علبة', 5]]);
  assert.deepEqual(fromLines.items[0].lots, [{ lotId: 'l1', qty: 48, lot: { lotNumber: 'A12', expiryDate: '2026-12-01' } }]);
  // ويُبنى منها الإشعار بتشغيلاته
  const doc = loadNoticeDocFromData(v.repName, fromLines, company, acceptanceOf(v));
  assert.deepEqual(doc.items[0].lots, [{ lotNumber: 'A12', qty: 48, expiryDate: '2026-12-01' }]);
});

test('الإشعار المطبوع: التحميل المقبول بإقرار المندوب وتوقيعه ولحظة قبوله (ميلادية) مكان سطر توقيعه — وغيره حرفاً بحرف كما كان', () => {
  const v = accepted();
  const mv = noticeMovementOf(v);
  const plainDoc = loadNoticeDocFromData('أحمد', mv, company);
  // بلا إقرار: المستند نفسه حرفاً — لا مفتاح acceptance أصلاً
  assert.equal('acceptance' in plainDoc, false);
  assert.deepEqual(loadNoticeDocFromData('أحمد', mv, company, null), plainDoc);
  assert.deepEqual(loadNoticeDocFromData('أحمد', mv, company, undefined), plainDoc);
  const plain = renderNotice(plainDoc);
  assert.ok(!plain.includes('data-load-acceptance'));
  assert.equal(plain.split('توقيع المندوب').length - 1, 1, 'سطر توقيع المندوب الفارغ كما كان');
  assert.ok(plain.includes('توقيع المستودع'));

  const signedDoc = loadNoticeDocFromData('أحمد', mv, company, acceptanceOf(v));
  assert.deepEqual(signedDoc.acceptance, { repName: 'أحمد', signature: SIG, acceptedAt: ACCEPTED_AT });
  const signed = renderNotice(signedDoc);
  assert.ok(signed.includes('data-load-acceptance=""'));
  assert.ok(signed.includes('إقرار استلام المندوب'));
  assert.ok(signed.includes('أقرّ أنا المندوب أحمد باستلام البضاعة الموضحة أعلاه'));
  assert.ok(signed.includes(`src="${SIG}"`), 'صورة التوقيع');
  assert.ok(signed.includes('توقيع المستودع'), 'سطر المستودع باقٍ بجانبه');
  // لحظة القبول بالتقويم الميلادي (ca-gregory) — التاريخ والوقت
  const day = formatDate(ACCEPTED_AT);
  assert.ok(signed.includes(day) && signed.includes(formatTime(ACCEPTED_AT)) && signed.includes('وقت القبول'));
  assert.match(day, /2026|٢٠٢٦/);
  assert.doesNotMatch(signed, /هـ|1448|١٤٤٨/, 'لا هجري');
  // الأصناف نفسها: الجزء قبل التوقيعين كما في الإشعار بلا إقرار
  const cut = (s: string) => s.slice(0, s.indexOf('<table')) + s.slice(s.indexOf('<table'), s.indexOf('</table>'));
  assert.equal(cut(signed), cut(plain), 'الترويسة والأصناف لا تتغيّر');

  // لا يُطبع الإقرار إلا لتحميلٍ بتوقيع PNG صالح ولحظة قبول
  const odd = (patch: Partial<LoadNoticeDoc>) => renderNotice({ ...signedDoc, ...patch });
  assert.ok(!odd({ movementKind: 'UNLOAD' }).includes('data-load-acceptance'), 'التنزيل لا إقرار له');
  assert.ok(!odd({ acceptance: { ...signedDoc.acceptance!, signature: 'https://evil.example/x.png' } }).includes('data-load-acceptance'));
  assert.ok(!odd({ acceptance: { ...signedDoc.acceptance!, acceptedAt: '' } }).includes('data-load-acceptance'));
  assert.equal(loadNoticeAcceptance({ acceptance: signedDoc.acceptance, movementKind: 'LOAD' })?.signature, SIG);
  assert.equal(loadNoticeAcceptance({ acceptance: signedDoc.acceptance, movementKind: undefined })?.signature, SIG, 'بلا نوع = تحميل');
  assert.equal(loadNoticeAcceptance({ acceptance: undefined, movementKind: 'LOAD' }), null);

  // بالإنجليزية: الإقرار مترجماً باسم المندوب كما هو، والتاريخ ميلادياً بلغة الواجهة
  inLang('en', () => {
    const html = renderNotice(signedDoc);
    assert.ok(html.includes('I, the rep أحمد, acknowledge receipt of the goods listed above'));
    assert.ok(html.includes('Rep’s acknowledgment of receipt') && html.includes('Accepted at'));
    assert.ok(html.includes(formatDate(ACCEPTED_AT)) && formatDate(ACCEPTED_AT).includes('2026'));
  });
});

test('مصادر الإشعار: اللوحة و/m يمرّران الإقرار من صفّ الحركة (pendingLoadId) أو من قسم المقبولة — ولا جلب لحركةٍ بلا إقرار', () => {
  const page = read('pages', 'VanStockPage.tsx');
  assert.ok(page.includes('if (m.kind === \'LOAD\' && m.pendingLoadId) {'), 'اللوحة: الجلب لحركة القبول وحدها');
  assert.ok(page.includes('loadNoticeDocFromData(repName, noticeMv, companyQ.data ?? null, noticeAcceptance)'));
  assert.ok(page.includes('onClose={() => { setNoticeMv(null); setNoticeAcceptance(null); }}'));
  const panel = read('components', 'PendingVanLoadsPanel.tsx');
  assert.ok(panel.includes('setNotice(loadNoticeDocFromData(view.repName, noticeMovementOf(view, d.vanLoad), company, acceptanceOf(view)));'));
  const m = read('m', 'MRepLoad.tsx');
  assert.ok(m.includes("if (m.kind === 'LOAD' && m.pendingLoadId) {"));
  assert.ok(m.includes('<MLoadNoticeDoc repName={rep.name} movement={noticeMv} company={company} acceptance={noticeAcceptance}'));
  assert.ok(read('m', 'MLoadNoticeDoc.tsx').includes('loadNoticeDocFromData(repName, movement, (company as Company | null) ?? null, acceptance)'));
});

// ═══ ٤) الشاشات مرسومةً، وربطها ═══

/**
 * بيئة متصفّحٍ دنيا لما يستورد مخزن الجلسة وعميل الـAPI (كـpages/taxOffScreens1.test.ts): localStorage، و`import.meta.env` بناءُ Vite لا
 * وجود له في node — خطّاف تحميلٍ يجعله كائناً فارغاً لملفات src وحدها. الذاكرة مملوءة مسبقاً فلا طلب يخرج.
 */
let envReady = false;
function browserEnv(): void {
  if (envReady) return;
  envReady = true;
  const g = globalThis as { localStorage?: Storage };
  if (!g.localStorage) {
    const m = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); },
      removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
      get length() { return m.size; },
    } as Storage;
  }
  g.localStorage!.setItem('user', JSON.stringify({ id: 'u1', role: 'ADMIN', scopeEnabled: false }));
  const hook = `export async function load(url, ctx, next) {
    const r = await next(url, ctx);
    if (url.includes('/web-admin/src/') && r.source != null) {
      let src = String(r.source);
      if (src.includes('import.meta.env')) src = src.replace(/import\\.meta\\.env/g, '({})');
      if (url.endsWith('/src/store/authStore.ts')) src = src.replace(/window\\.location\\.pathname/g, '"/app"');
      return { ...r, source: src };
    }
    return r;
  }`;
  register(`data:text/javascript,${encodeURIComponent(hook)}`);
}

const listOf = (rows: Record<string, unknown>[], counts?: { pending: number; disputed: number }): PendingLoadList =>
  normalizePendingList({ data: rows, ...(counts && { counts }) });
function client(seed: [unknown[], unknown][]): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  for (const [k, v] of seed) qc.setQueryData(k, v);
  return qc;
}
const inClient = (qc: QueryClient, el: ReactElement) => renderToStaticMarkup(h(QueryClientProvider, { client: qc }, el));
const OPEN_ROWS = [
  serverRow({ id: 'p-pend' }),
  serverRow({ id: 'p-disp', status: 'DISPUTED', disputedAt: '2026-11-24T07:00:00.000Z', disputeNote: 'ناقص كرتون ماء', revision: 2 }),
];
const ACCEPTED_ROWS = [serverRow({ id: 'p-acc', status: 'ACCEPTED', acceptedAt: ACCEPTED_AT, signature: SIG, vanLoadId: 'v1' })];

test('قسم اللوحة مرسوماً: الانتظار والاعتراض بملاحظة المندوب وإجراءي التعديل والإلغاء، والمقبولة بتوقيعها وطباعتها — والفارغ والتحميل', async () => {
  browserEnv();
  const { default: PendingVanLoadsPanel } = await import('../components/PendingVanLoadsPanel');
  const panel = () => h(PendingVanLoadsPanel, { company: null, onEdit: () => {} });
  const reps: [unknown[], unknown] = [['reps-min'], [{ id: 'r1', name: 'أحمد' }]];
  const full = inClient(client([reps,
    [[PENDING_LOADS_KEY, 'web', 'open', ''], listOf(OPEN_ROWS, { pending: 1, disputed: 1 })],
    [[PENDING_LOADS_KEY, 'web', 'accepted', ''], listOf(ACCEPTED_ROWS)],
  ]), panel());
  assert.ok(full.includes('تحميلات بانتظار القبول'));
  const statuses = [...full.matchAll(/data-pending-status="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(statuses, ['DISPUTED', 'PENDING', 'ACCEPTED'], 'المعترض عليه أولاً، ثم المنتظر، ثم المقبول');
  assert.ok(full.includes('ملاحظة المندوب') && full.includes('ناقص كرتون ماء'), 'اعتراض المندوب بملاحظته');
  assert.ok(full.includes('الإصدار') && full.includes('A12'), 'الإصدار المعدّل والتشغيلة');
  assert.equal((full.match(/تعديل<\/button>/g) ?? []).length, 2, 'تعديلٌ لكل مفتوح');
  assert.equal((full.match(/إلغاء<\/button>/g) ?? []).length, 2, 'إلغاءٌ لكل مفتوح');
  assert.equal((full.match(/طباعة<\/button>/g) ?? []).length, 1, 'طباعةٌ للمقبول وحده');
  assert.ok(full.includes(`src="${SIG}"`), 'صورة التوقيع على المقبول');
  assert.ok(full.includes('قبلها المناديب مؤخرا'));
  assert.ok(full.includes('بانتظار قبول المندوب') && full.includes('اعترض المندوب') && full.includes('قبله المندوب ووقع'));
  // الفارغ: عبارته بلا قسم المقبولة
  const empty = inClient(client([reps, [[PENDING_LOADS_KEY, 'web', 'open', ''], listOf([])], [[PENDING_LOADS_KEY, 'web', 'accepted', ''], listOf([])]]), panel());
  assert.ok(empty.includes('لا تحميلات بانتظار القبول'));
  assert.ok(!empty.includes('data-pending-status') && !empty.includes('قبلها المناديب مؤخرا'));
  // قبل وصول القائمة: «جار التحميل» لا «لا تحميلات»
  const loading = inClient(client([reps]), panel());
  assert.ok(loading.includes('جار التحميل') && !loading.includes('لا تحميلات بانتظار القبول'));
  // بالإنجليزية
  const html = inLang('en', () => inClient(client([reps,
    [[PENDING_LOADS_KEY, 'web', 'open', ''], listOf(OPEN_ROWS, { pending: 1, disputed: 1 })],
    [[PENDING_LOADS_KEY, 'web', 'accepted', ''], listOf(ACCEPTED_ROWS)],
  ]), panel()));
  for (const s of ['Loads awaiting acceptance', 'Awaiting rep acceptance', 'Disputed by the rep', 'Accepted and signed by the rep', 'Rep’s note', 'Recently accepted by reps', 'Version']) {
    assert.ok(html.includes(s), s);
  }
});

test('قسم /m مرسوماً: لا شيء بلا صفوف، والمفتوحة بإجراءيها (والمفتوح في النموذج «قيد التعديل») والمقبولة بطباعتها', async () => {
  browserEnv();
  const { default: MPendingLoads } = await import('../m/MPendingLoads');
  const el = (editingId: string | null = null) => h(MPendingLoads, { repId: 'r1', editingId, printingId: null, onEdit: () => {}, onCancel: () => {}, onPrint: () => {} });
  const none = inClient(client([[[PENDING_LOADS_KEY, 'm', 'open', 'r1'], listOf([])], [[PENDING_LOADS_KEY, 'm', 'accepted', 'r1'], listOf([])]]), el());
  assert.equal(none, '', 'بلا صفوف لا يُرسم شيء');
  const seeded = (): QueryClient => client([
    [[PENDING_LOADS_KEY, 'm', 'open', 'r1'], listOf(OPEN_ROWS)],
    [[PENDING_LOADS_KEY, 'm', 'accepted', 'r1'], listOf(ACCEPTED_ROWS)],
  ]);
  const html = inClient(seeded(), el());
  assert.ok(html.includes('data-m-pending-loads') && html.includes('تحميلات بانتظار القبول'));
  assert.deepEqual([...html.matchAll(/data-pending-status="(\w+)"/g)].map((m) => m[1]), ['DISPUTED', 'PENDING', 'ACCEPTED']);
  assert.ok(html.includes('ناقص كرتون ماء') && html.includes(`src="${SIG}"`));
  assert.equal((html.match(/طباعة<\/button>/g) ?? []).length, 1);
  const editing = inClient(seeded(), el('p-pend'));
  assert.ok(editing.includes('قيد التعديل'), 'المفتوح في النموذج موسوم');
});

test('مفتاح الإعداد مرسوماً: مطفأ قابلٌ للتفعيل، ومفعّلٌ بلا مفتوح قابلٌ للإيقاف، ومفعّلٌ فوق تحميلاتٍ مفتوحة معطّلٌ بعددها وسببه', async () => {
  browserEnv();
  const { default: VanLoadAcceptanceCard } = await import('../components/VanLoadAcceptanceCard');
  const input = (html: string) => /<input type="checkbox"[^>]*>/.exec(html)?.[0] ?? '';
  const off = inClient(client([]), h(VanLoadAcceptanceCard, { company: { vanLoadAcceptance: false } }));
  assert.ok(off.includes('اشتراط قبول المندوب للتحميل وتوقيعه') && off.includes(PENDING_LOAD_TEXT.settingHint));
  assert.ok(!/checked/.test(input(off)) && !/disabled/.test(input(off)));
  const oldServer = inClient(client([]), h(VanLoadAcceptanceCard, { company: {} }));
  assert.ok(!/checked/.test(input(oldServer)), 'خادمٌ بلا العلم = مطفأ');
  const on = inClient(client([[['van-load-acceptance'], { enabled: true, openCount: 0 }]]), h(VanLoadAcceptanceCard, { company: { vanLoadAcceptance: true } }));
  assert.ok(/checked/.test(input(on)) && !/disabled/.test(input(on)));
  assert.ok(!on.includes(PENDING_LOAD_TEXT.settingOpen));
  const blocked = inClient(client([[['van-load-acceptance'], { enabled: true, openCount: 3 }]]), h(VanLoadAcceptanceCard, { company: { vanLoadAcceptance: true } }));
  assert.ok(/checked/.test(input(blocked)) && /disabled/.test(input(blocked)), 'لا إيقاف فوق تحميلاتٍ مفتوحة');
  assert.ok(blocked.includes(PENDING_LOAD_TEXT.settingOpen));
  assert.match(blocked, /\((?:<!-- -->)?[3٣](?:<!-- -->)?\)/, 'العدد بأرقام الواجهة');
});

test('ربط الإعداد: البطاقة لمدير الشركة غير المقيَّد والمحاسبة مفعّلة، بمسارها المستقل PATCH، وتُبطل [company] — وPUT /company لا يرسل العلم', () => {
  const s = read('pages', 'CompanySettingsPage.tsx');
  assert.ok(s.includes("const vanLoadAcceptanceCardOn = accountingOn && role === 'ADMIN' && !scopeEnabled;"));
  assert.equal((s.match(/<VanLoadAcceptanceCard\b/g) ?? []).length, 1);
  assert.ok(s.includes('{vanLoadAcceptanceCardOn && <VanLoadAcceptanceCard company={data} />}'));
  const at = s.indexOf('<VanLoadAcceptanceCard company={data} />');
  assert.ok(at > s.indexOf('{returnPolicyCardOn && <ReturnPolicyCard') && at < s.indexOf('</form>'), 'في الإعدادات العامة بجانب بطاقة المرتجع');
  assert.ok(!/vanLoadAcceptance\s*:/.test(s), 'الحفظ العام لا يكتب العلم');
  const c = read('api', 'client.ts');
  assert.ok(c.includes("get: () => api.get('/company/van-load-acceptance'),"));
  assert.ok(c.includes("set: (enabled: boolean) => api.patch('/company/van-load-acceptance', { enabled }),"));
  assert.ok(c.includes('export const pendingLoadsApi = pendingLoadsClient(api);'));
  const card = read('components', 'VanLoadAcceptanceCard.tsx');
  assert.ok(card.includes('mutationFn: (enabled: boolean) => companyApi.vanLoadAcceptance.set(enabled),'));
  assert.ok(card.includes("await qc.invalidateQueries({ queryKey: ['company'] });"), 'اللوحة و/m يقرآن العلم من /company');
  assert.ok(card.includes('qc.invalidateQueries({ queryKey: [PENDING_LOADS_KEY] });'));
  assert.ok(card.includes('enabled: value,'), 'عدد المفتوح يُقرأ والميزة مفعّلة وحدها');
  assert.ok(card.includes('disabled={save.isPending || offBlocked}'));
  assert.ok(card.includes("toast.error(pendingErrorText(err, tr, 'حدث خطأ في الحفظ')"), 'رفض الخادم بعبارة رمزه');
});

test('ربط الإرسال في اللوحة و/m: pending:true برسالته لا «تم حفظ الحركة»، والقسم والتلميح والجلب والميزة مفعّلة وحدها — والمطفأة كما كانت', () => {
  const page = read('pages', 'VanStockPage.tsx');
  assert.ok(page.includes('const acceptanceOn = vanLoadAcceptanceOn(companyQ.data);'));
  assert.ok(page.includes('{acceptanceOn && <PendingVanLoadsPanel company={companyQ.data ?? null} onEdit={setEditPending} />}'), 'القسم مفعّلةً وحدها');
  assert.equal((page.match(/<PendingVanLoadsPanel\b/g) ?? []).length, 1);
  const m = read('m', 'MRepLoad.tsx');
  assert.ok(m.includes('const acceptanceOn = vanLoadAcceptanceOn(company);'));
  assert.ok(/\{acceptanceOn && \(\s*<MPendingLoads /.test(m), '/m: القسم مفعّلةً وحدها');
  assert.equal((m.match(/<MPendingLoads\b/g) ?? []).length, 1);
  for (const [name, s, hint] of [['اللوحة', page, '{acceptanceOn && !pending && ('], ['/m', m, '{acceptanceOn && !editing && split.out.length > 0 && (']] as const) {
    assert.ok(s.includes('pendingSent = isPendingLoadResponse(res);'), `${name}: قراءة الردّ`);
    assert.ok(s.includes('replayed = replayed || (!pendingSent && isReplayResponse(res));'), `${name}: الإعادة كما كانت لغير المرسَل`);
    assert.ok(s.includes('else if (pendingSent) toast.success(tr(PENDING_LOAD_TEXT.sent), { duration: 6000 });'), `${name}: رسالة الإرسال`);
    assert.ok(s.includes("if (!edited && (!pendingSent || unloaded)) toast.success(tr('تم حفظ الحركة'));"), `${name}: «تم حفظ الحركة» للحركة وحدها`);
    assert.ok(s.includes('if (pendingSent || edited) qc.invalidateQueries({ queryKey: [PENDING_LOADS_KEY] });'));
    assert.ok(s.includes(hint), `${name}: التلميح مفعّلةً وحدها`);
    // رفضٌ برمز المعلّق بعبارته (أسطرٌ ستتغيّر عند التسجيل، مندوبٌ موقوف، صفٌّ عُدّل أو قُبل أو أُلغي)
    assert.ok(s.includes("if (pe?.code && (pe.code.startsWith('PENDING_LOAD_') || pe.code === 'API_KEY_FORBIDDEN')) {"));
    // التعديل: PUT بمراجعة الصفّ التي بدأ منها، أسطرٌ موجبة وحدها
    assert.ok(/pendingLoadsApi\.update\((pending|editing)\.id, \{/.test(s) && /revision: (pending|editing)\.revision/.test(s), `${name}: التعديل بالمراجعة`);
  }
  // قسم /m وقسم اللوحة يقرآن عبر usePendingVanLoads — لا جلب حين لا يُركَّبان (المطفأة)
  const hook = read('lib', 'usePendingVanLoads.ts');
  assert.ok(hook.includes("fetchPendingList(pendingLoadsApi, { status: 'open'") && hook.includes("status: 'ACCEPTED', withSignature: true"));
  assert.ok(hook.includes('refetchInterval: (q) => ((q.state.data?.rows.length ?? 0) > 0 ? 60_000 : false),'), 'إعادةٌ دورية ما دام ما ينتظر وحده');
});

test('«تحميل مباشر» لطلب المندوب والميزة مفعّلة: ردّ pending:true يعلّم الطلب بمعرّف المعلّق برسالة الإرسال — والمطفأة كما كانت', () => {
  const modal = read('components', 'StockRequestModal.tsx');
  // التأكيد: مفعّلةً تلميح الإرسال مكان «تخصم الكميات»، ومطفأةً العبارة كما كانت
  assert.ok(modal.includes("const effect = vanLoadAcceptanceOn(company) ? tr(PENDING_LOAD_TEXT.hint) : tr('تخصم الكميات من مخزون الشركة');"));
  // المعرّف (حركةٌ أو معلّق) يعلّم الطلب بالمسار نفسه — /loaded يقبل معرّف المعلّق لسيارة صاحبه (repStockRequests.ts)
  assert.ok(modal.includes('pendingSent = isPendingLoadResponse(res);'));
  assert.ok(modal.indexOf('pendingSent = isPendingLoadResponse(res);') < modal.indexOf('await repStockRequestApi.loaded(r.id, { updatedAt: saved.updatedAt, vanLoadId });'));
  assert.ok(modal.includes("pendingSent ? `${tr(PENDING_LOAD_TEXT.sent)} · ${r.repName}` : fillNames(tr('حمل طلب المندوب {names} إلى سيارته'), [r.repName]),"));
  // ما بعد الإرسال لا يقول «تم التحميل» ولا «راجع حركة التحميل»: كل رسالةٍ بنظيرتها «أُرسل… تحميلات بانتظار القبول» — ومنها خطأ
  // التعليم في catch (فالعلم خارج try)
  assert.ok(modal.indexOf('let pendingSent = false;') < modal.indexOf('    try {', modal.indexOf('let pendingSent = false;')));
  for (const [sent, loaded] of [
    ['أرسل الطلب للمندوب مع ملاحظات من الخادم على {names} راجعه في تحميلات بانتظار القبول', 'حمل الطلب مع ملاحظات من الخادم على {names} راجع حركة التحميل في مخزون السيارات'],
    ['أرسل التحميل للمندوب لكنه عدل طلبه بعده فبقي معلقا راجع ما أضافه', 'تم التحميل لكن المندوب عدل طلبه بعده فبقي معلقا راجع ما أضافه'],
    ['أرسل التحميل للمندوب لكن الطلب لم يعد معلقا سحبه المندوب أو حسمه غيرك راجع تحميلات بانتظار القبول', 'تم التحميل لكن الطلب لم يعد معلقا سحبه المندوب أو حسمه غيرك راجع حركة التحميل في مخزون السيارات'],
    ['سبق إرسال هذا الطلب للمندوب فلم يتكرر', 'سبق تحميل هذا الطلب فلم يتكرر'],
    ['أرسل التحميل للمندوب لكن تعذر تعليم الطلب اضغط تحميل مباشر مرة أخرى ليعلم دون إرسال ثان', 'تم التحميل لكن تعذر تعليم الطلب اضغط تحميل مباشر مرة أخرى ليعلم دون تحميل ثان'],
  ]) {
    const at = modal.indexOf(`tr('${sent}')`);
    assert.ok(at > 0, sent);
    assert.ok(modal.lastIndexOf('pendingSent', at) > modal.lastIndexOf(`tr('${loaded}')`, at), `${sent}: بشرط pendingSent`);
    assert.ok(modal.includes(`tr('${loaded}')`), `المطفأة كما كانت: ${loaded}`);
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
      assert.ok(PHRASES[sent]?.[lang] && !/[؀-ۿ]/.test(PHRASES[sent][lang]), `${sent} (${lang})`);
    }
    assert.ok(!PHRASES[sent].fr.includes("'"), `${sent} (fr) بفاصلةٍ عليا لاتينية`);
  }
  assert.ok(modal.includes("...(replayed ? [pendingSent ? tr('سبق إرسال هذا الطلب للمندوب فلم يتكرر') : tr(VAN_MOVE_TEXT.replay)] : []), ...lotNotes,"),
    'المرسَل نفسه بعد إعادةٍ لا يقول «سبق حفظ هذه الحركة»');
  assert.ok(/'lot-fefo', PENDING_LOADS_KEY\]\) \{/.test(modal), 'قسم «تحميلات بانتظار القبول» يُعاد');
  const backend = path.resolve(process.cwd(), '..', 'backend', 'src', 'routes', 'repStockRequests.ts');
  if (fs.existsSync(backend)) {
    const s = fs.readFileSync(backend, 'utf8');
    assert.match(s, /\?\? \(req\.user\?\.apiKeyId \? null : await tx\.pendingVanLoad\.findFirst\(/, '/loaded يقبل معرّف المعلّق');
  }
});

// ═══ ٥) الترجمة ورسائل الخادم ═══

test('الترجمة: كل نصٍّ وحالةٍ ورسالة خادم بالإنجليزية والفرنسية والتركية والصينية — بلا عربية متسرّبة ولا فاصلةٍ عليا لاتينية في الفرنسية', () => {
  const keys = [...Object.values(PENDING_LOAD_TEXT), ...Object.values(PENDING_STATUS_LABELS), ...Object.values(PENDING_LOAD_MESSAGES),
    'قبلها المناديب مؤخرا', 'إلغاء التحميل', 'قيد التعديل', 'إلغاء التعديل', 'سيستبدل ما أدخلته بأسطر التحميل المرسل'];
  const missing: string[] = [];
  for (const k of keys) {
    const p = PHRASES[k];
    if (!p) { missing.push(k); continue; }
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
      const v = p[lang];
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${k} بلا ${lang}`);
      assert.doesNotMatch(v, /[؀-ۿ]/, `${k} (${lang}) فيه عربية`);
    }
    assert.ok(!p.fr.includes("'"), `${k} (fr) بفاصلةٍ عليا لاتينية`);
  }
  assert.deepEqual(missing, [], 'عباراتٌ بلا ترجمة');
  // الإقرار يحمل اسم المندوب في كل لغة
  for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(PHRASES[PENDING_LOAD_TEXT.declaration][lang].includes('{name}'), lang);
  // «الإصدار ٢» لا «مراجعة ٢» (ترجمتها Review)
  assert.equal(PENDING_LOAD_TEXT.revised, 'الإصدار');
  assert.equal(PHRASES['الإصدار'].en, 'Version');
});

test('رسائل الخادم حرفاً: رموز المعلّق ورموز الإعداد في العقد كما يرسلها الخادم (متى وُجد في الشجرة)', (t) => {
  const backend = path.resolve(process.cwd(), '..', 'backend', 'src');
  const svc = path.join(backend, 'services', 'vanPendingLoads.ts');
  const route = path.join(backend, 'routes', 'companyVanLoadAcceptance.ts');
  if (!fs.existsSync(svc) || !fs.existsSync(route)) { t.skip('الخادم غير موجود في الشجرة'); return; }
  const block = (file: string, start: string) => {
    const s = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const from = s.indexOf(start);
    assert.ok(from >= 0, `${start} غائب`);
    const body = s.slice(from, s.indexOf('});', from));
    return Object.fromEntries([...body.matchAll(/^\s+([A-Z_]+): '([^']*)',?$/gm)].map((m) => [m[1], m[2]]));
  };
  const server = {
    ...block(svc, 'export const PENDING_LOAD_MESSAGES = Object.freeze({'),
    ...block(route, 'export const VAN_LOAD_ACCEPTANCE_CODES = Object.freeze({'),
  };
  assert.ok(Object.keys(server).length >= 20, 'قراءة رموز الخادم');
  assert.deepEqual({ ...PENDING_LOAD_MESSAGES }, server);
});
