// ZATCA المرحلة الثانية (Z5.7) — الإسقاط النقيّ لشاشة متابعة المستندات: الدلاء والعدّادات والتنقية وأسماء الملفّات.
// لا قاعدة بيانات ولا شبكة. المطلوب إثباته:
//   ١) الدلاء **نسخة حرفية** من دلاء العميل (web-admin/src/lib/zatca/docQueue.ts) — عدّادُ الخادم لا يخالف قائمته.
//   ٢) العدّادات تحفظ المجموع وتنقل المتأخّر من دلوه المرآويّ (الحجب أوّلاً) كما يفعل العميل.
//   ٣) التنقية تمحو الأسرار **قبل** القصّ، وتُسقط كلّ حقلٍ خارج القائمة البيضاء.
//   ٤) اسم ملفّ الـXML لا يخرج من رقم فاتورةٍ يكتبه المستخدم إلى ترويسةٍ بلا تعقيم.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BUCKET_MIRRORS, MAX_MESSAGE_CHARS, NON_FINAL_DOCUMENT_STATUSES, QUEUE_BUCKETS, apiLogLineOf, bucketOfMirror,
  contentDispositionOf, countsFromMirrors, diagnosticsOf, emptyCounts, headlineMessage, isQueueFilter, isXmlVariant,
  mirrorMessagesOf, scrubPanelText, xmlFileNameOf,
} from '../compliance/zatca/docsPanel';
import { FINAL_DOCUMENT_STATUSES, INVOICE_MIRROR_STATUSES } from '../compliance/zatca/status';

// ═══ الدلاء ═══

test('الدلاء نسخة حرفية من منطق العميل (docQueue.zatcaQueueBucket)', () => {
  // النسخة المرجعية — منقولة من web-admin/src/lib/zatca/docQueue.ts
  const reference = (mirror: string | null, overdue: boolean): string => {
    if (mirror === 'rejected' || mirror === 'withdrawn') return 'rejected';
    if (overdue) return 'overdue';
    if (mirror === 'report_blocked' || mirror === 'clearance_blocked' || mirror === 'cleared_no_xml') return 'blocked';
    if (mirror === 'reported' || mirror === 'reported_warn' || mirror === 'cleared' || mirror === 'cleared_warn') return 'done';
    return 'pending';
  };
  for (const mirror of [...INVOICE_MIRROR_STATUSES, null, 'غريبة']) {
    for (const overdue of [false, true]) {
      assert.equal(bucketOfMirror(mirror, overdue), reference(mirror as string | null, overdue), `${mirror}/${overdue}`);
    }
  }
});

test('المرفوضة والمسحوبة لا تصير «متأخّرة» مهما فاتت المهلة — الأولوية للمرآة', () => {
  assert.equal(bucketOfMirror('rejected', true), 'rejected');
  assert.equal(bucketOfMirror('withdrawn', true), 'rejected');
  assert.equal(bucketOfMirror('clearance_pending', true), 'overdue');
});

test('BUCKET_MIRRORS تغطّي كل مرايا المرحلة الثانية مرّة واحدة (عدا overdue المحسوبة)', () => {
  const seen = new Map<string, string>();
  for (const b of QUEUE_BUCKETS) {
    if (b === 'overdue') continue;
    for (const m of BUCKET_MIRRORS[b]) {
      assert.equal(seen.has(m), false, `${m} في دلوين: ${seen.get(m)} و${b}`);
      seen.set(m, b);
      assert.equal(bucketOfMirror(m, false), b, `${m} يجب أن يقع في ${b}`);
    }
  }
  for (const m of INVOICE_MIRROR_STATUSES) assert.ok(seen.has(m), `${m} خارج كل الدلاء`);
});

test('مرايا overdue غير نهائية فقط — مستندٌ حُسم لا يتأخّر', () => {
  for (const m of BUCKET_MIRRORS.overdue) {
    assert.ok(['signed', 'clearance_pending', 'report_blocked', 'clearance_blocked'].includes(m), m);
  }
  for (const s of NON_FINAL_DOCUMENT_STATUSES) {
    assert.equal((FINAL_DOCUMENT_STATUSES as readonly string[]).includes(s), false, `${s} نهائية ولا يجوز عدّها متأخّرة`);
  }
  assert.ok(NON_FINAL_DOCUMENT_STATUSES.includes('SUBMITTING'));
  assert.ok(NON_FINAL_DOCUMENT_STATUSES.includes('AUTH_BLOCKED'));
});

test('isQueueFilter وisXmlVariant يرفضان ما ليس في القائمة', () => {
  assert.equal(isQueueFilter('all'), true);
  assert.equal(isQueueFilter('overdue'), true);
  assert.equal(isQueueFilter('DROP TABLE'), false);
  assert.equal(isQueueFilter(undefined), false);
  assert.equal(isXmlVariant('signed'), true);
  assert.equal(isXmlVariant('cleared'), true);
  assert.equal(isXmlVariant('raw'), false);
});

// ═══ العدّادات ═══

test('العدّادات: المجموع محفوظ والمتأخّر يُخصم من المحجوب ثم المعلّق', () => {
  const counts = countsFromMirrors([
    { mirror: 'clearance_pending', count: 5 },
    { mirror: 'reported', count: 10 },
    { mirror: 'rejected', count: 2 },
    { mirror: 'report_blocked', count: 3 },
  ], 4);
  assert.deepEqual(counts, { overdue: 4, blocked: 0, pending: 4, rejected: 2, done: 10 });
  const total = QUEUE_BUCKETS.reduce((n, b) => n + counts[b], 0);
  assert.equal(total, 20, 'المجموع لا يتغيّر بنقل المتأخّر');
});

test('العدّادات: صفر متأخّرين لا ينقل شيئاً، وصفوف فارغة تعطي أصفاراً', () => {
  assert.deepEqual(countsFromMirrors([{ mirror: 'signed', count: 7 }], 0), { ...emptyCounts(), pending: 7 });
  assert.deepEqual(countsFromMirrors([], 0), emptyCounts());
});

test('العدّادات: متأخّرٌ أكثر مما في الدلاء يُعرض ولا يُخفى (سباق بين استعلامين)', () => {
  const c = countsFromMirrors([{ mirror: 'signed', count: 1 }], 5);
  assert.equal(c.overdue, 5);
  assert.equal(c.pending, 0);
});

test('العدّادات تتجاهل الأعداد غير الصالحة ولا ترمي', () => {
  const c = countsFromMirrors([{ mirror: 'signed', count: Number.NaN }, { mirror: 'cleared', count: -3 }], -1);
  assert.deepEqual(c, emptyCounts());
});

// ═══ التنقية ═══

test('التنقية تمحو Basic وbase64 الطويلة وBearer وOTP', () => {
  const b64 = 'A'.repeat(70);
  assert.match(scrubPanelText('auth failed Basic YWxhZGRpbjpvcGVu')!, /Basic \[REDACTED\]/);
  assert.equal(scrubPanelText(`token=${b64}`)!.includes(b64), false);
  assert.equal(scrubPanelText('Bearer abcdefghijklmnop')!.includes('abcdefghijklmnop'), false);
  const otp = scrubPanelText('otp: 483920 expired')!;
  assert.equal(otp.includes('483920'), false);
  assert.match(otp, /\[REDACTED\]/);
});

test('التنقية تمحو قبل أن تقصّ — سرٌّ في آخر نصٍّ طويل لا يفلت بالقصّ', () => {
  const secret = 'B'.repeat(70);
  const long = `${'ت'.repeat(MAX_MESSAGE_CHARS - 5)} ${secret}`;
  const out = scrubPanelText(long)!;
  assert.equal(out.includes('BBBBBBBB'), false, 'تسلسل base64 الطويل خرج');
});

test('التنقية تزيل محارف التحكّم وتقصّ بعلامة، وترفض ما ليس نصّاً', () => {
  assert.equal(scrubPanelText('a\u0000\u0007b'), 'a b');
  assert.equal(scrubPanelText('   '), null);
  assert.equal(scrubPanelText(42), null);
  assert.equal(scrubPanelText(null), null);
  assert.equal(scrubPanelText({ message: 'x' }), null);
  const cut = scrubPanelText('ي'.repeat(400))!;
  assert.equal(cut.length, MAX_MESSAGE_CHARS + 1);
  assert.ok(cut.endsWith('…'));
});

test('رسائل المستند: قائمة حقولٍ بيضاء — ما خرج عنها لا يخرج أبداً', () => {
  const d = diagnosticsOf({
    at: '2026-09-23T10:00:00.000Z', outcome: 'REJECTED', local: null, reason: null,
    validationStatus: 'ERROR', reportingStatus: null, clearanceStatus: null, truncated: false,
    errors: [{
      type: 'ERROR', code: 'BR-KSA-01', category: 'قواعد', message: 'الرقم الضريبي غير صحيح',
      secret: 'super-secret-value', binarySecurityToken: 'C'.repeat(80), rawBody: '<xml/>',
    }],
    warnings: [{ type: 'WARNING', code: 'W-1', category: null, message: 'تحذير' }],
  });
  assert.equal(d.errors.length, 1);
  assert.deepEqual(Object.keys(d.errors[0]).sort(), ['category', 'code', 'kind', 'text']);
  const json = JSON.stringify(d);
  assert.equal(json.includes('super-secret-value'), false);
  assert.equal(json.includes('CCCC'), false);
  assert.equal(json.includes('rawBody'), false);
  assert.equal(d.errors[0].kind, 'error');
  assert.equal(d.warnings[0].kind, 'warning');
  assert.equal(d.validationStatus, 'ERROR');
});

test('رسائل المستند: الأخطاء تأكل الحصّة قبل التحذيرات', () => {
  const errors = Array.from({ length: 5 }, (_, i) => ({ type: 'ERROR', code: `E${i}`, message: `خطأ ${i}` }));
  const warnings = Array.from({ length: 5 }, (_, i) => ({ type: 'WARNING', code: `W${i}`, message: `تحذير ${i}` }));
  const d = diagnosticsOf({ errors, warnings }, 3);
  assert.equal(d.errors.length, 3);
  assert.equal(d.warnings.length, 0);
  assert.equal(headlineMessage(d)?.code, 'E0');
});

test('التشخيص من مدخلٍ تالف لا يرمي ويعيد الفارغ', () => {
  for (const bad of [null, undefined, 'نص', 42, [], { errors: 'x', warnings: 7 }]) {
    const d = diagnosticsOf(bad);
    assert.deepEqual(d.errors, []);
    assert.deepEqual(d.warnings, []);
  }
  assert.equal(headlineMessage(diagnosticsOf(null)), null);
});

test('رسائل المرآة تُقرأ من نصّ JSON ومن مصفوفة، والتالف يعطي []', () => {
  const raw = JSON.stringify([{ type: 'ERROR', code: 'X', message: 'رسالة', category: null }]);
  assert.equal(mirrorMessagesOf(raw)[0].code, 'X');
  assert.equal(mirrorMessagesOf([{ type: 'WARNING', message: 'تحذير' }])[0].kind, 'warning');
  assert.deepEqual(mirrorMessagesOf('{not json'), []);
  assert.deepEqual(mirrorMessagesOf(null), []);
});

test('سطر أثر الطلبات لا يحمل جسم الردّ ولا سرّاً', () => {
  const line = apiLogLineOf({
    createdAt: new Date('2026-09-23T10:00:00.000Z'), endpoint: 'clearance', httpStatus: 401,
    outcome: 'AUTH', durationMs: 120, errorText: 'unauthorized Basic YWxhZGRpbjpvcGVu',
    // حقولٌ لا تُقرأ أصلاً — لو قُرئت لظهرت
    response: { clearedInvoice: 'D'.repeat(90) },
  } as never);
  assert.deepEqual(Object.keys(line).sort(), ['at', 'durationMs', 'endpoint', 'error', 'httpStatus', 'outcome']);
  assert.match(line.error!, /Basic \[REDACTED\]/);
  assert.equal(line.httpStatus, 401);
  assert.equal(apiLogLineOf({ createdAt: new Date(), httpStatus: 'x', durationMs: null } as never).httpStatus, null);
});

// ═══ اسم الملف ═══

test('اسم ملف الـXML يعقّم رقم الفاتورة ويحمل النسخة ورقم المحاولة', () => {
  assert.equal(xmlFileNameOf({ number: 'INV-2026-001', attemptNo: 1, variant: 'signed' }), 'INV-2026-001-signed.xml');
  assert.equal(xmlFileNameOf({ number: 'INV/2026 001', attemptNo: 2, variant: 'cleared' }), 'INV-2026-001-a2-cleared.xml');
  assert.equal(xmlFileNameOf({ number: 'فاتورة', attemptNo: 1, variant: 'signed' }), 'invoice-signed.xml');
  assert.equal(xmlFileNameOf({ number: null, attemptNo: null, variant: 'signed' }), 'invoice-signed.xml');
  // حقن ترويسة: لا سطر جديد ولا علامة اقتباس تخرج
  const evil = xmlFileNameOf({ number: 'a"\r\nSet-Cookie: x=1', attemptNo: 1, variant: 'signed' });
  assert.equal(/[\r\n"]/.test(evil), false);
});

test('Content-Disposition يعقّم ASCII ويحمل الاسم الكامل في filename*', () => {
  const h = contentDispositionOf('فاتورة-١-signed.xml');
  assert.equal(/[\r\n]/.test(h), false);
  assert.match(h, /^attachment; filename="[\x20-\x7E]*"; filename\*=UTF-8''/);
  assert.match(h, /%D9%81/);
  assert.equal(contentDispositionOf('a"b.xml').includes('"a_b.xml"'), true);
});
