import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { productApi } from '../../api/client';
import { Product, ProductUnit, User } from '../../types';
import { useTr } from '../../i18n/strings';
import { useAuthStore } from '../../store/authStore';
import { X, Upload, Trash2, Image as ImageIcon, Pencil, Plus, Layers, ArrowDownUp, Power, Star } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatCurrency, formatNumber } from '../../utils/format';
import { formatQty, primaryUnitOf, unitPriceOf, type UnitDef } from '../../lib/units';
import {
  EMPTY_UNIT_FORM, unitFormOf, unitFormPayload, unitFormProblem, convertFormProblem, convertPreview, convertPayload, hasBigUnit,
  biggestUnit, productUnitLabel, EMPTY_REVERSE_FORM, reverseFormProblem, reverseCreatePayload, reverseEditPatch, reverseFormOf, reverseSubPrice,
  type UnitForm, type ConvertForm, type ReverseForm,
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

/* ═══ «الوحدة الرئيسية» (primary_unit_spec §4) ═══
 * طريقة تعريف الصنف: «بأصغر وحدة» (SMALL — النموذج كما كان حرفاً) أو «بالكرتون وفيه وحدة أصغر» (PRIMARY — الإنشاء العكسي
 * الذرّي في POST واحد). والحساب الداخلي لا ينقلب: الفرعية (قارورة) هي unit/basePrice والكرتون وحدةٌ بمعامل، وprimaryUnitId
 * عرضٌ وتعريفٌ وإدخالٌ افتراضي فقط (القاعدة ١٢). ونصوص الشاشة الجديدة بلا كلمة «الأساس» (D21). */
type DefMode = 'SMALL' | 'PRIMARY';
const DEF_MODES: DefMode[] = ['SMALL', 'PRIMARY'];
const DEF_MODE_LABELS: Record<DefMode, string> = {
  SMALL: 'أعرّف الصنف بأصغر وحدة (مثل الحبة)، وأضيف الكرتون وحدةً أكبر',
  PRIMARY: 'أعرّف الصنف بالكرتون، وفيه وحدة أصغر (مثل الحبة)',
};
/** آخر طريقةٍ اختارها هذا المستخدم لصنفٍ جديد — في المتصفح وحده (مفتاحٌ لكل مستخدم) ولا أثر في الخادم. تعذّر التخزين ⇒ الأولى */
const defModeKey = (userId: string | null | undefined) => `fs.productDefMode.${userId || '-'}`;
function readDefMode(userId: string | null | undefined): DefMode {
  try { return localStorage.getItem(defModeKey(userId)) === 'PRIMARY' ? 'PRIMARY' : 'SMALL'; } catch { return 'SMALL'; }
}
function writeDefMode(userId: string | null | undefined, m: DefMode): void {
  try { localStorage.setItem(defModeKey(userId), m); } catch { /* تخزينٌ محجوب (نافذة خاصة): يبقى الافتراض الأول */ }
}
/** رمز رفض الخادم ({ code }) — لتمييز «تغيّرت وحدات الصنف» (٤٠٩) عن غيره */
const serverCode = (err: unknown): string | undefined =>
  (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
/**
 * نموذجٌ قديم: الأساس أو الرئيسية تغيّرا منذ فُتح الصنف (تحويلٌ أو مديرٌ آخر)، أو الخادم يرى رئيسيةً لا يراها النموذج
 * (PRIMARY_UNIT_IN_USE) ⇒ «أعد فتحه» وإعادة الجلب، لا إعادة إرسالٍ صامتة
 */
const UNITS_STALE_CODES = new Set(['BASE_UNIT_CHANGED', 'PRIMARY_UNIT_CHANGED', 'PRIMARY_UNIT_IN_USE']);
const isUnitsStale = (err: unknown): boolean => UNITS_STALE_CODES.has(serverCode(err) ?? '');
const UNITS_STALE_MSG = 'تغيّرت وحدات الصنف — أعد فتحه';
/** تلميح «إضافة وحدة فرعية أصغر» المعطَّل بحسب سبب الخادم (convertBaseRefusalCode من ردّ الدخول — §4.2) */
const CONVERT_REFUSAL_HINTS: Record<NonNullable<User['convertBaseRefusalCode']>, string> = {
  OWNER_ONLY: 'غير مفعّلة لشركتك — اطلب تفعيلها من الدعم الفني',
  SCOPED_USER: 'تخصّ الشركة كلها — لمستخدم غير مقيّد بنطاق',
  ROLE_FORBIDDEN: 'لمستخدم بدور مدير أو مشرف',
  FORBIDDEN: 'تتطلّب صلاحيات الأصناف والفواتير ومخزون السيارات معاً',
};
const refusalHint = (code: User['convertBaseRefusalCode'] | undefined): string => CONVERT_REFUSAL_HINTS[code ?? 'OWNER_ONLY'];
/**
 * D21: رسائل تحقّقٍ مشتركة (lib/adminUnits.ts وlib/units.ts) فيها «الأساس» — تُعرض بديلتها في نافذة «إضافة وحدة فرعية أصغر»
 * وفي قسم الوحدات لصنفٍ له رئيسية. وغيرها (ولصنفٍ بلا رئيسية) يُعرض كما هو (I1)
 */
const D21_TEXT: Record<string, string> = {
  'معامل التحويل عدد صحيح أكبر من 1 — كم وحدة أساس جديدة في الوحدة الحالية': 'العدد صحيح أكبر من 1 — كم وحدة فرعية في الوحدة الحالية',
  'اسم وحدة الأساس الجديدة مطلوب': 'اسم الوحدة الفرعية مطلوب',
  'وحدة الأساس الجديدة هي الحالية نفسها': 'الوحدة الفرعية باسم الوحدة الحالية نفسها',
  'اسم وحدة الأساس الجديدة مستخدم لوحدة أخرى لهذا الصنف': 'اسم الوحدة الفرعية مستخدم لوحدة أخرى لهذا الصنف',
  'يوجد وحدة باسم وحدة الأساس الحالية لهذا الصنف': 'يوجد وحدة باسم الوحدة الحالية لهذا الصنف',
  'معامل الوحدة الإضافية أكبر من 1 — المعامل 1 هو وحدة الأساس نفسها': 'معامل الوحدة أكبر من 1 — المعامل 1 هو الوحدة الصغرى نفسها',
  'معامل التحويل عدد صحيح — وحدة الأساس هي الأصغر': 'المعامل عدد صحيح — الوحدة الصغرى هي الأصغر',
};
const d21 = (msg: string): string => D21_TEXT[msg] ?? msg;
/** نصٌّ بقيمٍ مسمّاة — يُترجَم النص كاملاً ثم تُبدَّل القيم ({unit} …) في كل مواضعها */
const fill = (s: string, vals: Record<string, string | number>): string =>
  Object.entries(vals).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), s);
/** رقمٌ من خانة (الأرقام الهندية والفاصلة العربية كاللاتينية) — للمعاينة وحدها، والتحقق في reverseFormProblem */
const fieldNum = (raw: string): number => {
  const s = String(raw ?? '').trim().replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace('٫', '.');
  return s === '' ? NaN : Number(s);
};

export default function ProductModal({ product, onClose, onSave, loading, zatcaCollect = false, lotTrackingOn = false }: Props) {
  const tr = useTr();
  const qc = useQueryClient();
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

  // «الوحدة الرئيسية»: معرّفها كما ردّه الخادم آخر مرة (يتبع التبديل والتحويل وإضافة وحدةٍ رئيسية)، وصلاحيتها من primaryUnitOf
  // (معرّفٌ تالف أو وحدةٌ موقوفة ⇒ null ⇒ النموذج كما كان حرفاً)
  const [primaryUnitId, setPrimaryUnitId] = useState<string | null>(product?.primaryUnitId ?? null);
  const primary = primaryUnitOf({ primaryUnitId, units });
  const userId = useAuthStore(s => s.user?.id);
  // «إضافة وحدة فرعية أصغر» (convert-base): الإذن يحسبه الخادم لحظة الدخول (adminPermissionFields) ويحكم في كل طلب. وجلسة
  // المالك مسموحةٌ دائماً في الخادم — فجلسةٌ محفوظة قبل الحقل الجديد لا تفقد الزرّ
  const canConvertBase = useAuthStore(s => s.user?.canConvertBase === true || !!s.impersonating);
  const convertRefusal = useAuthStore(s => s.user?.convertBaseRefusalCode ?? null);
  // صنفٌ جديد: الطريقة آخر ما اختاره هذا المستخدم. وصنفٌ قائم: تُشتقّ من رئيسيّه — والانتقال بخيارَي switchAsk لا بالتبديل المباشر
  const [defMode, setDefMode] = useState<DefMode>(() => (product ? 'SMALL' : readDefMode(userId)));
  const reverseLayout = product ? !!primary : defMode === 'PRIMARY';
  const [rev, setRev] = useState<ReverseForm>(() => reverseFormOf(product) ?? EMPTY_REVERSE_FORM);
  const [switchAsk, setSwitchAsk] = useState<null | 'TO_PRIMARY' | 'TO_SMALL'>(null);
  const [switchChoice, setSwitchChoice] = useState<null | 'EXISTING' | 'CONVERT'>(null);
  const [switchUnitId, setSwitchUnitId] = useState<string>('');
  const [convertOpen, setConvertOpen] = useState(false);
  const [modeBusy, setModeBusy] = useState(false);

  // قوائم الأصناف في الصفحات الأخرى (الفاتورة والتحميل والوارد) تقرأ الوحدات — تتبع كل تغيير
  const refreshLists = () => {
    qc.invalidateQueries({ queryKey: ['products'] });
    qc.invalidateQueries({ queryKey: ['products-all'] });
    qc.invalidateQueries({ queryKey: ['products-min'] });
  };
  /** يأخذ الصنف كما ردّه الخادم (تحويلٌ، تبديل رئيسية، إعادة جلبٍ بعد ٤٠٩): الوحدات والأساس وسعره والرئيسية وخانات النموذج */
  const adopt = (p: Product) => {
    setUnits(p.units ?? []);
    setSavedBase(p.unit);
    setSavedBasePrice(Number(p.basePrice));
    setPrimaryUnitId(p.primaryUnitId ?? null);
    // الأساس صار الجديد وسعره: الخانتان تتبعانه، وإلا أعاد «حفظ التعديلات» بعده الاسمَ القديم فرفضه الخادم
    setValue('unit', p.unit);
    setValue('basePrice', Number(p.basePrice));
    if (p.unitCode !== undefined) setValue('unitCode', p.unitCode);
    setRev(reverseFormOf(p) ?? EMPTY_REVERSE_FORM);
  };
  /** ٤٠٩ «تغيّرت وحدات الصنف»: رسالة ثم إعادة جلب الصنف وقوائمه — فلا يُعاد إرسال نموذجٍ بُني على أساسٍ قديم */
  const reloadStale = async () => {
    toast.error(tr(UNITS_STALE_MSG));
    refreshLists();
    if (!product) return;
    try { adopt((await productApi.get(product.id)).data.data as Product); } catch { /* تبقى الرسالة: «أعد فتحه» */ }
  };
  /** الرئيسية صارت `id` (أو أُلغيت بـnull) من قسم الوحدات: النموذج العكسي يُملأ من الصنف المحفوظ بوحداته الجديدة */
  const primaryChanged = (nextUnits: ProductUnit[], id: string | null) => {
    setUnits(nextUnits);
    setPrimaryUnitId(id);
    const saved = { unit: savedBase, basePrice: savedBasePrice, unitCode: getValues('unitCode') ?? null, units: nextUnits, primaryUnitId: id };
    setRev(reverseFormOf(saved) ?? EMPTY_REVERSE_FORM);
    // العودة إلى التعريف بأصغر وحدة: الخانتان بقيمتيهما المحفوظتين — لا ما بقي فيهما من قبل
    if (!id) { setValue('unit', savedBase); setValue('basePrice', savedBasePrice); }
  };
  /** الوحدات تغيّرت من قسمها: خانات الرئيسية في النموذج العكسي تتبع صفّها المحفوظ — وإلا أعاد «حفظ التعديلات» قيمها القديمة فوقه */
  const onUnits = (next: ProductUnit[]) => {
    setUnits(next);
    const pu = primaryUnitOf({ primaryUnitId, units: next });
    if (pu) {
      setRev(r => ({
        ...r, primaryName: pu.name, factor: String(Math.round(Number(pu.factor))),
        primaryPrice: String(unitPriceOf(pu, savedBasePrice)), primaryUnitCode: pu.unitCode ?? '',
      }));
    }
  };
  const closeSwitch = () => { setSwitchAsk(null); setSwitchChoice(null); setSwitchUnitId(''); };
  /** تبديل الرئيسية (D11: مجرّد علم) — expectedPrimaryUnitId ما رآه النموذج، فتغيّرٌ سبقه يُردّ ٤٠٩ */
  const setPrimary = async (unitId: string | null) => {
    if (!product) return;
    setModeBusy(true);
    try {
      const { data } = await productApi.setPrimaryUnit(product.id, { unitId, expectedPrimaryUnitId: primaryUnitId });
      adopt(data.data as Product);
      closeSwitch();
      refreshLists();
      toast.success(unitId ? tr('صارت الوحدة الرئيسية') : tr('ألغيت الوحدة الرئيسية'));
    } catch (err) {
      if (isUnitsStale(err)) await reloadStale();
      else toast.error(tr(serverMessage(err) || 'تعذر الحفظ'));
    }
    setModeBusy(false);
  };
  const currentMode: DefMode = product ? (primary ? 'PRIMARY' : 'SMALL') : defMode;
  const pickMode = (m: DefMode) => {
    if (!product) { setDefMode(m); writeDefMode(userId, m); return; }
    if (m === currentMode) { closeSwitch(); return; }
    setSwitchChoice(null);
    setSwitchAsk(m === 'PRIMARY' ? 'TO_PRIMARY' : 'TO_SMALL');
  };
  // خيار (أ) «اجعل وحدة موجودة رئيسية»: الوحدات النشطة الأكبر، وافتراض المنتقي أصغرها. ولا خيارَ مختارٌ مسبقاً بين (أ) و(ب) —
  // النظام لا يميّز «قارورة لها كرتون» من «كرتون له طبلية» (§4.2)
  const activeBig = units.filter(u => u.isActive !== false && Number(u.factor) > 1).sort((a, b) => Number(a.factor) - Number(b.factor));
  const switchUnit = activeBig.find(u => u.id === switchUnitId) ?? activeBig[0] ?? null;
  const continueSwitch = () => {
    if (switchChoice === 'EXISTING' && switchUnit) void setPrimary(switchUnit.id);
    else if (switchChoice === 'CONVERT' && canConvertBase) { closeSwitch(); setConvertOpen(true); }
  };

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
  // الوحدات الكبرى لـ«قيود المندوب»: وحدات الصنف المحفوظة، وللصنف الجديد بالكرتون رئيسيّته التي تُنشأ معه في الطلب نفسه
  const newReverse = reverseLayout && !product;
  const bigNames = newReverse
    ? (reverseFormProblem(rev) === null ? [rev.primaryName.trim()] : [])
    : units.filter((u) => Number(u.factor) > 1 && u.isActive !== false).map((u) => u.name);
  const submit = (data: Partial<Product>) => {
    // units تُحفظ بمساراتها لا مع الصنف — وإرسال لقطتها القديمة (من فتح النافذة) لا معنى له فتُنزع من الحمولة
    // وعلما اللوط من الصنف المحمَّل (lotTracked وحقبته) لا يُعادان كما هما: الانتقال وحده يُرسل (productLotPayload أدناه)
    // و«الوحدة الرئيسية» المحمّلة (primaryUnitId وbaseConvertedAt) لا تُعاد: الخادم يتجاهلها، وتبديلها بمسارها وحده
    const { vatCategory: cat, vatExemptionCode, vatExemptionReason, primaryUnitId: _primaryUnitId, baseConvertedAt: _baseConvertedAt, lotTracked: _lotTracked, lotTrackedSince: _lotTrackedSince, units: _units, ...rest } = data;
    void _units; void _lotTracked; void _lotTrackedSince; void _primaryUnitId; void _baseConvertedAt;
    // الطريقة العكسية (صنفٌ جديد بالكرتون، أو قائمٌ له رئيسية): الخانات من نموذجها، والتحقق قبل الإرسال بقاعدة الخادم
    if (reverseLayout) {
      const problem = reverseFormProblem(rev);
      if (problem) { toast.error(tr(problem)); return; }
    }
    // اسم الأساس لا يأخذ اسم وحدةٍ أكبر للصنف نفسه (والخادم يرفضه) — «٢ كرتون» تصير ملتبسة بين الأساس والكرتون
    const newBase = reverseLayout ? rev.subName.trim() : String(rest.unit ?? '').trim();
    if (product && newBase !== savedBase.trim() && units.some(u => u.name.trim() === newBase && !(reverseLayout && u.id === primary?.id))) {
      toast.error(tr(reverseLayout ? 'اسم الوحدة الفرعية مستخدم لوحدة أخرى لهذا الصنف' : 'اسم وحدة الأساس مستخدم لوحدة أخرى لهذا الصنف'));
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
    // «قيود المندوب»: «الكبرى فقط» يلزمه وحدةٌ كبرى نشطة (والخادم يرفض بـREP_UNIT_RULE_INVALID) — وللصنف الجديد بالكرتون
    // رئيسيّته وحدةٌ كبرى تُنشأ معه
    const repSaleUnit = rest.repSaleUnit || 'ANY';
    const repReturnUnit = rest.repReturnUnit || 'ANY';
    if ((repSaleUnit === 'LARGE' || repReturnUnit === 'LARGE') && !(newReverse ? bigNames.length > 0 : hasBigUnit(units))) {
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
      // «الوحدة الرئيسية»: الإنشاء العكسي في POST واحد ذرّي (الصنف ووحداته ورئيسيّه)، وتعديل صنفٍ له رئيسية برقعتها ذرّياً.
      // وكل تعديلٍ لصنفٍ قائم يحمل الأساس كما رآه النموذج — تحويلٌ سبقه يُردّ ٤٠٩ BASE_UNIT_CHANGED فلا يُكتب سعر الكرتون للقارورة
      ...(newReverse ? reverseCreatePayload(rev) : {}),
      ...(reverseLayout && product && primary?.id ? reverseEditPatch(rev, primary.id) : {}),
      ...(product ? { expectedBaseName: savedBase } : {}),
    } as Partial<Product>);
  };
  const revSet = (k: keyof ReverseForm) => (e: React.ChangeEvent<HTMLInputElement>) => { const v = e.target.value; setRev(r => ({ ...r, [k]: v })); };
  const revPrimaryName = rev.primaryName.trim() || tr('الوحدة الرئيسية');
  const revSubName = rev.subName.trim() || tr('الوحدة الفرعية');
  const revOk = reverseFormProblem(rev) === null;
  // المعاينة الحيّة: «1 كرتون = 24 قارورة · 48.00 / كرتون · 2.00 / قارورة» — سعر القارورة المكتوب وإلا المشتقّ (D10)
  const revFactor = Math.round(fieldNum(rev.factor));
  const revPrimaryPrice = fieldNum(rev.primaryPrice);
  const revDerivedHint = Number.isFinite(revPrimaryPrice) && revPrimaryPrice >= 0 && Number.isInteger(revFactor) && revFactor >= 2
    ? reverseSubPrice({ ...rev, subPrice: '' }) : null;

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

          {/* «طريقة تعريف الصنف» (§4.1–٤.2) — فوق خانتي الوحدة والسعر، بنصّ مثالٍ لا مصطلح (D21) */}
          <div data-def-mode="">
            <label className="label">{tr('طريقة تعريف الصنف')}</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label={tr('طريقة تعريف الصنف')}>
              {DEF_MODES.map(m => {
                const on = currentMode === m;
                return (
                  <button key={m} type="button" role="radio" aria-checked={on} disabled={modeBusy} onClick={() => pickMode(m)}
                    className={`text-right rounded-xl border-2 px-3 py-2 text-xs leading-relaxed transition-colors disabled:opacity-60 ${on ? 'border-[#E15A30] bg-[#FBEBE2] text-[#1F1A13] font-semibold' : 'border-[#E9E1D3] bg-white text-[#6E6557] hover:border-[#D8CDB9]'}`}>
                    {tr(DEF_MODE_LABELS[m])}
                  </button>
                );
              })}
            </div>

            {/* صنفٌ قائم إلى «بالكرتون»: خياران دائماً بأسماء وحداته، ولا خيارَ مختارٌ مسبقاً — والمتابعة معطّلة حتى يختار */}
            {product && switchAsk === 'TO_PRIMARY' && (
              <div className="mt-2 rounded-xl border border-[#E9E1D3] bg-[#FAF7F0] p-3 space-y-2 text-xs" data-switch-primary="">
                {activeBig.length > 0 && switchUnit && (
                  <label className="flex items-start gap-2 cursor-pointer" data-switch-existing="">
                    <input type="radio" name="switch-primary" className="mt-0.5 accent-[#E15A30]" checked={switchChoice === 'EXISTING'} onChange={() => setSwitchChoice('EXISTING')} />
                    <span className="flex-1 space-y-1">
                      <span className="block font-semibold text-[#1F1A13]">
                        {fill(tr('اجعل «{unit}» رئيسية (يبقى «{base}» أصغر وحدة)'), { unit: switchUnit.name, base: savedBase })}
                      </span>
                      {activeBig.length > 1 && (
                        <select className="input py-1 text-xs w-auto" value={switchUnit.id} aria-label={tr('الوحدة الرئيسية')}
                          onChange={e => { setSwitchUnitId(e.target.value); setSwitchChoice('EXISTING'); }}>
                          {activeBig.map(u => <option key={u.id} value={u.id}>{u.name} ({Number(u.factor)} {savedBase})</option>)}
                        </select>
                      )}
                    </span>
                  </label>
                )}
                <label className={`flex items-start gap-2 ${canConvertBase ? 'cursor-pointer' : 'opacity-60'}`} data-switch-convert=""
                  title={canConvertBase ? undefined : tr(refusalHint(convertRefusal))}>
                  <input type="radio" name="switch-primary" className="mt-0.5 accent-[#E15A30]" disabled={!canConvertBase}
                    checked={switchChoice === 'CONVERT'} onChange={() => setSwitchChoice('CONVERT')} />
                  <span className="flex-1">
                    <span className="block font-semibold text-[#1F1A13]">{fill(tr('اجعل «{unit}» رئيسية وأضف وحدة أصغر منها'), { unit: savedBase })}</span>
                    <span className="block text-[#6E6557]">{fill(tr('مثال: «{unit}» فيه 24 قارورة'), { unit: savedBase })}</span>
                    {!canConvertBase && (
                      <span className="block text-amber-800" data-convert-refusal="">{tr(refusalHint(convertRefusal))}</span>
                    )}
                  </span>
                </label>
                <div className="flex gap-2">
                  <button type="button" onClick={continueSwitch} disabled={modeBusy || switchChoice === null}
                    className="btn-primary py-1 px-3 text-xs disabled:opacity-50">{tr('متابعة')}</button>
                  <button type="button" onClick={closeSwitch} className="btn-secondary py-1 px-3 text-xs">{tr('إلغاء')}</button>
                </div>
              </div>
            )}
            {/* العودة إلى التعريف بأصغر وحدة: تأكيدٌ ثم إلغاء الرئيسية (علمٌ وحده — لا رصيد ولا سعر يتغيّر) */}
            {product && switchAsk === 'TO_SMALL' && primary && (
              <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 space-y-2 text-xs text-amber-900" data-switch-small="">
                <p className="leading-relaxed">{fill(tr('يعود الصنف إلى التعريف بأصغر وحدة «{base}» ولا تبقى «{unit}» الوحدة الرئيسية — لا يتغير أي رصيد أو سعر'), { base: savedBase, unit: primary.name })}</p>
                <div className="flex gap-2">
                  <button type="button" onClick={() => void setPrimary(null)} disabled={modeBusy} className="btn-primary py-1 px-3 text-xs disabled:opacity-50">{tr('تأكيد')}</button>
                  <button type="button" onClick={closeSwitch} className="btn-secondary py-1 px-3 text-xs">{tr('إلغاء')}</button>
                </div>
              </div>
            )}
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
            {/* الطريقة العكسية: الخانتان مخفيّتان وrequired مشروطٌ بها — الوحدة والسعر من نموذج الكرتون أدناه */}
            {!reverseLayout && (
              <div>
                <label className="label">{tr('وحدة القياس')} *</label>
                <input className="input" {...register('unit', { required: !reverseLayout })} placeholder={tr('كرتون / قطعة / كيلو')} />
                {/* صنفٌ قائم: الخانة إعادة تسمية لا تحويل — «كرتون» تُسمّى «حبة» فتُقرأ مبيعات سنةٍ حبّاتٍ (خطأ ٢٤ ضعفاً) */}
                {product && (
                  <p className="text-[10px] text-gray-400 mt-1 leading-relaxed">{tr('تغيير الاسم هنا إعادة تسمية فقط — لإضافة وحدة أصغر استخدم «إضافة وحدة فرعية أصغر»')}</p>
                )}
              </div>
            )}
            {!reverseLayout && (
              <div>
                {/* D21: لصنفٍ له رئيسية «سعر {الوحدة} الواحدة» بلا تلميح — وبلاها «السعر الأساسي» وتلميحه كما كانا (I1) */}
                <label className="label">{primary ? fill(tr('سعر {unit} الواحدة'), { unit: savedBase }) : tr('السعر الأساسي')} *</label>
                <input type="number" className="input" min="0" step="any" inputMode="decimal" {...register('basePrice', { required: !reverseLayout, valueAsNumber: true })} />
                {units.length > 0 && !primary && <p className="text-[10px] text-gray-400 mt-1">{tr('سعر وحدة الأساس')}</p>}
              </div>
            )}
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

          {/* «بالكرتون وفيه وحدة أصغر» (§4.1، ولصنفٍ قائم له رئيسية §4.2): الرئيسية واسمها وسعرها والعدد، ثم الفرعية وسعرها،
              ورمزا الوحدة الضريبيان في «متقدّم». الحساب الداخلي بالفرعية (القاعدة ١٢) */}
          {reverseLayout && (
            <div className="rounded-xl border border-gray-200 p-3 space-y-3" data-reverse-form="">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">{tr('الوحدة الرئيسية')} *</label>
                  <input className="input" maxLength={24} value={rev.primaryName} placeholder={tr('مثال: كرتون')} onChange={revSet('primaryName')} />
                </div>
                <div>
                  <label className="label">{fill(tr('سعر {unit}'), { unit: revPrimaryName })} *</label>
                  <input type="number" className="input" min="0" step="any" inputMode="decimal" value={rev.primaryPrice} onChange={revSet('primaryPrice')} />
                  <p className="text-[10px] text-gray-400 mt-1">{tr('قبل الضريبة')}</p>
                </div>
                <div>
                  <label className="label">{tr('الوحدة الفرعية')} *</label>
                  <input className="input" maxLength={24} value={rev.subName} placeholder={tr('مثال: قارورة')} onChange={revSet('subName')} />
                </div>
                <div>
                  <label className="label">{fill(tr('كم {sub} في {primary}'), { sub: revSubName, primary: revPrimaryName })} *</label>
                  <input type="number" className="input" min="2" step="1" inputMode="numeric" value={rev.factor} onChange={revSet('factor')} />
                  <p className="text-[10px] text-gray-400 mt-1">{tr('مثال: كرتون فيه 24 قارورة')}</p>
                </div>
                <div className="col-span-2">
                  <label className="label">{fill(tr('سعر {unit} الواحدة'), { unit: revSubName })} ({tr('اختياري')})</label>
                  <input type="number" className="input" min="0" step="any" inputMode="decimal" value={rev.subPrice} onChange={revSet('subPrice')}
                    placeholder={revDerivedHint != null ? `≈ ${revDerivedHint} ${tr('محسوب')}` : ''} />
                  <p className="text-[10px] text-gray-400 mt-1">{fill(tr('فارغ يعني سعر {unit} مقسوما على العدد'), { unit: revPrimaryName })}</p>
                </div>
              </div>
              <details className="rounded-lg border border-gray-100 bg-gray-50/60">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-gray-600">{tr('متقدم')}</summary>
                <div className="px-3 pb-3 pt-1 grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">{fill(tr('رمز الوحدة الضريبي لـ{unit}'), { unit: revPrimaryName })}</label>
                    <input className="input" dir="ltr" maxLength={16} value={rev.primaryUnitCode} placeholder="CT" onChange={revSet('primaryUnitCode')} />
                  </div>
                  <div>
                    <label className="label">{fill(tr('رمز الوحدة الضريبي لـ{unit}'), { unit: revSubName })}</label>
                    <input className="input" dir="ltr" maxLength={16} value={rev.subUnitCode} placeholder="PCE" onChange={revSet('subUnitCode')} />
                  </div>
                </div>
              </details>
              {revOk && (
                <p className="rounded-lg bg-[#FAF7F0] border border-[#F1EBDF] px-3 py-2 text-xs text-gray-700" data-reverse-preview="">
                  <b>1 {rev.primaryName.trim()}</b> = {revFactor} {rev.subName.trim()} · {formatCurrency(revPrimaryPrice)} / {rev.primaryName.trim()} · {formatCurrency(reverseSubPrice(rev), undefined, 4)} / {rev.subName.trim()}
                </p>
              )}
              {product && <p className="text-[10px] text-gray-400 leading-relaxed">{tr('تغيير اسم الوحدة الفرعية هنا إعادة تسمية فقط — لإضافة وحدة أصغر استخدم «إضافة وحدة فرعية أصغر»')}</p>}
            </div>
          )}

          {/* وحدات البيع (الوحدات المتعددة): وحدة الأساس أصغر ما يُباع، والكرتون والطبلية وحداتٌ بمعاملها. والصنف الجديد بالكرتون
              يُنشأ بوحدته في الطلب نفسه، فلا «احفظ الصنف أولاً» */}
          {!newReverse && (
            <ProductUnitsSection
              productId={product?.id ?? null}
              baseUnit={savedBase}
              basePrice={savedBasePrice}
              units={units}
              onUnits={onUnits}
              primaryUnitId={primary?.id ?? null}
              canConvertBase={canConvertBase}
              convertRefusal={convertRefusal}
              onSetPrimary={(unitId) => setPrimary(unitId)}
              onPrimaryChanged={primaryChanged}
              onStale={reloadStale}
              onConvert={() => setConvertOpen(true)}
              syncRepUnitRules={async () => {
                /* «قيود المندوب» تُحفظ مع «حفظ التعديلات» والوحدات فوراً: من غيّر القيد في النموذج ثم حذف آخر وحدةٍ كبرى رفضه
                 * الخادم (409 REP_UNIT_RULE_SET يقرأ القيد المحفوظ) وهو يرى القيد مُزالاً أمامه. فيُحفظ القيد كما في النموذج.
                 * و«الكبرى فقط» لفعلٍ ممنوعٍ على المندوب أصلاً لا أثر له (لا يبيعه/لا يرجعه بأي وحدة)، فيُعاد «كل الوحدات».
                 * ويبقى الرفض حين يطلب النموذج نفسه «الكبرى فقط» لفعلٍ مسموح — حذف آخر وحدةٍ كبرى يمنع الصنف عليه بلا قصد. */
                if (!product?.id) return false;
                const v = getValues();
                const saleOn = v.repSaleAllowed !== false;
                const returnOn = v.repReturnAllowed !== false;
                const repSaleUnit = saleOn ? (v.repSaleUnit || 'ANY') : 'ANY';
                const repReturnUnit = returnOn ? (v.repReturnUnit || 'ANY') : 'ANY';
                if (repSaleUnit === 'LARGE' || repReturnUnit === 'LARGE') return false;
                // وككل PUT للصنف يحمل الأساس كما رآه النموذج (§4.2) — الخادم لا يسأله ما دام لا يمسّ الوحدة أو السعر
                await productApi.update(product.id, { repSaleAllowed: saleOn, repReturnAllowed: returnOn, repSaleUnit, repReturnUnit, expectedBaseName: savedBase });
                setValue('repSaleUnit', repSaleUnit);
                setValue('repReturnUnit', repReturnUnit);
                return true;
              }}
            />
          )}
          {/* «إضافة وحدة فرعية أصغر» (convert-base): من زرّ قسم الوحدات أو من الخيار (ب) في «طريقة تعريف الصنف» */}
          {convertOpen && product && (
            <ConvertBaseDialog
              productId={product.id} baseUnit={savedBase} basePrice={savedBasePrice} units={units} primaryUnitId={primary?.id ?? null}
              onClose={() => setConvertOpen(false)}
              onStale={() => { setConvertOpen(false); void reloadStale(); }}
              onDone={(p) => {
                setConvertOpen(false);
                closeSwitch();
                adopt(p);
                // «قيود المندوب»: التحويل يقلب معنى الصغرى والكبرى، والخادم لا يقبله إلا والقيد المحفوظ «كل الوحدات» —
                // فقيدُ وحدةٍ اختير قبله ولم يُحفظ يُعاد إليه كي لا يُحفظ بعده بمعنىً آخر
                setValue('repSaleUnit', 'ANY');
                setValue('repReturnUnit', 'ANY');
                refreshLists();
              }}
            />
          )}

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
              الإدارة حرّة، وتطبيق المندوب يُخفي الممنوع، والخادم يرفضه. «الصغرى» وحدة الأساس، و«الكبرى» كل وحدةٍ أكبر منها
              (مستقلّةً عن «الوحدة الرئيسية»: قيدٌ بوحدةٍ للمندوب يغلب افتراض الرئيسية) */}
          <div className="rounded-xl border border-gray-200 p-3 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-700">{tr('قيود المندوب على الصنف')}</span>
              <span className="text-[10px] text-gray-400 mr-auto">{tr('لا تقيد الإدارة')}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {([['repSaleAllowed', 'repSaleUnit', 'يبيعه المندوب', 'وحدة البيع'], ['repReturnAllowed', 'repReturnUnit', 'يرجعه المندوب', 'وحدة المرتجع']] as const).map(([allowKey, unitKey, allowLabel, unitLabel]) => {
                const on = watch(allowKey) !== false;
                const big = bigNames;
                const smallName = newReverse ? rev.subName.trim() : savedBase;
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
                        <option value="BASE">{tr('بالوحدة الصغرى فقط')}{smallName ? ` — ${smallName}` : ''}</option>
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
              {/* الطريقة العكسية: رمزا الرئيسية والفرعية في «متقدّم» نموذجها — فلا خانةٌ ثانية لرمز الفرعية هنا */}
              {!reverseLayout && (
                <div className="col-span-2">
                  {/* للصنف وحدات: هذا رمز وحدة الأساس، ولكل وحدة بيعٍ رمزها في قسم «وحدات البيع» (بند الفاتورة يحمل رمز وحدته) */}
                  <label className="label">{units.length > 0 ? tr('كود وحدة الأساس') : tr('كود الوحدة')}</label>
                  <input className="input" dir="ltr" {...register('unitCode')} placeholder={tr('حسب جدول وحدات المزود مثال EA')} />
                </div>
              )}
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
 * وتعديلاً وإيقافاً وحذفاً، كلٌّ يُحفظ فوراً بمساره (productApi.addUnit/updateUnit/removeUnit). ومعه زرّ «إضافة وحدة فرعية
 * أصغر» لصنفٍ له تاريخ (productApi.convertBase)، و«الوحدة الرئيسية»: شارتها، و«اجعلها الرئيسية»، وخانة «وحدة رئيسية» في
 * الإضافة، وإيقاف الرئيسية أو حذفها بتأكيدٍ صريح (clearPrimary — D13: لا إلغاء صامت).
 *
 * لماذا فوراً لا مع «حفظ التعديلات»: الوحدة صفٌّ مستقلّ يحرسه الخادم بقفل الصنف (إضافةٌ تتزامن مع تحويل)، وجمعُها مع
 * حفظ الصنف يجعل فشل أحدهما نصف حفظٍ لا يعرف المالك أيّ نصفيه التزم. وكل كتابةٍ تحمل الأساس كما رآه النموذج
 * (expectedBaseName): وحدةٌ «طبلية = 50» حُسبت على الكرتون لا تُكتب بعد أن صار الأساس قارورة (٤٠٩ BASE_UNIT_CHANGED).
 *
 * والحذف فعليّ (الصفوف تحمل لقطة وحدتها فلا ينكسر تاريخ)، والإيقاف يحجبها عن البيع الجديد ويُبقي رفع مستندٍ أوف‑لاين صدر بها.
 */
function ProductUnitsSection({
  productId, baseUnit, basePrice, units, onUnits, syncRepUnitRules,
  primaryUnitId, canConvertBase, convertRefusal, onSetPrimary, onPrimaryChanged, onStale, onConvert,
}: {
  productId: string | null;
  baseUnit: string;
  basePrice: number;
  units: ProductUnit[];
  onUnits: (u: ProductUnit[]) => void;
  /** يحفظ «قيود المندوب» كما في النموذج — true إن حُفظت فتُعاد العملية، false إن بقي النموذج نفسه «الكبرى فقط» */
  syncRepUnitRules?: () => Promise<boolean>;
  /** معرّف الوحدة الرئيسية الصالحة (primaryUnitOf) أو null */
  primaryUnitId: string | null;
  canConvertBase: boolean;
  convertRefusal: User['convertBaseRefusalCode'] | null;
  /** «اجعلها الرئيسية» — PUT /products/:id/primary-unit بالرئيسية كما رآها النموذج */
  onSetPrimary: (unitId: string) => Promise<void>;
  /** الرئيسية تغيّرت من هنا (إضافةٌ بـmakePrimary، أو إيقاف/حذف بـclearPrimary ⇒ null) — بالوحدات الجديدة */
  onPrimaryChanged: (units: ProductUnit[], primaryUnitId: string | null) => void;
  /** ٤٠٩ «تغيّرت وحدات الصنف» ⇒ رسالة وإعادة جلب الصنف */
  onStale: () => void | Promise<void>;
  /** يفتح نافذة «إضافة وحدة فرعية أصغر» */
  onConvert: () => void;
}) {
  const tr = useTr();
  const qc = useQueryClient();
  const [adding, setAdding] = useState<UnitForm>(EMPTY_UNIT_FORM);
  const [addPrimary, setAddPrimary] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editing, setEditing] = useState<UnitForm>(EMPTY_UNIT_FORM);
  const [busy, setBusy] = useState<string | null>(null);
  // التحويل يغيّر الأساس ويضرب المعاملات — تعديلٌ مفتوح قبله يُغلق فلا يُحفظ بمعاملٍ قديم
  useEffect(() => { setEditId(null); }, [baseUnit]);

  // قوائم الأصناف في الصفحات الأخرى (الفاتورة والتحميل والوارد) تقرأ الوحدات — تتبع كل تغيير
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['products'] });
    qc.invalidateQueries({ queryKey: ['products-all'] });
    qc.invalidateQueries({ queryKey: ['products-min'] });
  };
  const sorted = [...units].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || Number(a.factor) - Number(b.factor));
  const product = { unit: baseUnit, units };
  const primary = primaryUnitOf({ primaryUnitId, units });
  // D21: لصنفٍ له رئيسية تُعرض رسائل التحقق بلا «الأساس»، وبلاها كما هي (I1)
  const shown = (msg: string) => (primary ? d21(msg) : msg);
  /** فشل كتابة وحدة: نموذجٌ قديم ⇒ «أعد فتحه» وإعادة الجلب، وإلا رسالة الخادم */
  const fail = (err: unknown, fallback: string) => {
    if (isUnitsStale(err)) void onStale();
    else toast.error(tr(shown(serverMessage(err) || fallback)));
  };

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
    if (problem) { toast.error(tr(shown(problem))); return; }
    setBusy('add');
    try {
      const { data } = await productApi.addUnit(productId, { ...unitFormPayload(adding), ...(addPrimary && { makePrimary: true }), expectedBaseName: baseUnit });
      const created = data.data as ProductUnit;
      const next = [...units, created];
      if (addPrimary) onPrimaryChanged(next, created.id);
      else onUnits(next);
      setAdding(EMPTY_UNIT_FORM);
      setAddPrimary(false);
      refresh();
      toast.success(tr('أضيفت الوحدة'));
    } catch (err) { fail(err, 'تعذر الحفظ'); }
    setBusy(null);
  };

  const saveEdit = async (u: ProductUnit) => {
    const problem = unitFormProblem(editing, product, u.id);
    if (problem) { toast.error(tr(shown(problem))); return; }
    setBusy(u.id);
    try {
      const { data } = await productApi.updateUnit(productId, u.id, { ...unitFormPayload(editing), expectedBaseName: baseUnit });
      onUnits(units.map(x => (x.id === u.id ? (data.data as ProductUnit) : x)));
      setEditId(null);
      refresh();
      toast.success(tr('حفظت الوحدة'));
    } catch (err) { fail(err, 'تعذر الحفظ'); }
    setBusy(null);
  };

  /** رفضٌ بسبب «قيود المندوب» المحفوظة (409 REP_UNIT_RULE_SET) والنموذج أزالها ⇒ يُحفظ القيد ثم تُعاد العملية مرّةً واحدة */
  const withRepRuleSync = async <T,>(op: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code !== 'REP_UNIT_RULE_SET' || !syncRepUnitRules || !(await syncRepUnitRules())) throw err;
      return op();
    }
  };

  const toggle = async (u: ProductUnit) => {
    // D13: إيقاف الرئيسية يُلغي كونها رئيسية في الطلب نفسه (clearPrimary) — بتأكيدٍ صريح، لا إلغاء صامت يقلب افتراض المندوب
    const clearing = primary?.id === u.id && u.isActive !== false;
    if (clearing && !window.confirm(`${tr('هذه الوحدة الرئيسية — سيُلغى كونها رئيسية ثم تُوقَف')} — ${u.name}`)) return;
    setBusy(u.id);
    try {
      const { data } = await withRepRuleSync(() => productApi.updateUnit(productId, u.id, clearing
        ? { isActive: false, clearPrimary: true, expectedBaseName: baseUnit }
        : { isActive: u.isActive === false, expectedBaseName: baseUnit }));
      const next = units.map(x => (x.id === u.id ? (data.data as ProductUnit) : x));
      if (clearing) onPrimaryChanged(next, null);
      else onUnits(next);
      refresh();
      toast.success(u.isActive === false ? tr('فعلت الوحدة') : tr('أوقفت الوحدة'));
    } catch (err) { fail(err, 'تعذر الحفظ'); }
    setBusy(null);
  };

  const remove = async (u: ProductUnit) => {
    const clearing = primary?.id === u.id;
    const ask = clearing
      ? tr('هذه الوحدة الرئيسية — سيُلغى كونها رئيسية ثم تُحذف')
      : tr('حذف الوحدة نهائيا؟ الفواتير والحركات السابقة بها تبقى كما هي وللإيقاف المؤقت استخدم إيقاف');
    if (!window.confirm(`${ask} — ${u.name}`)) return;
    setBusy(u.id);
    try {
      await withRepRuleSync(() => (clearing ? productApi.removeUnit(productId, u.id, { clearPrimary: true, expectedBaseName: baseUnit }) : productApi.removeUnit(productId, u.id, { expectedBaseName: baseUnit })));
      const next = units.filter(x => x.id !== u.id);
      if (clearing) onPrimaryChanged(next, null);
      else onUnits(next);
      if (editId === u.id) setEditId(null);
      refresh();
      toast.success(tr('حذفت الوحدة'));
    } catch (err) { fail(err, 'تعذر الحذف'); }
    setBusy(null);
  };

  const makePrimary = async (u: ProductUnit) => {
    setBusy(u.id);
    try { await onSetPrimary(u.id); } finally { setBusy(null); }
  };

  /** خانات وحدةٍ (إضافة أو تعديل) — الاسم والمعامل والسعر الاختياري والرمز الضريبي */
  const factorHint = primary ? fill(tr('كم {unit} فيها'), { unit: baseUnit }) : tr('عدد وحدات الأساس فيها');
  const fields = (f: UnitForm, set: (f: UnitForm) => void) => (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" onKeyDown={noSubmit}>
      <input className="input py-1.5 text-sm" maxLength={24} value={f.name} placeholder={tr('اسم الوحدة')}
        aria-label={tr('اسم الوحدة')} onChange={e => set({ ...f, name: e.target.value })} />
      <input className="input py-1.5 text-sm text-center" type="number" min="2" step="1" inputMode="numeric" value={f.factor}
        placeholder={tr('المعامل')} aria-label={factorHint} title={primary ? factorHint : `${tr('عدد وحدات الأساس فيها')} (${baseUnit})`}
        onChange={e => set({ ...f, factor: e.target.value })} />
      <input className="input py-1.5 text-sm text-center" type="number" min="0" step="any" inputMode="decimal" value={f.price}
        placeholder={tr('السعر اختياري')} aria-label={tr('السعر اختياري')}
        title={primary ? fill(tr('فارغ يعني سعر {unit} مضروبا في المعامل'), { unit: baseUnit }) : tr('فارغ يعني سعر الأساس مضروبا في المعامل')}
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
          {primary ? (
            <p className="text-[11px] text-gray-500 mt-0.5" data-units-primary-subtitle="">
              {tr('الوحدة الرئيسية')}: <b className="text-gray-700">{productUnitLabel({ unit: baseUnit, units, primaryUnitId: primary.id })}</b> — {fill(tr('الحساب الداخلي بوحدة {unit}'), { unit: baseUnit })}
            </p>
          ) : (
            <p className="text-[11px] text-gray-500 mt-0.5">
              {tr('وحدة الأساس')}: <b className="text-gray-700">{baseUnit}</b> — {tr('أصغر ما يباع من الصنف وكل وحدة أكبر تعرف بعدد وحدات الأساس فيها')}
            </p>
          )}
        </div>
        {/* «إضافة وحدة فرعية أصغر» (convert-base): بإذن الخادم (canConvertBase) — وإلا معطّلٌ بسبب المنع تلميحاً */}
        <span title={canConvertBase ? undefined : tr(refusalHint(convertRefusal))} data-convert-base-button="">
          <button type="button" onClick={onConvert} disabled={busy !== null || !canConvertBase}
            className="text-[11px] font-semibold text-[#6E6557] border border-[#E9E1D3] rounded-lg px-2.5 py-1 hover:bg-[#FAF7F0] flex items-center gap-1 disabled:opacity-50">
            <ArrowDownUp size={12} /> {tr('إضافة وحدة فرعية أصغر')}
          </button>
        </span>
      </div>

      {sorted.length === 0 ? (
        <p className="text-[11px] text-gray-400">{tr('لا وحدات إضافية والصنف يباع بوحدة الأساس وحدها')}</p>
      ) : (
        <div className="border border-gray-100 rounded-lg divide-y divide-gray-100">
          {sorted.map(u => {
            const off = u.isActive === false;
            const explicit = u.price != null;
            const isPrimary = primary?.id === u.id;
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
                    {isPrimary && <span className="ms-2 text-[10px] font-semibold text-[#C94E28] bg-[#FBEBE2] border border-[#F2CDBE] rounded px-1.5 py-0.5" data-primary-badge="">{tr('رئيسية')}</span>}
                    {off && <span className="ms-2 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">{tr('موقوفة')}</span>}
                  </p>
                  <p className="text-[11px] text-gray-500">
                    {formatCurrency(unitPriceOf({ name: u.name, factor: Number(u.factor), price: u.price ?? undefined }, basePrice))}
                    {!explicit && <span className="text-gray-400"> · {primary ? fill(tr('محسوب من سعر {unit}'), { unit: baseUnit }) : tr('محسوب من سعر الأساس')}</span>}
                    {u.unitCode && <span className="font-mono" dir="ltr"> · {u.unitCode}</span>}
                  </p>
                </div>
                {!isPrimary && !off && (
                  <button type="button" title={tr('اجعلها الرئيسية')} aria-label={tr('اجعلها الرئيسية')} disabled={busy !== null} onClick={() => makePrimary(u)}
                    className="p-1.5 rounded text-[#C94E28] hover:bg-[#FBEBE2] disabled:opacity-40" data-make-primary=""><Star size={13} /></button>
                )}
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

      {/* إضافة وحدة — و«وحدة رئيسية» تجعلها رئيسية في الطلب نفسه (makePrimary) */}
      <div className="space-y-2">
        {fields(adding, setAdding)}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-[11px] text-gray-600 cursor-pointer" data-add-make-primary="">
            <input type="checkbox" className="w-3.5 h-3.5 accent-[#E15A30]" checked={addPrimary} onChange={e => setAddPrimary(e.target.checked)} />
            {tr('وحدة رئيسية')}
          </label>
          <p className="text-[10px] text-gray-400">{tr('تحفظ الوحدات فور إضافتها أو تعديلها')}</p>
          <button type="button" onClick={add} disabled={busy !== null || !adding.name.trim()}
            className="btn-secondary py-1 px-3 text-xs disabled:opacity-50"><Plus size={13} /> {tr('إضافة وحدة')}</button>
        </div>
      </div>
    </div>
  );
}

/** ردّ معاينة «إضافة وحدة فرعية أصغر» (convert-base بـdryRun) — بلا كتابة */
interface ConvertDryRun {
  dryRun?: boolean;
  erpLinked?: boolean;
  apiKeys?: { write?: number; readOnly?: number };
  /** اسم الوحدة الرئيسية بعد الإضافة، أو null */
  primaryAfter?: string | null;
  converted?: Record<string, unknown>;
}
const countOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/**
 * رسالة رفض الخادم في نافذة «إضافة وحدة فرعية أصغر» بلا «الأساس» (D21): رسائل الخادم القائمة تسمّي العملية باسمها القديم
 * (رفض البوابة المغلقة، وقيد وحدة المندوب، وتكرار الاسم) — بالرمز حين يُعرف، وإلا ببديل النص المشترك (D21_TEXT)
 */
const convertServerText = (err: unknown): string => {
  const code = serverCode(err);
  if (code === 'CONVERT_BASE_OWNER_ONLY') return refusalHint('OWNER_ONLY');
  if (code === 'REP_UNIT_RULE_SET') return 'أزل قيد وحدة المندوب (البيع أو المرتجع) قبل إضافة وحدة فرعية أصغر';
  return d21(serverMessage(err) || 'تعذر التحويل');
};

/**
 * «إضافة وحدة فرعية أصغر» (اسم convert-base في الواجهة — D12) — نافذة تأكيد بلغة المالك قبل `productApi.convertBase`.
 *
 * الصنف الذي يُباع بالكرتون منذ سنة لا يصير «حبة» بتعديل اسم وحدته: كل فاتورةٍ وتحميلٍ مضى كُتب بالكرتون، فإعادة
 * التسمية تقرؤه حبّاتٍ (خطأ ٢٤ ضعفاً في كل رصيدٍ وتقرير). الإضافة على الخادم توسم كل صفٍّ قديم بوحدته ومعاملها فتبقى
 * أرقامه المطبوعة كما هي، والكرتون يصير وحدةً بمعامله وسعره — ويبقى «الوحدة الرئيسية» (keepOldBaseAsPrimary، مفعّل افتراضاً) —
 * والقارورة أصغر وحدة. و`expectedBaseName` = الأساس كما رآه المالك حين فتح النافذة: إضافةٌ سبقته (نقرةٌ ثانية أو مديرٌ آخر)
 * تُردّ ٤٠٩ «تغيّرت وحدات الصنف».
 *
 * المعاينة (dryRun) تُطلب بعد ٤٠٠ms من آخر تعديل حين تصحّ الخانات، لا عند فتح النافذة؛ وزرّ التنفيذ معطّلٌ حتى تنجح معاينةٌ
 * بالقيم الحالية نفسها (مفتاحها formKey)، وأيّ تعديلٍ بعدها يعيده معطّلاً حتى معاينةٍ جديدة. وإقرارا ERP والربط البرمجي
 * يظهران حين تقولهما المعاينة.
 */
function ConvertBaseDialog({ productId, baseUnit, basePrice, units, primaryUnitId, onClose, onDone, onStale }: {
  productId: string; baseUnit: string; basePrice: number; units: ProductUnit[]; primaryUnitId: string | null;
  onClose: () => void; onDone: (p: Product) => void; onStale: () => void;
}) {
  const tr = useTr();
  // الأساس لحظة فتح النافذة — لا يتبع ما يتغيّر بعدها، فهو ما يتحقّق منه الخادم
  const [expected] = useState(baseUnit);
  const [form, setForm] = useState<ConvertForm>({ newBaseName: '', factor: '', basePrice: '' });
  // تبقى الوحدة الحالية «الوحدة الرئيسية» (D12) — لا معنى للخانة حين للصنف رئيسيةٌ قائمة (طبلية): تبقى هي بمعاملها مضروباً
  const [keepPrimary, setKeepPrimary] = useState(true);
  const [ackErp, setAckErp] = useState(false);
  const [ackApi, setAckApi] = useState(false);
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ key: string; data: ConvertDryRun } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const seq = useRef(0);
  const product = { unit: expected, basePrice, units };
  const problem = convertFormProblem(form, product);
  const calc = convertPreview(product, form);
  const newName = form.newBaseName.trim() || tr('الوحدة الفرعية');
  const currentPrimary = primaryUnitOf({ primaryUnitId, units });
  // مفتاح المعاينة: القيم كما ستُرسل — أي تعديلٍ يُبطل المعاينة السابقة
  const formKey = JSON.stringify([form.newBaseName.trim(), form.factor.trim(), form.basePrice.trim(), keepPrimary]);
  const body = () => ({ ...convertPayload(form, expected), keepOldBaseAsPrimary: keepPrimary });

  /** رفض الخادم في المعاينة أو التنفيذ: ٤٠٩ «تغيّرت وحدات الصنف» ⇒ إغلاقٌ وإعادة جلب، والاسم المتقاعد تحت خانته، وغيرهما برسالته */
  const refused = (err: unknown): boolean => {
    const code = serverCode(err);
    if (code === 'BASE_UNIT_CHANGED') { onStale(); return true; }
    if (code === 'BASE_NAME_RETIRED') { setNameError(tr(serverMessage(err) || 'تعذر التحويل')); return true; }
    return false;
  };

  useEffect(() => {
    setNameError('');
    const mySeq = ++seq.current;
    if (problem) { setPreviewing(false); return; }
    setPreviewing(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await productApi.convertBase(productId, { ...body(), dryRun: true });
        if (mySeq !== seq.current) return;
        setPreview({ key: formKey, data: (data ?? {}) as ConvertDryRun });
        setError('');
      } catch (err) {
        if (mySeq !== seq.current) return;
        if (!refused(err)) setError(tr(convertServerText(err)));
      } finally {
        if (mySeq === seq.current) setPreviewing(false);
      }
    }, 400);
    return () => clearTimeout(t);
    // المعاينة تتبع القيم (formKey) وإعادة الطلب الصريحة (previewNonce) وحدهما
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey, previewNonce]);

  const fresh = preview && preview.key === formKey ? preview.data : null;
  const erpLinked = fresh?.erpLinked === true;
  const apiTotal = countOf(fresh?.apiKeys?.write) + countOf(fresh?.apiKeys?.readOnly);
  const conv = fresh?.converted ?? {};
  const relabeled = countOf(conv.invoiceItems) + countOf(conv.vanLoadItems) + countOf(conv.warehouseEntryItems) + countOf(conv.stockRequestItems);
  // الافتراض في البيع اليوم: الرئيسية، وإلا أكبر وحدة نشطة، وإلا الوحدة الحالية — وبعد الإضافة: ما تقوله المعاينة
  const defaultNow = currentPrimary?.name ?? biggestUnit(units)?.name ?? expected;
  const primaryAfter = fresh && fresh.primaryAfter !== undefined
    ? fresh.primaryAfter
    : (currentPrimary?.name ?? (keepPrimary ? expected : null));
  const defaultAfter = primaryAfter ?? biggestUnit(units)?.name ?? expected;
  // «مثال لشكل الرصيد»: مثالٌ بالوحدات بعد الإضافة (٢ رئيسية و٣ فرعية) بـformatQty نفسها التي تعرض الرصيد — موسومٌ «مثال»
  // صراحةً: المعاينة (dryRun) لا تحمل الرصيد، و«٢ كرتون و٣ قارورة» بلا وسمٍ يُقرأ رصيداً فعلياً
  const sample = (() => {
    if (!calc) return null;
    const F = calc.factor;
    const after: UnitDef[] = [
      { id: '__old', name: expected, factor: F, isActive: true },
      ...units.map(u => ({ id: u.id, name: u.name, factor: Number(u.factor) * F, isActive: u.isActive !== false })),
    ];
    const pAfter = primaryAfter ? after.find(u => u.name === primaryAfter && u.isActive !== false) ?? null : null;
    const pf = pAfter ? Number(pAfter.factor) : F;
    return formatQty(2 * pf + 3, after, calc.newBaseName, pAfter);
  })();
  const ready = !!fresh && !problem && !busy && (!erpLinked || ackErp) && (apiTotal === 0 || ackApi);

  const confirm = async () => {
    if (problem) { setError(tr(d21(problem))); return; }
    if (!ready) return;
    setBusy(true); setError(''); setNameError('');
    try {
      const { data } = await productApi.convertBase(productId, {
        ...body(), ...(ackErp && { acknowledgeErp: true }), ...(ackApi && { acknowledgeApi: true }),
      });
      toast.success(tr('أضيفت الوحدة الفرعية'));
      onDone(data.data as Product);
    } catch (err) {
      if (refused(err)) { setBusy(false); return; }
      // إقرارٌ صار لازماً بعد المعاينة (ربط ERP أو مفتاحٌ نشط جديد) ⇒ معاينةٌ جديدة تُظهر خانته
      const code = serverCode(err);
      if (code === 'CONVERT_BASE_ERP_ACK' || code === 'CONVERT_BASE_API_ACK') { setPreview(null); setPreviewNonce(n => n + 1); }
      // ٤٠٣ (الصلاحية أو البوابة) وغيرها برسالة الخادم داخل النافذة — بلا «الأساس» (D21)
      setError(tr(convertServerText(err)));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center p-4" dir="rtl" onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-bold text-gray-800 flex items-center gap-2"><ArrowDownUp size={17} className="text-[#E15A30]" /> {tr('إضافة وحدة فرعية أصغر')}</h3>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-lg text-gray-500"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          {/* الشرح بلغة المالك: ما يتغيّر وما لا يتغيّر — قبل أي خانة (D21: بلا «الأساس») */}
          <ul className="text-xs text-gray-600 space-y-1.5 leading-relaxed list-disc ps-4">
            <li>{fill(tr('الصنف يباع اليوم بـ«{unit}» بسعر {price}. بعد الإضافة يبقى «{unit}» بسعره وتصير الوحدة الفرعية أصغر وحدة له'), { unit: expected, price: formatCurrency(basePrice) })}</li>
            <li>{tr('أرقام الفواتير والحركات السابقة لا تتغير: ما بيع بها يبقى مطبوعا كما هو وتحسب كميته بالوحدة الجديدة تلقائيا')}</li>
            <li>{tr('أسعار العملاء الخاصة وشرائح الأسعار تقسم على المعامل فيبقى سعر الوحدة الحالية لكل عميل كما هو')}</li>
            {defaultAfter === defaultNow && <li>{tr('المندوب يستمر في البيع بالوحدة الحالية افتراضيا')}</li>}
          </ul>

          <div>
            <label className="label">{tr('اسم الوحدة الفرعية')} *</label>
            <input className="input" maxLength={24} value={form.newBaseName} placeholder={tr('مثال: قارورة')}
              onChange={e => setForm(f => ({ ...f, newBaseName: e.target.value }))} />
            {nameError && <p className="text-xs text-red-600 mt-1" data-base-name-retired="">{nameError}</p>}
          </div>
          <div>
            <label className="label">{fill(tr('كم {sub} في {primary}'), { sub: newName, primary: expected })} *</label>
            <input className="input" type="number" min="2" step="1" inputMode="numeric" value={form.factor}
              onChange={e => setForm(f => ({ ...f, factor: e.target.value }))} />
          </div>
          <div>
            <label className="label">{fill(tr('سعر {unit} الواحدة'), { unit: newName })} ({tr('اختياري')})</label>
            <input className="input" type="number" min="0" step="any" inputMode="decimal" value={form.basePrice}
              placeholder={calc ? String(calc.newBasePrice) : ''}
              onChange={e => setForm(f => ({ ...f, basePrice: e.target.value }))} />
            <p className="text-[10px] text-gray-400 mt-1">{fill(tr('فارغ يعني سعر {unit} مقسوما على العدد'), { unit: expected })}</p>
          </div>
          {currentPrimary ? (
            <p className="text-xs text-gray-600" data-keep-primary="">{fill(tr('تبقى «{unit}» الوحدة الرئيسية'), { unit: currentPrimary.name })}</p>
          ) : (
            <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer" data-keep-primary="">
              <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[#E15A30]" checked={keepPrimary} onChange={e => setKeepPrimary(e.target.checked)} />
              {fill(tr('تبقى «{unit}» الوحدة الرئيسية في العرض والإدخال'), { unit: expected })}
            </label>
          )}

          {calc && (
            <div className="rounded-lg bg-[#FAF7F0] border border-[#F1EBDF] p-3 text-xs text-gray-700 space-y-1" data-convert-preview="">
              <p><b>1 {calc.oldAsUnit.name}</b> = {calc.factor} {calc.newBaseName} · {formatCurrency(calc.oldAsUnit.price)}</p>
              <p>{calc.newBaseName}: {formatCurrency(calc.newBasePrice, undefined, 4)}</p>
              {calc.scaled.map(s => (
                <p key={s.name} className="text-gray-500">{s.name}: {s.from} {expected} ← {s.to} {calc.newBaseName}</p>
              ))}
            </div>
          )}
          {problem && (form.newBaseName.trim() || form.factor.trim()) && <p className="text-[11px] text-gray-500">{tr(d21(problem))}</p>}

          {/* معاينة الخادم (dryRun): ما سيُعاد وسمه، وما يبقى، وشكل الرصيد، والمدة، والإقراران حين يلزمان */}
          {previewing && !fresh && <p className="text-[11px] text-gray-400" data-convert-previewing="">{tr('جاري المعاينة')}</p>}
          {fresh && (
            <div className="rounded-lg border border-[#E9E1D3] p-3 text-xs text-gray-700 space-y-1.5" data-convert-dryrun="">
              <p>{fill(tr('سيعاد وسم {n} بندا، والفواتير المطبوعة لا تتغير'), { n: formatNumber(relabeled) })}</p>
              <p>{fill(tr('سعر العميل الخاص يبقى لـ«{unit}» كما هو'), { unit: expected })}</p>
              {sample && <p>{fill(tr('مثال لشكل الرصيد بعد الإضافة: {qty}'), { qty: sample })}</p>}
              <p className="text-gray-500">{tr('قد تستغرق حتى دقيقتين لصنف بتاريخ طويل، ومن يحفظ أثناءها يُطلب منه إعادة المحاولة')}</p>
              {defaultAfter !== defaultNow && (
                <p className="font-semibold text-[#1F1A13]" data-default-after="">{fill(tr('الافتراض في البيع بعد الإضافة: {unit}'), { unit: defaultAfter })}</p>
              )}
              {erpLinked && (
                <label className="flex items-start gap-2 cursor-pointer text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2" data-ack-erp="">
                  <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[#E15A30]" checked={ackErp} onChange={e => setAckErp(e.target.checked)} />
                  {fill(tr('الصنف مربوط بنظام ERP بوحدة واحدة: ما سبق الإضافة بـ{unit} وما بعدها بـ{sub} هناك — أؤكد المتابعة'), { unit: expected, sub: newName })}
                </label>
              )}
              {apiTotal > 0 && (
                <label className="flex items-start gap-2 cursor-pointer text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-2" data-ack-api="">
                  <input type="checkbox" className="mt-0.5 w-4 h-4 accent-[#E15A30]" checked={ackApi} onChange={e => setAckApi(e.target.checked)} />
                  {fill(tr('للشركة ربط برمجي نشط ({n} مفتاح) — بعد الإضافة تقرأ كمياته وأسعاره بـ{sub}، وأبلغت المتكامل'), { n: formatNumber(apiTotal), sub: newName })}
                </label>
              )}
            </div>
          )}

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error}</p>}
        </div>
        <div className="flex gap-3 p-4 border-t">
          <button type="button" onClick={confirm} disabled={!ready}
            className="btn-primary flex-1 justify-center py-2 disabled:opacity-60" data-convert-confirm="">
            {busy ? <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <ArrowDownUp size={15} />}
            {tr('إضافة الوحدة الفرعية')}
          </button>
          <button type="button" onClick={onClose} className="btn-secondary">{tr('إلغاء')}</button>
        </div>
      </div>
    </div>
  );
}
