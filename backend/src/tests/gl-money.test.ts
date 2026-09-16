// M1 — مبالغ الدفاتر بالملّي (DESIGN.md §2.3): toMilli نصف-لأعلى، وdistributeMilli مجموعه = الهدف حرفياً.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  toMilli, fromMilli, formatMilli, roundMilli, unitMilli, distributeMilli, sumMilli,
  absMilli, minMilli, maxMilli,
} from '../services/gl/money';
import { roundHalfUp } from '../lib/money';

// مولّد حتمي (mulberry32) — آلاف الحالات نفسها في كل تشغيل
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('unitMilli: 1000 للين (0)، 10 للريال (2)، 1 للدينار (3)، ويرفض غير المدعوم', () => {
  assert.equal(unitMilli(0), 1000n);
  assert.equal(unitMilli(2), 10n);
  assert.equal(unitMilli(3), 1n);
  assert.throws(() => unitMilli(4), RangeError);
  assert.throws(() => unitMilli(-1), RangeError);
  assert.throws(() => unitMilli(1.5), RangeError);
});

test('toMilli من رقم: نصف-لأعلى كـroundHalfUp وبلا غبار طفو', () => {
  assert.equal(toMilli(1.005, 2), 1010n);
  assert.equal(toMilli(2.135, 2), 2140n);
  assert.equal(toMilli(0.1 + 0.2, 2), 300n);
  assert.equal(toMilli(0.29, 2), 290n);
  assert.equal(toMilli(6.7 * 0.15, 2), 1010n);
  assert.equal(toMilli(-1.005, 2), -1010n); // السوالب بعيداً عن الصفر
  assert.equal(toMilli(1.0005, 3), 1001n);
  assert.equal(toMilli(2.5, 0), 3000n);
  assert.equal(toMilli(-2.5, 0), -3000n);
  assert.equal(toMilli(41, 2), 41000n);
  assert.equal(toMilli(35.65, 2), 35650n);
  assert.equal(toMilli(0, 2), 0n);
  assert.throws(() => toMilli(Number.NaN, 2), RangeError);
  assert.throws(() => toMilli(Infinity, 2), RangeError);
});

test('toMilli من نص (حمولات الأحداث): تحليل عشري حرفي بالقاعدة نفسها', () => {
  assert.equal(toMilli('1.005', 2), 1010n);
  assert.equal(toMilli('1.004999', 2), 1000n);
  assert.equal(toMilli('-1.005', 2), -1010n);
  assert.equal(toMilli('  12  ', 2), 12000n);
  assert.equal(toMilli('.5', 0), 1000n);
  assert.equal(toMilli('5.', 3), 5000n);
  assert.equal(toMilli('+7.1234', 3), 7123n);
  assert.equal(toMilli('7.1235', 3), 7124n);
  assert.equal(toMilli('123456789012.345', 3), 123456789012345n); // خارج دقة الطفو
  assert.equal(toMilli('-0.004', 2), 0n);
  for (const bad of ['', '.', 'abc', '1e3', '1,000', '--1', '1.2.3']) {
    assert.throws(() => toMilli(bad, 2), RangeError, bad);
  }
});

test('toMilli: الرقم والنص متطابقان عبر آلاف القيم العشوائية', () => {
  const r = rng(20260916);
  for (let i = 0; i < 5000; i++) {
    const dec = [0, 2, 3][i % 3];
    const x = Math.round((r() - 0.5) * 2e9) / 1e4; // حتى 4 منازل، موجب وسالب
    const s = x.toString();
    if (/e/i.test(s)) continue;
    assert.equal(toMilli(x, dec), toMilli(s, dec), `${s} @${dec}`);
    assert.equal(toMilli(x, dec) % unitMilli(dec), 0n);
    assert.equal(fromMilli(toMilli(x, dec)), roundHalfUp(x, dec));
  }
});

test('formatMilli وroundMilli وfromMilli', () => {
  assert.equal(formatMilli(41000n, 2), '41.00');
  assert.equal(formatMilli(-1010n, 2), '-1.01');
  assert.equal(formatMilli(5n, 2), '0.01'); // 0.005 ⇒ نصف-لأعلى
  assert.equal(formatMilli(-5n, 2), '-0.01');
  assert.equal(formatMilli(1234567n, 3), '1234.567');
  assert.equal(formatMilli(2500n, 0), '3');
  assert.equal(formatMilli(4n, 2), '0.00');
  assert.equal(roundMilli(1234n, 2), 1230n);
  assert.equal(roundMilli(1235n, 2), 1240n);
  assert.equal(roundMilli(-1235n, 2), -1240n);
  assert.equal(roundMilli(1499n, 0), 1000n);
  assert.equal(roundMilli(1500n, 0), 2000n);
  assert.equal(roundMilli(7n, 3), 7n);
  assert.equal(fromMilli(35650n), 35.65);
  assert.equal(sumMilli([1n, 2n, -3n]), 0n);
  assert.equal(absMilli(-5n), 5n);
  assert.equal(minMilli(3n, -2n), -2n);
  assert.equal(maxMilli(3n, -2n), 3n);
});

test('distributeMilli: متجهات ثابتة', () => {
  // 0.55 على عشرة أوزان متساوية — لا يضيع شيء
  const w = Array(10).fill(1090n);
  const s = distributeMilli(550n, w, 2);
  assert.equal(sumMilli(s), 550n);
  assert.ok(s.every((v) => v % 10n === 0n));
  assert.deepEqual(s.slice(0, 5), [60n, 60n, 60n, 60n, 60n]); // التعادل للفهرس الأصغر
  assert.deepEqual(s.slice(5), [50n, 50n, 50n, 50n, 50n]);
  // 100 على ثلاثة متساوية بمنزلتين
  assert.deepEqual(distributeMilli(100000n, [1n, 1n, 1n], 2), [33340n, 33330n, 33330n]);
  // بمنزلة صفرية
  assert.deepEqual(distributeMilli(10000n, [1n, 1n, 1n], 0), [4000n, 3000n, 3000n]);
  // بثلاث منازل
  assert.deepEqual(distributeMilli(10n, [1n, 1n, 1n], 3), [4n, 3n, 3n]);
  // الإشارة: الهدف السالب يُقلب
  assert.deepEqual(distributeMilli(-100000n, [1n, 1n, 1n], 2), [-33340n, -33330n, -33330n]);
  // الأوزان السالبة والصفرية تأخذ صفراً
  assert.deepEqual(distributeMilli(1000n, [0n, -5n, 3n], 2), [0n, 0n, 1000n]);
  // كل الأوزان صفرية ⇒ توزيع متساوٍ لا ضياع
  assert.deepEqual(distributeMilli(1000n, [0n, 0n], 2), [500n, 500n]);
  assert.deepEqual(distributeMilli(1010n, [0n, -1n], 2), [510n, 500n]);
  // هدف صفري
  assert.deepEqual(distributeMilli(0n, [3n, 7n], 2), [0n, 0n]);
  assert.deepEqual(distributeMilli(0n, [], 2), []);
  assert.throws(() => distributeMilli(10n, [], 2), RangeError);
  // هدف ليس مضاعفاً للوحدة: البقية دون الوحدة لأكبر وزن، والمجموع حرفي
  const odd = distributeMilli(1005n, [1n, 3n], 2);
  assert.equal(sumMilli(odd), 1005n);
  assert.deepEqual(odd, [250n, 755n]);
  // §2.2: بند 0٪ مخصوم 100٪ بجوار بند 15٪ — الخصم كله على البند الأول
  assert.deepEqual(distributeMilli(100000n, [100000n, 0n], 2), [100000n, 0n]);
});

test('distributeMilli: مجموع التوزيع = الهدف عبر آلاف الحالات المولدة حتمياً (منازل 0 و2 و3)', () => {
  const r = rng(424242);
  let cases = 0;
  for (const dec of [0, 2, 3]) {
    const u = unitMilli(dec);
    for (let i = 0; i < 3000; i++) {
      const n = 1 + Math.floor(r() * 12);
      const weights: bigint[] = [];
      for (let k = 0; k < n; k++) {
        const kind = r();
        if (kind < 0.1) weights.push(0n);
        else if (kind < 0.15) weights.push(-BigInt(Math.floor(r() * 1e6)));
        else if (kind < 0.25) weights.push(BigInt(Math.floor(r() * 10) + 1)); // أوزان صغيرة جداً
        else weights.push(BigInt(Math.floor(r() * 1e12)));
      }
      const units = BigInt(Math.floor(r() * 1e9)) * (r() < 0.3 ? -1n : 1n);
      const target = units * u;
      const shares = distributeMilli(target, weights, dec);
      assert.equal(shares.length, n);
      assert.equal(sumMilli(shares), target, `dec=${dec} i=${i}`);
      for (const s of shares) {
        assert.equal(s % u, 0n, 'كل حصة مضاعف لوحدة العملة');
        if (target > 0n) assert.ok(s >= 0n);
        if (target < 0n) assert.ok(s <= 0n);
      }
      const anyPositive = weights.some((w) => w > 0n);
      if (anyPositive) {
        const sumW = weights.reduce((a, w) => a + (w > 0n ? w : 0n), 0n);
        const absT = target < 0n ? -target : target;
        weights.forEach((w, k) => {
          const abs = shares[k] < 0n ? -shares[k] : shares[k];
          if (w <= 0n) assert.equal(abs, 0n, 'الوزن غير الموجب يأخذ صفراً');
          else {
            // الحصة لا تبتعد عن النسبة الدقيقة بأكثر من وحدة واحدة
            const exact = (absT * w) / sumW;
            assert.ok(abs - exact <= u && exact - abs <= u, 'انحراف أكبر من وحدة');
          }
        });
      }
      cases++;
    }
  }
  assert.equal(cases, 9000);
});

test('distributeMilli: حتمي — نفس المدخلات ⇒ نفس المخرجات', () => {
  const w = [3n, 3n, 3n, 1n];
  assert.deepEqual(distributeMilli(1000n, w, 2), distributeMilli(1000n, w, 2));
});

test('money.ts صرف: لا prisma ولا I/O', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'gl', 'money.ts'), 'utf8');
  assert.doesNotMatch(src, /prisma|@prisma\/client|from ['"]fs['"]|node:fs/);
});
