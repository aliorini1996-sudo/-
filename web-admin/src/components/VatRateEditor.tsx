import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { companyApi } from '../api/client';
import { getCountry } from '../i18n/countries';
import { useTr } from '../i18n/strings';

/**
 * «محرّر الضريبة» (طلب المالك ٨ نوفمبر ٢٠٢٦): المشترك خارج السعودية يحدّد نسبة ضريبة دولته بنفسه (PATCH /company/vat-rate)
 * فتصير نسبة كل صنف جديد، ويختار نقل الأصناف التي على النسبة السابقة إليها. السعودية ثابتة وفق ZATCA (والخادم يردّها 409).
 * يُحفظ فوراً بمساره المستقل لا مع زرّ حفظ النموذج — والدولة المختارة ولم تُحفظ تُحفظ أولاً (نسبتها تتبع الدولة المحفوظة)
 */
export default function VatRateEditor({ savedCountry, savedVatPct, selectedCountry }: {
  savedCountry: string; savedVatPct: number; selectedCountry: string;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [value, setValue] = useState(String(savedVatPct));
  const [applyToProducts, setApplyToProducts] = useState(true);
  useEffect(() => { setValue(String(savedVatPct)); }, [savedVatPct, savedCountry]);

  const save = useMutation({
    mutationFn: (pct: number) => companyApi.vatRate({ defaultVatPct: pct, applyToProducts }),
    onSuccess: (res) => {
      const d = res.data?.data as { productsUpdated?: number } | undefined;
      qc.invalidateQueries({ queryKey: ['company'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      toast.success(`${tr('تم حفظ نسبة الضريبة')}${d?.productsUpdated ? ` — ${tr('عدد الأصناف المحدثة')}: ${d.productsUpdated}` : ''}`);
    },
    onError: () => toast.error(tr('حدث خطأ في الحفظ')),
  });

  if (getCountry(savedCountry).einvoice === 'zatca' && selectedCountry === savedCountry) {
    return <p className="text-[11px] text-[#6E6557] mt-1.5">{tr('نسبة الضريبة ثابتة في السعودية وفق نظام ZATCA')}</p>;
  }
  if (selectedCountry !== savedCountry) {
    return <p className="text-[11px] text-[#C94E28] mt-1.5">{tr('احفظ الدولة أولا ثم حدد نسبة الضريبة')}</p>;
  }

  const pct = Number(value.replace(',', '.'));
  const valid = value.trim() !== '' && Number.isFinite(pct) && pct >= 0 && pct <= 100;
  const changed = valid && Math.round(pct * 100) / 100 !== savedVatPct;

  return (
    <div className="mt-3 rounded-xl border border-[#E9E1D3] bg-white px-3 py-3">
      <label className="label">{tr('نسبة الضريبة')} %</label>
      <div className="flex items-center gap-2">
        <input className="input max-w-[140px]" dir="ltr" inputMode="decimal" value={value}
          onChange={e => setValue(e.target.value)} aria-invalid={!valid} />
        <button type="button" disabled={!changed || save.isPending} onClick={() => save.mutate(pct)}
          className="rounded-lg bg-[#E15A30] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">
          {save.isPending ? '…' : tr('حفظ النسبة')}
        </button>
      </div>
      {!valid && <p className="text-red-500 text-xs mt-1">{tr('النسبة بين 0 و 100')}</p>}
      <label className="mt-2 flex items-start gap-2 text-[12px] text-[#44403a] cursor-pointer">
        <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[#E15A30]" checked={applyToProducts} onChange={e => setApplyToProducts(e.target.checked)} />
        {tr('تطبيق النسبة الجديدة على الأصناف التي على النسبة السابقة')}
      </label>
      <p className="text-[11px] text-[#6E6557] mt-1.5">{tr('حدد نسبة الضريبة التي تفرضها دولتك وتطبق على كل صنف جديد')}</p>
    </div>
  );
}
