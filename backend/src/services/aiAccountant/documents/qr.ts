/**
 * «المحاسب الذكي AI» — مستندات المحادثة: قراءة رمز QR الزكوي (D4: المصدر الآلي الوحيد للحقائق — لا ذكاء اصطناعي).
 *
 * الجهاز يفكّ صورة الـQR بـ@zxing/browser ويرسل نصّه base64 في الترويسة X-Zatca-Qr؛ هنا يُتحقَّق منه بـdecodeQr الصارمة
 * (compliance/zatca/qr.ts — تُستورد ولا تُعدَّل: طول ≤ 2048 بزمن ثابت، base64 قانوني، تسلسل وسوم 1–5 أو 1–8/9، UTF-8 صالح).
 * الوسوم: 1 اسم البائع · 2 رقمه الضريبي · 3 الختم الزمني ⇐ تاريخ ميلادي بمنطقة الشركة · 4 الإجمالي شامل الضريبة · 5 الضريبة.
 * الختم الزمني:
 *   - بمنطقة صريحة (Z أو ±hh:mm، شائع في QR المرحلة الأولى) ⇒ اللحظة ثم تاريخها بتوقيت الشركة (localDate).
 *   - بلا منطقة (المرحلة الثانية: IssueDate + 'T' + IssueTime كما كتبها البائع) ⇒ جزء التاريخ كما هو — تاريخ الفاتورة نفسه.
 *   - سنة 13xx–15xx ⇒ هجري (hijri) يُحفظ ليمنعه فحص HIJRI_DATE.
 * أي خلل (فكّ، مبلغ غير صالح، ضريبة ≥ الإجمالي) ⇒ {ok:false} فيُعامل المستند بلا QR (QR_INVALID تنبيه + إدخال يدوي).
 * ملف صِرف بلا قاعدة ولا شبكة؛ نصّ الـQR بيانات لا تعليمات، وكل نص منه يُنظَّف ويُقصّ.
 */
import { decodeQr, MAX_QR_DECODE_LENGTH } from '../../../compliance/zatca/qr';
import { localDate } from '../../gl/dates';
import type { Milli } from '../../gl/types';
import { cleanDocText, isHijriYear, latinDigits, normalizeVatNo, parseDocAmount } from './normalize';

export interface ZatcaQrFacts {
  sellerName: string | null;
  /** أرقام لاتينية كما في الوسم 2 ('' إن لم يكن أرقاماً) */
  vatNo: string | null;
  /** YYYY-MM-DD ميلادي بمنطقة الشركة، أو الهجري كما هو (hijri)، أو null إن لم يُفهم الختم */
  issueDate: string | null;
  hijri: boolean;
  totalMilli: Milli;
  vatMilli: Milli;
  /** الوسم 9 حاضر ⇒ فاتورة مبسّطة (المرحلة الثانية) */
  simplified: boolean;
  phase: 1 | 2;
}

export type ZatcaQrResult = { ok: true; qr: ZatcaQrFacts } | { ok: false; reason: string };

/**
 * نصّ الترويسة ⇐ base64 مرشّح: يُقصّ، ويُفكّ ترميز URL إن وصل مرمَّزاً (%2B…)، وتُزال فواصل الأسطر التي يضيفها بعض
 * القرّاء — والباقي تحكم فيه decodeQr (القانونية والطول).
 */
export function cleanQrHeader(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '' || s.length > MAX_QR_DECODE_LENGTH * 3) return null;
  if (/%[0-9A-Fa-f]{2}/.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
  }
  s = s.replace(/[\r\n\t ]+/g, '');
  return s === '' ? null : s;
}

const TS_ZONED_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s?(Z|[+-]\d{2}:?\d{2})$/i;
const TS_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/;

/** الختم الزمني (الوسم 3) ⇐ تاريخ الفاتورة بمنطقة الشركة */
export function qrTimestampDate(ts: string, tz: string): { date: string | null; hijri: boolean } {
  const s = latinDigits(ts).trim();
  const zoned = TS_ZONED_RE.exec(s);
  const local = zoned ? null : TS_LOCAL_RE.exec(s);
  const y = Number((zoned ?? local)?.[1] ?? NaN);
  if (!Number.isInteger(y)) return { date: null, hijri: false };
  if (isHijriYear(y)) {
    const mm = (zoned ?? local)!;
    return { date: `${mm[1]}-${mm[2]}-${mm[3]}`, hijri: true };
  }
  try {
    if (zoned) {
      const zone = zoned[7].toUpperCase() === 'Z' ? 'Z' : zoned[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
      const iso = `${zoned[1]}-${zoned[2]}-${zoned[3]}T${zoned[4]}:${zoned[5]}:${zoned[6] ?? '00'}${zone}`;
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return { date: null, hijri: false };
      return { date: localDate(d, tz), hijri: false };
    }
    const date = `${local![1]}-${local![2]}-${local![3]}`;
    // تاريخ تقويمي صالح (لا 2026-02-30)
    const d = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return { date: null, hijri: false };
    return { date, hijri: false };
  } catch {
    return { date: null, hijri: false };
  }
}

/**
 * يقرأ رمز QR الزكوي (base64) ويعيد حقائقه، أو {ok:false} لأي خلل — لا يرمي أبداً.
 * decimals: منازل عملة المبالغ (الإجمالي والضريبة نصّان عشريان في الوسمين 4 و5 ⇐ ملّي بتقريب نصف-لأعلى).
 */
export function readZatcaQr(raw: unknown, opts: { tz: string; decimals: number }): ZatcaQrResult {
  const b64 = cleanQrHeader(raw);
  if (!b64) return { ok: false, reason: 'EMPTY' };
  let decoded: ReturnType<typeof decodeQr>;
  try {
    decoded = decodeQr(b64);
  } catch {
    return { ok: false, reason: 'DECODE' };
  }
  const total = parseDocAmount(decoded.totalWithVat, opts.decimals);
  const vat = parseDocAmount(decoded.vatTotal, opts.decimals, { allowZero: true });
  if (total === null) return { ok: false, reason: 'TOTAL' };
  if (vat === null || vat >= total) return { ok: false, reason: 'VAT' };
  const { date, hijri } = qrTimestampDate(decoded.timestamp, opts.tz);
  return {
    ok: true,
    qr: {
      sellerName: cleanDocText(decoded.sellerName),
      vatNo: normalizeVatNo(decoded.vat),
      issueDate: date,
      hijri,
      totalMilli: total,
      vatMilli: vat,
      simplified: decoded.certSignatureDer !== undefined,
      phase: decoded.invoiceHash !== undefined ? 2 : 1,
    },
  };
}
