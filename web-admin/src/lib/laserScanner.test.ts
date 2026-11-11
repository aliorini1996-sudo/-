// «قارئ الباركود الليزر» (طلب المالك ١١ نوفمبر ٢٠٢٦): كاشف الدفعة السريعة، ولوحة المفاتيح العربية، ومطابقة الصنف.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { barcodeMatches, cleanScan, codeMatches, createWedgeDetector, findByScan, latinDigits, scanMatcher, wedgeChar, type WedgeKey } from './laserScanner';

/** دفعة قارئ: حروفٌ بمواضعها (code) ومفاتيحها كما تترجمها لغة النظام (key) كل gap جزءاً ثم Enter */
function burst(chars: { key: string; code: string; shiftKey?: boolean }[], t0 = 1000, gap = 8, enterGap = gap): WedgeKey[] {
  const out: WedgeKey[] = chars.map((c, i) => ({ ...c, timeStamp: t0 + i * gap }));
  out.push({ key: 'Enter', code: 'Enter', timeStamp: t0 + (chars.length - 1) * gap + enterGap });
  return out;
}
const digits = (s: string, layoutKey?: (d: string) => string) =>
  [...s].map(d => ({ key: layoutKey ? layoutKey(d) : d, code: `Digit${d}` }));
const run = (keys: WedgeKey[], det = createWedgeDetector()) => keys.map(k => det.key(k)).filter(r => r.kind === 'scan');
/** كل النتائج غير «none» بالترتيب */
const events = (keys: WedgeKey[], det = createWedgeDetector()) => keys.map(k => det.key(k)).filter(r => r.kind !== 'none');
/** حروفٌ بأزمنةٍ صريحة (لمحاكاة التوقّف وسط الدفعة) */
const timed = (s: string, t0: number, gap = 8) => [...s].map((d, i) => ({ key: d, code: `Digit${d}`, timeStamp: t0 + i * gap }));

test('دفعة القارئ: أرقام سريعة ثم Enter ⇒ باركود واحد، ويُوقف Enter الخاتم', () => {
  const r = run(burst(digits('6281000123456')));
  assert.deepEqual(r, [{ kind: 'scan', code: '6281000123456', consume: true }]);
});

test('كتابة الإنسان لا تُعدّ مسحاً: فواصل أطول من ٥٠ جزءاً، أو Enter بعد توقّف، أو أقصر من ٤', () => {
  assert.deepEqual(run(burst(digits('6281000123456'), 1000, 120)), [], 'إنسانٌ يكتب كل ١٢٠ جزءاً');
  assert.deepEqual(run(burst(digits('62810001'), 1000, 8, 400)), [], 'Enter بعد توقّف ⇒ ليس من القارئ');
  assert.deepEqual(run(burst(digits('123'))), [], 'أقصر من الحدّ الأدنى');
  // حروفٌ بطيئة ثم دفعةٌ سريعة: تبدأ الدفعة من أول حرفٍ سريع
  const det = createWedgeDetector();
  det.key({ key: '9', code: 'Digit9', timeStamp: 0 });
  assert.deepEqual(run(burst(digits('12345678'), 500), det), [{ kind: 'scan', code: '12345678', consume: true }]);
  // كاتبٌ سريع: أزواجٌ متداخلة (<٥٠) بينها فواصل قصيرة، ثم Enter سريع — لا مسح ولا «متعثّرة» (لا يُمحى ما كتب)
  const human: WedgeKey[] = [
    { key: 't', code: 'KeyT', timeStamp: 0 }, { key: 'h', code: 'KeyH', timeStamp: 30 },
    { key: 'e', code: 'KeyE', timeStamp: 110 }, { key: 'r', code: 'KeyR', timeStamp: 150 },
    { key: 'e', code: 'KeyE', timeStamp: 220 }, { key: 's', code: 'KeyS', timeStamp: 250 },
    { key: 'Enter', code: 'Enter', timeStamp: 310 },
  ];
  assert.deepEqual(events(human).filter(r => r.kind !== 'start'), []);
  // وكاتبٌ بفواصل ٦٠–١٤٠ ثم Enter سريع كذلك
  let at = 0;
  const steady = [...'123456789'].map((d, i) => ({ key: d, code: `Digit${d}`, timeStamp: (at += 60 + (i % 3) * 40) }));
  steady.push({ key: 'Enter', code: 'Enter', timeStamp: steady[steady.length - 1].timeStamp + 40 });
  assert.deepEqual(events(steady).filter(r => r.kind !== 'start'), []);
});

test('بداية الدفعة «start» مرّةً واحدة قبل أول حرف — لا مع Shift بعده ولا عند توقّفٍ وسطها', () => {
  const det = createWedgeDetector();
  const keys: WedgeKey[] = [
    { key: 'Shift', code: 'ShiftLeft', timeStamp: 0 }, { key: 'A', code: 'KeyA', shiftKey: true, timeStamp: 5 },
    { key: 'Shift', code: 'ShiftLeft', timeStamp: 12 }, { key: 'B', code: 'KeyB', shiftKey: true, timeStamp: 18 },
    ...timed('123', 90), { key: 'Enter', code: 'Enter', timeStamp: 120 },
  ];
  const r = keys.map(k => det.key(k).kind);
  assert.deepEqual(r.filter(k => k === 'start').length, 1);
  assert.equal(r[1], 'start', 'الحرف الأول لا Shift قبله');
  // دفعةٌ جديدة بعد سكونٍ أطول من النافذة تبدأ من جديد
  assert.equal(det.key({ key: '7', code: 'Digit7', timeStamp: 2000 }).kind, 'start');
  assert.equal(det.pending(), 1);
});

test('التكرار ومفاتيح التحكّم تُسقط الدفعة: الضغط الطويل على «1» ليس باركوداً', () => {
  const det = createWedgeDetector();
  const held: WedgeKey[] = Array.from({ length: 10 }, (_, i) => ({ key: '1', code: 'Digit1', repeat: i > 0, timeStamp: i * 30 }));
  held.push({ key: 'Enter', code: 'Enter', timeStamp: 300 });
  assert.deepEqual(run(held, det), []);
  const ctrl = burst(digits('12345678'));
  ctrl[3] = { ...ctrl[3], ctrlKey: true };
  assert.ok(!run(ctrl).some(r => r.kind === 'scan' && r.code === '12345678'), 'Ctrl وسط الدفعة يُسقط ما قبله');
  const bs = burst(digits('12345678'));
  bs.splice(4, 0, { key: 'Backspace', code: 'Backspace', timeStamp: bs[3].timeStamp + 1 });
  assert.ok(!run(bs).some(r => r.kind === 'scan' && r.code.includes('1234')), 'Backspace ليس حرفاً ويُسقط ما قبله');
});

test('لوحة المفاتيح العربية: Code128 «AB-12x» يصل بمواضعه صحيحاً لا «شلا»، وShift وحده لا يُسقط', () => {
  const arabic: Record<string, string> = { KeyA: 'ش', KeyB: 'لا', KeyX: 'ء', Minus: '-' };
  const keys = [
    { key: 'Shift', code: 'ShiftLeft' }, { key: arabic.KeyA, code: 'KeyA', shiftKey: true },
    { key: 'Shift', code: 'ShiftLeft' }, { key: arabic.KeyB, code: 'KeyB', shiftKey: true },
    { key: '-', code: 'Minus' }, { key: '1', code: 'Digit1' }, { key: '2', code: 'Digit2' }, { key: arabic.KeyX, code: 'KeyX' },
  ];
  assert.deepEqual(run(burst(keys)), [{ kind: 'scan', code: 'AB-12x', consume: true }]);
  // قارئٌ يرسل Shift تقريراً مستقلاً (بلوتوث ~٣٠ جزءاً للتقرير): الحرف الكبير بعد حرفه السابق بـ٦٠ — يبقى من الدفعة
  const sep = keys.map((k, i) => ({ ...k, timeStamp: 1000 + i * 30 }));
  sep.push({ key: 'Enter', code: 'Enter', timeStamp: 1000 + sep.length * 30 });
  assert.deepEqual(events(sep).filter(r => r.kind !== 'start'), [{ kind: 'scan', code: 'AB-12x', consume: true }]);
  // لكن ضغط Shift الطويل (تكرار) لا يُبقي دفعةً حيّة بعد أن سكنت
  const held: WedgeKey[] = [...timed('1234', 0),
    ...[60, 100, 140, 180].map(t => ({ key: 'Shift', code: 'ShiftLeft', repeat: true, timeStamp: t })),
    { key: 'Enter', code: 'Enter', timeStamp: 200 }];
  assert.deepEqual(events(held).filter(r => r.kind !== 'start'), []);
});

test('الفرنسية AZERTY: موضع Digit1 بلا Shift يكتب «&» لكن القارئ قصد «1»', () => {
  const azerty: Record<string, string> = { '1': '&', '2': 'é', '3': '"', '4': "'", '5': '(' };
  assert.deepEqual(run(burst(digits('12345', d => azerty[d]))), [{ kind: 'scan', code: '12345', consume: true }]);
});

test('قارئٌ مضبوطٌ على تخطيط الجهاز (AZERTY/العربية ١٠٢): Shift+موضع الرقم يكتب الرقم — يُقرأ رقماً لا «!@#»', () => {
  const shifted = digits('6281000123456').map(k => ({ ...k, shiftKey: true }));
  assert.deepEqual(run(burst(shifted)), [{ kind: 'scan', code: '6281000123456', consume: true }]);
  // ومع Shift تقريراً مستقلاً قبل كل رقم
  const withShift = shifted.flatMap(k => [{ key: 'Shift', code: 'ShiftLeft', shiftKey: true }, k]);
  assert.deepEqual(run(burst(withShift, 1000, 6)), [{ kind: 'scan', code: '6281000123456', consume: true }]);
  // أرقامٌ هندية من موضع الرقم (تخطيطٌ عربي)
  assert.equal(wedgeChar({ key: '٦', code: 'Digit6' }), '6');
  assert.equal(wedgeChar({ key: '۳', code: 'Digit3', shiftKey: true }), '3');
  assert.deepEqual(run(burst([...'٦٢٨١٠٠٠١'].map((k, i) => ({ key: k, code: `Digit${'62810001'[i]}` })))), [{ kind: 'scan', code: '62810001', consume: true }]);
  // والقارئ بتخطيط US يبقى كما هو: Shift+Digit1 على جهاز US «!»، وDigit1 على AZERTY «&» ⇒ «1»
  assert.equal(wedgeChar({ key: '!', code: 'Digit1', shiftKey: true }), '!');
  assert.equal(wedgeChar({ key: '&', code: 'Digit1' }), '1');
  assert.equal(wedgeChar({ key: 'à', code: 'Digit0' }), '0');
});

test('بلا موضع (أحداث أندرويد المحقونة): الحرف نفسه، والأرقام الهندية لاتينية، والفارسية كذلك', () => {
  assert.equal(wedgeChar({ key: '٧', code: '' }), '7');
  assert.equal(wedgeChar({ key: '۹', code: 'Unidentified' }), '9');
  assert.equal(wedgeChar({ key: 'Z', code: '' }), 'Z');
  assert.equal(wedgeChar({ key: 'Backspace', code: '' }), null);
  assert.equal(wedgeChar({ key: '1', code: 'Numpad1' }), '1');
  assert.equal(wedgeChar({ key: '/', code: 'Slash' }), '/');
  assert.equal(latinDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
  const det = createWedgeDetector();
  const keys = [...'٦٢٨١٠٠٠١'].map(k => ({ key: k, code: '' }));
  assert.deepEqual(run(burst(keys), det), [{ kind: 'scan', code: '62810001', consume: true }]);
});

test('Tab خاتمٌ كـEnter، وقارئٌ بلا لاحقة يُقبل بعد سكونٍ إن بلغ ٨ حروف', () => {
  const tab = burst(digits('12345678'));
  tab[tab.length - 1] = { key: 'Tab', code: 'Tab', timeStamp: tab[tab.length - 1].timeStamp };
  assert.deepEqual(run(tab), [{ kind: 'scan', code: '12345678', consume: true }]);
  const det = createWedgeDetector();
  digits('6281000123456').forEach((c, i) => det.key({ ...c, timeStamp: 100 + i * 8 }));
  assert.deepEqual(det.idle(100 + 12 * 8 + 10), { kind: 'none' }, 'ما زال داخل الفاصل');
  assert.deepEqual(det.idle(100 + 12 * 8 + 80), { kind: 'none' }, 'ولا قبل انقضاء نافذة Enter');
  assert.equal(det.pending(), 13);
  assert.deepEqual(det.idle(100 + 12 * 8 + 160), { kind: 'scan', code: '6281000123456', consume: false });
  const short = createWedgeDetector();
  digits('12345').forEach((c, i) => short.key({ ...c, timeStamp: i * 8 }));
  assert.deepEqual(short.idle(500), { kind: 'none' }, 'خمسة حروف بلا Enter: قد تكون كتابة سريعة — لا تُقبل');
  assert.equal(short.pending(), 0, 'والسكون يُسقطها');
});

test('السكون لا يسبق Enter المتأخّر: لاحقةٌ بعد ١٣٠ جزءاً تختم المسح ويُوقف Enter (لا يتسرّب)', () => {
  const det = createWedgeDetector();
  timed('6281000123456', 0).forEach(k => det.key(k));
  const lastT = 12 * 8;
  assert.deepEqual(det.idle(lastT + 120), { kind: 'none' });
  assert.deepEqual(det.key({ key: 'Enter', code: 'Enter', timeStamp: lastT + 130 }), { kind: 'scan', code: '6281000123456', consume: true });
  // وكود داخلي قصير (٥ حروف) بـEnter متأخّر كذلك — لا يُسقطه السكون قبل خاتمه
  const s = createWedgeDetector();
  timed('10234', 0).forEach(k => s.key(k));
  assert.deepEqual(s.idle(32 + 120), { kind: 'none' });
  assert.deepEqual(s.key({ key: 'Enter', code: 'Enter', timeStamp: 32 + 125 }), { kind: 'scan', code: '10234', consume: true });
});

test('السكون بلا Enter لا يقبل نصّاً بمسافات (مُوسِّع نصوص يحقن مفاتيحه سريعاً) — يبقى حيث كُتب', () => {
  const det = createWedgeDetector();
  const text = [...'Delivered to x'].map((c, i) => ({ key: c, code: c === ' ' ? 'Space' : `Key${c.toUpperCase()}`, shiftKey: c === 'D', timeStamp: i * 3 }));
  text.forEach(k => det.key(k));
  assert.deepEqual(det.idle(500), { kind: 'none' });
  assert.equal(det.pending(), 0);
});

test('التعثّر وسط الدفعة يُغلق لا يُفتح: لا يُقبل الذيل مسحاً، وخاتمه «broken» يُوقف', () => {
  const tail = (stall: number) => {
    // «broken» يحتاج جرياً سريعاً بطول idleMinLength (٨): رأسٌ من ٨ ثم توقّف ثم الذيل
    const head = timed('62810001', 0);
    const rest = timed('2345678', 7 * 8 + stall);
    return [...head, ...rest, { key: 'Enter', code: 'Enter', timeStamp: rest[rest.length - 1].timeStamp + 8 }];
  };
  for (const stall of [70, 120]) {
    const det = createWedgeDetector();
    const r = events(tail(stall), det);
    assert.deepEqual(r, [{ kind: 'start' }, { kind: 'broken' }], `توقّف ${stall} جزءاً: لا مسح ولا بداية جديدة من الذيل`);
    assert.equal(det.pending(), 0);
  }
  // بلا Enter: السكون لا يقبلها أبداً بل «broken»
  const det = createWedgeDetector();
  const keys = tail(70).slice(0, -1);
  keys.forEach(k => det.key(k));
  assert.deepEqual(det.idle(keys[keys.length - 1].timeStamp + 200), { kind: 'broken' });
  // توقّفٌ بعد أول حرفٍ من القارئ كذلك (لا «مفتاح إنسانٍ» يقبل الذيل)
  const one = [...timed('6', 0), ...timed('281000123456', 80)];
  one.push({ key: 'Enter', code: 'Enter', timeStamp: one[one.length - 1].timeStamp + 8 });
  assert.deepEqual(events(one).filter(r => r.kind !== 'start'), [{ kind: 'broken' }]);
  // Enter متأخّر عن دفعةٍ متعثّرة (داخل النافذة) «broken» كذلك
  const late = tail(70);
  late[late.length - 1] = { ...late[late.length - 1], timeStamp: late[late.length - 1].timeStamp + 120 };
  assert.deepEqual(events(late).filter(r => r.kind !== 'start'), [{ kind: 'broken' }]);
  // جريان قصيران (٣+٣) بلا جريٍ يشبه القارئ: لا مسح ولا «broken» (قد يكون إنساناً)
  const short = [...timed('123', 0), ...timed('456', 16 + 80)];
  short.push({ key: 'Enter', code: 'Enter', timeStamp: short[short.length - 1].timeStamp + 8 });
  assert.deepEqual(events(short).filter(r => r.kind !== 'start'), []);
  // EAN-13 انقسم ٦+٧ بلا جريٍ بطول ٨: لا مسح للذيل ولا «broken» — آمنٌ (لا صنف خاطئ) ويُعاد المسح
  const split = [...timed('628100', 0), ...timed('0123456', 5 * 8 + 70)];
  split.push({ key: 'Enter', code: 'Enter', timeStamp: split[split.length - 1].timeStamp + 8 });
  assert.deepEqual(events(split).filter(r => r.kind !== 'start'), []);
  // الكاتب السريع: «pepsi» بتوقّفٍ ثم تداخل أصابع (٤ مفاتيح متلاحقة) ثم Enter بعد ١٢٠ — لا يُمحى ما كتبه ولا يُبتلع Enter
  const at = [0, 120, 155, 185, 225];
  const pepsi: WedgeKey[] = [...'pepsi'].map((c, i) => ({ key: c, code: `Key${c.toUpperCase()}`, timeStamp: at[i] }));
  assert.deepEqual(events([...pepsi, { key: 'Enter', code: 'Enter', timeStamp: 345 }]).filter(r => r.kind !== 'start'), []);
  const idlePepsi = createWedgeDetector();
  pepsi.forEach(k => idlePepsi.key(k));
  assert.deepEqual(idlePepsi.idle(600), { kind: 'none' });
});

test('الخاتم الثاني (CR+LF، Tab+Enter، Ctrl+J) يُبتلع بعد المسح — وEnter الإنسان بعده بقليلٍ لا يُمسّ', () => {
  const det = createWedgeDetector();
  const keys = burst(digits('6281000123456'));
  const endT = keys[keys.length - 1].timeStamp;
  assert.deepEqual(events([...keys, { key: 'Enter', code: 'NumpadEnter', timeStamp: endT + 5 }], det).filter(r => r.kind !== 'start'),
    [{ kind: 'scan', code: '6281000123456', consume: true }, { kind: 'swallow' }]);
  assert.deepEqual(det.key({ key: 'Enter', code: 'Enter', timeStamp: endT + 500 }), { kind: 'none' }, 'Enter بعد نصف ثانية للصفحة');
  // Tab ثم Enter
  const tabEnter = burst(digits('12345678'));
  const tEnd = tabEnter[tabEnter.length - 1].timeStamp;
  tabEnter[tabEnter.length - 1] = { key: 'Tab', code: 'Tab', timeStamp: tEnd };
  tabEnter.push({ key: 'Enter', code: 'Enter', timeStamp: tEnd + 4 });
  assert.deepEqual(events(tabEnter).map(r => r.kind), ['start', 'scan', 'swallow']);
  // LF بصيغة Ctrl+J (Zebra)
  const zebra = [...burst(digits('12345678')), { key: 'Control', code: 'ControlLeft', ctrlKey: true, timeStamp: 70 + 1000 }, { key: 'j', code: 'KeyJ', ctrlKey: true, timeStamp: 72 + 1000 }];
  assert.deepEqual(events(zebra).map(r => r.kind), ['start', 'scan', 'swallow']);
  // وبعد دفعةٍ متعثّرة كذلك، وبعد قبولٍ بالسكون
  const broken = [...timed('62810001', 0), ...timed('23456789', 7 * 8 + 110)];
  const bEnd = broken[broken.length - 1].timeStamp;
  broken.push({ key: 'Enter', code: 'Enter', timeStamp: bEnd + 8 }, { key: 'Enter', code: 'Enter', timeStamp: bEnd + 12 });
  assert.deepEqual(events(broken).map(r => r.kind), ['start', 'broken', 'swallow']);
  const idle = createWedgeDetector();
  timed('6281000123456', 0).forEach(k => idle.key(k));
  assert.equal(idle.idle(300).kind, 'scan');
  assert.deepEqual(idle.key({ key: 'Enter', code: 'Enter', timeStamp: 310 }), { kind: 'swallow' });
});

test('المطابقة: الباركود تامّاً، والأصفار البادئة (UPC-A/EAN-13)، والكود الداخلي احتياطاً بلا حساسية حالة', () => {
  const p = { barcode: '012345678905', code: 'SKU-7' };
  assert.ok(barcodeMatches(p, '012345678905'));
  assert.ok(barcodeMatches(p, '0012345678905'), 'EAN-13 بصفرٍ بادئ لـUPC-A');
  assert.ok(barcodeMatches({ barcode: 6281000123456 }, '6281000123456'), 'باركود مخزّن رقماً');
  assert.ok(barcodeMatches(p, ' ٠١٢٣٤٥٦٧٨٩٠٥ '), 'أرقام هندية ومسافات');
  assert.ok(!barcodeMatches(p, '12345678905x'));
  assert.ok(!barcodeMatches({ barcode: null }, '123'));
  assert.ok(codeMatches(p, 'sku-7'));
  assert.ok(!codeMatches(p, 'SKU-8'));
  assert.equal(cleanScan('\u0002 6281\r\n'), '6281');
  // الباركود أولاً على القائمة كلها: باركود صنفٍ يساوي كود صنفٍ آخر ⇒ صاحب الباركود
  const list = [{ id: 'a', barcode: '999', code: '1111' }, { id: 'b', barcode: '1111', code: 'B' }];
  assert.equal(findByScan(list, '1111')?.id, 'b');
  assert.equal(findByScan(list, 'b')?.id, 'b', 'الكود احتياطاً');
  assert.equal(findByScan(list, 'zzz'), undefined);
  assert.equal(findByScan(null, '1'), undefined);
});

test('scanMatcher: الطبقة (باركود/كود) تُقرَّر على الأصناف كلها ثم يُبحث بها في القائمة المصفّاة', () => {
  // صاحب الباركود «1111» خارج أصناف الفريق، وصنف الفريق كوده «1111»: لا يخطف الكودُ المسحَ
  const owner = { id: 'b', barcode: '1111', code: 'B' };
  const teamA = { id: 'a', barcode: '999', code: '1111' };
  const all = [teamA, owner];
  const team = [teamA];
  const m = scanMatcher(all, '1111');
  assert.equal(m, barcodeMatches);
  assert.equal(team.find(x => m(x, '1111')), undefined, 'لا صنف فريقٍ بالباركود ⇒ يُقال سبب صاحبه لا يُضاف غيره');
  assert.equal(all.find(x => m(x, '1111'))?.id, 'b');
  // لا باركود يطابق أحداً ⇒ الكود الداخلي (بلا حساسية حالة)
  const byCode = scanMatcher(all, 'b');
  assert.equal(byCode, codeMatches);
  assert.equal(all.find(x => byCode(x, 'b'))?.id, 'b');
  assert.equal(scanMatcher(null, '1'), codeMatches);
  // أصفار UPC-A/EAN-13 البادئة تُعدّ تطابق باركود
  assert.equal(scanMatcher([{ barcode: '012345678905' }], '0012345678905'), barcodeMatches);
});

test('الوصل: الشاشات الثلاث تستمع للقارئ وتطابق بالدالة المشتركة', () => {
  const src = (...p: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...p), 'utf8');
  const rep = src('rep', 'RepApp.tsx');
  assert.match(rep, /useLaserScanner\(/);
  assert.match(rep, /scanMatcher\(/);
  assert.match(src('components', 'forms', 'InvoiceModal.tsx'), /useLaserScanner\(/);
  assert.match(src('m', 'MInvoiceCreate.tsx'), /useLaserScanner\(/);
  // الحقل المخصّص للقارئ لا يفتح لوحة مفاتيح الجوال، ويُستثنى من المستمع العام (لا إضافة مرّتين)
  const field = src('rep', 'LaserScanField.tsx');
  assert.match(field, /inputMode="none"/);
  assert.match(field, /data-laser-field=""/);
  // والمستمع العام لا يلتقط ولا يعيد في الحقل المخصّص ولا في النصّ الحرّ ولا فيما وُسم data-laser-ignore
  const hook = src('lib', 'useLaserScanner.ts');
  assert.match(hook, /'\[data-laser-field\]'/);
  assert.match(hook, /'\[data-laser-ignore\]'/);
  assert.match(hook, /instanceof HTMLTextAreaElement/);
});
