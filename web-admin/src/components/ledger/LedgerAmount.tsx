import { ledgerAmountParts, AmountInput, NegativeStyle } from '../../lib/ledger/format';

/**
 * مبلغ دفاتر معزول الاتجاه (§8.3): `<bdi dir="ltr">` والعلامة اللاحقة **داخل** العزل،
 * وإلا نقلت خوارزمية Bidi «-» يسار الرقم في فقرة RTL فقُرئ «3,210.34-» كـ«-3,210.34».
 * السالب أحمر، والصفري رمادي (نمط ReportView).
 */
export function LedgerAmount({ value, decimals, negativeStyle = 'trailing', className = '', colored = true, blankZero = false }: {
  value: AmountInput;
  decimals: number;
  negativeStyle?: NegativeStyle;
  className?: string;
  /** تلوين السالب والصفر (يُطفأ داخل خلية ملوّنة أصلاً) */
  colored?: boolean;
  /** الصفر خانة فارغة (أعمدة مدين/دائن) */
  blankZero?: boolean;
}) {
  const p = ledgerAmountParts(value, { decimals, negativeStyle });
  if (blankZero && p.zero) return <bdi dir="ltr" className={className} />;
  const tone = !colored ? '' : p.negative ? 'text-[#C0392B]' : p.zero ? 'text-gray-400' : '';
  return (
    <bdi dir="ltr" className={`tabular-nums whitespace-nowrap ${tone} ${className}`.trim()}>
      {p.text}
    </bdi>
  );
}

export default LedgerAmount;
