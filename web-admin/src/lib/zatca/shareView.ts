// ============================================================================
// ZATCA المرحلة الثانية (Z5.7) — منطق صفحة المشتري العلنية. نقيّ: بلا React ولا شبكة ولا ساعة.
// ----------------------------------------------------------------------------
// من يفتح الصفحة ليس مستخدم المنصّة بل **مشترٍ** لا حساب له، جاءه رابطٌ في واتساب. فثلاثة قيود تحكم هذا الملفّ:
//
//   ١) **الردّ بيانات لا وعد**: ما يصل من `/api/public/einvoice/:token` يُفكّك بقائمةٍ بيضاء (`parsePublicDoc`)
//      قبل أن يمسّه الرسم. جسمٌ ناقص أو حقلٌ من نوعٍ آخر يعطي `null` فتُعرض شاشة «الرابط غير متاح» — لا شاشة
//      بيضاء ولا «undefined» في وجه مشترٍ لا يعرف ما المنصّة أصلاً.
//   ٢) **الحالة تُقرأ لا تُزيَّن**: أربع حالاتٍ نهائية وحدها تصل إلى هنا (الخادم يحجب ما عداها)، ولكلٍّ منها
//      جملةٌ تقول للمشتري ما الذي بيده: مبلَّغة للهيئة أم معتمدة منها. و«بتحفّظات» لا تُخفى — تحفّظ الهيئة
//      على مستندٍ قبلته حقٌّ للمشتري أن يعرفه، ولا يعني بطلانه.
//   ٣) **المبالغ تُجمع كما تُطبع**: الوعاء = الإجمالي قبل الضريبة ناقص الخصم، وفرق التقريب (٠٫٠١ أو ٠٫٠٢ من
//      الأسعار الشاملة) يُعرض سطراً باسمه لا يُبتلع في الإجمالي — فمشترٍ يجمع السطور بيده يصل إلى الرقم نفسه،
//      وإلا ظنّ الفاتورة مغلوطة.
//
// اللغات الخمس هنا لا في `i18n/strings.ts`: هذا الملفّ يُحمَّل كسولاً مع الصفحة وحدها، فلا يثقل حزمة الدخول
// التي يحمّلها كلّ زائر. ويحرس اكتمالها اختبارُ هذا الملفّ (كلّ مفتاحٍ بلغاته الأربع).
// ============================================================================

import type { Lang } from '../../i18n/lang';

// ─── الرمز والرابط ───

/** صيغة الرمز كما يبنيها الخادم: 32 خانة ست‑عشرية (معرّف المستند) ثمّ نقطة ثمّ 27 محرف base64url للبصمة. */
export const SHARE_TOKEN_RE = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{27}$/;

/** رمزٌ صالح الشكل؟ فحصٌ محلّيّ يوفّر نداءً على القاعدة حين يُقصّ الرابط ناقصاً في لصق واتساب. */
export function isShareToken(v: unknown): v is string {
  return typeof v === 'string' && SHARE_TOKEN_RE.test(v);
}

/** رابط الصفحة العلنية — مسارٌ واحد `/e/:token` يطابق ما يبنيه `shareUrlOf` في الخادم. */
export function shareLinkOf(origin: string, token: string): string {
  return `${String(origin).replace(/\/+$/, '')}/e/${token}`;
}

// ─── بوابة العرض في شاشات المدير ───

/**
 * المرايا التي يُصدَر لها رابط. هي بعينها بوابة الخادم (`isShareableDocument` في compliance/zatca/publicView.ts):
 * المبسّطة بعد الإبلاغ، والقياسية بعد الاعتماد. و`cleared_no_xml` خارجها — اعتمدت الهيئة ولم تصل نسختها، فلا
 * مستند قانونيّ يُسلَّم. و«الطباعة» ليست شرطاً إضافياً: المرايا الأربع كلّها قابلة للطباعة بحكم القاعدة نفسها.
 */
export const SHAREABLE_MIRRORS: readonly string[] = Object.freeze(
  ['reported', 'reported_warn', 'cleared', 'cleared_warn'],
);

/** يُعرض زرّ الرابط؟ حكمٌ واحد لكلّ شاشة — والخادم يبقى صاحب القول الأخير (`available:false` بسببه). */
export function isShareableMirror(mirror: unknown): boolean {
  return typeof mirror === 'string' && SHAREABLE_MIRRORS.includes(mirror);
}

/** صفّ فاتورةٍ من `GET /invoices` — بلا استيراد نوعٍ من docStatus كي لا تتشابك الوحدتان. */
export function isShareableRow(row: { zatcaPhase?: unknown; einvoiceStatus?: unknown } | null | undefined): boolean {
  if (!row) return false;
  return Number(row.zatcaPhase) === 2 && isShareableMirror(row.einvoiceStatus);
}

// ─── الإسقاط القادم من الخادم ───

export type ShareStatus = 'reported' | 'reported_warn' | 'cleared' | 'cleared_warn';
export type ShareKind = 'INVOICE' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
export type ShareSubtype = '01' | '02';

const STATUSES: readonly string[] = Object.freeze(['reported', 'reported_warn', 'cleared', 'cleared_warn']);
const KINDS: readonly string[] = Object.freeze(['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE']);

export interface PublicDoc {
  seller: { name: string | null; vatNumber: string | null };
  buyer: { name: string | null };
  document: {
    kind: ShareKind;
    subtype: ShareSubtype;
    number: string | null;
    uuid: string;
    issueDate: string | null;
    issueTime: string | null;
    currency: string;
    subtotal: number | null;
    discount: number | null;
    tax: number | null;
    total: number | null;
    status: ShareStatus;
    flow: 'CLEARANCE' | 'REPORTING';
  };
  qr: string | null;
  xml: { available: boolean; variant: 'signed' | 'cleared' };
}

const str = (v: unknown, max = 200): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * فكّ الردّ بقائمةٍ بيضاء. `null` تعني «لا تعرض شيئاً»: الحالة أو النوع خارج المعروف، أو الجسم ليس كائناً.
 * المبالغ تُقبل ناقصةً (`null`) ولا تُصفَّر — صفرٌ مخترع في فاتورةٍ رقمٌ كاذب، والشرطة تقول «غير متاح».
 */
export function parsePublicDoc(raw: unknown): PublicDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const d = (r.document ?? null) as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return null;
  if (typeof d.status !== 'string' || !STATUSES.includes(d.status)) return null;
  if (d.subtype !== '01' && d.subtype !== '02') return null;
  const uuid = str(d.uuid, 64);
  if (!uuid) return null;
  const seller = (r.seller ?? {}) as Record<string, unknown>;
  const buyer = (r.buyer ?? {}) as Record<string, unknown>;
  const xml = (r.xml ?? {}) as Record<string, unknown>;
  return {
    seller: { name: str(seller.name, 120), vatNumber: str(seller.vatNumber, 64) },
    buyer: { name: str(buyer.name, 120) },
    document: {
      kind: (typeof d.kind === 'string' && KINDS.includes(d.kind) ? d.kind : 'INVOICE') as ShareKind,
      subtype: d.subtype,
      number: str(d.number, 60),
      uuid,
      issueDate: str(d.issueDate, 10),
      issueTime: str(d.issueTime, 8),
      currency: str(d.currency, 8) ?? 'SAR',
      subtotal: num(d.subtotal),
      discount: num(d.discount),
      tax: num(d.tax),
      total: num(d.total),
      status: d.status as ShareStatus,
      flow: d.flow === 'CLEARANCE' ? 'CLEARANCE' : 'REPORTING',
    },
    qr: str(r.qr, 4096),
    xml: { available: xml.available === true, variant: xml.variant === 'cleared' ? 'cleared' : 'signed' },
  };
}

// ─── العناوين والحالة ───

/**
 * عناوين المستندات: عبارةٌ كاملة لكلّ حالة لا تركيبٌ بالوصل. الوصل يصنع «إشعار دائن مبسطة» (وصفٌ مؤنّث لمذكّر)
 * ويصنع مفاتيح ترجمةٍ لا وجود لها في القاموس فتسقط اللغة صامتةً إلى العربية.
 */
const TITLES: Readonly<Record<ShareKind, Readonly<Record<ShareSubtype, string>>>> = Object.freeze({
  INVOICE: Object.freeze({ '01': 'فاتورة ضريبية', '02': 'فاتورة ضريبية مبسطة' }),
  CREDIT_NOTE: Object.freeze({ '01': 'إشعار دائن', '02': 'إشعار دائن مبسط' }),
  DEBIT_NOTE: Object.freeze({ '01': 'إشعار مدين', '02': 'إشعار مدين مبسط' }),
});

/** عنوان المستند بالعربية — «مبسّط» للمبسّطة وحدها كما يميّزها دليل الهيئة. */
export function shareDocTitle(d: PublicDoc): string {
  return TITLES[d.document.kind][d.document.subtype];
}

export interface ShareStatusNote {
  tone: 'ok' | 'warn';
  label: string;
  hint: string;
}

const NOTES: Readonly<Record<ShareStatus, ShareStatusNote>> = Object.freeze({
  reported: {
    tone: 'ok',
    label: 'مبلغة لهيئة الزكاة والضريبة والجمارك',
    hint: 'وصل هذا المستند إلى الهيئة وقبلته',
  },
  reported_warn: {
    tone: 'warn',
    label: 'مبلغة للهيئة مع ملاحظات',
    hint: 'قبلت الهيئة المستند وسجلت عليه ملاحظات شكلية لا تبطله',
  },
  cleared: {
    tone: 'ok',
    label: 'معتمدة من هيئة الزكاة والضريبة والجمارك',
    hint: 'اعتمدت الهيئة هذا المستند قبل تسليمه لك',
  },
  cleared_warn: {
    tone: 'warn',
    label: 'معتمدة من الهيئة مع ملاحظات',
    hint: 'اعتمدت الهيئة المستند وسجلت عليه ملاحظات شكلية لا تبطله',
  },
});

export function shareStatusNote(d: PublicDoc): ShareStatusNote {
  return NOTES[d.document.status];
}

// ─── المبالغ ───

export interface ShareAmountLine {
  /** مفتاح العرض (عربيّ) — يمرّ بـ`shareTranslate`. */
  label: string;
  value: number;
  /** سطر الإجمالي يُبرز. */
  strong?: boolean;
  /** خصمٌ يُعرض بإشارة سالبة. */
  negative?: boolean;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * سطور المبالغ كما تُطبع. القاعدة: `الوعاء = ما قبل الضريبة − الخصم`، و`الإجمالي = الوعاء + الضريبة + فرق تقريب`.
 * فرق التقريب (٠٫٠١/٠٫٠٢ من الأسعار الشاملة للضريبة) يُفرد سطراً بدل أن يُخفى، وإلا بدت الفاتورة غير متّسقة
 * لمن يجمعها بيده. وحين ينقص مبلغٌ من الخادم يسقط سطره ولا يُخترع له صفر.
 */
export function shareAmountLines(d: PublicDoc): ShareAmountLine[] {
  const { subtotal, discount, tax, total } = d.document;
  const out: ShareAmountLine[] = [];
  if (subtotal !== null) out.push({ label: 'الإجمالي قبل الضريبة', value: r2(subtotal) });
  const disc = discount !== null && Math.abs(discount) >= 0.005 ? r2(discount) : null;
  if (disc !== null) out.push({ label: 'الخصم', value: disc, negative: true });
  if (subtotal !== null && disc !== null) {
    out.push({ label: 'الوعاء الخاضع للضريبة', value: r2(subtotal - disc) });
  }
  if (tax !== null) out.push({ label: 'ضريبة القيمة المضافة', value: r2(tax) });
  if (subtotal !== null && tax !== null && total !== null) {
    const diff = r2(total - (subtotal - (disc ?? 0) + tax));
    if (Math.abs(diff) >= 0.005) out.push({ label: 'فرق تقريب', value: diff, negative: diff < 0 });
  }
  if (total !== null) out.push({ label: 'الإجمالي شامل الضريبة', value: r2(total), strong: true });
  return out;
}

// ─── المشاركة من شاشة المدير ───

/** نصّ الرسالة التي يرسلها المندوب/المدير للمشتري مع الرابط — عربيّ دائماً (المستلم عميل الشركة). */
export function shareMessageOf(input: { number: string | null; sellerName?: string | null }, link: string): string {
  const head = input.number ? `فاتورتكم الضريبية رقم ${input.number}` : 'فاتورتكم الضريبية';
  const from = input.sellerName ? ` من ${input.sellerName}` : '';
  return `${head}${from}\nنسخة معتمدة من هيئة الزكاة والضريبة والجمارك:\n${link}`;
}

/** رابط واتساب — الرقم اختياريّ (بلا رقم تفتح قائمة جهات الاتصال). */
export function waShareUrl(text: string, phone?: string | null): string {
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  const base = digits ? `https://wa.me/${digits}` : 'https://wa.me/';
  return `${base}?text=${encodeURIComponent(text)}`;
}

// ─── القاموس (خمس لغات) ───

export const SHARE_PHRASES: Record<string, { en: string; fr: string; tr: string; zh: string }> = {
  'فاتورة ضريبية': { en: 'Tax invoice', fr: 'Facture fiscale', tr: 'Vergi faturası', zh: '税务发票' },
  'فاتورة ضريبية مبسطة': { en: 'Simplified tax invoice', fr: 'Facture fiscale simplifiée', tr: 'Basitleştirilmiş vergi faturası', zh: '简化税务发票' },
  'إشعار دائن': { en: 'Credit note', fr: 'Note de crédit', tr: 'İade faturası', zh: '贷记单' },
  'إشعار دائن مبسط': { en: 'Simplified credit note', fr: 'Note de crédit simplifiée', tr: 'Basitleştirilmiş iade faturası', zh: '简化贷记单' },
  'إشعار مدين': { en: 'Debit note', fr: 'Note de débit', tr: 'Borç dekontu', zh: '借记单' },
  'إشعار مدين مبسط': { en: 'Simplified debit note', fr: 'Note de débit simplifiée', tr: 'Basitleştirilmiş borç dekontu', zh: '简化借记单' },
  'مبلغة لهيئة الزكاة والضريبة والجمارك': { en: 'Reported to ZATCA', fr: 'Déclarée à la ZATCA', tr: 'ZATCA’ya bildirildi', zh: '已向 ZATCA 报送' },
  'مبلغة للهيئة مع ملاحظات': { en: 'Reported to ZATCA with notes', fr: 'Déclarée à la ZATCA avec remarques', tr: 'ZATCA’ya notlarla bildirildi', zh: '已向 ZATCA 报送并有备注' },
  'معتمدة من هيئة الزكاة والضريبة والجمارك': { en: 'Cleared by ZATCA', fr: 'Validée par la ZATCA', tr: 'ZATCA tarafından onaylandı', zh: '已通过 ZATCA 审核' },
  'معتمدة من الهيئة مع ملاحظات': { en: 'Cleared by ZATCA with notes', fr: 'Validée par la ZATCA avec remarques', tr: 'ZATCA tarafından notlarla onaylandı', zh: '已通过 ZATCA 审核并有备注' },
  'وصل هذا المستند إلى الهيئة وقبلته': { en: 'ZATCA received and accepted this document', fr: 'La ZATCA a reçu et accepté ce document', tr: 'ZATCA bu belgeyi aldı ve kabul etti', zh: 'ZATCA 已接收并接受此单据' },
  'قبلت الهيئة المستند وسجلت عليه ملاحظات شكلية لا تبطله': { en: 'ZATCA accepted the document and recorded formal notes that do not invalidate it', fr: 'La ZATCA a accepté le document et consigné des remarques de forme qui ne l’invalident pas', tr: 'ZATCA belgeyi kabul etti ve geçersiz kılmayan biçimsel notlar kaydetti', zh: 'ZATCA 已接受该单据，并记录了不影响其效力的形式性备注' },
  'اعتمدت الهيئة هذا المستند قبل تسليمه لك': { en: 'ZATCA cleared this document before it was handed to you', fr: 'La ZATCA a validé ce document avant qu’il vous soit remis', tr: 'ZATCA bu belgeyi size teslim edilmeden önce onayladı', zh: 'ZATCA 在交付给您之前已审核此单据' },
  'اعتمدت الهيئة المستند وسجلت عليه ملاحظات شكلية لا تبطله': { en: 'ZATCA cleared the document and recorded formal notes that do not invalidate it', fr: 'La ZATCA a validé le document et consigné des remarques de forme qui ne l’invalident pas', tr: 'ZATCA belgeyi onayladı ve geçersiz kılmayan biçimsel notlar kaydetti', zh: 'ZATCA 已审核该单据，并记录了不影响其效力的形式性备注' },
  'البائع': { en: 'Seller', fr: 'Vendeur', tr: 'Satıcı', zh: '销售方' },
  'المشتري': { en: 'Buyer', fr: 'Acheteur', tr: 'Alıcı', zh: '购买方' },
  'الرقم الضريبي': { en: 'VAT number', fr: 'Numéro de TVA', tr: 'VKN', zh: '税号' },
  'رقم المستند': { en: 'Document number', fr: 'Numéro du document', tr: 'Belge numarası', zh: '单据编号' },
  'المعرف الفريد': { en: 'Unique identifier', fr: 'Identifiant unique', tr: 'Benzersiz kimlik', zh: '唯一标识' },
  'تاريخ الإصدار': { en: 'Issue date', fr: 'Date d’émission', tr: 'Düzenleme tarihi', zh: '开具日期' },
  'بتوقيت الرياض': { en: 'Riyadh time', fr: 'Heure de Riyad', tr: 'Riyad saati', zh: '利雅得时间' },
  'الإجمالي قبل الضريبة': { en: 'Total before VAT', fr: 'Total hors TVA', tr: 'KDV hariç toplam', zh: '税前合计' },
  'الخصم': { en: 'Discount', fr: 'Remise', tr: 'İndirim', zh: '折扣' },
  'الوعاء الخاضع للضريبة': { en: 'Taxable amount', fr: 'Base imposable', tr: 'Vergi matrahı', zh: '应税金额' },
  'ضريبة القيمة المضافة': { en: 'VAT', fr: 'TVA', tr: 'KDV', zh: '增值税' },
  'فرق تقريب': { en: 'Rounding difference', fr: 'Écart d’arrondi', tr: 'Yuvarlama farkı', zh: '舍入差额' },
  'الإجمالي شامل الضريبة': { en: 'Total including VAT', fr: 'Total TTC', tr: 'KDV dâhil toplam', zh: '含税总额' },
  'رمز الاستجابة السريعة المختوم': { en: 'Stamped QR code', fr: 'QR code tamponné', tr: 'Damgalı QR kod', zh: '带签章二维码' },
  'امسح الرمز للتحقق من المستند في تطبيق الهيئة': { en: 'Scan the code to verify the document in the ZATCA app', fr: 'Scannez le code pour vérifier le document dans l’application de la ZATCA', tr: 'Belgeyi ZATCA uygulamasında doğrulamak için kodu okutun', zh: '扫描二维码可在 ZATCA 应用中验证该单据' },
  'تنزيل المستند الإلكتروني XML': { en: 'Download the XML e-document', fr: 'Télécharger le document électronique XML', tr: 'XML e-belgesini indir', zh: '下载 XML 电子单据' },
  'هذه النسخة الإلكترونية هي المستند المعتمد لدى الهيئة': { en: 'This electronic copy is the document held by ZATCA', fr: 'Cette copie électronique est le document conservé par la ZATCA', tr: 'Bu elektronik kopya ZATCA nezdindeki belgedir', zh: '此电子副本即 ZATCA 存档的单据' },
  'جاري التحميل': { en: 'Loading', fr: 'Chargement', tr: 'Yükleniyor', zh: '加载中' },
  'الرابط غير صحيح أو لم يعد متاحا': { en: 'This link is invalid or no longer available', fr: 'Ce lien est invalide ou n’est plus disponible', tr: 'Bu bağlantı geçersiz veya artık kullanılamıyor', zh: '该链接无效或已失效' },
  'تحقق من الرابط كاملا مع من أرسله لك': { en: 'Check the full link with whoever sent it to you', fr: 'Vérifiez le lien complet auprès de son expéditeur', tr: 'Bağlantının tamamını size gönderen kişiyle doğrulayın', zh: '请与发送者核对完整链接' },
  'طلبات كثيرة حاول بعد قليل': { en: 'Too many requests — try again shortly', fr: 'Trop de requêtes — réessayez dans un instant', tr: 'Çok fazla istek — birazdan tekrar deneyin', zh: '请求过于频繁——请稍后重试' },
  'اللغة': { en: 'Language', fr: 'Langue', tr: 'Dil', zh: '语言' },
  'طباعة': { en: 'Print', fr: 'Imprimer', tr: 'Yazdır', zh: '打印' },
};

/** tr() للصفحة العلنية: العربية كما هي، ثمّ ترجمة الصفحة، ثمّ العربية (لا شاشة فارغة إن نقص مفتاح). */
export function shareTranslate(lang: string, ar: string): string {
  if (lang === 'ar') return ar;
  const l = lang as Exclude<Lang, 'ar'>;
  return SHARE_PHRASES[ar]?.[l] ?? ar;
}
