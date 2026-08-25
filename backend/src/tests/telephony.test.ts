import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toE164, samePhone } from '../lib/phone';
import { parseCallWebhook, parseChannels } from '../services/telephony';

/**
 * حرّاس تكامل هاتف:
 * ١) تطبيع الأرقام — أكثر مصدر أخطاء متوقَّع: بحث المزوّد مطابقة تامّة، فاختلاف
 *    التطبيع يعني عميلاً مكرّراً ومكالمة بلا صاحب.
 * ٢) محلّلا الويبهوك والقنوات المتسامحان — الصيغة غير منشورة علنياً، وأي تضييق
 *    مستقبلي يجب أن يكسر اختباراً لا الإنتاج.
 */

test('toE164: كل صيغ الرقم السعودي تنتج +966501234567', () => {
  const expect = '+966501234567';
  for (const raw of ['0501234567', '+966501234567', '00966501234567', '966 50 123 4567', '٠٥٠١٢٣٤٥٦٧', '050-123-4567', '501234567']) {
    assert.equal(toE164(raw), expect, `فشل التطبيع لـ: ${raw}`);
  }
});

test('toE164: الأرقام الدولية تمرّ بمفتاحها', () => {
  assert.equal(toE164('+201001234567'), '+201001234567');
  assert.equal(toE164('00201001234567'), '+201001234567');
});

test('toE164: المدخل غير المفهوم يعيد null لا رقماً مغلوطاً', () => {
  assert.equal(toE164(''), null);
  assert.equal(toE164('abc'), null);
  assert.equal(toE164('123'), null);
  assert.equal(toE164(null), null);
});

test('samePhone: يطابق عبر الصيغ المختلفة', () => {
  assert.ok(samePhone('0501234567', '+966 50 123 4567'));
  assert.ok(!samePhone('0501234567', '0501234568'));
});

test('parseChannels: يقرأ {data:[...]} بأسماء حقول متعددة ويطبع الرقم', () => {
  const body = { data: [
    { id: 'ch_1', phoneNumber: '0501234567', name: 'الرياض ١', type: 'voice' },
    { channelId: 'ch_2', number: '+966555555555', title: 'واتساب', channelType: 'whatsapp' },
    { id: 'ch_3' }, // قناة بلا رقم — تمرّ بلا e164 ولا تكسر
  ] };
  const chans = parseChannels(body);
  assert.equal(chans.length, 3);
  assert.equal(chans[0].e164, '+966501234567');
  assert.equal(chans[0].kind, 'voice');
  assert.equal(chans[1].id, 'ch_2');
  assert.equal(chans[1].kind, 'whatsapp');
  assert.equal(chans[2].e164, null);
});

test('parseChannels: شكل مجهول يعيد فارغة لا يرمي', () => {
  assert.deepEqual(parseChannels(null), []);
  assert.deepEqual(parseChannels({ weird: 1 }), []);
});

test('parseCallWebhook: حمولة نموذجية تُقرأ كاملة', () => {
  const ev = parseCallWebhook({
    call: {
      id: 'call_99', direction: 'inbound', from: '0501234567', to: '+966112223344',
      startedAt: '2026-08-25T10:00:00Z', duration: 95,
      recordingUrl: 'https://rec/x', summary: 'عميل يسأل عن فاتورة',
      channelId: 'ch_1',
    },
  });
  assert.ok(ev);
  assert.equal(ev!.providerCallId, 'call_99');
  assert.equal(ev!.direction, 'IN');
  assert.equal(ev!.fromE164, '+966501234567');
  assert.equal(ev!.durationSec, 95);
  assert.equal(ev!.channelProviderId, 'ch_1');
  assert.equal(ev!.aiSummary, 'عميل يسأل عن فاتورة');
});

test('parseCallWebhook: الصادر والفائتة يُميَّزان', () => {
  assert.equal(parseCallWebhook({ id: 'a', direction: 'outbound', from: '05', to: '05' })!.direction, 'OUT');
  assert.equal(parseCallWebhook({ id: 'b', direction: 'inbound', answered: false, from: '05', to: '05' })!.direction, 'MISSED');
});

test('parseCallWebhook: بلا معرف مكالمة يعيد null (لا سجل بلا حصانة تكرار)', () => {
  assert.equal(parseCallWebhook({ direction: 'inbound' }), null);
});
