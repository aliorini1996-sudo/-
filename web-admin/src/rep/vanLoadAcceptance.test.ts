// «قبول المندوب للتحميل وتوقيعه» (طلب المالك ٢٢ نوفمبر ٢٠٢٦) — تطبيق المندوب فوق العقد المشترك (lib/pendingLoads.ts): أقسام
// شاشته وبطاقة الرئيسية، والكاش لكل مندوب، وجسم القبول (توقيع PNG إلزامي + revision) والاعتراض، والانقطاع ورموز الرفض، ونصّا
// الكمية والتشغيلة على سطر الخادم كما يرسله (pendingLinesView). ثمّ حرّاسٌ نصّية للتوصيل في RepApp وRepPendingLoads: الشركة
// المطفأة كما كانت حرفاً، والقبول متصلٌ وحده بلا صفّ صادر، والمخزون يُحدَّث بعده.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DISPUTE_NOTE_MAX, PENDING_LOADS_SCREEN, SIGNATURE_MAX, acceptBlocked, acceptBodyOf, activeRowStale, disputeNoteOf, lineLotText,
  lineQtyText, myRequestStatusText, pendingCacheEntry, pendingCacheOf, pendingHomeCardOf, pendingLoadsCacheKey, repPendingFailureOf, repPendingFailureText,
  repPendingSections, requestLoadAwaiting,
} from './vanLoadAcceptance';
import { PHRASES } from '../i18n/strings';
import {
  PENDING_LOAD_MESSAGES, acceptanceOf, fetchPendingDetail, normalizePendingList, normalizePendingLoad, noticeMovementOf, pendingLoadsClient,
} from '../lib/pendingLoads';
import { PrintableLoadNotice, loadNoticeDocFromData } from './RepDocuments';
import { iosPushScreen, type IosPushEvent } from './iosPush';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
const tr = (s: string) => s;
const fmt = (n: number) => String(n);
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** صفٌّ كما يرسله الخادم للمندوب (pendingLoadView بأسطر pendingLinesView — بلا body ولا توقيع) */
const view = (over: Record<string, unknown> = {}) => ({
  id: 'p1', salesRepId: 'r1', repName: 'سالم', status: 'PENDING', revision: 1, note: 'حمّل صباحاً', createdByName: 'المدير',
  createdAt: '2026-11-22T06:00:00.000Z', updatedAt: '2026-11-22T06:00:00.000Z',
  disputeNote: null, disputedAt: null, acceptedAt: null, acceptedLat: null, acceptedLng: null, vanLoadId: null,
  cancelledAt: null, cancelledByName: null, lineCount: 2,
  lines: [
    { idx: 0, productId: 'a', name: 'ماء', code: 'W1', unit: 'حبة', primaryUnitId: null, units: [{ id: 'u-box', name: 'كرتون', factor: 24, isActive: true }],
      unitId: 'u-box', unitName: 'كرتون', unitFactor: 24, qty: 3, baseQty: 72, missing: false,
      lots: [{ lotId: 'l1', lotNumber: 'B-77', expiryDate: '2027-01-31', qty: 48 }, { lotId: null, lotNumber: null, expiryDate: null, qty: 24 }] },
    { idx: 1, productId: 'b', name: 'عصير', code: null, unit: 'حبة', primaryUnitId: null, units: [],
      unitId: null, unitName: 'حبة', unitFactor: 1, qty: 5, baseQty: 5, lots: [], missing: false },
  ],
  ...over,
});

test('سطر الخادم كما يرسله: وحدة السطر وأساسه بين قوسين، والتشغيلة برقمها وانتهائها وكميتها بالأساس', () => {
  const r = normalizePendingLoad(view())!;
  assert.equal(r.lines.length, 2);
  assert.equal(lineQtyText(r.lines[0], fmt), '3 كرتون (72 حبة)');
  assert.equal(lineQtyText(r.lines[1], fmt), '5 حبة', 'الأساس وحده بلا قوسين');
  assert.equal(lineLotText(r.lines[0].lots[0], r.lines[0], tr, fmt), 'B-77 · ينتهي 31/01/2027 · ×48 حبة');
  assert.equal(lineLotText(r.lines[0].lots[1], r.lines[0], tr, fmt), 'غير مسمى · ×24 حبة');
  assert.equal(lineLotText({ lotId: null, lotNumber: 'NEW-1', expiryDate: null, qty: 0 }, r.lines[0], tr, fmt), 'NEW-1', 'بلا كمية: بلا وسمها');
  // صنفٌ حُذف بعد الإرسال: لا يُفتح التوقيع (القبول سيُرفض PENDING_LOAD_CHANGED)
  assert.equal(acceptBlocked(r), false);
  const gone = normalizePendingLoad(view({ lines: [{ ...view().lines[1], name: '', missing: true }] }))!;
  assert.equal(acceptBlocked(gone), true);
});

test('الأقسام: بانتظار القبول الأقدم أولاً، ثم الاعتراض، ثم المقبول الأحدث — وبطاقة الرئيسية', () => {
  const l = normalizePendingList({
    success: true,
    data: [
      view({ id: 'n2', createdAt: '2026-11-22T09:00:00.000Z' }),
      view({ id: 'n1', createdAt: '2026-11-22T07:00:00.000Z' }),
      view({ id: 'd1', status: 'DISPUTED', disputeNote: 'ناقص كرتون', disputedAt: '2026-11-21T10:00:00.000Z' }),
      view({ id: 'a1', status: 'ACCEPTED', acceptedAt: '2026-11-20T10:00:00.000Z' }),
      view({ id: 'a2', status: 'ACCEPTED', acceptedAt: '2026-11-21T10:00:00.000Z' }),
    ],
    counts: { pending: 7, disputed: 1 },
  });
  const s = repPendingSections(l.rows);
  assert.deepEqual(s.pending.map((r) => r.id), ['n1', 'n2'], 'يُستلم بترتيب الإرسال');
  assert.deepEqual(s.disputed.map((r) => r.id), ['d1']);
  assert.deepEqual(s.accepted.map((r) => r.id), ['a2', 'a1']);
  assert.deepEqual(pendingHomeCardOf(l.counts), { kind: 'pending', n: 7 }, 'عدّاد الخادم يشمل ما وراء الحدّ');
  assert.deepEqual(pendingHomeCardOf({ pending: 0, disputed: 3 }), { kind: 'disputed', n: 3 });
  assert.equal(pendingHomeCardOf({ pending: 0, disputed: 0 }), null);
  assert.equal(pendingHomeCardOf(null), null);
});

test('الكاش لكل مندوب: محفوظ غيره أو شكلٌ قديم لا يُعرض', () => {
  const list = normalizePendingList({ data: [view()], counts: { pending: 1, disputed: 0 } });
  const e = pendingCacheEntry('r1', list, 1000);
  assert.equal(pendingLoadsCacheKey('r1'), 'rep-pending-loads:r1');
  const back = pendingCacheOf(JSON.parse(JSON.stringify(e)), 'r1')!;
  assert.equal(back.at, 1000);
  assert.deepEqual(back.list.counts, { pending: 1, disputed: 0 });
  assert.equal(back.list.rows[0].lines[0].baseQty, 72);
  assert.equal(pendingCacheOf(e, 'r2'), null, 'جهازٌ مشترك: قائمة زميله لا تظهر');
  assert.equal(pendingCacheOf(e, null), null);
  assert.equal(pendingCacheOf({ ...e, v: 2 }, 'r1'), null);
  assert.equal(pendingCacheOf({ ...e, list: { rows: 'x' } }, 'r1'), null);
  assert.equal(pendingCacheOf(null, 'r1'), null);
});

test('جسم القبول: توقيع PNG إلزاميٌّ ضمن الحدّ وrevision صحيح، والموقع اختياريٌّ صالحاً وحده', () => {
  assert.deepEqual(acceptBodyOf(SIG, 2), { signature: SIG, revision: 2 });
  assert.deepEqual(acceptBodyOf(SIG, 1, { lat: 24.7, lng: 46.6 }), { signature: SIG, revision: 1, lat: 24.7, lng: 46.6 });
  assert.deepEqual(acceptBodyOf(SIG, 1, { lat: 0, lng: 0 }), { signature: SIG, revision: 1 }, 'نقطة الصفر ليست موقعاً');
  assert.deepEqual(acceptBodyOf(SIG, 1, { lat: 91, lng: 46 }), { signature: SIG, revision: 1 });
  assert.deepEqual(acceptBodyOf(SIG, 1, { lat: Number.NaN, lng: 46 }), { signature: SIG, revision: 1 });
  assert.equal(acceptBodyOf(null, 1), null);
  assert.equal(acceptBodyOf('', 1), null);
  assert.equal(acceptBodyOf('data:image/jpeg;base64,AAAA', 1), null, 'PNG وحده كما يشترط الخادم');
  assert.equal(acceptBodyOf('data:image/png;base64,AA AA', 1), null);
  assert.equal(acceptBodyOf(`data:image/png;base64,${'A'.repeat(SIGNATURE_MAX)}`, 1), null, 'فوق حدّ الخادم لا يُرسل');
  assert.equal(acceptBodyOf(SIG, 0), null);
  assert.equal(acceptBodyOf(SIG, 1.5), null);
});

test('اللوحة المفتوحة والقائمة تتجدّد تحتها: صفٌّ عدّلته الإدارة أو لم يعد مفتوحاً يُغلقها — فلا يُقبل بتوقيعٍ رُسم على غير المعروض', () => {
  const acc = { mode: 'accept' as const, revision: 1 };
  const dis = { mode: 'dispute' as const, revision: 1 };
  assert.equal(activeRowStale(acc, { status: 'PENDING', revision: 1 }), false, 'كما هو: تبقى بتوقيعها');
  assert.equal(activeRowStale(acc, { status: 'PENDING', revision: 2 }), true, 'عدّلته الإدارة: يوقّع من جديد');
  assert.equal(activeRowStale(acc, undefined), true, 'اختفى من القائمة (أُلغي)');
  assert.equal(activeRowStale(acc, null), true);
  for (const s of ['DISPUTED', 'ACCEPTED', 'CANCELLED'] as const) assert.equal(activeRowStale(acc, { status: s, revision: 1 }), true, s);
  assert.equal(activeRowStale(dis, { status: 'PENDING', revision: 1 }), false);
  assert.equal(activeRowStale(dis, { status: 'DISPUTED', revision: 1 }), false, 'تعديل الاعتراض على صفّه المعترَض عليه');
  assert.equal(activeRowStale(dis, { status: 'PENDING', revision: 2 }), true, 'عدّلته الإدارة بعد الاعتراض');
  assert.equal(activeRowStale(dis, { status: 'ACCEPTED', revision: 1 }), true);
  assert.equal(activeRowStale(dis, { status: 'CANCELLED', revision: 1 }), true);
});

test('سبب الاعتراض: إلزاميٌّ بعد القصّ وضمن الحدّ', () => {
  assert.equal(disputeNoteOf('  ناقص كرتون  '), 'ناقص كرتون');
  assert.equal(disputeNoteOf('   '), null);
  assert.equal(disputeNoteOf(null), null);
  assert.equal(disputeNoteOf('x'.repeat(DISPUTE_NOTE_MAX)), 'x'.repeat(DISPUTE_NOTE_MAX));
  assert.equal(disputeNoteOf('x'.repeat(DISPUTE_NOTE_MAX + 1)), null);
});

test('الرفض: الانقطاع برسالته لكل فعل، ورموز الخادم بعباراته، وما يعيد القائمة، وما يدعو للاعتراض', () => {
  const err = (status: number, data: unknown) => ({ response: { status, data } });
  const offline = new Error('Network Error');
  assert.equal(repPendingFailureOf(offline).offline, true);
  assert.equal(repPendingFailureText(offline, tr, 'accept'), 'قبول التحميل وتوقيعه يتمّان والجهاز متصل');
  assert.equal(repPendingFailureText(offline, tr, 'dispute'), 'الاعتراض يرسل والجهاز متصل');
  assert.equal(repPendingFailureText(offline, tr, 'load'), 'تعذر تحميل البيانات');

  const revisedErr = err(409, { success: false, code: 'PENDING_LOAD_REVISED', message: 'x', data: view({ revision: 2 }) });
  const revised = repPendingFailureOf(revisedErr);
  assert.equal(revised.reload, true);
  assert.equal(revised.invitesDispute, false);
  assert.equal(revised.row?.revision, 2, 'الصفّ الحالي من الرفض نفسه');
  assert.equal(repPendingFailureText(revisedErr, tr, 'accept'), PENDING_LOAD_MESSAGES.PENDING_LOAD_REVISED);
  for (const code of ['PENDING_LOAD_NOT_PENDING', 'PENDING_LOAD_ACCEPTED', 'PENDING_LOAD_CANCELLED', 'PENDING_LOAD_NOT_FOUND']) {
    assert.equal(repPendingFailureOf(err(409, { code })).reload, true, code);
  }
  assert.equal(repPendingFailureOf(err(404, {})).reload, true);

  for (const code of ['PENDING_LOAD_STOCK_SHORT', 'PENDING_LOAD_LOTS_SHORT', 'PENDING_LOAD_CHANGED']) {
    const f = repPendingFailureOf(err(409, { code, message: 'm' }));
    assert.equal(f.reload, false, `${code}: ما زال بانتظار القبول`);
    assert.equal(f.invitesDispute, true, code);
    assert.equal(repPendingFailureText(err(409, { code }), tr, 'accept'), PENDING_LOAD_MESSAGES[code]);
  }
  // رمزٌ لا يعرفه العقد: رسالة الخادم كما هي، وبلاها نصٌّ عام
  assert.equal(repPendingFailureText(err(400, { code: 'X', message: 'رسالة الخادم' }), tr, 'accept'), 'رسالة الخادم');
  assert.equal(repPendingFailureText(err(500, {}), tr, 'accept'), 'تعذر الحفظ');
  assert.equal(repPendingFailureText(err(500, {}), tr, 'load'), 'تعذر تحميل البيانات');
});

test('نسخة المندوب الموقَّعة: تفصيل الخادم (GET /pending-loads/:id) ⇒ إشعار التحميل بإقراره وتوقيعه ولحظة قبوله، وغير المقبول بلا إقرار', async () => {
  const acceptedAt = '2026-11-22T08:15:00.000Z';
  const detail = {
    success: true,
    data: {
      ...view({ status: 'ACCEPTED', acceptedAt, vanLoadId: 'vl1' }),
      signature: SIG,
      vanLoad: {
        id: 'vl1', createdAt: acceptedAt, createdBy: 'ADMIN', note: 'حمّل صباحاً',
        items: [
          { qty: 3, unitName: 'كرتون', unitFactor: 24, baseQty: 72, product: { id: 'a', name: 'ماء', unit: 'حبة', primaryUnitId: null } },
          { qty: 5, product: { id: 'b', name: 'عصير', unit: 'حبة', primaryUnitId: null } },
        ],
      },
    },
  };
  const calls: string[] = [];
  const http = {
    get: async (url: string) => { calls.push(`GET ${url}`); return { data: detail }; },
    post: async (url: string) => { calls.push(`POST ${url}`); return { data: {} }; },
    put: async (url: string) => { calls.push(`PUT ${url}`); return { data: {} }; },
  };
  const d = await fetchPendingDetail(pendingLoadsClient(http), 'p1');
  assert.deepEqual(calls, ['GET /van-stock/pending-loads/p1'], 'قراءةٌ وحدها — لا كتابة');
  assert.ok(d);
  // كما تبنيه الشاشة (openNotice): الاسم من الخادم، والحركة التي كتبها القبول، والإقرار من الصفّ المقبول
  const v = { ...d.view, repName: d.view.repName || 'احتياط' };
  const doc = loadNoticeDocFromData(v.repName, noticeMovementOf(v, d.vanLoad), { name: 'شركة الاختبار للتوزيع', countryCode: 'SA' }, acceptanceOf(v));
  assert.equal(doc.kind, 'loadNotice');
  assert.equal(doc.repName, 'سالم');
  assert.deepEqual(doc.acceptance, { repName: 'سالم', signature: SIG, acceptedAt });
  assert.deepEqual(doc.items.map((i) => i.name), ['ماء', 'عصير'], 'بنود الحركة التي دخلت السيارة');
  const html = renderToStaticMarkup(createElement(PrintableLoadNotice, { doc }));
  assert.ok(html.includes('data-load-acceptance'), 'كتلة الإقرار');
  assert.ok(html.includes('أقرّ أنا المندوب سالم باستلام البضاعة الموضحة أعلاه'));
  assert.ok(html.includes(`src="${SIG}"`), 'صورة التوقيع');

  // غير المقبول، أو مقبولٌ بلا توقيعٍ صالح: بلا إقرار — والإشعار كما كان حرفاً
  assert.equal(acceptanceOf(normalizePendingLoad(view())), null);
  assert.equal(acceptanceOf(normalizePendingLoad({ ...view({ status: 'ACCEPTED', acceptedAt }), signature: 'https://evil/x.png' })), null);
  const plain = loadNoticeDocFromData('سالم', noticeMovementOf(normalizePendingLoad(view())!), null, null);
  assert.equal('acceptance' in plain, false);
  assert.ok(!renderToStaticMarkup(createElement(PrintableLoadNotice, { doc: plain })).includes('data-load-acceptance'));
});

test('المسار وشاشة الإشعار — كما يرسلها الخادم', () => {
  assert.equal(PENDING_LOADS_SCREEN, 'vanloads');
  const e = (over: Partial<IosPushEvent>): IosPushEvent => ({ kind: 'open', id: 'i', tag: null, checkId: null, url: null, at: 1, ...over });
  assert.equal(iosPushScreen(e({ kind: 'open', tag: 'van-load', url: '/rep?screen=vanloads' })), 'vanloads', 'لمس إشعار الآيفون يفتح شاشة القبول');
  assert.equal(iosPushScreen(e({ kind: 'receive', tag: 'van-load', url: '/rep?screen=vanloads' })), null, 'والتطبيق ظاهر: لا ينقله');
  const server = path.join(process.cwd(), '..', 'backend', 'src', 'services', 'vanPendingLoads.ts');
  if (fs.existsSync(server)) {
    assert.ok(read('..', 'backend', 'src', 'services', 'vanPendingLoads.ts').includes(`url: '/rep?screen=${PENDING_LOADS_SCREEN}'`), 'رابط الإشعار');
    const routes = read('..', 'backend', 'src', 'routes', 'vanStock.ts');
    for (const r of ["router.get('/pending-loads'", "router.post('/pending-loads/:id/accept'", "router.post('/pending-loads/:id/dispute'"]) {
      assert.ok(routes.includes(r), r);
    }
  }
});

test('«مخزون سيارتي»: طلبٌ «حُمِّل» بتحميلٍ أُرسل ولم يُقبل بعد ⇒ «بانتظار قبولك وتوقيعك» لا «حملت الإدارة طلبك» — وما سواه كما كان', () => {
  assert.equal(myRequestStatusText({ status: 'LOADED', pendingStatus: 'PENDING' }, tr), 'أرسلت الإدارة طلبك للتحميل — بانتظار قبولك وتوقيعك');
  assert.equal(myRequestStatusText({ status: 'LOADED', pendingStatus: 'DISPUTED' }, tr), 'اعترضت على تحميل طلبك — بانتظار تعديل الإدارة');
  // المقبول (دخل السيارة)، والحركة المباشرة (null)، وخادمٌ أقدم بلا الحقل: كما كان
  for (const pendingStatus of ['ACCEPTED', null, undefined]) {
    assert.equal(myRequestStatusText({ status: 'LOADED', pendingStatus }, tr), 'حملت الإدارة طلبك إلى سيارتك', String(pendingStatus));
    assert.equal(requestLoadAwaiting({ status: 'LOADED', pendingStatus }), false);
  }
  assert.equal(myRequestStatusText({ status: 'SENT' }, tr), 'أرسلت الإدارة طلبك ضمن طلب المخزون');
  assert.equal(myRequestStatusText({ status: 'REJECTED' }, tr), 'رفضت الإدارة طلبك الأخير');
  assert.equal(requestLoadAwaiting({ status: 'LOADED', pendingStatus: 'PENDING' }), true);
  assert.equal(requestLoadAwaiting({ status: 'LOADED', pendingStatus: 'DISPUTED' }), true);
  assert.equal(requestLoadAwaiting({ status: 'SENT', pendingStatus: 'PENDING' }), false);
  for (const k of ['أرسلت الإدارة طلبك للتحميل — بانتظار قبولك وتوقيعك', 'اعترضت على تحميل طلبك — بانتظار تعديل الإدارة']) {
    for (const lang of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(PHRASES[k]?.[lang] && !/[؀-ۿ]/.test(PHRASES[k][lang]), `${k} (${lang})`);
    assert.ok(!PHRASES[k].fr.includes("'"), k);
  }
  // RepApp يعرض العبارة من الدالّة نفسها، والمنتظر بلون الانتظار
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.ok(app.includes('{myRequestStatusText(myReq.last, tr)} · {formatDate(myReq.last.decidedAt)}'));
  assert.ok(app.includes("requestLoadAwaiting(myReq.last) ? 'bg-amber-50 text-amber-800'"));
  assert.ok(app.includes('pendingStatus?: string | null;'));
});

test('حارس ثابت: RepApp — الشركة المطفأة كما كانت حرفاً، والبطاقة والشريط خلف العلم، والإشعار يفتح الشاشة', () => {
  const app = read('src', 'rep', 'RepApp.tsx');
  assert.match(app, /type Screen = [^;]*\| 'vanloads'[\s|;]/); // عضوٌ في الاتحاد أينما كان (لا آخره بالضرورة: «طلبات المنيو» بعده)
  assert.ok(app.includes("const vanLoadsOn = accountingOn && (company as { vanLoadAcceptance?: boolean } | null)?.vanLoadAcceptance === true;"),
    'مطفأ افتراضياً (=== true) وخلف المحاسبة');
  const home = app.slice(app.indexOf('function RepHome('), app.indexOf('function RepCustomers('));
  assert.ok(home.includes("{vanLoadsOn && <PendingLoadsHomeCard onOpen={() => onQuick('vanloads')} />}"));
  assert.ok(home.indexOf('<PendingLoadsHomeCard') < home.indexOf("{tr('رصيد التحصيل لديك')}"), 'أعلى الرئيسية');
  assert.ok(app.includes('aiRepOn={aiRepOn} vanLoadsOn={vanLoadsOn} />}'));
  // «مخزون سيارتي» للشركة المطفأة: النداء نفسه بلا غلاف ولا شريط
  assert.ok(app.includes(") : <RepVanStock canLoad={user.canManageVanStock !== false} canRequest={(company as { warehouseEnabled?: boolean } | null)?.warehouseEnabled === true} />)}"));
  assert.ok(app.includes("<PendingLoadsStrip onOpen={() => setScreen('vanloads')} />"));
  assert.match(app, /\{screen === 'vanstock' && \(vanLoadsOn \? \(/);
  // الإشعار: الرابط والرسالة (عامل الخدمة والآيفون)
  assert.match(app, /\} else if \(s === PENDING_LOADS_SCREEN\) \{\s*\/\/[^\n]*\n\s*setScreen\('vanloads'\);/);
  assert.ok(app.includes("else if (e.data.screen === PENDING_LOADS_SCREEN) setScreen('vanloads');"));
  assert.ok(app.includes("if (!accountingOn && screen === 'vanloads') setScreen('home');"));
  // بعد القبول: لقطة اللوط بجلبٍ يبدأ بعده
  assert.match(app, /onAccepted=\{\(\) => \{ void refreshVanLots\(0, true\); \}\}/);
  // الشاشة لا تُعاد بمزامنةٍ رفعت صفّاً صادراً (refreshKey) — توقيعٌ قيد الرسم لا يُمحى؛ والشركة واسم المندوب لإشعاره الموقَّع
  const screen = app.slice(app.indexOf("{screen === 'vanloads' && ("), app.indexOf("{screen === 'dailyreport' &&"));
  assert.ok(screen.includes('<RepPendingLoads onBack='));
  assert.doesNotMatch(screen, /key=/);
  assert.ok(screen.includes('company={company} repName={user.name} />'));
  // الحرّاس القائمة لم تتغيّر
  assert.match(app, /if \(s === 'attendance' \|\| s === 'presence'\) \{\s*if \(s === 'attendance'\) setScreen\('attendance'\);/);
  assert.match(app, /<RepVanStock canLoad=\{user\.canManageVanStock !== false\} canRequest=\{\(company as \{ warehouseEnabled\?: boolean \} \| null\)\?\.warehouseEnabled === true\} \/>/);
});

test('حارس ثابت: RepPendingLoads — العميل المشترك، والقبول متصلٌ بتوقيعٍ وإقرار، والاعتراض بسبب، بلا صفّ صادر، والمخزون بعده', () => {
  const ui = read('src', 'rep', 'RepPendingLoads.tsx');
  assert.doesNotMatch(ui, /outboxAdd|newClientRef|x-fs-replay/, 'لا قبول دون اتصال');
  assert.ok(ui.includes('const client = pendingLoadsClient(repApi);'), 'عميل العقد المشترك على جلسة المندوب');
  assert.ok(ui.includes("import SignaturePad from './SignaturePad';"));
  assert.ok(ui.includes("{tr('أقرّ باستلام البضاعة الموضحة أعلاه كاملة وسليمة')}"));
  assert.ok(ui.includes('<SignaturePad value={signature} onChange={setSignature}'));
  assert.ok(ui.includes('disabled={busy || !signature || !actionsOn}'), 'لا قبول بلا توقيع أو دون اتصال');
  assert.ok(ui.includes('disabled={!actionsOn || busy || blocked}'), 'صنفٌ محذوف: لا يُفتح التوقيع');
  assert.ok(ui.includes('const body = acceptBodyOf(signature, row.revision, fix.current);'), 'revision الصفّ المعروض');
  assert.ok(ui.includes('await client.accept(row.id, body);'));
  assert.ok(ui.includes('await client.dispute(row.id, n);'));
  assert.ok(ui.includes('disabled={busy || !disputeNoteOf(note) || !actionsOn}'), 'لا اعتراض بلا سبب');
  assert.ok(ui.includes("const actionsOn = online && net.kind === 'ok';"), 'القائمة المحفوظة بلا أزرار');
  const acc = ui.slice(ui.indexOf('const accept = async'), ui.indexOf('const dispute = async'));
  assert.ok(acc.indexOf('onAccepted?.();') > acc.indexOf('await client.accept('), 'التحديث بعد النجاح وحده');
  assert.ok(acc.includes('void refreshVanCurrentCache();'), 'أرصدة السيارة المحفوظة بعد القبول');
  assert.ok(ui.includes('cacheSet<VanCurrentCache<unknown>>(VAN_CURRENT_CACHE_PREFIX + me, { v: 1, repId: me, fetchedAt: startedAt, rows })'));
  // العدّاد: طلبٌ خلفيّ لا يُخرج المندوب، ومحفوظٌ لكل مندوب
  assert.ok(ui.includes('await fetchPendingList(client, {}, { background: true });'), 'عبر العميل المشترك لا نداءً مكرّراً');
  assert.doesNotMatch(ui, /repApi\.(get|post|put)\([^)]*pending-loads/, 'لا مسار معلّقٍ خارج العميل المشترك');
  assert.ok(ui.includes('pendingCacheOf(hit?.data, me)'));
  // «إشعار PDF» للمقبول: تفصيل الخادم بتوقيعه ثم البانية نفسها التي تطبع بها الإدارة — متصلٌ وحده، والرجوع يغلقه
  assert.ok(ui.includes('const d = await fetchPendingDetail(client, row.id);'));
  assert.ok(ui.includes('setNotice(loadNoticeDocFromData(v.repName, noticeMovementOf(v, d.vanLoad), company, acceptanceOf(v)));'));
  assert.ok(ui.includes('if (notice) return <DocumentResult doc={notice} onClose={() => setNotice(null)} />;'));
  assert.ok(ui.includes('useBackClose(notice !== null, () => setNotice(null));'));
  const acceptedPart = ui.slice(ui.indexOf('{sections.accepted.map('));
  assert.ok(acceptedPart.includes('{actionsOn && (') && acceptedPart.includes('onClick={() => { void openNotice(row); }}'), 'دون اتصال لا زرّ');
  // اللوحة تحفظ revision صفّها لحظة فتحها، والقائمة إذا تجدّدت تحتها بصفٍّ عدّلته الإدارة تُغلقها وتمحو التوقيع
  assert.ok(ui.includes("setActive({ id: row.id, mode, revision: row.revision }); setSignature(null);"));
  const stale = ui.slice(ui.indexOf('if (!activeRowStale(active, row)) return;'));
  assert.ok(stale.indexOf('setActive(null); setSignature(null);') >= 0 && stale.indexOf('setActive(null); setSignature(null);') < stale.indexOf('}, [list]);'));
  // رجوع التطبيق إلى الواجهة يعيد القائمة — لا أثناء قبولٍ جارٍ
  assert.ok(ui.includes("const onVisible = () => { if (document.visibilityState === 'visible' && !busyRef.current) void load(); };"));
  // الشاشة لا تقرأ التوقيع من الكاش ولا تحفظه: القائمة المحفوظة صفوف العرض وحدها (الخادم لا يرسل التوقيع في القائمة للمندوب)
  assert.doesNotMatch(ui, /cacheSet\([^)]*signature/);
});
