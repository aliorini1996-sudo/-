import { useEffect, useRef, useState } from 'react';

/**
 * حقل عشري صبور — يحلّ علّة «كتابة الفاصلة تمسح الرقم»:
 *
 * <input type="number"> المتحكَّم به في React يعيد قيمة فارغة لأي نصّ جزئي غير
 * صالح («113.» أو «113,» أو فاصلة عربية ٫)، فيلتقطها onChange صفراً ويُعاد
 * التصيير فيُمسح ما كُتب. هنا الحقل نصّي يحتفظ بما يكتبه المستخدم حرفياً أثناء
 * التركيز، ويقبل الفاصلة (,) والعربية (٫) والنقطة والأرقام العربية-الهندية،
 * ويبلّغ القيمة العددية أولاً بأول متى صلحت — ولا يُطبَّع العرض إلا عند مغادرة
 * الحقل أو تغيّر القيمة من الخارج (كتغيّر الكمية الذي يعيد حساب الإجمالي).
 */

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function normalize(raw: string): string {
  let s = raw.replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  s = s.replace(/[,٫]/g, '.');
  return s;
}

interface Props {
  value: number;
  onCommit: (n: number) => void;
  className?: string;
  title?: string;
  readOnly?: boolean;
  placeholder?: string;
  min?: number;
}

export default function DecimalInput({ value, onCommit, className, title, readOnly, placeholder, min }: Props) {
  const [txt, setTxt] = useState<string>(String(value ?? 0));
  const focused = useRef(false);
  // ضغطةٌ أبلغت قيمةً للتوّ: تغيّر value في التصيير الذي يليها صداها (وقد قصّه الأب — أرضية السعر أو حدّ الخصم)
  const typed = useRef(false);

  // مزامنة من الخارج (إعادة حساب، أو مسحُ قارئٍ زاد كمية البند والحقل مركَّز) — لا صدى ما يكتبه المستخدم: لا يُعاد نصّه أثناء كتابته
  useEffect(() => {
    if (!focused.current || !typed.current) setTxt(String(value ?? 0));
  }, [value]);
  // الصدى يُستهلك بأول تصييرٍ بعد الضغطة (React يصيّر الحقل المتحكَّم به فور حدثه) — فتغيّرٌ لاحق من الخارج يظهر ولو والحقل مركَّز
  useEffect(() => { typed.current = false; });

  // trusted: ضغطة المستخدم نفسه — أما حدثٌ اصطناعيّ (إرجاع قارئ الليزر قيمة الحقل) فليس كتابةً يُحمى صداها
  const handle = (raw: string, trusted = true) => {
    const clean = normalize(raw);
    if (!/^\d*\.?\d*$/.test(clean)) return; // حرف دخيل — نتجاهل الضغطة ولا نمسح شيئاً
    setTxt(clean);
    const n = parseFloat(clean);
    if (Number.isFinite(n) && (min === undefined || n >= min)) { typed.current = trusted; onCommit(n); }
  };

  return (
    <input
      type="text" inputMode="decimal" dir="ltr"
      className={className} title={title} readOnly={readOnly} placeholder={placeholder}
      value={txt}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; setTxt(String(value ?? 0)); }}
      onChange={(e) => handle(e.target.value, e.nativeEvent.isTrusted !== false)}
    />
  );
}
