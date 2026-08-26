/**
 * الحارس الحتمي — يفحص كل ردّ قبل خروجه للعميل.
 *
 * المبدأ (من دراسة الشركات المؤتمتة، نمط Sierra و«البيروقراطية النافعة» في Project Vend):
 * قواعد العمل الصارمة تُفرَض حتمياً **خارج النموذج**، لا بالثقة في البرومبت.
 * النموذج يقترح، والحارس يقرر ما يخرج فعلاً.
 */

import { FORBIDDEN_PHRASES, allowedMoneyValues, OFFER } from './pricing';

export interface GuardVerdict {
  ok: boolean;
  /** الردّ بعد التنظيف (إن كان قابلاً للإصلاح) */
  text: string;
  /** أسباب الحجب/التعديل — تُسجَّل دائماً */
  violations: string[];
  /** هل يجب تصعيد المحادثة للمالك بدل الإرسال */
  forceEscalate: boolean;
}

const MAX_CHARS = 700;
const MAX_LINES = 8;

/** أرقام يجوز ظهورها وليست مالية: عدد المناديب، سنوات، نسب مئوية، أرقام هواتف */
function isLikelyNonMoney(match: string, context: string): boolean {
  const idx = context.indexOf(match);
  const after = context.slice(idx + match.length, idx + match.length + 12);
  const before = context.slice(Math.max(0, idx - 12), idx);
  if (/%|٪/.test(after)) return true;
  if (/مندوب|مناديب|يوم|أيام|شهر|ساعة|دقيقة|مرة|صفحة/.test(after)) return true;
  if (/\+?9\d{2}|رقم|جوال|واتس/.test(before)) return true;
  return false;
}

export function guardReply(raw: string): GuardVerdict {
  const violations: string[] = [];
  let text = (raw || '').trim();
  let forceEscalate = false;

  // 0) إزالة وسم التصعيد الداخلي قبل أي فحص (لا يخرج للعميل أبداً)
  if (/\[\[ESCALATE\]\]/i.test(text)) {
    forceEscalate = true;
    text = text.replace(/\[\[ESCALATE\]\]/gi, '').trim();
  }

  if (!text) {
    return { ok: false, text: '', violations: ['ردّ فارغ من النموذج'], forceEscalate: true };
  }

  // 1) العبارات المحظورة قطعياً — حجب كامل وتصعيد
  for (const { pattern, reason } of FORBIDDEN_PHRASES) {
    if (pattern.test(text)) {
      violations.push(`عبارة محظورة: ${reason}`);
      forceEscalate = true;
    }
  }

  // 2) أي رقم مالي خارج القائمة البيضاء = حجب وتصعيد
  const allowed = allowedMoneyValues();
  const moneyMatches = text.match(/\d[\d,\.]*/g) || [];
  for (const m of moneyMatches) {
    const n = Number(m.replace(/[,\.]/g, ''));
    if (!Number.isFinite(n) || n === 0) continue;
    if (isLikelyNonMoney(m, text)) continue;
    // أرقام صغيرة (1-60) قد تكون عدد مناديب أو أيام — نتجاهلها ما لم تكن مقترنة بريال
    const nearRiyal = new RegExp(`${m}\\s*(ريال|ر\\.?س|SAR)`, 'i').test(text);
    if (!nearRiyal && n <= 60) continue;
    if (!allowed.has(n)) {
      violations.push(`رقم مالي خارج القائمة البيضاء: ${n}`);
      forceEscalate = true;
    }
  }

  // 3) ذكر منافس (حارس الادّعاءات القائم في CI يمنعه على الموقع — نمنعه هنا أيضاً)
  if (/\b(رِيبزو|repzo|salesbuzz|سيلز\s*بز|odoo|أودو)\b/i.test(text)) {
    violations.push('ذكر منافس بالاسم');
    forceEscalate = true;
  }

  // 4) طلب بيانات حسّاسة
  if (/(رقم\s*البطاقة|CVV|كلمة\s*(ال)?مرور|الرقم\s*السري|رقم\s*الهوية)/i.test(text)) {
    violations.push('طلب بيانات حسّاسة');
    forceEscalate = true;
  }

  // 5) أسلوب: طول الرسالة وعدد الأسطر (يمنع «الرد الآلي الممل» الطويل)
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS).replace(/\s+\S*$/, '') + '…';
    violations.push('ردّ أطول من الحد — قُصّ');
  }
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length > MAX_LINES) {
    text = lines.slice(0, MAX_LINES).join('\n');
    violations.push('أسطر أكثر من الحد — قُصّت');
  }

  // 6) تنظيف تنسيق ماركداون (واتساب لا يدعمه ويبدو آلياً)
  text = text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^[-•]\s+/gm, '• ')
    .trim();

  // 7) العرض المنتهي: منع ذكره بعد تاريخ الانتهاء
  if (OFFER.active && new Date() > new Date(`${OFFER.endsAt}T23:59:59+03:00`)) {
    if (new RegExp(OFFER.name).test(text) || /عرض\s*سبتمبر/.test(text)) {
      violations.push('ذكر عرض منتهي الصلاحية');
      forceEscalate = true;
    }
  }

  return { ok: violations.length === 0, text, violations, forceEscalate };
}

/** رسالة آمنة تُرسل للعميل حين يُحجب الردّ ويُصعَّد */
export function safeFallback(dialect: 'gulf' | 'egypt' | 'levant' | 'maghreb' | 'msa'): string {
  switch (dialect) {
    case 'gulf':
      return 'سؤالك مهم وأبي أعطيك جواب دقيق 🙌 ثواني أحوّلك لصاحب المنصّة يردّ عليك بنفسه.';
    case 'egypt':
      return 'سؤالك مهم وعايز أديك إجابة مظبوطة 🙌 ثواني بحوّلك لصاحب المنصة يرد عليك بنفسه.';
    case 'levant':
      return 'سؤالك مهم وبدي جاوبك بدقة 🙌 لحظة بحوّلك لصاحب المنصّة يرد عليك بنفسه.';
    default:
      return 'سؤالك مهم وأريد أن أعطيك إجابة دقيقة 🙌 لحظة من فضلك، سأحوّلك لصاحب المنصّة ليرد عليك بنفسه.';
  }
}
