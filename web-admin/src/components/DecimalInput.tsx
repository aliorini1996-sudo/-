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

  // مزامنة من الخارج (إعادة حساب) — فقط حين لا يكتب المستخدم في الحقل
  useEffect(() => {
    if (!focused.current) setTxt(String(value ?? 0));
  }, [value]);

  const handle = (raw: string) => {
    const clean = normalize(raw);
    if (!/^\d*\.?\d*$/.test(clean)) return; // حرف دخيل — نتجاهل الضغطة ولا نمسح شيئاً
    setTxt(clean);
    const n = parseFloat(clean);
    if (Number.isFinite(n) && (min === undefined || n >= min)) onCommit(n);
  };

  return (
    <input
      type="text" inputMode="decimal" dir="ltr"
      className={className} title={title} readOnly={readOnly} placeholder={placeholder}
      value={txt}
      onFocus={() => { focused.current = true; }}
      onBlur={() => { focused.current = false; setTxt(String(value ?? 0)); }}
      onChange={(e) => handle(e.target.value)}
    />
  );
}
