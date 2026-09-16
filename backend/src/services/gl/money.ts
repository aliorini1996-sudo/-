/**
 * مبالغ الدفاتر بوحدة «ملّي» BigInt (DESIGN.md §2.3).
 *
 * toMilli(x, decimals) = BigInt(Math.round(roundHalfUp(x, decimals) × 1000)) للأرقام،
 * وتحليل عشري حرفي للنصوص (حمولات الأحداث تخزّن المبالغ نصوصاً، §5.2) بالقاعدة نفسها:
 * نصف-لأعلى وبعيداً عن الصفر للسوالب. lib/money.ts يُستورد ولا يُعدَّل.
 */
import { roundHalfUp } from '../../lib/money';
import type { Milli } from './types';

/** منازل العملة المدعومة: 0..3 (وحدة الألف لا تحتمل أكثر). */
export const MAX_CURRENCY_DECIMALS = 3;

/** تكلفة الوحدة بأربع منازل (§2.3). */
export const COST_DECIMALS = 4;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_CURRENCY_DECIMALS) {
    throw new RangeError(`currencyDecimals غير مدعوم: ${decimals} (المسموح 0..3)`);
  }
}

/** أصغر وحدة عملة بالملّي: 10^(3−decimals) — 1000 للين، 10 للريال، 1 للدينار الكويتي. */
export function unitMilli(decimals: number): Milli {
  assertDecimals(decimals);
  return 10n ** BigInt(MAX_CURRENCY_DECIMALS - decimals);
}

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?$/;

function stringToMilli(raw: string, decimals: number): Milli {
  const s = raw.trim();
  const m = DECIMAL_RE.exec(s);
  if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) {
    throw new RangeError(`مبلغ نصي غير صالح: "${raw}"`);
  }
  const neg = m[1] === '-';
  const intPart = m[2] === '' ? '0' : m[2];
  const frac = m[3] ?? '';
  // نقرّب إلى منازل العملة نصف-لأعلى على القيمة المطلقة
  const kept = (frac + '000').slice(0, decimals);
  const nextDigit = frac.length > decimals ? frac.charCodeAt(decimals) - 48 : 0;
  let units = BigInt(intPart + kept); // بوحدة العملة الصغرى
  if (nextDigit >= 5) units += 1n;
  const milli = units * 10n ** BigInt(MAX_CURRENCY_DECIMALS - decimals);
  return neg ? -milli : milli;
}

/**
 * مبلغ عشري ⇐ ملّي مقرَّب إلى منازل العملة (نصف-لأعلى، السوالب بعيداً عن الصفر).
 * الناتج مضاعف دائماً لـunitMilli(decimals).
 */
export function toMilli(x: number | string, decimals: number): Milli {
  assertDecimals(decimals);
  if (typeof x === 'string') return stringToMilli(x, decimals);
  if (!Number.isFinite(x)) throw new RangeError(`مبلغ غير منتهٍ: ${x}`);
  const r = roundHalfUp(x, decimals);
  // r×1000 قد يحمل غبار طفو (0.29×1000=290.00000000000006) — Math.round يزيله
  return BigInt(Math.round(r * 1000));
}

/** ملّي ⇐ رقم عشري (للعرض والمقارنة مع المخزَّن فقط، لا للحساب). */
export function fromMilli(milli: Milli): number {
  return Number(milli) / 1000;
}

/** ملّي ⇐ نص عشري حرفي بعدد المنازل المطلوب (بلا فقد دقة) — للحمولات والتصدير. */
export function formatMilli(milli: Milli, decimals: number = MAX_CURRENCY_DECIMALS): string {
  assertDecimals(decimals);
  const rounded = roundMilli(milli, decimals);
  const neg = rounded < 0n;
  const abs = neg ? -rounded : rounded;
  const intPart = abs / 1000n;
  const fracAll = (abs % 1000n).toString().padStart(3, '0');
  const body = decimals === 0 ? intPart.toString() : `${intPart}.${fracAll.slice(0, decimals)}`;
  return neg ? `-${body}` : body;
}

/** تقريب ملّي إلى أصغر وحدة عملة (نصف-لأعلى، السوالب بعيداً عن الصفر). */
export function roundMilli(milli: Milli, decimals: number): Milli {
  const u = unitMilli(decimals);
  if (u === 1n) return milli;
  const neg = milli < 0n;
  const abs = neg ? -milli : milli;
  const q = abs / u;
  const r = abs % u;
  const out = (r * 2n >= u ? q + 1n : q) * u;
  return neg ? -out : out;
}

export function sumMilli(values: readonly Milli[]): Milli {
  let s = 0n;
  for (const v of values) s += v;
  return s;
}

export function absMilli(v: Milli): Milli {
  return v < 0n ? -v : v;
}

export function minMilli(a: Milli, b: Milli): Milli {
  return a < b ? a : b;
}

export function maxMilli(a: Milli, b: Milli): Milli {
  return a > b ? a : b;
}

/**
 * توزيع هدف على أوزان بطريقة أكبر الباقي بوحدة العملة الصغرى (§2.2، §2.3):
 * - Σ الناتج = target حرفياً، دائماً.
 * - كل حصة مضاعف لـunitMilli(decimals) (إلا بقية دون الوحدة إن لم يكن الهدف مضاعفاً — تذهب لأكبر وزن).
 * - الإشارة: هدف سالب يُوزَّع بقيمته المطلقة ثم تُقلب الحصص.
 * - الأوزان السالبة أو الصفرية تأخذ صفراً (كـdistributeAmount في lib/money.ts).
 * - كل الأوزان صفرية والهدف غير صفري ⇒ توزيع متساوٍ، فلا يضيع مبلغ.
 * - تعادل البواقي يُحسم بالفهرس الأصغر (حتمي).
 */
export function distributeMilli(target: Milli, weights: readonly Milli[], decimals: number = MAX_CURRENCY_DECIMALS): Milli[] {
  const u = unitMilli(decimals);
  const n = weights.length;
  if (n === 0) {
    if (target === 0n) return [];
    throw new RangeError('distributeMilli: لا أوزان لتوزيع مبلغ غير صفري');
  }
  if (target === 0n) return weights.map(() => 0n);

  const neg = target < 0n;
  const absTarget = neg ? -target : target;
  let safe = weights.map((w) => (w > 0n ? w : 0n));
  let sumW = sumMilli(safe);
  if (sumW === 0n) {
    safe = weights.map(() => 1n);
    sumW = BigInt(n);
  }

  const units = absTarget / u;
  const subUnit = absTarget % u;

  const shares: bigint[] = new Array(n);
  const rems: { i: number; rem: bigint }[] = [];
  let allocated = 0n;
  for (let i = 0; i < n; i++) {
    const p = units * safe[i];
    shares[i] = p / sumW;
    allocated += shares[i];
    if (safe[i] > 0n) rems.push({ i, rem: p % sumW });
  }
  let left = units - allocated; // < عدد الأوزان الموجبة
  rems.sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (let k = 0; left > 0n; k++, left--) shares[rems[k].i] += 1n;

  const out = shares.map((s) => s * u);
  if (subUnit !== 0n) {
    // بقية دون الوحدة: لأكبر وزن (الأصغر فهرساً عند التعادل)
    let best = 0;
    for (let i = 1; i < n; i++) if (safe[i] > safe[best]) best = i;
    out[best] += subUnit;
  }
  return neg ? out.map((v) => -v) : out;
}
