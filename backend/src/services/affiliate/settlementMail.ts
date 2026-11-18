/**
 * بريد دورة التسوية (v2 §5): ملخّص الدورة للمالك، و«تعذّر التحويل» للسفير.
 * بهوية بريد البرنامج نفسها (mail.ts)، وكلّ نصٍّ من مستخدمٍ أو من المالك مُهرَّب، والإرسال لا يُسقط أيّ عملية.
 * المنصّة لا تحرّك مالاً: الملخّص يقول «جُهّزت» لا «حُوِّلت» — التحويل يدويّ من المالك.
 */
import { sendMail } from '../mailer';
import { escapeHtml, frontendBase, riyadhDay } from './core';

function layout(title: string, paragraphs: string[], cta?: { label: string; url: string }): string {
  const body = paragraphs.map(p => `<p style="margin:0 0 12px">${p}</p>`).join('');
  const button = cta
    ? `<div style="text-align:center;margin:22px 0">
         <a href="${escapeHtml(cta.url)}" style="background:#E15A30;color:#fff;text-decoration:none;font-weight:700;padding:13px 30px;border-radius:12px;display:inline-block">${escapeHtml(cta.label)}</a>
       </div>`
    : '';
  return `<div dir="rtl" style="font-family:'Segoe UI',Tahoma,Arial,sans-serif;background:#FAF7F0;padding:24px">
    <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E9E1D3;border-radius:16px;overflow:hidden">
      <div style="background:#1F1A13;padding:18px 22px;color:#fff;font-size:18px;font-weight:700">سفير فيلد سيلز — ${escapeHtml(title)}</div>
      <div style="padding:22px;color:#3a342b;font-size:15px;line-height:1.8">${body}${button}</div>
    </div>
  </div>`;
}

function send(to: string, subject: string, html: string): void {
  sendMail({ to, subject, html })
    .then(ok => { if (!ok) console.error(`[affiliate] mail not sent: ${subject}`); })
    .catch(e => console.error('[affiliate] mail error:', (e as Error).message));
}

const sar = (h: number) => (h / 100).toFixed(2);

export interface SettlementSummaryMail {
  cycleKey: string;
  periodStart: Date;
  periodEnd: Date;
  payouts: Array<{ fullName: string; code: string; netHalalas: number; ibanLast4: string }>;
  totalHalalas: number;
  /** رصيدٌ بلغ الحدّ لكنّ ملف صاحبه ناقص (ومنه الآيبان: `no_iban` و`profile_incomplete`) — ينتظر اكتماله */
  waitingProfile: number;
  /** فشل آخر تحويلٍ لصاحبه ولم يحدّث بيانات استلامه */
  waitingIban: number;
  /** عمولاتٌ اعتمدها النظام منذ الدورة السابقة (settlement.ts: autoApprovedSinceLastCycle) */
  autoApproved: number;
}

/** ملخّص الدورة لصندوق المالك — العدد والمجموع وكلّ دفعة (حتى ٣٠ سطراً) */
export function mailOwnerSettlementSummary(s: SettlementSummaryMail): void {
  const to = process.env.MAIL_TO || 'info@fieldsa.net';
  const lines = s.payouts.slice(0, 30).map(p => `• ${escapeHtml(p.fullName)} (${escapeHtml(p.code)}) — <b>${sar(p.netHalalas)} ريال</b> إلى آيبانٍ ينتهي بـ${escapeHtml(p.ibanLast4)}`);
  const more = s.payouts.length > 30 ? [`و${s.payouts.length - 30} دفعةً أخرى في اللوحة.`] : [];
  send(to, `دورة تسوية السفراء ${s.cycleKey}: ${s.payouts.length} دفعة بمجموع ${sar(s.totalHalalas)} ريال`, layout('دورة التسوية', [
    `انتهت دورة التسوية (${riyadhDay(s.periodStart)} ← ${s.cycleKey}).`,
    s.payouts.length
      ? `جُهّزت <b>${s.payouts.length}</b> دفعة بمجموع <b>${sar(s.totalHalalas)} ريال</b> — حوّلها من البنك ثمّ سجّل كلّ دفعة «مدفوعة» أو «فشل التحويل».`
      : 'لم تُجهَّز دفعاتٌ في هذه الدورة.',
    ...lines,
    ...more,
    ...(s.autoApproved ? [`اعتُمدت تلقائياً ${s.autoApproved} عمولة انتهى حجزها منذ الدورة السابقة.`] : []),
    ...(s.waitingProfile ? [`${s.waitingProfile} سفيراً بلغ رصيدهم الحدّ وينتظرون إكمال ملفهم (النوع والآيبان والهوية).`] : []),
    ...(s.waitingIban ? [`${s.waitingIban} سفيراً فشل آخر تحويلٍ لهم وينتظرون تحديث الآيبان.`] : []),
  ], { label: 'لوحة السفراء', url: `${frontendBase()}/platform` }));
}

/** تعذّر التحويل — السبب الذي كتبه المالك مُهرَّب، والدعوة لتصحيح بيانات الاستلام */
export function mailPayoutFailed(to: string, name: string, p: { netHalalas: number; ibanLast4: string; reason: string }): void {
  send(to, 'تعذّر تحويل مستحقّاتك — سفير فيلد سيلز', layout('تعذّر التحويل', [
    `مرحباً ${escapeHtml(name)}،`,
    `تعذّر تحويل <b>${sar(p.netHalalas)} ريال</b> إلى الآيبان المنتهي بـ${escapeHtml(p.ibanLast4)}.`,
    `السبب: ${escapeHtml(p.reason)}`,
    'تحقّق من بيانات الآيبان واسم صاحب الحساب في ملفك وحدّثها — تدخل مستحقّاتك دورة التسوية التالية تلقائياً بعد التحديث.',
  ], { label: 'تحديث بيانات الاستلام', url: `${frontendBase()}/ax#profile` }));
}
