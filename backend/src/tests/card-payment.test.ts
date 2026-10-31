import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { parseIntent, parseTerminals, signTerminalJwt } from '../services/nearpay';
import { decideCardPayment, halalasOf, launchUriFor } from '../services/cardPayment';

/**
 * حرّاس «التحصيل بالبطاقة» (NearPay). الخطأ الذي تحرسه: سند قبضٍ لمالٍ لم يُقبض — بما يقوله الجوال، أو بمبلغٍ غير
 * المبلغ، أو على نقطة بيع تاجرٍ آخر، أو لعمليةٍ عُكست. القرار دالة صرفة: نيّة NearPay ← فعلٌ واحد.
 */

// شكل «Find Transaction Intent» الموثّق (docs.nearpay.io › Accounts API) — الحقول التي نقرؤها بأسمائها هناك
const approvedIntent = (over: Record<string, unknown> = {}) => ({
  details: {
    intenet_id: 'c1b2a3d4-0000-4000-8000-000000000001',
    reference_id: 'INV-2026-0042',
    type: 'purchase',
    status: 'approved',
    amount: '11500',
    transactions: [{
      id: 'tx-1',
      status: 'approved',
      card: { pan: '4111********1111' },
      amount: '11500',
      events: [{
        rrn: '630115000123',
        stan: '000123',
        type: 'purchase',
        status: 'approved',
        receipt: {
          standard: 'mada',
          id: 'rc-1',
          data: {
            tid: '0212184900121849',
            pan: '4111********1111',
            card_scheme: { name: { english: 'VISA' } },
            is_approved: true,
            approval_code: { value: '474747' },
            transaction_type: { name: { english: 'PURCHASE' } },
            transaction_uuid: 'b6e5d4c3-1111-4222-8333-444455556666',
            amount_authorized: { value: '115.00' },
            system_trace_audit_number: '000123',
            retrieval_reference_number: '630115000123',
          },
        },
      }],
    }],
    ...over,
  },
});

const row = (over: Partial<{ status: string; amountHalalas: number; tid: string; createdAt: Date }> = {}) => ({
  status: 'pending', amountHalalas: 11500, tid: '0212184900121849', createdAt: new Date('2026-10-28T10:00:00Z'), ...over,
});
const NOW = new Date('2026-10-28T10:02:00Z');

test('parseIntent: الشكل الموثّق — موافقة وإيصال ومراجع وكود موافقة من كائن value', () => {
  const s = parseIntent(approvedIntent());
  assert.equal(s.found, true);
  assert.equal(s.id, 'c1b2a3d4-0000-4000-8000-000000000001');
  assert.equal(s.status, 'approved');
  assert.equal(s.amountHalalas, 11500);
  assert.equal(s.approved, true);
  assert.equal(s.reversed, false);
  assert.equal(s.tid, '0212184900121849');
  assert.equal(s.transactionUuid, 'b6e5d4c3-1111-4222-8333-444455556666');
  assert.equal(s.rrn, '630115000123');
  assert.equal(s.stan, '000123');
  assert.equal(s.approvalCode, '474747');
  assert.equal(s.cardScheme, 'VISA');
  assert.equal(s.maskedPan, '4111********1111');
});

test('parseIntent: إيصال غير موافَق لا يصنع موافقة، وحدث عكسٍ موافَق عليه يعلّم العكس', () => {
  const declined = approvedIntent({ status: 'declined' });
  ((declined.details.transactions[0].events[0].receipt.data) as Record<string, unknown>).is_approved = false;
  const d = parseIntent(declined);
  assert.equal(d.approved, false);
  assert.equal(d.status, 'declined');

  const rev = approvedIntent();
  rev.details.transactions[0].events.push({
    rrn: '630115000124', stan: '000124', type: 'reversal', status: 'approved',
    receipt: { standard: 'mada', id: 'rc-2', data: { is_approved: true } as never },
  } as never);
  assert.equal(parseIntent(rev).reversed, true);
});

test('parseIntent: شكل القائمة المسطّح (is_reversed على المعاملة) وردٌّ فارغ', () => {
  const flat = { id: 'x', status: 'approved', amount: 500, transactions: [{ uuid: 'u-1', is_approved: true, is_reversed: true, retrieval_reference_number: '1' }] };
  const s = parseIntent(flat);
  // معاملةٌ عُكست ليست «فعّالة»: لا موافقة تُقيد، والنيّة معكوسة
  assert.equal(s.approved, false);
  assert.equal(s.effectiveCount, 0);
  assert.equal(s.reversed, true);
  assert.equal(s.amountHalalas, 500);
  assert.equal(parseIntent(null).found, false);
  assert.equal(parseIntent({ details: { amount: '12.50' } }).amountHalalas, null); // ليس هللاتٍ صحيحة ⇒ مجهول لا مخمَّن
});

test('القرار: لا سند إلا لموافقةٍ بالمبلغ ونقطة البيع نفسيهما', () => {
  assert.deepEqual(decideCardPayment(row(), parseIntent(approvedIntent()), NOW), { action: 'approve' });
  assert.equal(decideCardPayment(row({ amountHalalas: 11400 }), parseIntent(approvedIntent()), NOW).action, 'mismatch');
  assert.equal(decideCardPayment(row({ tid: '0212184800121848' }), parseIntent(approvedIntent()), NOW).action, 'mismatch');
  // نيّة «approved» بلا إيصال موافَق بعد ⇒ انتظار لا قيد
  const noReceipt = approvedIntent();
  ((noReceipt.details.transactions[0].events[0].receipt.data) as Record<string, unknown>).is_approved = false;
  assert.deepEqual(decideCardPayment(row(), parseIntent(noReceipt), NOW), { action: 'wait' });
  // الموافق محلياً لا يُقيد ثانية
  assert.deepEqual(decideCardPayment(row({ status: 'approved' }), parseIntent(approvedIntent()), NOW), { action: 'wait' });
});

test('القرار: الغياب والرفض والعكس والانتهاء', () => {
  assert.deepEqual(decideCardPayment(row(), null, NOW), { action: 'wait' });
  assert.deepEqual(decideCardPayment(row(), null, new Date('2026-10-28T11:00:00Z')), { action: 'expire' });
  // سندٌ قائم لا يُمحى لأن النيّة لم تُرجع — مراجعة بشرية لا إلغاء آلي
  assert.deepEqual(decideCardPayment(row({ status: 'approved' }), null, new Date('2026-10-28T11:00:00Z')), { action: 'wait' });
  assert.equal(decideCardPayment(row(), parseIntent(approvedIntent({ status: 'declined', transactions: [] })), NOW).action, 'decline');
  const rev = { details: { status: 'approved', amount: '11500', transactions: [{ is_approved: true, is_reversed: true }] } };
  assert.equal(decideCardPayment(row({ status: 'approved' }), parseIntent(rev), NOW).action, 'reverse');
  assert.equal(decideCardPayment(row(), parseIntent(rev), NOW).action, 'decline');
  // ميتٌ محلياً ثم ظهرت موافقته لدى NearPay ⇒ يُقيد (دفعة اللحظة الأخيرة لا تضيع)
  assert.deepEqual(decideCardPayment(row({ status: 'expired' }), parseIntent(approvedIntent()), NOW), { action: 'approve' });
});

test('الهللات: تقريب نصف-لأعلى إلى خانتين ثم ×١٠٠ بلا كسور عائمة', () => {
  assert.equal(halalasOf(115), 11500);
  assert.equal(halalasOf(0.1 + 0.2), 30);
  assert.equal(halalasOf(10.005), 1001);
  assert.equal(halalasOf(1), 100);
});

test('رابط فتح وحدة الدفع: الرمز وحده فيه — لا مبلغ ولا فاتورة — ولحزمة تطبيق المندوب', () => {
  const u = launchUriFor('tok_ABC-123');
  assert.match(u, /^intent:\/\/cardpay\?t=tok_ABC-123#Intent;scheme=fieldsapay;package=net\.fieldsa\.twa;/);
  assert.match(u, /S\.browser_fallback_url=https%3A%2F%2Ffieldsa\.net%2Frep%3Fcardpay%3Dunsupported;end$/);
  assert.doesNotMatch(u, /amount|invoice/i);
});

test('JWT نقطة البيع: RS256 والحمولة الموثّقة data{ops,client_uuid,terminal_id}، والمفتاح المحفوظ بـ\\n حرفية', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const prev = { k: process.env.NEARPAY_JWT_PRIVATE_KEY, c: process.env.NEARPAY_CLIENT_UUID };
  try {
    process.env.NEARPAY_JWT_PRIVATE_KEY = pem.replace(/\n/g, '\\n'); // كما تحفظه لوحات البيئة سطراً واحداً
    process.env.NEARPAY_CLIENT_UUID = 'dc7fb082-0000-4000-8000-000000000000';
    const token = signTerminalJwt('0212184900121849', 300);
    const decoded = jwt.verify(token, publicKey.export({ type: 'spki', format: 'pem' }).toString(), { algorithms: ['RS256'] }) as Record<string, unknown>;
    assert.deepEqual(decoded.data, { ops: 'auth', client_uuid: 'dc7fb082-0000-4000-8000-000000000000', terminal_id: '0212184900121849' });
    assert.equal(typeof decoded.exp, 'number');
  } finally {
    if (prev.k === undefined) delete process.env.NEARPAY_JWT_PRIVATE_KEY; else process.env.NEARPAY_JWT_PRIVATE_KEY = prev.k;
    if (prev.c === undefined) delete process.env.NEARPAY_CLIENT_UUID; else process.env.NEARPAY_CLIENT_UUID = prev.c;
  }
});

test('نقاط البيع: يُقرأ TID والتاجر والاتصال من ردّ /terminals الحقيقي، وما بلا TID صالح يُسقط', () => {
  const out = parseTerminals({
    terminals: [
      { id: 'bb6b5e32', tid: '0212184900121849', merchant: { id: 'm-1', name: 'Takamul', name_ar: 'مؤسسة تكامل الميدان' }, user: { mobile: '+966553634056' }, is_connected: false },
      { id: 'zz', tid: 'abc', merchant: { id: 'm-1' } },
    ],
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { id: 'bb6b5e32', tid: '0212184900121849', merchantId: 'm-1', merchantName: 'مؤسسة تكامل الميدان', userMobile: '+966553634056', connected: false });
});

// ═══ مراجعة ٢٨ أكتوبر ٢٠٢٦: القرار يفشل مغلقاً، وكل معاملة على حدة ═══

const tx = (o: { tid?: string; uuid?: string; approved?: boolean; type?: string; authorized?: string; extraEvents?: unknown[] } = {}) => ({
  status: 'approved',
  events: [
    {
      rrn: 'r', stan: 's', type: o.type ?? 'purchase', status: o.approved === false ? 'declined' : 'approved',
      receipt: { data: { tid: o.tid ?? '0212184900121849', is_approved: o.approved !== false, transaction_uuid: o.uuid ?? 'uuid-1', amount_authorized: { value: o.authorized ?? '115.00' } } },
    },
    ...(o.extraEvents ?? []),
  ],
});
const intent = (txs: unknown[], over: Record<string, unknown> = {}) => ({ details: { intenet_id: 'i', status: 'approved', amount: '11500', transactions: txs, ...over } });
const reversalEvent = { type: 'reversal', status: 'approved', receipt: { data: { is_approved: true } } };
const refundEvent = (sar: string) => ({ type: 'refund', status: 'approved', receipt: { data: { is_approved: true, amount_authorized: { value: sar } } } });

test('يفشل مغلقاً: مبلغٌ أو نقطة بيعٍ غير مقروءة، أو مأذونٌ مختلف ⇒ اختلاف لا قيد', () => {
  assert.equal(decideCardPayment(row(), parseIntent(intent([tx()], { amount: '115.00' })), NOW).action, 'mismatch'); // ليس هللات
  assert.equal(decideCardPayment(row(), parseIntent(intent([tx()], { amount: undefined })), NOW).action, 'mismatch');
  const noTid = intent([tx()]);
  delete ((noTid.details.transactions[0] as { events: { receipt: { data: Record<string, unknown> } }[] }).events[0].receipt.data).tid;
  assert.equal(decideCardPayment(row(), parseIntent(noTid), NOW).action, 'mismatch');
  assert.equal(decideCardPayment(row(), parseIntent(intent([tx({ authorized: '1.00' })])), NOW).action, 'mismatch');
  assert.deepEqual(decideCardPayment(row(), parseIntent(intent([tx()])), NOW), { action: 'approve' });
});

test('حالة النيّة «عكس/إلغاء» تحكم على أي إيصال موافَق: معكوسة/ملغاة', () => {
  for (const st of ['reversed', 'cancelled', 'voided']) {
    const snap = parseIntent(intent([tx()], { status: st }));
    assert.equal(decideCardPayment(row(), snap, NOW).action, 'decline', st);
    assert.equal(decideCardPayment(row({ status: 'approved' }), snap, NOW).action, 'reverse', st);
  }
  // «refunded» بلا استردادٍ مقروء على المعاملة: كاملٌ أم جزئي؟ لا يُخمَّن (مراجعة ٣١ أكتوبر ٢٠٢٦) — وقفٌ للمراجعة لا إلغاء
  const refunded = parseIntent(intent([tx()], { status: 'refunded' }));
  assert.equal(decideCardPayment(row(), refunded, NOW).action, 'mismatch');
  assert.equal(decideCardPayment(row({ status: 'approved' }), refunded, NOW).action, 'mismatch');
});

test('كل معاملة على حدة: إعادةٌ ناجحة بعد عكسٍ آلي تُقيد ببياناتها، وخصمٌ مكرر يُوقف القيد', () => {
  const retry = parseIntent(intent([tx({ uuid: 'first', extraEvents: [reversalEvent] }), tx({ uuid: 'second' })]));
  assert.equal(retry.effectiveCount, 1);
  assert.equal(retry.reversed, false);
  assert.equal(retry.transactionUuid, 'second');
  assert.deepEqual(decideCardPayment(row(), retry, NOW), { action: 'approve' });

  const twice = parseIntent(intent([tx({ uuid: 'a' }), tx({ uuid: 'b' })]));
  assert.equal(twice.effectiveCount, 2);
  assert.equal(decideCardPayment(row(), twice, NOW).action, 'mismatch');

  // شراءٌ موافَق على نقطة تاجرٍ آخر وحده ⇒ اختلاف (لا يُقرأ TID من معاملةٍ أخرى)
  assert.equal(decideCardPayment(row(), parseIntent(intent([tx({ tid: '0212189000121890' })])), NOW).action, 'mismatch');
});

test('الاسترداد: الكامل يلغي السند، والجزئي يُنبّه ولا يُلغي', () => {
  const full = parseIntent(intent([tx({ extraEvents: [refundEvent('115.00')] })]));
  assert.equal(full.refund, 'full');
  assert.equal(decideCardPayment(row({ status: 'approved' }), full, NOW).action, 'reverse');
  const partial = parseIntent(intent([tx({ extraEvents: [refundEvent('15.00')] })]));
  assert.equal(partial.refund, 'partial');
  assert.equal(decideCardPayment(row({ status: 'approved' }), partial, NOW).action, 'mismatch');
});

test('نيّة «approved» بلا إيصال موافَق مقروء: انتظارٌ ثم صوتٌ بعد المهلة — لا قيد ولا انتظار أبدي', () => {
  const snap = parseIntent(intent([tx({ approved: false })]));
  assert.deepEqual(decideCardPayment(row(), snap, NOW), { action: 'wait' });
  assert.equal(decideCardPayment(row(), snap, new Date('2026-10-28T11:00:00Z')).action, 'mismatch');
});

test('إسناد نقاط البيع إداريٌّ وحده: requireAdmin قبل الصلاحية (requireAdminPermission يمرّر المندوب)، وبنطاق المستخدم', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'cardPayments.ts'), 'utf8');
  assert.match(src, /const manageReps = \[requireAdmin, requireAdminPermission\('canManageSalesReps'\)\];/);
  assert.match(src, /router\.get\('\/terminals', manageReps,/);
  assert.match(src, /router\.put\('\/reps\/:salesRepId', manageReps,/);
  assert.equal((src.match(/adminRepFilter\(req\)/g) || []).length, 2);
  // البدء للمندوب وحده وبصلاحية السندات
  assert.match(src, /if \(!isRep\(req\)\) \{ res\.status\(403\)/);
  assert.match(src, /canCreateReceipt/);
});

// ═══ مراجعة ٣١ أكتوبر ٢٠٢٦: الخطأ في الاتجاهين مالٌ ضائع — ما لا يُحسم بدليلٍ يُوقَف للمراجعة ═══

const booked = (uuid = 'uuid-1') => ({ ...row({ status: 'approved' }), transactionUuid: uuid });

test('رفضٌ/فشل في حالة النيّة لا يُسقط شراءً موافَقاً قائماً: وقفٌ للمراجعة لا «مرفوضة» ولا إلغاء سند', () => {
  for (const st of ['declined', 'failed', 'rejected']) {
    const snap = parseIntent(intent([tx()], { status: st }));
    assert.equal(snap.approved, true, st);
    assert.equal(decideCardPayment(row(), snap, NOW).action, 'mismatch', st);
    assert.equal(decideCardPayment(booked(), snap, NOW).action, 'mismatch', st);
    assert.equal(decideCardPayment(row({ status: 'declined' }), snap, NOW).action, 'mismatch', st); // كنس الميت يراه
  }
  // رفضٌ بلا شراء موافَق = رفضٌ حقيقي
  assert.equal(decideCardPayment(row(), parseIntent(intent([tx({ approved: false })], { status: 'declined' })), NOW).action, 'decline');
});

test('الاسترداد الجزئي لا يُلغي السند ولو كانت حالة النيّة refunded أو partially_refunded', () => {
  for (const st of ['refunded', 'partially_refunded', 'approved']) {
    const snap = parseIntent(intent([tx({ extraEvents: [refundEvent('15.00')] })], { status: st }));
    assert.equal(snap.refund, 'partial', st);
    assert.equal(decideCardPayment(booked(), snap, NOW).action, 'mismatch', st);
  }
  // الكامل بحالة refunded يلغي كما كان
  const full = parseIntent(intent([tx({ extraEvents: [refundEvent('115.00')] })], { status: 'refunded' }));
  assert.equal(full.reversed, true);
  assert.equal(full.refund, 'full');
  assert.equal(decideCardPayment(booked(), full, NOW).action, 'reverse');
});

test('خصمٌ مكرر ثم استرداد أحدهما كاملاً: لا يُلغى السند — والمستردّ ليس «فعّالاً»', () => {
  const firstRefunded = parseIntent(intent([tx({ uuid: 'a', extraEvents: [refundEvent('115.00')] }), tx({ uuid: 'b' })]));
  assert.equal(firstRefunded.effectiveCount, 1);
  assert.equal(firstRefunded.reversed, false);
  assert.equal(firstRefunded.refund, 'none');
  assert.equal(firstRefunded.transactionUuid, 'b');
  // السند على المستردّة: المال الباقي من معاملةٍ أخرى — وقفٌ بتنبيه لا إلغاء
  assert.equal(decideCardPayment(booked('a'), firstRefunded, NOW).action, 'mismatch');
  // السند على الباقية: سليم
  assert.deepEqual(decideCardPayment(booked('b'), firstRefunded, NOW), { action: 'wait' });
  // معلّقٌ: يُقيد بالباقية
  assert.deepEqual(decideCardPayment(row(), firstRefunded, NOW), { action: 'approve' });
  // والخصمان قائمان: وقفٌ لا إلغاء ولو حملت الحالة refunded
  const both = parseIntent(intent([tx({ uuid: 'a' }), tx({ uuid: 'b', extraEvents: [refundEvent('15.00')] })], { status: 'refunded' }));
  assert.equal(decideCardPayment(booked('a'), both, NOW).action, 'mismatch');
});

test('إشارات الاسترداد غير الموافَقة صراحةً لا تُهمَل: معلّق، أو منتهٍ بلا is_approved، أو على حالة المعاملة، أو مستقل', () => {
  const pendingRefund = { type: 'refund', status: 'pending', receipt: { data: { amount_authorized: { value: '115.00' } } } };
  assert.equal(decideCardPayment(booked(), parseIntent(intent([tx({ extraEvents: [pendingRefund] })])), NOW).action, 'mismatch');
  assert.equal(decideCardPayment(row(), parseIntent(intent([tx({ extraEvents: [pendingRefund] })])), NOW).action, 'mismatch');
  // «completed» بلا is_approved: استردادٌ تمّ
  const completed = { type: 'refund', status: 'completed', receipt: { data: { amount_authorized: { value: '115.00' } } } };
  assert.equal(decideCardPayment(booked(), parseIntent(intent([tx({ extraEvents: [completed] })])), NOW).action, 'reverse');
  // مرفوضٌ صراحةً: لا أثر
  const rejectedRefund = { type: 'refund', status: 'declined', receipt: { data: { is_approved: false, amount_authorized: { value: '115.00' } } } };
  assert.deepEqual(decideCardPayment(booked(), parseIntent(intent([tx({ extraEvents: [rejectedRefund] })])), NOW), { action: 'wait' });
  // حالة المعاملة refunded بلا حدث: مبلغٌ مجهول ⇒ جزئي ⇒ وقف
  const txRefunded = { ...tx(), status: 'refunded' };
  assert.equal(parseIntent(intent([txRefunded])).refund, 'partial');
  assert.equal(decideCardPayment(booked(), parseIntent(intent([txRefunded])), NOW).action, 'mismatch');
  // استردادٌ في معاملةٍ مستقلة يُنسب للشراء الوحيد: كاملٌ يلغي، وجزئيٌّ يوقف
  const standalone = (sar: string) => ({ status: 'approved', events: [refundEvent(sar)] });
  assert.equal(decideCardPayment(booked(), parseIntent(intent([tx(), standalone('115.00')])), NOW).action, 'reverse');
  assert.equal(decideCardPayment(booked(), parseIntent(intent([tx(), standalone('15.00')])), NOW).action, 'mismatch');
  // ولا شراء يُنسب إليه ⇒ وقف
  assert.equal(decideCardPayment(row(), parseIntent(intent([standalone('115.00')])), NOW).action, 'mismatch');
});

test('عكسٌ غير محسوم واسترجاع chargeback يوقفان القيد والسند — وحدثٌ بنوعٍ غريب لا يصير «شراءً»', () => {
  const openReversal = { type: 'reversal', status: 'pending', receipt: { data: {} } };
  assert.equal(decideCardPayment(row(), parseIntent(intent([tx({ extraEvents: [openReversal] })])), NOW).action, 'mismatch');
  const chargeback = { type: 'chargeback', status: 'approved', receipt: { data: { is_approved: true } } };
  assert.equal(decideCardPayment(booked(), parseIntent(intent([tx({ extraEvents: [chargeback] })])), NOW).action, 'mismatch');
  const odd = parseIntent(intent([tx({ type: '' })]));
  assert.equal(odd.approved, false);
  assert.deepEqual(decideCardPayment(row(), odd, NOW), { action: 'wait' }); // ثم وقفٌ بعد المهلة — لا قيد
  assert.equal(decideCardPayment(row(), odd, new Date('2026-10-28T11:00:00Z')).action, 'mismatch');
});

test('fetchIntent: ردّ 200 بشكلٍ غير معروف يُرمى (لا «غير مسجّلة» فتنتهي الدفعة صامتة)، و404 4047 وحده null', async () => {
  const { fetchIntent, NearpayError } = await import('../services/nearpay');
  const prevFetch = globalThis.fetch;
  const prevKey = process.env.NEARPAY_API_KEY;
  const id = 'c1b2a3d4-0000-4000-8000-000000000001';
  const reply = (status: number, body: string) => { globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch; };
  const is502 = (e: unknown) => e instanceof NearpayError && e.status === 502;
  try {
    process.env.NEARPAY_API_KEY = 'test-key';
    reply(200, '<html>maintenance</html>');
    await assert.rejects(fetchIntent(id), is502);
    reply(200, JSON.stringify({ data: approvedIntent().details })); // غلافٌ آخر
    await assert.rejects(fetchIntent(id), is502);
    reply(200, JSON.stringify(approvedIntent({ intenet_id: 'another-intent' }))); // نيّةٌ غير المطلوبة
    await assert.rejects(fetchIntent(id), is502);
    reply(200, JSON.stringify(approvedIntent({ status: undefined }))); // بلا حالة
    await assert.rejects(fetchIntent(id), is502);
    reply(200, JSON.stringify(approvedIntent({ intenet_id: id.toUpperCase() })));
    assert.equal((await fetchIntent(id))?.approved, true);
    reply(404, JSON.stringify({ code: 4047, code_text: 'intent_not_found' }));
    assert.equal(await fetchIntent(id), null);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.NEARPAY_API_KEY; else process.env.NEARPAY_API_KEY = prevKey;
  }
});

test('الساند بوكس على خادم الإنتاج: محجوبٌ إلا لشركاتٍ مسمّاة في NEARPAY_SANDBOX_TENANTS', async () => {
  const { sandboxBlocked } = await import('../services/cardPayment');
  const keys = ['NEARPAY_ENV', 'NODE_ENV', 'NEARPAY_SANDBOX_TENANTS'] as const;
  const prev = keys.map((k) => process.env[k]);
  try {
    process.env.NEARPAY_ENV = 'sandbox';
    process.env.NODE_ENV = 'production';
    delete process.env.NEARPAY_SANDBOX_TENANTS;
    assert.equal(sandboxBlocked('t1'), true);
    process.env.NEARPAY_SANDBOX_TENANTS = ' t0 , t1 ';
    assert.equal(sandboxBlocked('t1'), false);
    assert.equal(sandboxBlocked('t2'), true);
    process.env.NEARPAY_ENV = 'production';
    assert.equal(sandboxBlocked('t2'), false);
    process.env.NEARPAY_ENV = 'sandbox';
    process.env.NODE_ENV = 'development';
    assert.equal(sandboxBlocked('t2'), false);
  } finally {
    keys.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
  }
});

test('حرّاس نصّية: «review» بعد الخصم يمنع تحصيلاً ثانياً، والحسم إداريٌّ بصلاحية السندات، والتاجر للمالك وحده', async () => {
  const fs = await import('fs');
  const path = await import('path');
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const svc = read('services/cardPayment.ts');
  // الاختلاف بعد الخصم يصير review لا failed
  assert.match(svc, /data: \{ status: 'review', statusDetail: detail \}/);
  assert.doesNotMatch(svc, /data: \{ status: 'failed', statusDetail: detail \}/);
  // الإنشاء يرفض فاتورةً عليها عملية review، والجارية تعيد معرّفها
  assert.match(svc, /invoiceId: invoice\.id, status: 'review' \}/);
  assert.match(svc, /'CARD_PAY_REVIEW', held\.id\)/);
  assert.match(svc, /'CARD_PAY_IN_PROGRESS', f\.id\)/);
  // الساند بوكس محروس عند الإنشاء والتسليم
  assert.equal((svc.match(/sandboxBlocked\((params\.tenantId|row\.tenantId)\)/g) || []).length, 2);
  // التوقيع قبل استهلاك الرمز، وكذلك رفض الضبط الناقص (503 يُبقي الرمز صالحاً)
  assert.ok(svc.indexOf('const terminalJwt =') < svc.indexOf('data: { launchedAt: now }'));
  assert.ok(svc.indexOf("if (!nearpayJwtConfigured() || !gcp) throw") > -1);
  assert.ok(svc.indexOf("if (!nearpayJwtConfigured() || !gcp) throw") < svc.indexOf('data: { launchedAt: now }'));
  assert.doesNotMatch(svc, /jwt: string \| null/);
  const routes = read('routes/cardPayments.ts');
  assert.match(routes, /router\.post\('\/:id\/close', requireAdmin, receiptsGate,/);
  assert.match(routes, /router\.get\('\/', receiptsGate,/);
  assert.match(routes, /router\.post\('\/:id\/check', receiptsGate,/);
  const tenants = read('routes/tenants.ts');
  assert.match(tenants, /platformStaff && cardPayCur/);
  assert.match(tenants, /'STAFF_CARDPAY_FORBIDDEN'/);
  assert.match(tenants, /'NEARPAY_MERCHANT_UNKNOWN'/);
});

test('زرّ المندوب لا يظهر إلا والتحصيل ممكنٌ فعلاً: مفاتيح، وبيئةٌ غير محجوبة، وتطبيقٌ بوحدة الدفع (CARD_PAY_APP_READY)', async () => {
  const { cardPayUsable } = await import('../services/cardPayment');
  const keys = [
    'NEARPAY_ENV', 'NODE_ENV', 'NEARPAY_SANDBOX_TENANTS', 'NEARPAY_API_KEY', 'NEARPAY_API_BASE', 'CARD_PAY_APP_READY',
    'NEARPAY_JWT_PRIVATE_KEY', 'NEARPAY_CLIENT_UUID', 'NEARPAY_GCP_PROJECT_NUMBER',
  ] as const;
  const prev = keys.map((k) => process.env[k]);
  try {
    process.env.NEARPAY_API_KEY = 'test-key';
    // دخول الوحدة: مفتاح JWT ومعرّف العميل ورقم المشروع — تُفحص في آخر الاختبار
    process.env.NEARPAY_JWT_PRIVATE_KEY = 'test-private-key';
    process.env.NEARPAY_CLIENT_UUID = 'test-client';
    process.env.NEARPAY_GCP_PROJECT_NUMBER = '123456789012';
    process.env.NEARPAY_ENV = 'sandbox';
    process.env.NODE_ENV = 'production';
    delete process.env.NEARPAY_SANDBOX_TENANTS;
    delete process.env.CARD_PAY_APP_READY;
    assert.equal(cardPayUsable('t1'), false); // الحال اليوم: ساند بوكس محجوب ولا تطبيق
    process.env.NEARPAY_SANDBOX_TENANTS = 't1';
    assert.equal(cardPayUsable('t1'), false); // البيئة مسموحة والتطبيق بلا وحدة ⇒ لا زرّ يقود إلى «حدّث التطبيق»
    process.env.CARD_PAY_APP_READY = '1';
    assert.equal(cardPayUsable('t1'), true);
    assert.equal(cardPayUsable('t2'), false);
    process.env.NEARPAY_ENV = 'production';
    delete process.env.NEARPAY_API_BASE;
    assert.equal(cardPayUsable('t2'), false); // الإنتاج بلا عنوان API معلَن من NearPay ⇒ غير مهيأ
    process.env.NEARPAY_API_BASE = 'https://api.example.test/v1';
    assert.equal(cardPayUsable('t2'), true);
    // الوحدة لا تنفّذ OTP: بلا مفتاح JWT أو بلا رقم مشروع (أو برقمٍ غير رقمي) لا زرّ — كان كل نقرٍ يحرق رمزاً ويحجز الفاتورة
    delete process.env.NEARPAY_JWT_PRIVATE_KEY;
    assert.equal(cardPayUsable('t2'), false);
    process.env.NEARPAY_JWT_PRIVATE_KEY = 'test-private-key';
    delete process.env.NEARPAY_CLIENT_UUID;
    assert.equal(cardPayUsable('t2'), false);
    process.env.NEARPAY_CLIENT_UUID = 'test-client';
    delete process.env.NEARPAY_GCP_PROJECT_NUMBER;
    assert.equal(cardPayUsable('t2'), false);
    process.env.NEARPAY_GCP_PROJECT_NUMBER = 'my-project-id';
    assert.equal(cardPayUsable('t2'), false);
    process.env.NEARPAY_GCP_PROJECT_NUMBER = '123456789012';
    assert.equal(cardPayUsable('t2'), true);
    delete process.env.NEARPAY_API_KEY;
    assert.equal(cardPayUsable('t2'), false);
  } finally {
    keys.forEach((k, i) => { if (prev[i] === undefined) delete process.env[k]; else process.env[k] = prev[i]; });
  }
  const fs = await import('fs');
  const path = await import('path');
  const company = fs.readFileSync(path.join(__dirname, '..', 'routes/company.ts'), 'utf8');
  assert.match(company, /cardPayAvailable: tenant\?\.cardPayEnabled === true && cardPayUsable\(tid\)/);
});
