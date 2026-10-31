import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { productApi } from '../../api/client';
import { Product, ProductUnit } from '../../types';
import { useTr } from '../../i18n/strings';
import { useAuthStore } from '../../store/authStore';
import { X, Upload, Trash2, Image as ImageIcon, Pencil, Plus, Layers, ArrowDownUp, Power } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatCurrency } from '../../utils/format';
import { unitPriceOf } from '../../lib/units';
import {
  EMPTY_UNIT_FORM, unitFormOf, unitFormPayload, unitFormProblem, convertFormProblem, convertPreview, convertPayload, hasBigUnit,
  type UnitForm, type ConvertForm,
} from '../../lib/adminUnits';
import { PRODUCT_VAT_CATEGORY_LABELS_AR, VATEX_LABELS_AR, productVatPayload, vatexCodesFor } from '../../lib/zatca/productVatForm';
import {
  RETURN_RULE_METRIC_LABELS, RETURN_RULE_MODE_LABELS, ReturnRuleMetric, ReturnRuleMode, SHELF_LIFE_BASIS_LABELS, SHELF_LIFE_UNIT_LABELS,
  ShelfLifeBasis, ShelfLifeUnit, previewExpiry, returnRuleValueProblem,
} from '../../lib/shelfLife';
import { formatDayOnly } from '../../utils/format';
import { productLotNote, productLotPayload } from '../../lib/lotTrackingUi';

interface Props {
  product: Product | null; onClose: () => void; onSave: (data: Partial<Product>) => void; loading: boolean;
  /** فوترة ZATCA (Z5.1a): الشركة تجمع بيانات الفوترة؟ (zatcaCollectOn) — false ⇒ النموذج والحمولة كما اليوم */
  zatcaCollect?: boolean;
  /** «تتبّع اللوط» مفعّل للشركة؟ (lotFlagsOf(company).on) — false ⇒ لا قسم ولا حقل في الحمولة (§١٠.١) */
  lotTrackingOn?: boolean;
}

// يضغط الصورة في المتصفح (يصغّر الأبعاد ويحوّلها JPEG) لتقليل حجمها قبل التخزين
function compressImage(file: File, maxSize = 400, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) { height = (height * maxSize) / width; width = maxSize; }
        else if (height > maxSize) { width = (width * maxSize) / height; height = maxSize; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('no ctx')); return; }
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ProductModal({ product, onClose, onSave, loading, zatcaCollect = false, lotTrackingOn = false }: Props) {
  const tr = useTr();
  const { register, handleSubmit, watch, setValue, getValues, formState: { errors } } = useForm<Partial<Product>>({
    // وحدة الصلاحية الافتراضية «أشهر» — صنفٌ قديم بلا وحدة محفوظة لا يُرسل فارغاً حين تُفعَّل له
    // وتاريخ الشراء بصيغة حقل التاريخ (YYYY-MM-DD) — الخادم يعيده لحظةً كاملة
    defaultValues: product
      ? {
        ...product, shelfLifeUnit: product.shelfLifeUnit || 'MONTH', shelfLifeBasis: product.shelfLifeBasis || 'SALE', shelfLifeFromDate: product.shelfLifeFromDate ? product.shelfLifeFromDate.slice(0, 10) : '',
        returnRuleMode: product.returnRuleMode || 'NEAR_EXPIRY', returnRuleMetric: product.returnRuleMetric || 'DAYS',
        // «قيود المندوب»: صريحةً — خانةٌ بقيمة غائبة تُرسل false فيُمنع الصنف على المندوب بصمت
        repSaleAllowed: product.repSaleAllowed !== false, repReturnAllowed: product.repReturnAllowed !== false,
        repSaleUnit: product.repSaleUnit || 'ANY', repReturnUnit: product.repReturnUnit || 'ANY',
      }
      : {
        status: 'ACTIVE', taxPct: 15, basePrice: 0, shelfLifeEnabled: false, shelfLifeUnit: 'MONTH', shelfLifeBasis: 'SALE', shelfLifeFromDate: '',
        returnRuleEnabled: false, returnRuleMode: 'NEAR_EXPIRY', returnRuleMetric: 'DAYS',
        repSaleAllowed: true, repReturnAllowed: true, repSaleUnit: 'ANY', repReturnUnit: 'ANY',
      },
  });
  // صورة الصنف تُدار بـ state ليتم ضغطها ودمجها يدوياً
  const [image, setImage] = useState<string>(product?.image || '');
  /* وحدات البيع (الوحدات المتعددة): تُحفظ فور كل إضافةٍ أو تعديل عبر مساراتها (/products/:id/units) لا مع زرّ الحفظ —
   * فهي هنا حالةٌ محلية تتبع ما ردّه الخادم. ووحدة الأساس المحفوظة (لا ما في خانة الوحدة الآن) هي ما تُقاس به الوحدات
   * وما يتوقّعه التحويل؛ التحويل يغيّرها فتُحدَّث معه */
  const [units, setUnits] = useState<ProductUnit[]>(product?.units ?? []);
  const [savedBase, setSavedBase] = useState<string>(product?.unit ?? '');
  const [savedBasePrice, setSavedBasePrice] = useState<number>(Number(product?.basePrice ?? 0));
  // «تتبّع باللوط» — حالةٌ محلية لا حقل نموذج: يُرسل حين يتغيّر وحده (productLotPayload)، والإطفاء بأرصدة يؤكَّد بعد ردّ الخادم (D9)
  const [lotTracked, setLotTracked] = useState<boolean>(product?.lotTracked === true);
  const lotNote = lotTrackingOn ? productLotNote(product, lotTracked) : null;

  const { data: categories } = useQuery({
    queryKey: ['product-categories'],
    queryFn: async () => { const res = await productApi.categories(); return res.data.data as { id: string; name: string }[]; },
  });

  const onImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error(tr('الملف يجب أن يكون صورة')); return; }
    try {
      const compressed = await compressImage(file);
      setImage(compressed);
    } catch { toast.error(tr('تعذر معالجة الصورة')); }
  };

  // الفئة الضريبية (Z5.1a) تُرسل للشركة الجامعة وحدها — غيرها لا تصله الحقول الثلاثة أصلاً (كان الخادم يُسقطها)
  const vatCategory = zatcaCollect ? watch('vatCategory') : null;
  // صلاحية الصنف: المدة من أساسٍ يختاره المالك (البيع أو الشراء المكتوب أو تحميل السيارة)، والمعاينة بحسبه
  const lifeOn = !!watch('shelfLifeEnabled');
  const lifeBasis = (watch('shelfLifeBasis') || 'SALE') as ShelfLifeBasis;
  const lifePreview = previewExpiry({
    shelfLifeEnabled: lifeOn, shelfLifeValue: watch('shelfLifeValue'), shelfLifeUnit: watch('shelfLifeUnit'),
    shelfLifeBasis: lifeBasis, shelfLifeFromDate: watch('shelfLifeFromDate'),
  });
  // «تتبّع اللوط» (§٤.١٨): الصنف المتتبَّع تُختم صلاحية بنوده من تاريخ انتهاء تشغيلته، فيُخفى «أساس الصلاحية» ومعاينته وتبقى
  // المدة (لقيد المرتجع بالنسبة ولما بيع قبل التتبّع). أساسٌ لا يكتمل (شراءٌ بلا تاريخ) يبقى ظاهراً فلا يُرفض الحفظ بحقلٍ مخفي
  const lotExpiry = lotTrackingOn && lotTracked && !(lifeBasis === 'PURCHASE' && !watch('shelfLifeFromDate'));
  // قيد المرتجع: لا يقبل مرتجع الصنف إلا قرب انتهائه أو وهو ما زال صالحاً، بأيامٍ أو نسبةٍ متبقية
  const ruleOn = lifeOn && !!watch('returnRuleEnabled');
  const ruleMode = (watch('returnRuleMode') || 'NEAR_EXPIRY') as ReturnRuleMode;
  const ruleMetric = (watch('returnRuleMetric') || 'DAYS') as ReturnRuleMetric;
  const ruleValue = Number(watch('returnRuleValue'));
  const PREVIEW_LABEL: Record<ShelfLifeBasis, string> = {
    SALE: 'ما يباع اليوم تنتهي صلاحيته في',
    PURCHASE: 'تنتهي صلاحية كمية هذا الصنف في',
    VAN_LOAD: 'ما يحمل اليوم في سيارة المندوب تنتهي صلاحيته في',
  };
  const submit = (data: Partial<Product>) => {
    // units تُحفظ بمساراتها لا مع الصنف — وإرسال لقطتها القديمة (من فتح النافذة) لا معنى له فتُنزع من الحمولة
    // وعلما اللوط من الصنف المحمَّل (lotTracked وحقبته) لا يُعادان كما هما: الانتقال وحده يُرسل (productLotPayload أدناه)
    const { vatCategory: cat, vatExemptionCode, vatExemptionReason, lotTracked: _lotTracked, lotTrackedSince: _lotTrackedSince, units: _units, ...rest } = data;
    void _units; void _lotTracked; void _lotTrackedSince;
    // اسم الأساس لا يأخذ اسم وحدةٍ أكبر للصنف نفسه (والخادم يرفضه) — «٢ كرتون» تصير ملتبسة بين الأساس والكرتون
    const newBase = String(rest.unit ?? '').trim();
    if (product && newBase !== savedBase.trim() && units.some(u => u.name.trim() === newBase)) {
      toast.error(tr('اسم وحدة الأساس مستخدم لوحدة أخرى لهذا الصنف'));
      return;
    }
    // حقلٌ رقميّ فارغ يصير NaN — يُرسل null لا NaN (JSON يحوّله null أصلاً، والصراحة أوضح)
    const lifeValue = Number.isFinite(rest.shelfLifeValue as number) ? rest.shelfLifeValue : null;
    if (rest.shelfLifeEnabled && (!lifeValue || !Number.isInteger(lifeValue) || lifeValue <= 0)) {
      toast.error(tr('مدة الصلاحية يجب أن تكون عدداً صحيحاً أكبر من صفر'));
      return;
    }
    const fromDate = rest.shelfLifeFromDate ? String(rest.shelfLifeFromDate).slice(0, 10) : null;
    if (rest.shelfLifeEnabled && rest.shelfLifeBasis === 'PURCHASE' && !fromDate) {
      toast.error(tr('اكتب تاريخ الشراء أو الإنتاج الذي تحسب منه الصلاحية'));
      return;
    }
    // القيد يتبع الصلاحية: إطفاؤها يطفئه، ويبقى اتجاهه وحدّه محفوظين لإعادة التفعيل
    const ruleEnabled = !!rest.shelfLifeEnabled && !!rest.returnRuleEnabled;
    const ruleVal = Number.isFinite(rest.returnRuleValue as number) ? rest.returnRuleValue : null;
    const ruleProblem = ruleEnabled ? returnRuleValueProblem(rest.returnRuleMetric, ruleVal) : null;
    if (ruleProblem) { toast.error(tr(ruleProblem)); return; }
    // «قيود المندوب»: «الكبرى فقط» يلزمه وحدةٌ كبرى نشطة (والخادم يرفض بـREP_UNIT_RULE_INVALID)
    const repSaleUnit = rest.repSaleUnit || 'ANY';
    const repReturnUnit = rest.repReturnUnit || 'ANY';
    if ((repSaleUnit === 'LARGE' || repReturnUnit === 'LARGE') && !hasBigUnit(units)) {
      toast.error(tr('قيد الوحدة الكبرى فقط يحتاج وحدة كبرى نشطة لهذا الصنف')); return;
    }
    onSave({
      ...rest, shelfLifeEnabled: !!rest.shelfLifeEnabled, shelfLifeValue: lifeValue,
      shelfLifeBasis: rest.shelfLifeBasis || 'SALE', shelfLifeFromDate: fromDate,
      returnRuleEnabled: ruleEnabled, returnRuleMode: rest.returnRuleMode || 'NEAR_EXPIRY', returnRuleMetric: rest.returnRuleMetric || 'DAYS',
      returnRuleValue: ruleVal,
      repSaleAllowed: rest.repSaleAllowed !== false, repReturnAllowed: rest.repReturnAllowed !== false, repSaleUnit, repReturnUnit,
      image: image || null, ...(zatcaCollect ? productVatPayload({ vatCategory: cat, vatExemptionCode, vatExemptionReason }) : {}),
      ...productLotPayload(product, lotTrackingOn, lotTracked),
    } as Partial<Product>);
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" dir="rtl">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-bold text-gray-800">{product ? tr('تعديل صنف') : tr('إضافة صنف جديد')}</h2>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit(submit)} className="p-5 space-y-4">
          {/* صورة الصنف */}
          <div>
            <label className="label">{tr('صورة الصنف')}</label>
            <div className="flex items-center gap-3">
              <div className="w-20 h-20 rounded-xl border-2 border-dashed border-gray-200 flex items-center justify-center overflow-hidden bg-gray-50 flex-shrink-0">
                {image
                  ? <img src={image} alt={tr('صورة الصنف')} className="w-full h-full object-cover" />
                  : <ImageIcon size={26} className="text-gray-300" />}
              </div>
              <div className="flex flex-col gap-2">
                <label className="btn-secondary cursor-pointer text-xs">
                  <Upload size={14} /> {tr('اختيار صورة')}
                  <input type="file" accept="image/*" className="hidden" onChange={onImageChange} />
                </label>
                {image && (
                  <button type="button" onClick={() => setImage('')} className="text-red-500 text-xs flex items-center gap-1">
                    <Trash2 size={12} /> {tr('إزالة الصورة')}
                  </button>
                )}
                <span className="text-[10px] text-gray-400">{tr('تضغط تلقائيا تظهر للمندوب عند البيع')}</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{tr('كود الصنف')} *</label>
              <input className="input" {...register('code', { required: true })} />
              {errors.code && <p className="text-red-500 text-xs mt-1">{tr('مطلوب')}</p>}
            </div>
            <div>
              <label className="label">{tr('اسم الصنف')} *</label>
              <input className="input" {...register('name', { required: true })} />
              {errors.name && <p className="text-red-500 text-xs mt-1">{tr('مطلوب')}</p>}
            </div>
            <div>
              <label className="label">{tr('باركود')}</label>
              <input className="input" dir="ltr" {...register('barcode')} />
            </div>
            <div>
              <label className="label">{tr('وحدة القياس')} *</label>
              <input className="input" {...register('unit', { required: true })} placeholder={tr('كرتون / قطعة / كيلو')} />
              {/* صنفٌ قائم: الخانة إعادة تسمية لا تحويل — «كرتون» تُسمّى «حبة» فتُقرأ مبيعات سنةٍ حبّاتٍ (خطأ ٢٤ ضعفاً) */}
              {product && (
                <p className="text-[10px] text-gray-400 mt-1 leading-relaxed">{tr('تغيير الاسم هنا إعادة تسمية فقط ولتصغير وحدة الأساس استخدم تحويل إلى وحدة أصغر')}</p>
              )}
            </div>
            <div>
              <label className="label">{tr('السعر الأساسي')} *</label>
              <input type="number" className="input" min="0" step="any" inputMode="decimal" {...register('basePrice', { required: true, valueAsNumber: true })} />
              {units.length > 0 && <p className="text-[10px] text-gray-400 mt-1">{tr('سعر وحدة الأساس')}</p>}
            </div>
            <div>
              <label className="label">{tr('نسبة الضريبة %')}</label>
              <input type="number" className="input" min="0" max="100" step="0.01" {...register('taxPct', { valueAsNumber: true })} />
            </div>
            <div>
              <label className="label">{tr('الفئة')}</label>
              <select className="input" {...register('categoryId')}>
                <option value="">{tr('بدون فئة')}</option>
                {categories?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{tr('الحالة')}</label>
              <select className="input" {...register('status')}>
                <option value="ACTIVE">{tr('نشط')}</option>
                <option value="INACTIVE">{tr('غير نشط')}</option>
              </select>
            </div>
          </div>

          {/* وحدات البيع (الوحدات المتعددة): وحدة الأساس أصغر ما يُباع، والكرتون والطبلية وحداتٌ بمعاملها */}
          <ProductUnitsSection
            productId={product?.id ?? null}
            baseUnit={savedBase}
            basePrice={savedBasePrice}
            units={units}
            onUnits={setUnits}
            onConverted={(p) => {
              // الأساس صار الجديد وسعره: الخانتان تتبعانه، وإلا أعاد «حفظ التعديلات» بعده الاسمَ القديم فرفضه الخادم
              setUnits(p.units ?? []);
              setSavedBase(p.unit);
              setSavedBasePrice(Number(p.basePrice));
              setValue('unit', p.unit);
              setValue('basePrice', Number(p.basePrice));
              // «قيود المندوب»: التحويل يقلب معنى الصغرى والكبرى، والخادم لا يقبله إلا والقيد المحفوظ «كل الوحدات» —
              // فقيدُ وحدةٍ اختير قبله ولم يُحفظ يُعاد إليه كي لا يُحفظ بعده بمعنىً آخر
              setValue('repSaleUnit', 'ANY');
              setValue('repReturnUnit', 'ANY');
            }}
          />

          {/* سياسة «المرتجع التالف يعود لمخزون السيارة» أُلغيت (طلب المالك ١٥ أكتوبر ٢٠٢٦): كل مرتجعٍ تالف يدخل السيارة رصيد
              «المرتجع التالف» ولا يُباع حتى تزيله الإدارة — من صفحة مخزون سيارات المناديب */}

          {/* صلاحية الصنف — اختيارية: مدةٌ من أساسٍ يُختار (البيع أو الشراء أو تحميل السيارة)، ومنها يُسجَّل عند المرتجع هل عاد منتهياً */}
          <div className="rounded-xl border border-gray-200 p-3 space-y-3">
            <label className="flex items-center gap-2.5 cursor-pointer">
              <input type="checkbox" {...register('shelfLifeEnabled')} className="w-4 h-4 accent-[#E15A30]" />
              <span className="text-sm font-semibold text-gray-700">{tr('تفعيل تاريخ صلاحية الصنف')}</span>
              <span className="text-[10px] text-gray-400 mr-auto">
                {lotExpiry ? tr('الصلاحية من تاريخ انتهاء التشغيلة') : <>{tr('تحسب من')} {tr(SHELF_LIFE_BASIS_LABELS[lifeBasis])}</>}
              </span>
            </label>
            {lifeOn && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">{tr('مدة الصلاحية')} *</label>
                  <input type="number" className="input" min="1" step="1" inputMode="numeric" {...register('shelfLifeValue', { valueAsNumber: true })} />
                </div>
                <div>
                  <label className="label">{tr('الوحدة')}</label>
                  <select className="input" {...register('shelfLifeUnit')}>
                    {(Object.keys(SHELF_LIFE_UNIT_LABELS) as ShelfLifeUnit[]).map(u => <option key={u} value={u}>{tr(SHELF_LIFE_UNIT_LABELS[u])}</option>)}
                  </select>
                </div>
                {lotExpiry ? (
                  <p className="col-span-2 text-[11px] text-gray-500 bg-[#FAF7F0] border border-[#E9E1D3] rounded-lg px-2.5 py-1.5 leading-relaxed" data-lot-expiry-basis="">
                    {tr('تختم صلاحية الصنف المتتبع من تاريخ انتهاء التشغيلة وتبقى المدة لقيد المرتجع بالنسبة ولما بيع قبل التتبع')}
                  </p>
                ) : (
                  <>
                    <div className={lifeBasis === 'PURCHASE' ? '' : 'col-span-2'}>
                      <label className="label">{tr('تحسب الصلاحية من')}</label>
                      <select className="input" {...register('shelfLifeBasis')}>
                        {(Object.keys(SHELF_LIFE_BASIS_LABELS) as ShelfLifeBasis[]).map(b => <option key={b} value={b}>{tr(SHELF_LIFE_BASIS_LABELS[b])}</option>)}
                      </select>
                    </div>
                    {lifeBasis === 'PURCHASE' && (
                      <div>
                        <label className="label">{tr('تاريخ الشراء أو الإنتاج')} *</label>
                        <input type="date" className="input" {...register('shelfLifeFromDate')} />
                      </div>
                    )}
                    {lifeBasis === 'VAN_LOAD' && (
                      <p className="col-span-2 text-[11px] text-gray-400">{tr('البيع يطابق بدفعة التحميل التي جاء منها والأقدم يباع أولا')}</p>
                    )}
                    {lifePreview && (
                      <p className="col-span-2 text-xs text-gray-500">
                        {tr(PREVIEW_LABEL[lifeBasis])} <b className="text-gray-700">{formatDayOnly(lifePreview)}</b>
                      </p>
                    )}
                  </>
                )}
                {/* قيد المرتجع — يُفعَّل أو يُطفأ لكل صنف، ويُطبَّق على كل مرتجعٍ له من المندوب والإدارة */}
                <div className="col-span-2 rounded-lg bg-gray-50 p-3 space-y-3" data-return-rule="">
                  <label className="flex items-center gap-2.5 cursor-pointer">
                    <input type="checkbox" {...register('returnRuleEnabled')} className="w-4 h-4 accent-[#E15A30]" />
                    <span className="text-sm font-semibold text-gray-700">{tr('قيد على مرتجع الصنف')}</span>
                    <span className="text-[10px] text-gray-400 mr-auto">{tr('لا يقبل المرتجع إلا ضمن حد الصلاحية')}</span>
                  </label>
                  {ruleOn && (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="col-span-2">
                        <label className="label">{tr('يقبل المرتجع')}</label>
                        <select className="input" {...register('returnRuleMode')}>
                          {(Object.keys(RETURN_RULE_MODE_LABELS) as ReturnRuleMode[]).map(m => <option key={m} value={m}>{tr(RETURN_RULE_MODE_LABELS[m])}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="label">{tr('الحد')} *</label>
                        <input type="number" className="input" min="1" step="1" max={ruleMetric === 'PERCENT' ? 100 : undefined} inputMode="numeric"
                          {...register('returnRuleValue', { valueAsNumber: true })} />
                      </div>
                      <div>
                        <label className="label">{tr('يقاس بـ')}</label>
                        <select className="input" {...register('returnRuleMetric')}>
                          {(Object.keys(RETURN_RULE_METRIC_LABELS) as ReturnRuleMetric[]).map(m => <option key={m} value={m}>{tr(RETURN_RULE_METRIC_LABELS[m])}</option>)}
                        </select>
                      </div>
                      {Number.isInteger(ruleValue) && ruleValue > 0 && (
                        <p className="col-span-2 text-xs text-gray-500" data-return-rule-summary="">
                          {tr('يقبل المرتجع إذا بقي على انتهاء صلاحيته')}{' '}
                          <b className="text-gray-700">{ruleMetric === 'PERCENT' ? `${ruleValue}%` : `${ruleValue} ${tr('أيام')}`}</b>{' '}
                          {tr(ruleMode === 'NEAR_EXPIRY' ? 'أو أقل والمنتهي يقبل' : 'أو أكثر والمنتهي لا يقبل')}
                          {ruleMetric === 'PERCENT' && <> — {tr('النسبة من مدة الصلاحية كاملة')}</>}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* «قيود المندوب» (طلب المالك ٣١ أكتوبر ٢٠٢٦، backend services/repProductRules.ts): ما يفعله المندوب وحده بهذا الصنف —
              الإدارة حرّة، وتطبيق المندوب يُخفي الممنوع، والخادم يرفضه. «الصغرى» وحدة الأساس، و«الكبرى» كل وحدةٍ أكبر منها */}
          <div className="rounded-xl border border-gray-200 p-3 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-700">{tr('قيود المندوب على الصنف')}</span>
              <span className="text-[10px] text-gray-400 mr-auto">{tr('لا تقيد الإدارة')}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {([['repSaleAllowed', 'repSaleUnit', 'يبيعه المندوب', 'وحدة البيع'], ['repReturnAllowed', 'repReturnUnit', 'يرجعه المندوب', 'وحدة المرتجع']] as const).map(([allowKey, unitKey, allowLabel, unitLabel]) => {
                const on = watch(allowKey) !== false;
                const big = units.filter((u) => Number(u.factor) > 1 && u.isActive !== false).map((u) => u.name);
                return (
                  <div key={allowKey} className="space-y-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" {...register(allowKey)} className="w-4 h-4 accent-[#E15A30]" />
                      <span className="text-sm text-gray-700">{tr(allowLabel)}</span>
                    </label>
                    <div className={on ? '' : 'opacity-50'}>
                      <label className="label">{tr(unitLabel)}</label>
                      <select className="input" {...register(unitKey)}>
                        <option value="ANY">{tr('بكل الوحدات')}</option>
                        <option value="BASE">{tr('بالوحدة الصغرى فقط')}{savedBase ? ` — ${savedBase}` : ''}</option>
                        <option value="LARGE" disabled={!big.length && watch(unitKey) !== 'LARGE'}>
                          {tr('بالوحدة الكبرى فقط')} — {big.length ? big.join('، ') : tr('أضف وحدة أكبر أولا')}
                        </option>
                      </select>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* «تتبّع باللوط» — للشركة المفعّلة لها الميزة وحدها: الصنف المتتبَّع يُسجَّل بتشغيلته في الوارد والتحميل والفواتير،
              ويصرف المندوب الأقرب انتهاءً تلقائياً بلا نقرة، ولا يُباع من تشغيلاته أكثر من رصيدها */}
          {lotTrackingOn && (
            <div className="rounded-xl border border-gray-200 p-3 space-y-2" data-lot-tracking="">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <input type="checkbox" checked={lotTracked} onChange={e => setLotTracked(e.target.checked)} className="w-4 h-4 accent-[#E15A30]" />
                <span className="text-sm font-semibold text-gray-700">{tr('تتبع بـLOT')}</span>
                <span className="text-[10px] text-gray-400 mr-auto">{tr('رقم التشغيلة وتاريخ انتهائها في كل حركة')}</span>
              </label>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                {tr('يسجل الوارد بتشغيلته ويصرف المندوب الأقرب انتهاء تلقائيا ولا يباع من التشغيلات أكثر من رصيدها ولو سمح البيع بدون مخزون')}
              </p>
              {lotTracked && lifeOn && (
                <p className="text-[11px] text-gray-500">{tr('تاريخ انتهاء التشغيلة إلزامي لأن صلاحية الصنف مفعلة')}</p>
              )}
              {lotNote === 'OFF' && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 leading-relaxed">
                  {tr('الإطفاء يخفي تشغيلات الصنف ولا يحذفها وإن كانت له أرصدة في تشغيلات نطلب تأكيدك عند الحفظ')}
                </p>
              )}
              {lotNote === 'NEW_EPOCH' && (
                <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 leading-relaxed">
                  {tr('إعادة التفعيل تبدأ حقبة جديدة للصنف أرصدته تصير غير مسماة حتى تسمى من جديد')}
                </p>
              )}
            </div>
          )}

          {/* فوترة ZATCA المرحلة الثانية: الفئة الضريبية للصنف — للشركة التي تجمع بيانات الفوترة وحدها */}
          {zatcaCollect && (
            <div className="rounded-xl border border-gray-200 p-4 space-y-3" data-zatca-product-vat="">
              <p className="text-sm font-semibold text-gray-700">{tr('الفئة الضريبية للفوترة الإلكترونية')}</p>
              <div className="grid grid-cols-2 gap-4">
                <div className={vatCategory && vatCategory !== 'S' ? '' : 'col-span-2'}>
                  <label className="label">{tr('الفئة الضريبية')}</label>
                  <select className="input" {...register('vatCategory')}>
                    <option value="">{tr('تلقائية قياسية عند نسبة أكبر من صفر')}</option>
                    {(['S', 'Z', 'E', 'O'] as const).map(c => <option key={c} value={c}>{tr(PRODUCT_VAT_CATEGORY_LABELS_AR[c])}</option>)}
                  </select>
                </div>
                {vatCategory && vatCategory !== 'S' && (
                  <div>
                    <label className="label">{tr('رمز سبب الإعفاء أو الصفرية')}</label>
                    <select className="input" {...register('vatExemptionCode', {
                      onChange: e => { if (!getValues('vatExemptionReason')) setValue('vatExemptionReason', VATEX_LABELS_AR[e.target.value] ?? ''); },
                    })}>
                      <option value="">{tr('اختر')}</option>
                      {vatexCodesFor(vatCategory).map(code => <option key={code} value={code}>{`${code} — ${tr(VATEX_LABELS_AR[code])}`}</option>)}
                    </select>
                  </div>
                )}
                {vatCategory && vatCategory !== 'S' && (
                  <div className="col-span-2">
                    <label className="label">{tr('نص سبب الإعفاء أو الصفرية')}</label>
                    <input className="input" {...register('vatExemptionReason')} />
                    <p className="text-[11px] text-gray-400 mt-1">{tr('نسبة الضريبة لهذه الفئة يجب أن تكون 0%')}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* أكواد الفوترة الإلكترونية — تلزم لبعض الدول (مصر ETA وغيرها) */}
          <details className="rounded-xl border border-gray-200 bg-gray-50/60">
            <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-semibold text-gray-700 flex items-center gap-2">
              {tr('أكواد الفوترة الإلكترونية')}
              <span className="text-[10px] font-normal text-gray-400">{tr('اختياري يلزم لبعض الدول')}</span>
            </summary>
            <div className="px-4 pb-4 pt-1 grid grid-cols-2 gap-4">
              <div>
                <label className="label">{tr('نوع كود الصنف')}</label>
                <select className="input" {...register('itemCodeType')}>
                  <option value="EGS">EGS</option>
                  <option value="GS1">GS1 (GTIN)</option>
                </select>
              </div>
              <div>
                <label className="label">{tr('كود الصنف')} (EGS/GS1)</label>
                <input className="input" dir="ltr" {...register('itemCode')} placeholder="EG-xxxx / 6221xxxxxxxxx" />
              </div>
              <div className="col-span-2">
                {/* للصنف وحدات: هذا رمز وحدة الأساس، ولكل وحدة بيعٍ رمزها في قسم «وحدات البيع» (بند الفاتورة يحمل رمز وحدته) */}
                <label className="label">{units.length > 0 ? tr('كود وحدة الأساس') : tr('كود الوحدة')}</label>
                <input className="input" dir="ltr" {...register('unitCode')} placeholder={tr('حسب جدول وحدات المزود مثال EA')} />
              </div>
            </div>
          </details>

          <div className="flex gap-3 pt-2">
            <button type="submit" disabled={loading} className="btn-primary flex-1 justify-center py-2.5">
              {loading ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : null}
              {product ? tr('حفظ التعديلات') : tr('إضافة الصنف')}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** رسالة الخادم لا «حدث خطأ» العمياء — سبب الرفض (معاملٌ مكرّر، اسمٌ مستخدم، ٤٠٩ التحويل) يصل للمالك */
const serverMessage = (err: unknown): string | undefined =>
  (err as { response?: { data?: { message?: string } } })?.response?.data?.message;

/**
 * قسم «وحدات البيع» في نافذة الصنف: وحداتٌ أكبر من الأساس بالاسم والمعامل والسعر الاختياري والرمز الضريبي — إضافةً
 * وتعديلاً وإيقافاً وحذفاً، كلٌّ يُحفظ فوراً بمساره (productApi.addUnit/updateUnit/removeUnit). ومعه زرّ «تحويل إلى وحدة
 * أصغر» لصنفٍ له تاريخ (productApi.convertBase).
 *
 * لماذا فوراً لا مع «حفظ التعديلات»: الوحدة صفٌّ مستقلّ يحرسه الخادم بقفل الصنف (إضافةٌ تتزامن مع تحويل)، وجمعُها مع
 * حفظ الصنف يجعل فشل أحدهما نصف حفظٍ لا يعرف المالك أيّ نصفيه التزم.
 *
 * والحذف فعليّ (الصفوف تحمل لقطة وحدتها فلا ينكسر تاريخ)، والإيقاف يحجبها عن البيع الجديد ويُبقي رفع مستندٍ أوف‑لاين صدر بها.
 */
function ProductUnitsSection({ productId, baseUnit, basePrice, units, onUnits, onConverted }: {
  productId: string | null;
  baseUnit: string;
  basePrice: number;
  units: ProductUnit[];
  onUnits: (u: ProductUnit[]) => void;
  onConverted: (p: Product) => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  // تقييدٌ مؤقّت: التحويل بجلسة المالك وحدها (الخادم يفرضه؛ هذا إخفاءٌ للزرّ) — docs/multi-unit/REVIEW.md
  const ownerSession = useAuthStore(s => !!s.impersonating);
  const [adding, setAdding] = useState<UnitForm>(EMPTY_UNIT_FORM);
  const [editId, setEditId] = useState<string | null>(null);
  const [editing, setEditing] = useState<UnitForm>(EMPTY_UNIT_FORM);
  const [busy, setBusy] = useState<string | null>(null);
  const [showConvert, setShowConvert] = useState(false);

  // قوائم الأصناف في الصفحات الأخرى (الفاتورة والتحميل والوارد) تقرأ الوحدات — تتبع كل تغيير
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['products'] });
    qc.invalidateQueries({ queryKey: ['products-all'] });
    qc.invalidateQueries({ queryKey: ['products-min'] });
  };
  const sorted = [...units].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || Number(a.factor) - Number(b.factor));
  const product = { unit: baseUnit, units };

  // Enter في خانات الوحدة لا يُرسل نموذج الصنف كلّه (القسم داخل <form> الصنف)
  const noSubmit = (e: React.KeyboardEvent) => { if (e.key === 'Enter') e.preventDefault(); };

  if (!productId) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 p-3 text-xs text-gray-500 flex items-center gap-2">
        <Layers size={14} className="text-gray-400 shrink-0" />
        {tr('احفظ الصنف أولا ثم أضف له وحدات بيع أكبر مثل الكرتون')}
      </div>
    );
  }

  const add = async () => {
    const problem = unitFormProblem(adding, product);
    if (problem) { toast.error(tr(problem)); return; }
    setBusy('add');
    try {
      const { data } = await productApi.addUnit(productId, unitFormPayload(adding));
      onUnits([...units, data.data as ProductUnit]);
      setAdding(EMPTY_UNIT_FORM);
      refresh();
      toast.success(tr('أضيفت الوحدة'));
    } catch (err) { toast.error(tr(serverMessage(err) || 'تعذر الحفظ')); }
    setBusy(null);
  };

  const saveEdit = async (u: ProductUnit) => {
    const problem = unitFormProblem(editing, product, u.id);
    if (problem) { toast.error(tr(problem)); return; }
    setBusy(u.id);
    try {
      const { data } = await productApi.updateUnit(productId, u.id, unitFormPayload(editing));
      onUnits(units.map(x => (x.id === u.id ? (data.data as ProductUnit) : x)));
      setEditId(null);
      refresh();
      toast.success(tr('حفظت الوحدة'));
    } catch (err) { toast.error(tr(serverMessage(err) || 'تعذر الحفظ')); }
    setBusy(null);
  };

  const toggle = async (u: ProductUnit) => {
    setBusy(u.id);
    try {
      const { data } = await productApi.updateUnit(productId, u.id, { isActive: u.isActive === false });
      onUnits(units.map(x => (x.id === u.id ? (data.data as ProductUnit) : x)));
      refresh();
      toast.success(u.isActive === false ? tr('فعلت الوحدة') : tr('أوقفت الوحدة'));
    } catch (err) { toast.error(tr(serverMessage(err) || 'تعذر الحفظ')); }
    setBusy(null);
  };

  const remove = async (u: ProductUnit) => {
    if (!window.confirm(`${tr('حذف الوحدة نهائيا؟ الفواتير والحركات السابقة بها تبقى كما هي وللإيقاف المؤقت استخدم إيقاف')} — ${u.name}`)) return;
    setBusy(u.id);
    try {
      await productApi.removeUnit(productId, u.id);
      onUnits(units.filter(x => x.id !== u.id));
      if (editId === u.id) setEditId(null);
      refresh();
      toast.success(tr('حذفت الوحدة'));
    } catch (err) { toast.error(tr(serverMessage(err) || 'تعذر الحذف')); }
    setBusy(null);
  };

  /** خانات وحدةٍ (إضافة أو تعديل) — الاسم والمعامل والسعر الاختياري والرمز الضريبي */
  const fields = (f: UnitForm, set: (f: UnitForm) => void) => (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" onKeyDown={noSubmit}>
      <input className="input py-1.5 text-sm" maxLength={24} value={f.name} placeholder={tr('اسم الوحدة')}
        aria-label={tr('اسم الوحدة')} onChange={e => set({ ...f, name: e.target.value })} />
      <input className="input py-1.5 text-sm text-center" type="number" min="2" step="1" inputMode="numeric" value={f.factor}
        placeholder={tr('المعامل')} aria-label={tr('عدد وحدات الأساس فيها')} title={`${tr('عدد وحدات الأساس فيها')} (${baseUnit})`}
        onChange={e => set({ ...f, factor: e.target.value })} />
      <input className="input py-1.5 text-sm text-center" type="number" min="0" step="any" inputMode="decimal" value={f.price}
        placeholder={tr('السعر اختياري')} aria-label={tr('السعر اختياري')} title={tr('فارغ يعني سعر الأساس مضروبا في المعامل')}
        onChange={e => set({ ...f, price: e.target.value })} />
      <input className="input py-1.5 text-sm" dir="ltr" maxLength={16} value={f.unitCode} placeholder={tr('رمز الوحدة الضريبي')}
        aria-label={tr('رمز الوحدة الضريبي')} onChange={e => set({ ...f, unitCode: e.target.value })} />
    </div>
  );

  return (
    <div className="rounded-xl border border-gray-200 p-3 space-y-3" data-product-units="">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-gray-700 flex items-center gap-1.5"><Layers size={15} className="text-[#E15A30]" /> {tr('وحدات البيع')}</p>
          <p className="text-[11px] text-gray-500 mt-0.5">
            {tr('وحدة الأساس')}: <b className="text-gray-700">{baseUnit}</b> — {tr('أصغر ما يباع من الصنف وكل وحدة أكبر تعرف بعدد وحدات الأساس فيها')}
          </p>
        </div>
{ownerSession && (
        <button type="button" onClick={() => setShowConvert(true)} disabled={busy !== null}
          className="text-[11px] font-semibold text-[#6E6557] border border-[#E9E1D3] rounded-lg px-2.5 py-1 hover:bg-[#FAF7F0] flex items-center gap-1 disabled:opacity-50">
          <ArrowDownUp size={12} /> {tr('تحويل إلى وحدة أصغر')}
        </button>
        )}
      </div>

      {sorted.length === 0 ? (
        <p className="text-[11px] text-gray-400">{tr('لا وحدات إضافية والصنف يباع بوحدة الأساس وحدها')}</p>
      ) : (
        <div className="border border-gray-100 rounded-lg divide-y divide-gray-100">
          {sorted.map(u => {
            const off = u.isActive === false;
            const explicit = u.price != null;
            if (editId === u.id) {
              return (
                <div key={u.id} className="p-2 space-y-2 bg-[#FAF7F0]">
                  {fields(editing, setEditing)}
                  <p className="text-[10px] text-gray-500">{tr('تغيير المعامل لا يغير الفواتير والحركات السابقة فكل حركة تحفظ معامل وحدتها لحظتها')}</p>
                  <div className="flex gap-2">
                    <button type="button" onClick={() => saveEdit(u)} disabled={busy !== null} className="btn-primary py-1 px-3 text-xs disabled:opacity-60">{tr('حفظ')}</button>
                    <button type="button" onClick={() => setEditId(null)} className="btn-secondary py-1 px-3 text-xs">{tr('إلغاء')}</button>
                  </div>
                </div>
              );
            }
            return (
              <div key={u.id} className={`flex items-center gap-2 px-2.5 py-2 text-sm ${off ? 'opacity-60' : ''}`}>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-gray-800">
                    {u.name} <span className="text-[11px] font-normal text-gray-500">= {Number(u.factor)} {baseUnit}</span>
                    {off && <span className="ms-2 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{tr('موقوفة')}</span>}
                  </p>
                  <p className="text-[11px] text-gray-500">
                    {formatCurrency(unitPriceOf({ name: u.name, factor: Number(u.factor), price: u.price ?? undefined }, basePrice))}
                    {!explicit && <span className="text-gray-400"> · {tr('محسوب من سعر الأساس')}</span>}
                    {u.unitCode && <span className="font-mono" dir="ltr"> · {u.unitCode}</span>}
                  </p>
                </div>
                <button type="button" title={tr('تعديل')} disabled={busy !== null}
                  onClick={() => { setEditId(u.id); setEditing(unitFormOf(u)); }}
                  className="p-1.5 rounded text-[#E15A30] hover:bg-[#FBEBE2] disabled:opacity-40"><Pencil size={13} /></button>
                <button type="button" title={off ? tr('تفعيل') : tr('إيقاف')} disabled={busy !== null} onClick={() => toggle(u)}
                  className={`p-1.5 rounded disabled:opacity-40 ${off ? 'text-[#1E7A52] hover:bg-green-50' : 'text-amber-600 hover:bg-amber-50'}`}><Power size={13} /></button>
                <button type="button" title={tr('حذف')} disabled={busy !== null} onClick={() => remove(u)}
                  className="p-1.5 rounded text-red-500 hover:bg-red-50 disabled:opacity-40"><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>
      )}

      {/* إضافة وحدة */}
      <div className="space-y-2">
        {fields(adding, setAdding)}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-[10px] text-gray-400">{tr('تحفظ الوحدات فور إضافتها أو تعديلها')}</p>
          <button type="button" onClick={add} disabled={busy !== null || !adding.name.trim()}
            className="btn-secondary py-1 px-3 text-xs disabled:opacity-50"><Plus size={13} /> {tr('إضافة وحدة')}</button>
        </div>
      </div>

      {showConvert && (
        <ConvertBaseDialog
          productId={productId} baseUnit={baseUnit} basePrice={basePrice} units={units}
          onClose={() => setShowConvert(false)}
          onDone={(p) => { setShowConvert(false); setEditId(null); onConverted(p); refresh(); }}
        />
      )}
    </div>
  );
}

/**
 * «تحويل إلى وحدة أصغر» — نافذة تأكيد بلغة المالك قبل `productApi.convertBase`.
 *
 * الصنف الذي يُباع بالكرتون منذ سنة لا يصير «حبة» بتعديل اسم وحدته: كل فاتورةٍ وتحميلٍ مضى كُتب بالكرتون، فإعادة
 * التسمية تقرؤه حبّاتٍ (خطأ ٢٤ ضعفاً في كل رصيدٍ وتقرير). التحويل على الخادم يوسم كل صفٍّ قديم بوحدته ومعاملها فتبقى
 * أرقامه المطبوعة كما هي، والكرتون يصير وحدةً بمعامله وسعره، والأساس الجديد أصغر. و`expectedBaseName` = الأساس كما
 * رآه المالك حين فتح النافذة: تحويلٌ سبقه (نقرةٌ ثانية أو مديرٌ آخر) يُردّ ٤٠٩ «تغيّرت وحدة الأساس» برسالته هنا.
 */
function ConvertBaseDialog({ productId, baseUnit, basePrice, units, onClose, onDone }: {
  productId: string; baseUnit: string; basePrice: number; units: ProductUnit[];
  onClose: () => void; onDone: (p: Product) => void;
}) {
  const tr = useTr();
  // الأساس لحظة فتح النافذة — لا يتبع ما يتغيّر بعدها، فهو ما يتحقّق منه الخادم
  const [expected] = useState(baseUnit);
  const [form, setForm] = useState<ConvertForm>({ newBaseName: '', factor: '', basePrice: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const product = { unit: expected, basePrice, units };
  const problem = convertFormProblem(form, product);
  const preview = convertPreview(product, form);
  const newName = form.newBaseName.trim() || tr('الوحدة الجديدة');

  const confirm = async () => {
    if (problem) { setError(tr(problem)); return; }
    setBusy(true); setError('');
    try {
      const { data } = await productApi.convertBase(productId, convertPayload(form, expected));
      toast.success(tr('تم تحويل وحدة الأساس'));
      onDone(data.data as Product);
    } catch (err) {
      // ٤٠٩ BASE_UNIT_CHANGED: حُوّل الصنف أو عُدّل منذ فتح النافذة — رسالة الخادم تقول الأساس الآن، ولا يُعاد الإرسال
      setError(tr(serverMessage(err) || 'تعذر التحويل'));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" dir="rtl" onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-bold text-gray-800 flex items-center gap-2"><ArrowDownUp size={17} className="text-[#E15A30]" /> {tr('تحويل وحدة الأساس إلى وحدة أصغر')}</h3>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          {/* الشرح بلغة المالك: ما يتغيّر وما لا يتغيّر — قبل أي خانة */}
          <ul className="text-xs text-gray-600 space-y-1.5 leading-relaxed list-disc ps-4">
            <li>{tr('الصنف يباع اليوم بوحدة')} «<b>{expected}</b>». {tr('بعد التحويل تصير وحدة بيع بالمعامل الذي تكتبه وبسعرها الحالي')} ({formatCurrency(basePrice)})، {tr('وتصبح وحدة الأساس الجديدة هي الأصغر')}.</li>
            <li>{tr('أرقام الفواتير والحركات السابقة لا تتغير: ما بيع بها يبقى مطبوعا كما هو وتحسب كميته بالوحدة الجديدة تلقائيا')}</li>
            <li>{tr('أسعار العملاء الخاصة وشرائح الأسعار تقسم على المعامل فيبقى سعر الوحدة الحالية لكل عميل كما هو')}</li>
            <li>{tr('المندوب يستمر في البيع بالوحدة الحالية افتراضيا')}</li>
          </ul>

          <div>
            <label className="label">{tr('اسم وحدة الأساس الجديدة')} *</label>
            <input className="input" maxLength={24} value={form.newBaseName} placeholder={tr('حبة')}
              onChange={e => setForm(f => ({ ...f, newBaseName: e.target.value }))} />
          </div>
          <div>
            <label className="label">{tr('عدد وحدات الأساس الجديدة في الوحدة الحالية')} ({newName} / {expected}) *</label>
            <input className="input" type="number" min="2" step="1" inputMode="numeric" value={form.factor}
              onChange={e => setForm(f => ({ ...f, factor: e.target.value }))} />
          </div>
          <div>
            <label className="label">{tr('سعر وحدة الأساس الجديدة')} ({tr('اختياري')})</label>
            <input className="input" type="number" min="0" step="any" inputMode="decimal" value={form.basePrice}
              placeholder={preview ? String(preview.newBasePrice) : ''}
              onChange={e => setForm(f => ({ ...f, basePrice: e.target.value }))} />
            <p className="text-[10px] text-gray-400 mt-1">{tr('فارغ يعني السعر الحالي مقسوما على المعامل')}</p>
          </div>

          {preview && (
            <div className="rounded-lg bg-[#FAF7F0] border border-[#F1EBDF] p-3 text-xs text-gray-700 space-y-1" data-convert-preview="">
              <p><b>1 {preview.oldAsUnit.name}</b> = {preview.factor} {preview.newBaseName} · {formatCurrency(preview.oldAsUnit.price)}</p>
              <p>{preview.newBaseName}: {formatCurrency(preview.newBasePrice, undefined, 4)}</p>
              {preview.scaled.map(s => (
                <p key={s.name} className="text-gray-500">{s.name}: {s.from} {expected} ← {s.to} {preview.newBaseName}</p>
              ))}
            </div>
          )}

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
        </div>
        <div className="flex gap-3 p-4 border-t">
          <button type="button" onClick={confirm} disabled={busy || !!problem}
            className="btn-primary flex-1 justify-center py-2 disabled:opacity-60">
            {busy ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ArrowDownUp size={15} />}
            {tr('تأكيد التحويل')}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
