import { memo, type ReactNode } from 'react';
import {
  Activity, ArrowLeft, ArrowLeftRight, BadgeCheck, Ban, BookOpenCheck, BookX, Bot, CreditCard, FileImage, FileText, FileX, History,
  Hourglass, Import, Link2, MapPin, MapPinned, MessageSquareText, PhoneCall, Receipt, Repeat, RotateCcw, Route, Scale, ShieldAlert,
  ShieldQuestion, ShoppingCart, Tag, Undo2, UserCheck, UserCog, UserMinus, UserPlus, UserRound, UserX, Wallet, type LucideIcon,
} from 'lucide-react';
import { useTr } from '../../i18n/strings';
import { activeLocale, formatCurrency, formatDateTime, formatNumber, formatTime } from '../../utils/format';
import { docKindLabel } from '../../lib/customerDocs';
import {
  actionLabel, actorDisplay, actorKindLabel, allocationsOf, amountOf, amountSign, changesOf, detailsOf, formatDuration, groupByDay,
  isBalanceEffect, itemsOf, noteOf, refNoOf, statusBadgeOf, unverifiedBadgeOf, type ActivityCategory, type ActivityDetail, type ActivityItem,
} from '../../lib/customerActivity';

/**
 * «سجلّ العميل» الثابت — قائمة العرض وحدها (طلب المالك ٢٦ نوفمبر ٢٠٢٦). للقراءة فقط: لا زرّ تعديلٍ ولا حذفٍ لأي بند،
 * والخادم لا يقبل تعديله أصلاً (حارس قاعدة البيانات). البنود مجمّعةٌ بأيامها، ولكل قسمٍ أيقونته ولونه، والمال لا يظهر
 * حين يُطفأ النظام المحاسبي (accountingOn)، ولا ذكر للضريبة تحت «إزالة الضريبة» (taxOff).
 * البيانات والتحميل في ActivityTimeline.tsx؛ وrenderExtra لإضافاتٍ تعرفها الشاشة المضيفة (صور الزيارة في أرشيف اللوحة).
 * القائمة والبطاقة محفوظتان (memo): مؤقّت الزيارة في تطبيق المندوب يعيد رسم الملفّ كل ثانية، فلا تُعاد مئات البطاقات معه.
 */

const CATEGORY_STYLE: Record<ActivityCategory, { icon: LucideIcon; cls: string }> = {
  visits: { icon: MapPin, cls: 'text-[#E15A30] bg-[#FBEBE2]' },
  sales: { icon: FileText, cls: 'text-[#1F1A13] bg-[#EFE9DD]' },
  returns: { icon: RotateCcw, cls: 'text-[#B4471F] bg-[#F8E3D9]' },
  money: { icon: Wallet, cls: 'text-[#1E7A52] bg-[#EAF4EE]' },
  docs: { icon: FileImage, cls: 'text-[#8A6D1F] bg-[#F7EFD9]' },
  edits: { icon: UserCog, cls: 'text-[#4B4336] bg-[#F1EBDF]' },
  other: { icon: Activity, cls: 'text-[#6E6557] bg-[#F4EEE3]' },
};

/** أيقونةٌ أدقّ من أيقونة القسم لبعض الإجراءات */
const ACTION_ICON: Record<string, LucideIcon> = {
  CUSTOMER_CREATED: UserPlus, CUSTOMER_DELETED: UserX, CUSTOMER_IMPORTED: Import, CUSTOMER_LOCATION_SET: MapPinned,
  CUSTOMER_ASSIGNED: UserCheck, CUSTOMER_UNASSIGNED: UserMinus,
  CUSTOMER_PRICE_SET: Tag, CUSTOMER_PRICE_REMOVED: Tag, CUSTOMER_PRICE_LIST_CHANGED: Tag,
  INVOICE_CANCELLED: Ban, INVOICE_VOIDED: Ban, RECEIPT_CANCELLED: Ban, PAYLINK_CANCELLED: Ban,
  INVOICE_EXPIRED: Hourglass, PAYLINK_EXPIRED: Hourglass,
  INVOICE_REASSIGNED: ArrowLeftRight, RECEIPT_REASSIGNED: ArrowLeftRight, VISIT_REASSIGNED: ArrowLeftRight,
  INVOICE_REISSUED: Repeat, INVOICE_PAID: BadgeCheck, RECEIPT_ISSUED: Receipt,
  INVOICE_DELETED: FileX, RECEIPT_DELETED: FileX,
  ADJUSTMENT_CREATED: Scale, ADJUSTMENT_UPDATED: Scale, OPENING_BALANCE_SET: Scale,
  LEDGER_JOURNAL_POSTED: BookOpenCheck, LEDGER_JOURNAL_REVERSED: BookX,
  PAYLINK_CREATED: Link2, PAYLINK_PAID: Link2, PAYLINK_REFUNDED: Undo2,
  CARD_PAYMENT_COMPLETED: CreditCard, CARD_PAYMENT_FAILED: CreditCard, CARD_PAYMENT_REVERSED: Undo2, CARD_PAYMENT_HELD: ShieldAlert,
  ROUTE_STOP_ADDED: Route, ROUTE_STOP_REMOVED: Route, CALL_LOGGED: PhoneCall, SMART_REP_OUTCOME: Bot,
  CATALOG_ORDER_PLACED: ShoppingCart, CATALOG_ORDER_UPDATED: ShoppingCart, DOCUMENT_REMOVED: FileX,
};

/** إلغاءٌ أو حذفٌ أو فشلٌ أو ردّ مال: لونٌ أحمر هادئ يميّزه في السجلّ */
const NEGATIVE = /_(CANCELLED|VOIDED|DELETED|REMOVED|FAILED|EXPIRED|REVERSED|REFUNDED)$/;
const NEGATIVE_CLS = 'text-[#B42318] bg-[#FDECEA]';
/** مالٌ معلّق للمراجعة: كهرمانيّ — لا سلبيٌّ ولا مكتمل */
const PENDING = /_HELD$/;
const PENDING_CLS = 'text-[#8A5A00] bg-[#FDF3DC]';

/** عنوان اليوم: «اليوم» أو «أمس» ثم اليوم بتاريخه الميلادي بلغة الواجهة */
function dayHeader(at: string, tr: (s: string) => string): string {
  const d = new Date(at);
  if (isNaN(d.getTime())) return '-';
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  const date = new Intl.DateTimeFormat(activeLocale(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  const rel = days === 0 ? tr('اليوم') : days === 1 ? tr('أمس') : '';
  return rel ? `${rel} · ${date}` : date;
}

function DetailValue({ d, accountingOn }: { d: ActivityDetail; accountingOn: boolean }) {
  const tr = useTr();
  if (d.kind === 'money') return accountingOn ? <span dir="ltr">{formatCurrency(Number(d.value))}</span> : null;
  if (d.kind === 'number') return <span dir="ltr">{formatNumber(d.value)}</span>;
  if (d.kind === 'duration') return <span dir="ltr">{formatDuration(Number(d.value)) ?? '—'}</span>;
  if (d.kind === 'code') return <span dir="ltr" className="font-mono">{String(d.value)}</span>;
  if (d.kind === 'date') return <span dir="ltr">{formatDateTime(String(d.value))}</span>;
  if (d.kind === 'label') return <>{tr(String(d.value))}</>;
  return <span dir="auto" className="[overflow-wrap:anywhere]">{String(d.value)}</span>;
}

function ChangeValue({ v }: { v: ReturnType<typeof changesOf>[number]['from'] }) {
  const tr = useTr();
  if (!v) return null;
  return <bdi dir={v.ltr ? 'ltr' : 'auto'} className="[overflow-wrap:anywhere]">{v.translate ? tr(v.text) : v.text}</bdi>;
}

function ActivityCardView({ item, accountingOn, taxOff = false, compact = false, renderExtra }: {
  item: ActivityItem; accountingOn: boolean; taxOff?: boolean; compact?: boolean; renderExtra?: (item: ActivityItem) => ReactNode;
}) {
  const tr = useTr();
  const style = CATEGORY_STYLE[item.category] ?? CATEGORY_STYLE.other;
  const Icon = ACTION_ICON[item.action] ?? style.icon;
  const iconCls = NEGATIVE.test(item.action) ? NEGATIVE_CLS : PENDING.test(item.action) ? PENDING_CLS : style.cls;
  const actor = actorDisplay(item.actor);
  const amount = amountOf(item);
  const badge = statusBadgeOf(item);
  const unverified = unverifiedBadgeOf(item);
  const refNo = refNoOf(item);
  const details = detailsOf(item, { accountingOn, taxOff, docKindLabel: (k) => docKindLabel(k, taxOff) })
    .filter((d) => d.kind !== 'money' || accountingOn);
  const changes = changesOf(item, { accountingOn, taxOff });
  const allocations = allocationsOf(item);
  const lines = itemsOf(item, { accountingOn });
  const note = noteOf(item);
  const extra = renderExtra?.(item);
  return (
    <li className={`relative rounded-xl border border-[#E9E1D3] bg-white ${compact ? 'p-2.5' : 'p-3.5'}`}>
      <div className="flex items-start gap-2.5">
        <span className={`flex-shrink-0 rounded-full flex items-center justify-center ${compact ? 'w-8 h-8' : 'w-9 h-9'} ${iconCls}`}>
          <Icon size={compact ? 15 : 16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-2 gap-y-0.5">
            <p className="min-w-0 flex flex-wrap items-center gap-1.5 text-sm font-bold text-[#1F1A13]">
              <span>{tr(actionLabel(item.action, { taxOff, data: item.data }))}</span>
              {refNo && <span dir="ltr" className="text-[11px] font-semibold text-[#4B4336] bg-[#FAF7F0] border border-[#E9E1D3] rounded px-1.5 py-px">{refNo}</span>}
              {badge && <span className="text-[10px] font-bold bg-red-600 text-white rounded px-1.5">{tr(badge)}</span>}
              {unverified && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#8A5A00] bg-[#FDF3DC] border border-[#F0D9A8] rounded px-1.5">
                  <ShieldQuestion size={11} className="flex-shrink-0" /> {tr(unverified)}
                </span>
              )}
            </p>
            <span className="flex-shrink-0 text-[11px] text-[#6E6557]" dir="ltr">{formatTime(item.at)}</span>
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[#6E6557]">
            <UserRound size={12} className="text-[#8A6D1F] flex-shrink-0" />
            <bdi className="font-semibold text-[#1F1A13]">{actor.translate ? tr(actor.text) : actor.text}</bdi>
            {!actor.translate && (
              <span className="rounded-full bg-[#FAF7F0] border border-[#E9E1D3] px-2 py-px font-semibold text-[#4B4336]">{tr(actorKindLabel(item.actor.kind))}</span>
            )}
            {item.historical && (
              <span className="inline-flex items-center gap-1 rounded-full bg-[#F4EEE3] px-2 py-px font-semibold text-[#8A6D1F]" title={tr('مستخرج من سجلات النظام السابقة لبدء السجل الثابت')}>
                <History size={11} /> {tr('سجل تاريخي')}
              </span>
            )}
          </div>

          {accountingOn && amount !== null && (
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-1.5 text-sm font-bold text-[#1F1A13]">
              {/* التسويات والقيود: أثرها الموقَّع على الرصيد (+ يزيد ما على العميل) لا قيمةً مطلقة */}
              <span dir="ltr">{amountSign(item, amount)}{formatCurrency(amount)}</span>
              {isBalanceEffect(item.action) && <span className="text-[11px] font-semibold text-[#6E6557]">{tr('أثر على رصيد العميل')}</span>}
            </p>
          )}

          {details.length > 0 && (
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
              {details.map((d, i) => (
                <div key={`${d.label}-${i}`} className="contents">
                  <dt className="text-[#6E6557]">{tr(d.label)}</dt>
                  <dd className="text-[#1F1A13] font-semibold min-w-0"><DetailValue d={d} accountingOn={accountingOn} /></dd>
                </div>
              ))}
            </dl>
          )}

          {allocations.length > 0 && (
            <div className="mt-1.5 text-[11px]">
              <p className="text-[#6E6557]">{tr('سداد الفواتير')}</p>
              <ul className="mt-0.5 space-y-0.5">
                {allocations.map((a, i) => (
                  <li key={`${a.invoiceNo ?? ''}-${i}`} className="flex flex-wrap items-center gap-1.5 text-[#1F1A13]">
                    {a.invoiceNo ? <span dir="ltr" className="font-mono">{a.invoiceNo}</span> : <span>{tr('فاتورة')}</span>}
                    {accountingOn && a.amount !== null && <span dir="ltr" className="font-semibold">{formatCurrency(a.amount)}</span>}
                    {a.settled && <span className="rounded bg-[#EAF4EE] text-[#1E7A52] px-1.5 font-semibold">{tr('سددت كاملة')}</span>}
                    {a.restored && <span className="rounded bg-[#FDF3DC] text-[#8A5A00] px-1.5 font-semibold">{tr('أعيد مبلغها إلى الفاتورة')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {lines.length > 0 && (
            <div className="mt-1.5 text-[11px]">
              <p className="text-[#6E6557]">{tr('الأصناف')}</p>
              <ul className="mt-0.5 space-y-0.5">
                {lines.map((l, i) => (
                  <li key={`${l.name ?? ''}-${i}`} className="flex flex-wrap items-center gap-1.5 text-[#1F1A13]">
                    <span dir="auto" className="font-semibold [overflow-wrap:anywhere]">{l.name ?? '—'}</span>
                    {l.qty !== null && <span dir="ltr">× {formatNumber(l.qty)}</span>}
                    {l.unit && <span dir="auto" className="text-[#6E6557]">{l.unit}</span>}
                    {accountingOn && (l.from !== null || l.to !== null) && (
                      <>
                        <span dir="ltr" className="text-[#9A8F7E] line-through decoration-[#D9CDB8]">{l.from !== null ? formatCurrency(l.from) : '—'}</span>
                        <ArrowLeft size={11} className="text-[#9A8F7E] flex-shrink-0" />
                        <span dir="ltr" className="font-semibold">{l.to !== null ? formatCurrency(l.to) : '—'}</span>
                      </>
                    )}
                    {accountingOn && l.from === null && l.to === null && l.price !== null && <span dir="ltr">{formatCurrency(l.price)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {changes.length > 0 && (
            <ul className="mt-1.5 space-y-1 rounded-lg bg-[#FAF7F0] px-2.5 py-1.5 text-[11px]">
              {changes.map((c, i) => (
                <li key={`${c.field}-${i}`} className="flex flex-wrap items-center gap-1 text-[#1F1A13]">
                  <span className="font-semibold">{tr(c.label)}:</span>
                  {/* طرفٌ لا يُقرأ (معرّفٌ آلي) لا يُرسم خانةً فارغة: القيمة الجديدة وحدها، أو «تغير» إن لم تُقرأ هي */}
                  {c.from && c.to ? (
                    <>
                      <span className="text-[#9A8F7E] line-through decoration-[#D9CDB8]"><ChangeValue v={c.from} /></span>
                      <ArrowLeft size={11} className="text-[#9A8F7E] flex-shrink-0" />
                      <span className="font-semibold"><ChangeValue v={c.to} /></span>
                    </>
                  ) : c.to ? (
                    <span className="font-semibold"><ChangeValue v={c.to} /></span>
                  ) : <span className="text-[#6E6557]">{tr('تغير')}</span>}
                </li>
              ))}
            </ul>
          )}

          {note && (
            <p className="mt-1.5 text-sm text-[#1F1A13] whitespace-pre-wrap leading-relaxed flex gap-1.5" dir="auto">
              <MessageSquareText size={14} className="text-[#8A6D1F] mt-1 flex-shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">{note}</span>
            </p>
          )}

          {extra ? <div className="mt-2">{extra}</div> : null}
        </div>
      </div>
    </li>
  );
}

/** البطاقة محفوظةً: بندٌ لم يتغيّر (المرجع نفسه بعد «تحميل المزيد» أو البحث) لا يُعاد رسمه */
export const ActivityCard = memo(ActivityCardView);

/** البنود مجمّعةً بأيامها — عنوان اليوم يلتصق أعلى حاوية التمرير */
function ActivityListView({ items, accountingOn, taxOff = false, compact = false, renderExtra }: {
  items: ActivityItem[]; accountingOn: boolean; taxOff?: boolean; compact?: boolean; renderExtra?: (item: ActivityItem) => ReactNode;
}) {
  const tr = useTr();
  return (
    <div className="space-y-3">
      {groupByDay(items).map((g) => (
        <section key={g.key} className="space-y-2">
          <div className="sticky top-0 z-10 -mx-1 px-1 py-1 bg-[#FFFDF9]/95 backdrop-blur">
            <span className="inline-flex items-center text-xs font-bold text-[#1F1A13] bg-[#F4EEE3] rounded-full px-3 py-1">{dayHeader(g.at, tr)}</span>
          </div>
          <ol className="space-y-2">
            {g.items.map((it) => (
              <ActivityCard key={it.id} item={it} accountingOn={accountingOn} taxOff={taxOff} compact={compact} renderExtra={renderExtra} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** القائمة محفوظةً: البنود (المرجع نفسه) وأعلامٌ أوّلية ودالّة إضافةٍ ثابتة ⇒ لا رسم مع كل نبضة مؤقّت في الشاشة المضيفة */
const ActivityList = memo(ActivityListView);
export default ActivityList;
