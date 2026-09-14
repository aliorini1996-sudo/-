// ============================================================================
// ZATCA المرحلة الثانية (Z1) — حساب عشري دقيق بلا فاصلة عائمة في مسار الـXML
// ----------------------------------------------------------------------------
// لماذا: قواعد الهيئة (BR-CO-10..17 · BR-KSA-51 · BR-KSA-EN16931-11) مساواةٌ حرفية
// بلا هامش سماح. عدد عائم واحد (0.1+0.2) يكفي لإسقاط فاتورة، لذا كل مبلغ يُكتب في
// الـXML يمرّ من هنا بأعداد صحيحة (BigInt) فقط.
//
// ═══ اصطلاحات المقياس (scale) ═══
//   • Dec = { units, scale } وقيمته units ÷ 10^scale — عدد عشري دقيق بلا تقريب.
//   • المبالغ النقدية: هللات صحيحة (bigint) = مقياس 2 (MONEY_SCALE). 1.05 ريال = 105n.
//   • الكمية والسعر والنِّسب تبقى Dec بمقياسها الطبيعي (كما أُدخلت) ولا تُقرَّب أبداً
//     قبل الضرب — «قرّب النتائج النهائية لا الوسيطة» [XML §10].
//   • التقريب نصف-لأعلى بعيداً عن الصفر (123.4949→123.49 و123.4950→123.50)، وهو
//     نفس اتجاه lib/money.ts:roundHalfUp للقيم الموجبة والسالبة.
//   • تحويل number→Dec يأخذ **أقصر تمثيل عشري يُعيد نفس العدد** (String(n)) — أي ما
//     كتبه المستخدم فعلاً (0.1 تبقى 0.1 لا 0.1000000000000000055…).
//
// هذه الوحدة نقيّة: بلا Prisma ولا شبكة ولا تبعيات.
// ============================================================================

/** مقياس المبالغ النقدية في الـXML (هللتان). */
export const MONEY_SCALE = 2;

/** عدد عشري دقيق: القيمة = units / 10^scale. */
export interface Dec {
  readonly units: bigint;
  readonly scale: number;
}

const POW10_CACHE: bigint[] = [];

/** 10^n بعدد صحيح كبير (n ≥ 0). */
export function pow10(n: number): bigint {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`pow10: أسّ غير صالح ${n}`);
  if (n < 64) {
    let v = POW10_CACHE[n];
    if (v === undefined) {
      v = 10n ** BigInt(n);
      POW10_CACHE[n] = v;
    }
    return v;
  }
  return 10n ** BigInt(n);
}

/**
 * قسمة صحيحة مقرّبة نصف-لأعلى بعيداً عن الصفر: round(num / den).
 * المقام يجب أن يكون موجباً.
 */
export function divRoundHalfUp(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('divRoundHalfUp: المقام يجب أن يكون موجباً');
  const neg = num < 0n;
  const a = neg ? -num : num;
  // floor((2a + den) / (2den)) = round-half-up للقيمة المطلقة
  const q = (2n * a + den) / (2n * den);
  return neg ? -q : q;
}

/** قسمة صحيحة بالأرضية (للقيم غير السالبة). */
export function divFloor(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new RangeError('divFloor: المقام يجب أن يكون موجباً');
  const q = num / den;
  return num < 0n && q * den !== num ? q - 1n : q;
}

/** يحذف الأصفار الزائدة يمين الفاصلة (1.500 → 1.5) — شكل قانوني للمقارنة والمفاتيح. */
export function decNormalize(d: Dec): Dec {
  let { units, scale } = d;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale };
}

const DEC_STRING = /^(-?)(\d+)(?:\.(\d+))?$/;

/** يحلّل نصاً عشرياً صارماً مثل "123.45" أو "-0.5" (بلا أسّ ولا مسافات). */
export function decFromString(s: string): Dec {
  const m = DEC_STRING.exec(s);
  if (!m) throw new RangeError(`قيمة عشرية غير صالحة: "${s}"`);
  const frac = m[3] ?? '';
  const units = BigInt(m[2] + frac);
  return { units: m[1] === '-' ? -units : units, scale: frac.length };
}

/**
 * يحوّل number إلى Dec دقيق عبر أقصر تمثيل عشري يُعيد نفس العدد (String(n)).
 * يقبل الصيغة الأسّية (1e-7 و1.5e+21). يرفض NaN وInfinity.
 */
export function decFromNumber(n: number): Dec {
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new RangeError(`عدد غير صالح: ${n}`);
  const s = String(n); // أقصر تمثيل ذهاباً وإياباً (ECMA-262 Number::toString)
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(s);
  if (!m) throw new RangeError(`تمثيل عددي غير متوقع: ${s}`);
  const frac = m[3] ?? '';
  let units = BigInt(m[2] + frac);
  let scale = frac.length;
  const exp = m[4] ? parseInt(m[4], 10) : 0;
  if (exp > 0) {
    if (exp >= scale) {
      units *= pow10(exp - scale);
      scale = 0;
    } else {
      scale -= exp;
    }
  } else if (exp < 0) {
    scale += -exp;
  }
  if (m[1] === '-') units = -units;
  return decNormalize({ units, scale });
}

/** يعيد units بمقياس هدف مع تقريب نصف-لأعلى عند تقليص الخانات. */
export function roundDecToScale(d: Dec, scale: number): bigint {
  if (d.scale <= scale) return d.units * pow10(scale - d.scale);
  return divRoundHalfUp(d.units, pow10(d.scale - scale));
}

/** r2(قيمة) بالهللات. */
export function toHalalas(d: Dec): bigint {
  return roundDecToScale(d, MONEY_SCALE);
}

/** ضرب دقيق لعددين عشريين. */
export function mulDec(a: Dec, b: Dec): Dec {
  return { units: a.units * b.units, scale: a.scale + b.scale };
}

/** مقارنة دقيقة: -1 | 0 | 1. */
export function decCompare(a: Dec, b: Dec): -1 | 0 | 1 {
  const s = Math.max(a.scale, b.scale);
  const x = a.units * pow10(s - a.scale);
  const y = b.units * pow10(s - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** يحوّل units بمقياس ثابت إلى نصّ بعدد خانات ثابت: (12345n, 2) → "123.45". */
export function formatUnits(units: bigint, scale: number): string {
  const neg = units < 0n;
  const digits = (neg ? -units : units).toString();
  if (scale === 0) return (neg ? '-' : '') + digits;
  const padded = digits.padStart(scale + 1, '0');
  const int = padded.slice(0, padded.length - scale);
  const frac = padded.slice(padded.length - scale);
  return `${neg ? '-' : ''}${int}.${frac}`;
}

/** مبلغ بالهللات → نصّ بخانتين دائماً ("0.00"). */
export function formatHalalas(h: bigint): string {
  return formatUnits(h, MONEY_SCALE);
}

/**
 * يكتب Dec بقيمته الدقيقة وبحدٍّ أدنى من الخانات (تُكمَّل بأصفار) بلا أي تقريب:
 * (33, min 6) → "33.000000"، (12.3456, min 2) → "12.3456".
 */
export function formatDec(d: Dec, minScale: number): string {
  const n = decNormalize(d);
  const scale = Math.max(n.scale, minScale);
  return formatUnits(n.units * pow10(scale - n.scale), scale);
}

const AMOUNT_STRING = /^-?\d+\.\d{2}$/;

/** يحلّل مبلغ XML صارم بخانتين ("123.45") إلى هللات. */
export function parseAmount(s: string): bigint {
  if (typeof s !== 'string' || !AMOUNT_STRING.test(s)) throw new RangeError(`مبلغ غير صالح (خانتان مطلوبتان): "${s}"`);
  return decFromString(s).units;
}

/** هل النص مبلغ صالح بخانتين بالضبط؟ (BR-DEC-*) */
export function isAmountString(s: unknown): s is string {
  return typeof s === 'string' && AMOUNT_STRING.test(s);
}
