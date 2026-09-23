/**
 * قالب شجرة الحسابات السعودية `SA_6D` (DESIGN.md §4.2، §4.3، §4.5، §8.7).
 *
 * بيانات صرفة بلا I/O: الحسابات المئة والسبعة والثلاثون بترتيب جدول §4.2، والدفاتر الستة عشر،
 * ومفاتيح الربط مشتقة من الحسابات (مصدر واحد). كل صف يحمل `names: {ar, en, fr, tr, zh}`
 * يُزرع منه `name` (العربية) و`nameEn` و`nameI18n`.
 *
 * رؤوس المجموعات (1 الأصول … 9 حسابات النظام) ليست صفوف GlAccount (بلا نوع ولا حركة):
 * تُصدَّر مستقلة في `SA_6D_ACCOUNT_GROUPS` للعرض — وفيها **كل** بادئات الشجرة (1، 11، 111…) لا الجذور وحدها (م‑7) —
 * و`parentCode` لكل حساب = رقمه الأول. ومعها `SA_6D_ACCOUNT_DESCRIPTIONS` (م‑5) و`SA_6D_ACCOUNT_SYNONYMS` (م‑1).
 * لا فواصل عليا ASCII داخل النصوص (§8.7): يُستعمل ’ (U+2019).
 */
import type {
  AccountType, CashFlowTag, ControlKind, JournalSystemKey, JournalType, MappingKey, SequenceReset,
  TemplateKey,
} from '../types';
import { MAPPING_KEYS } from '../types';

// ═══ أسماء القوالب بخمس لغات (§8.7) ═══

export const LEDGER_LANGS = ['ar', 'en', 'fr', 'tr', 'zh'] as const;
export type LedgerLang = (typeof LEDGER_LANGS)[number];
export type TemplateNames = Readonly<Record<LedgerLang, string>>;

const n = (ar: string, en: string, fr: string, tr: string, zh: string): TemplateNames => ({ ar, en, fr, tr, zh });

// ═══ أشكال صفوف القالب ═══

export interface AccountGroupTemplate {
  code: string;
  names: TemplateNames;
}

export interface AccountTemplate {
  /** ٦ أرقام — GlAccount.code */
  code: string;
  /** رمز رأس المجموعة (الرقم الأول) — للعرض فقط، لا عمود parent في GlAccount */
  parentCode: string;
  type: AccountType;
  reconcile: boolean;
  controlKind: ControlKind | null;
  /** قائمة مفاتيح: صف GlAccountMapping لكل مفتاح (§4.2) */
  mappingKeys: readonly MappingKey[];
  /** وسوم GlAccountTag (مثل DRAWINGS على 315001) */
  tags: readonly string[];
  cashFlowTag: CashFlowTag | null;
  /** حساب مربوط بمفتاح أو رئيسي ⇒ لا يُحذف ولا يتغيّر نوعه بعد أول حركة */
  isSystem: boolean;
  /** false ⇒ يُزرع مؤرشفاً (حسابات الضريبة في دول 0٪ بالقالب العام) */
  isActive: boolean;
  /** GlAccount.templateRef — مفتاح إعادة التحميل؛ = الرمز في القالبين (نفس الهيكل) */
  templateRef: string;
  names: TemplateNames;
  /**
   * وصف عربي قصير: **ما الذي يُسجَّل في هذا الحساب** بلغة محاسب منشأة صغيرة (م‑5).
   * يُزرع في `GlAccount.description`، وتُعرَّبه الواجهة عبر tr() لتترجمه لاحقاً.
   */
  description: string;
}

export interface JournalTemplate {
  code: string;
  type: JournalType;
  systemKey: JournalSystemKey;
  sequenceReset: SequenceReset;
  /** بادئة التسلسل: INV/2026/09/0001 */
  sequencePrefix: string;
  /** بادئة المرتجع (RINV، RBILL) — null إن لم يكن للدفتر مرتجع */
  refundSequencePrefix: string | null;
  /** رمز الحساب الافتراضي أو null */
  defaultAccountCode: string | null;
  suspenseAccountCode: string | null;
  /** true ⇒ القاعدة R‑BNK (§5.5) */
  useOutstandingAccounts: boolean;
  showOnDashboard: boolean;
  isSystem: boolean;
  names: TemplateNames;
}

export interface ChartTemplate {
  key: TemplateKey;
  groups: readonly AccountGroupTemplate[];
  accounts: readonly AccountTemplate[];
  journals: readonly JournalTemplate[];
  /** مفتاح الربط ← رمز الحساب */
  mappings: Readonly<Record<MappingKey, string>>;
}

// ═══ المجموعات ═══

/**
 * عقد الشجرة المسمّاة (م‑7): **كل** بادئة موجودة في القالب — الجذور الثمانية ومستويا الرقمين والثلاثة —
 * كي لا تظهر في شجرة الحسابات أرقام عارية («61»، «611»، «62»…). مرتَّبة هرمياً لا أبجدياً.
 * الجذور وحدها هي أسماء §4.2 في الوثيقة، وبقيتها أسماء عرض لا صفوف GlAccount.
 */
export const SA_6D_ACCOUNT_GROUPS: readonly AccountGroupTemplate[] = [
  // ── 1 الأصول ──
  { code: '1', names: n('الأصول', 'Assets', 'Actifs', 'Varlıklar', '资产') },
  { code: '11', names: n('الأصول المتداولة', 'Current Assets', 'Actifs courants', 'Dönen Varlıklar', '流动资产') },
  { code: '111', names: n('النقد بالصندوق والبنك', 'Cash on Hand and at Bank', 'Caisse et banque', 'Kasa ve Banka', '库存现金及银行存款') },
  // م‑6 (قرار مراجعة الخبير): «الصندوق حاجة رئيسية وتحتها النقدية» — المستوى الرابع يفصل الصناديق عن البنوك
  // تحت «111 النقد بالصندوق والبنك»، فتُقرأ الشجرة: النقد ← الصناديق ← الصندوق الرئيسي. أودو نفسه يجمّع
  // ببادئة الرمز (account.group) بلا حسابات أب، فلا داعي لتغيير النموذج ولا لإعادة تسمية حسابٍ قائم.
  { code: '1110', names: n('الصناديق', 'Cash Boxes', 'Caisses', 'Kasalar', '现金柜') },
  { code: '1111', names: n('البنوك', 'Banks', 'Banques', 'Bankalar', '银行') },
  { code: '112', names: n('حسابات التحصيل والتسوية النقدية', 'Cash Clearing Accounts', 'Comptes de compensation de trésorerie', 'Nakit Mutabakat Hesapları', '现金结算账户') },
  { code: '113', names: n('الذمم المدينة', 'Receivables', 'Créances', 'Alacaklar', '应收款项') },
  { code: '114', names: n('المخزون', 'Inventory', 'Stocks', 'Stoklar', '存货') },
  { code: '115', names: n('المدفوعات المقدمة والتأمينات', 'Prepayments and Deposits', 'Charges d’avance et dépôts', 'Peşin Ödemeler ve Depozitolar', '预付款项及押金') },
  { code: '116', names: n('الضريبة المدينة (المدخلات)', 'Recoverable Tax (Input)', 'Taxe déductible (intrants)', 'İndirilecek Vergi (Girdi)', '应收税金（进项）') },
  { code: '12', names: n('الأصول غير المتداولة', 'Non-current Assets', 'Actifs non courants', 'Duran Varlıklar', '非流动资产') },
  { code: '121', names: n('الأصول الثابتة بالتكلفة', 'Fixed Assets at Cost', 'Immobilisations corporelles au coût', 'Maddi Duran Varlıklar (Maliyet)', '固定资产原值') },
  { code: '122', names: n('مجمعات إهلاك الأصول الثابتة', 'Accumulated Depreciation of Fixed Assets', 'Amortissements cumulés des immobilisations', 'Maddi Duran Varlık Birikmiş Amortismanları', '固定资产累计折旧') },
  { code: '123', names: n('أصول حق الاستخدام ومجمع استهلاكها', 'Right-of-Use Assets and Accumulated Depreciation', 'Droits d’utilisation et amortissements cumulés', 'Kullanım Hakkı Varlıkları ve Birikmiş Amortismanı', '使用权资产及累计折旧') },
  { code: '124', names: n('الأصول غير الملموسة', 'Intangible Assets', 'Immobilisations incorporelles', 'Maddi Olmayan Duran Varlıklar', '无形资产') },
  { code: '125', names: n('أصول غير متداولة أخرى', 'Other Non-current Assets', 'Autres actifs non courants', 'Diğer Duran Varlıklar', '其他非流动资产') },

  // ── 2 الالتزامات ──
  { code: '2', names: n('الالتزامات', 'Liabilities', 'Passifs', 'Yükümlülükler', '负债') },
  { code: '21', names: n('الالتزامات المتداولة', 'Current Liabilities', 'Passifs courants', 'Kısa Vadeli Yükümlülükler', '流动负债') },
  { code: '211', names: n('الذمم الدائنة', 'Payables', 'Dettes fournisseurs', 'Borçlar', '应付款项') },
  { code: '212', names: n('الضرائب والزكاة المستحقة', 'Taxes and Zakat Payable', 'Taxes et zakat à payer', 'Ödenecek Vergi ve Zekât', '应交税费及天课') },
  { code: '213', names: n('المستحقات والأجور', 'Accruals and Payroll Liabilities', 'Charges à payer et dettes de personnel', 'Tahakkuklar ve Personel Borçları', '应计费用及应付职工薪酬') },
  { code: '214', names: n('الإيرادات المؤجلة', 'Deferred Revenue', 'Produits constatés d’avance', 'Ertelenmiş Gelirler', '递延收入') },
  { code: '215', names: n('القروض والتزامات الإيجار المتداولة', 'Current Loans and Lease Liabilities', 'Emprunts et dettes locatives courants', 'Kısa Vadeli Krediler ve Kiralama Yükümlülükleri', '流动借款及租赁负债') },
  { code: '216', names: n('بطاقات الائتمان', 'Credit Cards', 'Cartes de crédit', 'Kredi Kartları', '信用卡') },
  { code: '217', names: n('جاري الشركاء الدائن', 'Partners Current Accounts (Credit)', 'Comptes courants d’associés créditeurs', 'Ortaklar Cari Hesabı (Alacak)', '合伙人往来（贷方）') },
  { code: '22', names: n('الالتزامات غير المتداولة', 'Non-current Liabilities', 'Passifs non courants', 'Uzun Vadeli Yükümlülükler', '非流动负债') },
  { code: '221', names: n('القروض والتزامات الإيجار طويلة الأجل', 'Long-term Loans and Lease Liabilities', 'Emprunts et dettes locatives à long terme', 'Uzun Vadeli Krediler ve Kiralama Yükümlülükleri', '长期借款及租赁负债') },
  { code: '222', names: n('المخصصات طويلة الأجل', 'Long-term Provisions', 'Provisions à long terme', 'Uzun Vadeli Karşılıklar', '长期准备金') },

  // ── 3 حقوق الملكية ──
  { code: '3', names: n('حقوق الملكية', 'Equity', 'Capitaux propres', 'Özkaynaklar', '所有者权益') },
  { code: '31', names: n('رأس المال وحقوق الملاك', 'Capital and Owners’ Equity', 'Capital et capitaux des propriétaires', 'Sermaye ve Sahip Hakları', '实收资本及业主权益') },
  { code: '311', names: n('رأس المال', 'Share Capital', 'Capital social', 'Sermaye', '实收资本') },
  { code: '312', names: n('الاحتياطيات', 'Reserves', 'Réserves', 'Yedekler', '盈余公积') },
  { code: '313', names: n('الأرباح المبقاة', 'Retained Earnings', 'Résultats reportés', 'Geçmiş Yıllar Kârları', '留存收益') },
  { code: '314', names: n('جاري الملاك والشركاء', 'Owners and Partners Current Accounts', 'Comptes courants des propriétaires et associés', 'Sahipler ve Ortaklar Cari Hesapları', '业主及合伙人往来') },
  { code: '315', names: n('المسحوبات والتوزيعات', 'Drawings and Distributions', 'Prélèvements et distributions', 'Çekişler ve Dağıtımlar', '提款及分配') },
  { code: '319', names: n('نتيجة السنة والأرصدة الافتتاحية', 'Current Year Result and Opening Balances', 'Résultat de l’exercice et soldes d’ouverture', 'Cari Yıl Sonucu ve Açılış Bakiyeleri', '本年结果及期初余额') },

  // ── 4 الإيرادات ──
  { code: '4', names: n('الإيرادات', 'Revenue', 'Produits', 'Gelirler', '收入') },
  { code: '41', names: n('إيرادات النشاط', 'Operating Revenue', 'Produits d’exploitation', 'Faaliyet Gelirleri', '营业收入') },
  { code: '411', names: n('المبيعات والخدمات', 'Sales and Services', 'Ventes et prestations', 'Satışlar ve Hizmetler', '销售及服务') },
  { code: '412', names: n('مردودات المبيعات', 'Sales Returns', 'Retours sur ventes', 'Satış İadeleri', '销售退回') },
  { code: '413', names: n('خصومات المبيعات', 'Sales Discounts', 'Remises sur ventes', 'Satış İskontoları', '销售折扣') },
  { code: '42', names: n('إيرادات أخرى', 'Other Income', 'Autres produits', 'Diğer Gelirler', '其他收入') },
  { code: '421', names: n('إيرادات وأرباح متنوعة', 'Miscellaneous Income and Gains', 'Produits et gains divers', 'Çeşitli Gelir ve Kazançlar', '各项收益') },

  // ── 5 تكلفة الإيرادات ──
  { code: '5', names: n('تكلفة الإيرادات', 'Cost of Revenue', 'Coût des ventes', 'Satışların Maliyeti', '营业成本') },
  { code: '51', names: n('تكلفة المبيعات والمخزون', 'Cost of Sales and Inventory', 'Coût des ventes et des stocks', 'Satış ve Stok Maliyetleri', '销售及存货成本') },
  { code: '511', names: n('تكلفة البضاعة المباعة', 'Cost of Goods Sold', 'Coût des marchandises vendues', 'Satılan Malın Maliyeti', '已售商品成本') },
  { code: '512', names: n('المشتريات ومصروفاتها', 'Purchases and Purchase Costs', 'Achats et frais sur achats', 'Alışlar ve Alış Giderleri', '采购及采购费用') },
  { code: '513', names: n('التغيّر في المخزون', 'Change in Inventory', 'Variation des stocks', 'Stok Değişimi', '存货变动') },
  { code: '514', names: n('فروقات المخزون والتالف', 'Inventory Differences and Write-offs', 'Écarts de stock et pertes', 'Stok Farkları ve Fireler', '存货差异及损耗') },

  // ── 6 المصروفات التشغيلية ──
  { code: '6', names: n('المصروفات التشغيلية', 'Operating Expenses', 'Charges d’exploitation', 'Faaliyet Giderleri', '营业费用') },
  { code: '61', names: n('مصروفات البيع والتوزيع', 'Selling and Distribution Expenses', 'Charges de vente et de distribution', 'Satış ve Dağıtım Giderleri', '销售及配送费用') },
  { code: '611', names: n('مصروفات فرق البيع والسيارات', 'Sales Teams and Vehicles Expenses', 'Charges des équipes de vente et des véhicules', 'Satış Ekipleri ve Araç Giderleri', '销售团队及车辆费用') },
  { code: '62', names: n('المصروفات الإدارية والعمومية', 'General and Administrative Expenses', 'Charges administratives et générales', 'Genel Yönetim Giderleri', '管理及一般费用') },
  { code: '621', names: n('رواتب الإدارة ومصروفات المقر والخدمات', 'Administrative Payroll, Premises and Services', 'Salaires administratifs, locaux et services', 'İdari Personel, Bina ve Hizmet Giderleri', '管理薪酬、场所及服务费用') },
  { code: '63', names: n('الإهلاكات والإطفاءات', 'Depreciation and Amortisation', 'Amortissements et dépréciations', 'Amortismanlar ve İtfa Payları', '折旧及摊销') },
  { code: '631', names: n('قسط إهلاك الأصول وإطفائها', 'Depreciation and Amortisation Charge', 'Dotations aux amortissements de la période', 'Dönem Amortisman ve İtfa Gideri', '本期折旧摊销额') },

  // ── 7 مصروفات أخرى وزكاة ──
  { code: '7', names: n('مصروفات أخرى وزكاة', 'Other Expenses and Zakat', 'Autres charges et zakat', 'Diğer Giderler ve Zekât', '其他费用及天课') },
  { code: '71', names: n('مصروفات وخسائر غير تشغيلية', 'Non-operating Expenses and Losses', 'Charges et pertes hors exploitation', 'Faaliyet Dışı Gider ve Zararlar', '营业外支出及损失') },
  { code: '711', names: n('تكاليف تمويلية وخسائر متنوعة', 'Finance Costs and Miscellaneous Losses', 'Charges financières et pertes diverses', 'Finansman Giderleri ve Çeşitli Zararlar', '财务费用及各项损失') },
  { code: '72', names: n('الزكاة والضرائب على الدخل', 'Zakat and Taxes on Income', 'Zakat et impôts sur le résultat', 'Zekât ve Gelir Üzerinden Vergiler', '天课及所得税') },
  { code: '721', names: n('مصروف الزكاة وضريبة الدخل', 'Zakat and Income Tax Expense', 'Charge de zakat et d’impôt sur le revenu', 'Zekât ve Gelir Vergisi Gideri', '天课及所得税费用') },

  // ── 9 حسابات النظام ──
  { code: '9', names: n('حسابات النظام', 'System Accounts', 'Comptes système', 'Sistem Hesapları', '系统账户') },
  { code: '91', names: n('الحسابات المعلّقة', 'Suspense Accounts', 'Comptes d’attente', 'Askı Hesapları', '暂记账户') },
  { code: '911', names: n('معلّق الترحيل الآلي', 'Automatic Posting Suspense', 'Attente de comptabilisation automatique', 'Otomatik Kayıt Askı Hesabı', '自动过账暂记') },
  { code: '99', names: n('حسابات نظامية خارج الميزانية', 'Off-balance Sheet Accounts', 'Comptes d’ordre hors bilan', 'Bilanço Dışı Nazım Hesaplar', '表外备查账户') },
  { code: '991', names: n('شيكات الضمان ومقابلها', 'Guarantee Cheques and Contra', 'Chèques de garantie et contrepartie', 'Teminat Çekleri ve Karşılığı', '保证支票及其对应科目') },
];

/** رؤوس §4.2 في الوثيقة: الجذور وحدها (رمز من رقم واحد). */
export const SA_6D_ROOT_GROUPS: readonly AccountGroupTemplate[] = SA_6D_ACCOUNT_GROUPS.filter((g) => g.code.length === 1);

/** §4.2: الحسابات المعادلة للنقد موسومة CASH_EQUIVALENT (§7.9). */
export const CASH_EQUIVALENT_CODES: readonly string[] = [
  '111003', '112001', '112002', '112003', '112004', '112005', '112006', '112009',
];

/** حسابات ضريبة القيمة المضافة — تُنشأ مؤرشفة في القالب العام لدول 0٪ (§4.2). */
export const VAT_ACCOUNT_CODES: readonly string[] = ['116001', '116002', '212001', '212002', '212003', '212006'];

/**
 * أوصاف الحسابات (م‑5): سطر واحد بالعربية يقول **ما الذي يُسجَّل في الحساب** لا إعادة صياغة لاسمه،
 * بلغة محاسب منشأة صغيرة. يُزرع في `GlAccount.description` ويُعرض تحت اسم الحساب في المنتقي والشجرة.
 * أي إضافة حساب للقالب تُضيف سطرها هنا (اختبار gl-coa-template يمنع الوصف الفارغ أو المكرر).
 */
export const SA_6D_ACCOUNT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  // ── 1 الأصول ──
  '111001': 'النقد الورقي والمعدني في خزنة المنشأة: متحصلات اليوم والمدفوعات النقدية المباشرة منه',
  '111002': 'مبلغ صغير يُسلَّم للموظف لصرف نثريات يومية كالضيافة والمواصلات وتُعوَّض قيمته عند نفادها',
  '111003': 'النقد الذي حصّله المندوب من العملاء ولم يورّده بعد لأمين الصندوق أو البنك',
  '111101': 'رصيد الحساب الجاري للمنشأة لدى البنك: الإيداعات والتحويلات والسحوبات التي ظهرت في كشف الحساب',
  '112001': 'متحصلات استُلمت فعلاً ولم تصل الحساب البنكي بعد، تُقفل عند ظهور الإيداع في الكشف',
  '112002': 'مدفوعات صدرت أوامرها أو شيكاتها ولم تُخصم من البنك بعد، تُقفل عند خصمها فعلياً',
  '112003': 'شيكات مستلمة من العملاء أُودعت أو ستُودع ولم يُحصَّل مبلغها من البنك بعد',
  '112004': 'مبالغ بطاقات مدى والشبكة في أجهزة نقاط البيع قبل أن يوردها البنك إلى الحساب',
  '112005': 'مبالغ دفعها العملاء بروابط الدفع وتحتفظ بها فيلد سيلز حتى التوريد الأسبوعي',
  '112006': 'مبالغ خرجت من صندوق أو بنك ولم تصل وجهتها بعد داخل حسابات المنشأة',
  '112009': 'حركة ظهرت في كشف البنك ولم يُعرف سببها بعد، تُصنَّف عند المطابقة',
  '113001': 'ما على العملاء من فواتير آجلة لم تُحصَّل بعد، بكشف حساب لكل عميل',
  '113002': 'كمبيالات وسندات لأمر وشيكات آجلة بذمة العملاء لم يحلّ موعد استحقاقها بعد',
  '113003': 'سلف نقدية وعهد صُرفت للموظفين والمناديب تُخصم لاحقاً من الراتب أو تُسوّى بمستندات',
  '113004': 'مبالغ مستحقة للمنشأة على جهات ليست عملاء ولا موظفين، كتعويضات ومطالبات ومردودات',
  '113009': 'تقدير الجزء الذي يُرجَّح عدم تحصيله من ذمم العملاء، يُطرح من رصيدها في الميزانية',
  '114001': 'تكلفة البضاعة الموجودة في المستودع بسعر شرائها قبل بيعها أو تحميلها للمناديب',
  '114002': 'تكلفة البضاعة المحمَّلة في سيارات التوزيع ولم تُبَع بعد، وكل مندوب مسؤول عن عهدته',
  '114003': 'بضاعة اشتُريت ودُفعت أو فُوترت ولم تصل المستودع بعد، تبقى هنا حتى الاستلام',
  '115001': 'مبالغ دُفعت عن فترة قادمة كالتأمين والاشتراكات، تُحمَّل على المصروف شهراً بعد شهر',
  '115002': 'قيمة إيجار المحل أو المستودع المدفوعة عن أشهر قادمة لم تمضِ بعد',
  '115003': 'مبالغ دُفعت للمورد قبل استلام البضاعة أو الخدمة، تُخصم من فاتورته عند وصولها',
  '115004': 'مبالغ تأمين لدى جهات كالكهرباء والإيجار تُسترد خلال سنة عند انتهاء التعامل',
  '116001': 'الضريبة المدفوعة في فواتير المشتريات والمصروفات وتُخصم من ضريبة المبيعات في الإقرار',
  '116002': 'صافي الإقرار حين تزيد ضريبة المشتريات عن المبيعات، مبلغ يُسترد أو يُرحَّل للفترة التالية',
  '121001': 'تكلفة شراء الأرض ورسوم إفراغها ونقل ملكيتها، وهي أصل لا يُهلَك',
  '121002': 'تكلفة شراء أو إنشاء المبنى المملوك للمنشأة، يُهلَك على سنوات عمره الإنتاجي',
  '121003': 'تكلفة الديكور والتقسيم والتمديدات في محل أو مستودع مستأجر، تُهلَك على مدة العقد',
  '121004': 'تكلفة آلات التشغيل والتعبئة والثلاجات والمعدات التي تُستعمل أكثر من سنة',
  '121005': 'مكاتب وكراسي ورفوف وتجهيزات المعرض والمستودع التي تُقتنى للاستعمال الطويل',
  '121006': 'حواسيب وطابعات وأجهزة نقاط البيع والشبكات المشتراة للاستعمال في أعمال المنشأة',
  '121007': 'تكلفة شراء سيارات التوزيع وما يُركَّب عليها من ثلاجات وصناديق ولوحات',
  '121008': 'عدد يدوية وأدوات صغيرة تدوم أكثر من سنة ولا تُستهلك في التشغيل اليومي',
  '122002': 'مجموع أقساط إهلاك المباني منذ اقتنائها، يُطرح من تكلفتها ليظهر صافي قيمتها الدفترية',
  '122003': 'مجموع ما أُهلِك من تكلفة تحسينات المواقع المستأجرة حتى تاريخ إعداد الميزانية',
  '122004': 'مجموع أقساط إهلاك الآلات والمعدات المتراكمة منذ شرائها حتى اليوم',
  '122005': 'مجموع أقساط إهلاك الأثاث والتجهيزات المتراكمة، يُطرح من تكلفتها في الميزانية',
  '122006': 'مجموع أقساط إهلاك الحواسيب والطابعات المتراكمة حتى تاريخ إعداد القوائم',
  '122007': 'مجموع أقساط إهلاك سيارات التوزيع المتراكمة منذ شرائها، يُطرح من تكلفتها',
  '122008': 'مجموع أقساط إهلاك العدد والأدوات المتراكمة حتى تاريخ إعداد الميزانية',
  '123001': 'القيمة الحالية لعقود الإيجار طويلة الأجل المُثبَتة أصلاً في الدفاتر وفق المعيار الدولي',
  '123009': 'مجموع أقساط استهلاك عقود الإيجار المرسملة، يُطرح من قيمة أصل حق الاستخدام',
  '124001': 'تكلفة شراء أنظمة وبرامج وتراخيص تُستعمل سنوات، تُطفأ سنوياً بدل تحميلها دفعة واحدة',
  '124009': 'مجموع ما أُطفئ من تكلفة البرمجيات والتراخيص حتى تاريخ إعداد القوائم المالية',
  '125001': 'تكاليف بدء النشاط وأعمال تحت الإنشاء لم تُشغَّل بعد، تُرحَّل للأصل عند اكتمالها',
  '125002': 'مبالغ تأمين لدى الغير لا تُسترد قبل سنة، كتأمين عقود الإيجار الطويلة',

  // ── 2 الالتزامات ──
  '211001': 'ما على المنشأة من فواتير موردين آجلة لم تُسدَّد بعد، بكشف حساب لكل مورد',
  '211002': 'بضاعة دخلت المستودع ولم تصل فاتورتها بعد، التزام مؤقت يُقفل عند قيد الفاتورة',
  '211003': 'كمبيالات وشيكات آجلة حرّرتها المنشأة لمورديها ولم يحلّ موعد استحقاقها بعد',
  '212001': 'الضريبة المحصَّلة من العملاء في فواتير المبيعات، أمانة تُورَّد للهيئة مع الإقرار',
  '212002': 'صافي الفرق الواجب سداده للهيئة بعد خصم ضريبة المشتريات من ضريبة المبيعات',
  '212003': 'ضريبة مخرجات على خدمات مستوردة تحتسبها المنشأة على نفسها وتخصمها في الإقرار نفسه',
  '212004': 'ضريبة تُحجز من مستحقات مورد غير مقيم وتُورَّد للهيئة نيابةً عنه',
  '212005': 'المبلغ المقدَّر للزكاة عن السنة قبل ربطها نهائياً وسدادها للهيئة',
  '212006': 'فروق ضريبة عن إقرارات سابقة تُعالَج في إقرار الفترة الحالية أو بإفصاح مستقل',
  '213001': 'صافي رواتب الشهر المستحقة للموظفين والمناديب ولم تُصرف بعد في نهاية الفترة',
  '213002': 'مصروفات استُهلكت خدمتها ولم تصل فاتورتها أو لم تُدفع، كالكهرباء والإيجار والأتعاب',
  '213003': 'حصّتا المنشأة والموظف من اشتراك التأمينات عن الشهر قبل سدادهما للمؤسسة',
  '214001': 'مبالغ قبضتها المنشأة عن بضاعة أو خدمة لم تُسلَّم بعد، تصير إيراداً عند التسليم',
  '215001': 'تمويل بنكي أو تسهيلات تُسدَّد خلال سنة، يظهر بأصل الدين دون الفوائد',
  '215002': 'أقساط القروض الطويلة التي تستحق السداد خلال الاثني عشر شهراً القادمة',
  '215003': 'أقساط عقود الإيجار المرسملة المستحقة خلال سنة من تاريخ الميزانية',
  '216001': 'رصيد مستحق على بطاقة الشركة عن مشتريات ومصروفات لم تُسدَّد للبنك بعد',
  '217001': 'مبالغ أدخلها شريك من ماله الخاص للمنشأة وتُردّ له، لا تُعدّ رأس مال',
  '221001': 'تمويل يُسدَّد على أكثر من سنة، ويُنقل قسط كل سنة إلى الالتزامات المتداولة',
  '221002': 'أقساط عقود الإيجار المرسملة المستحقة بعد أكثر من سنة من تاريخ الميزانية',
  '222001': 'التزام متراكم للعاملين عن سنوات خدمتهم يُحسب وفق نظام العمل ويُسدَّد عند انتهاء الخدمة',

  // ── 3 حقوق الملكية ──
  '311001': 'ما قدّمه المالك أو الشركاء من نقد وأصول عند التأسيس أو عند زيادة رأس المال',
  '312001': 'نسبة من الأرباح تُحتجز وفق النظام ولا تُوزَّع على الشركاء',
  '313001': 'أرباح السنوات السابقة بعد الزكاة والتوزيعات، تبقى في المنشأة لتمويل نشاطها',
  '314001': 'حركة إيداعات المالك وسحوباته الجارية مع المنشأة خلال السنة قبل تسويتها',
  '315001': 'ما سحبه المالك من نقد أو بضاعة لنفسه، يُطرح من حقوق الملكية لا من المصروفات',
  '319001': 'نتيجة السنة الحالية المرحَّلة آلياً من قائمة الدخل قبل إقفالها في الأرباح المبقاة',
  '319002': 'الطرف المقابل لأرصدة بداية المدة عند بدء الدفاتر، يجب أن يُصفَّى بعد اكتمالها',

  // ── 4 الإيرادات ──
  '411001': 'قيمة البضاعة المباعة للعملاء نقداً وآجلاً قبل الضريبة، أساس قائمة الدخل',
  '411002': 'مقابل خدمات تقدّمها المنشأة كالتوصيل أو التركيب بلا بيع بضاعة',
  '412001': 'قيمة البضاعة التي أعادها العملاء بإشعارات دائنة، تُطرح من إيراد المبيعات',
  '413001': 'الخصم الممنوح للعميل على قيمة الفاتورة، يُعرض مطروحاً من الإيراد لا مصروفاً',
  '421001': 'دخل عرضي خارج نشاط البيع كإيجار مؤجَّر أو تعويض أو بيع مخلفات',
  '421002': 'الفرق الموجب بين ثمن بيع السيارة أو المعدة وصافي قيمتها الدفترية',
  '421003': 'مكاسب تنشأ من اختلاف سعر الصرف بين تاريخ الفاتورة وتاريخ التحصيل أو السداد',
  '421004': 'خصم منحه المورد للمنشأة مقابل السداد قبل موعده، يُسجَّل إيراداً لا تخفيضاً للمشتريات',
  '421009': 'فروق الهللات الصغيرة بين المستندات والدفاتر، تُجمَّع هنا كي يتوازن القيد',

  // ── 5 تكلفة الإيرادات ──
  '511001': 'تكلفة شراء ما بيع فعلاً من بضاعة، تُقابل الإيراد لاستخراج مجمل الربح',
  '512001': 'قيمة البضاعة المشتراة خلال الفترة في نظام الجرد الدوري قبل تسوية المخزون',
  '512002': 'ما أُعيد للمورد وما مُنح من خصومات، يُطرح من قيمة المشتريات',
  '512003': 'أجور النقل والتخليص والرسوم على البضاعة الواردة حتى وصولها المستودع',
  '513001': 'فرق مخزون أول المدة وآخرها في الجرد الدوري، يُصحِّح تكلفة المبيعات',
  '514001': 'قيمة البضاعة التالفة أو منتهية الصلاحية أو المفقودة التي أُعدمت من المخزون',
  '514002': 'فرق الزيادة أو النقص بين الجرد الفعلي ورصيد الدفاتر عند التسوية',

  // ── 6 المصروفات التشغيلية ──
  '611001': 'الرواتب الأساسية والبدلات الشهرية لمندوبي البيع والتوزيع وسائقي سيارات المنشأة',
  '611002': 'عمولة المندوب على ما باعه أو حصّله وحوافز بلوغ المستهدف الشهري',
  '611003': 'بنزين وسولار وزيوت وغيار زيت ومحروقات سيارات التوزيع والمناديب في جولاتهم',
  '611004': 'إصلاحات ودوريات وقطع غيار وإطارات وغسيل سيارات التوزيع وأجور الورش',
  '611005': 'أقساط التأمين وتجديد الاستمارة والفحص الدوري والمخالفات المرورية لسيارات التوزيع',
  '611006': 'تكاليف الإعلانات واللوحات والمطبوعات الترويجية وحملات مواقع التواصل لجذب العملاء',
  '611007': 'نسبة تخصمها بوابة الدفع الإلكتروني عن كل عملية سداد يدفعها العميل',
  '611008': 'رسوم الحوالات وإدارة الحساب وأجهزة الشبكة التي يخصمها البنك من الحساب',
  '611009': 'بضاعة تُعطى للعملاء مجاناً عيّنةً أو هديةً وتُحمَّل مصروفاً بتكلفتها',
  '611010': 'أجور توصيل البضاعة للعملاء بسيارات أجرة أو شركات شحن خارجية',
  '621001': 'رواتب موظفي الإدارة والمحاسبة والمستودع وبدلاتهم الشهرية عدا فريق البيع',
  '621002': 'حصّة المنشأة من اشتراك التأمينات الاجتماعية عن موظفيها المسجَّلين شهرياً',
  '621003': 'العبء الشهري أو السنوي لمكافآت نهاية خدمة العاملين المحمَّل على الفترة',
  '621004': 'أجرة المعرض والمكتب والمستودع ومواقف السيارات المحمَّلة على أشهر الفترة',
  '621005': 'إيجار سكن العاملين وفواتيره وما يتبعه من أثاث ومستلزمات معيشية بسيطة',
  '621006': 'فواتير الكهرباء والماء والصرف للمحل والمستودع والمكتب عن أشهر الاستهلاك',
  '621007': 'فواتير الجوالات والخطوط الأرضية وباقات الإنترنت الشهرية وشرائح أجهزة المناديب',
  '621008': 'رسوم الاشتراك الشهري أو السنوي في الأنظمة والتطبيقات والاستضافة التي تستعملها المنشأة',
  '621009': 'قرطاسية وأحبار وطباعة فواتير ودفاتر وأختام تُستهلك في العمل اليومي',
  '621010': 'إصلاح المكيفات والثلاجات والمباني والأجهزة المكتبية وعقود الصيانة الدورية للمواقع',
  '621011': 'أجور عمال النظافة ومواد التنظيف ومكافحة الحشرات في المحل والمستودع والمكتب',
  '621012': 'قهوة وشاي وحلويات وما يُقدَّم للزوار والعملاء في اجتماعات العمل',
  '621013': 'تجديد السجل التجاري ورخصة البلدية ورسوم العمل والجوازات والمنصات الحكومية',
  '621014': 'أتعاب المحاسب القانوني والمحامي والمستشار ومكاتب الخدمات عن أعمال محدَّدة',
  '621015': 'أقساط وثيقة التأمين الصحي للموظفين وذويهم التي يفرضها النظام سنوياً',
  '621016': 'مصروفات صغيرة متفرقة لا حساب مخصص لها، تُراجَع دورياً كي لا تكبر',
  '621017': 'مبالغ تشجيعية تُصرف للموظفين خارج الراتب والعمولات في مناسبات أو إنجازات',
  '621018': 'أعمال يؤديها متعاقدون من خارج المنشأة كالحراسة والتوصيل والعمالة المؤقتة',
  '631001': 'قسط الفترة من تكلفة المباني وتحسينات المواقع المستأجرة المحمَّل على المصروف',
  '631002': 'قسط الفترة من تكلفة الآلات والمعدات موزَّعاً على سنوات عمرها الإنتاجي',
  '631003': 'قسط الفترة من تكلفة الأثاث والرفوف والتجهيزات المحمَّل على نتيجة الأعمال',
  '631004': 'قسط الفترة من تكلفة الحواسيب والطابعات وأجهزة نقاط البيع والشبكات',
  '631005': 'قسط الفترة من تكلفة سيارات التوزيع موزَّعاً على سنوات استعمالها المتوقَّعة',
  '631006': 'قسط الفترة من قيمة عقود الإيجار المرسملة المحمَّل على المصروف',
  '631007': 'قسط الفترة من تكلفة البرمجيات والتراخيص موزَّعاً على مدة الانتفاع بها',

  // ── 7 مصروفات أخرى وزكاة ──
  '711001': 'فوائد القروض وتكاليف التمويل والتسهيلات ورسوم الاعتمادات المحمَّلة على الفترة',
  '711002': 'خسائر تنشأ من اختلاف سعر الصرف بين تاريخ العملية وتاريخ السداد أو التحصيل',
  '711003': 'الفرق السالب بين ثمن بيع الأصل وصافي قيمته الدفترية عند التخلص منه',
  '711004': 'خصم منحته المنشأة لعميل سدّد فاتورته قبل موعد استحقاقها تشجيعاً على التحصيل',
  '711005': 'ذمم عملاء تعذّر تحصيلها نهائياً وأُعدمت بقرار، تُشطب من الذمم المدينة',
  '711006': 'عبء الفترة من تكوين مخصص التحصيل المتعثّر دون شطب الذمة نفسها',
  '711007': 'غرامات الجهات الحكومية والمخالفات وجزاءات التأخر التي لا تُعدّ مصروفاً تشغيلياً',
  '721001': 'عبء الزكاة المحمَّل على نتيجة السنة وفق الوعاء الزكوي المعتمد',
  '721002': 'ضريبة على أرباح الشركاء غير السعوديين تُحمَّل على نتيجة السنة',

  // ── 9 حسابات النظام ──
  '911001': 'حركة آلية لم يجد النظام حسابها الصحيح، تُراجَع وتُنقل لحسابها ثم يفرغ رصيدها',
  '991001': 'شيكات أخذتها المنشأة ضماناً لا تحصيلاً، تُقيَّد خارج الميزانية للمتابعة فقط',
  '991002': 'الطرف المقابل لشيكات الضمان المستلمة كي يتوازن القيد النظامي خارج الميزانية',
};

interface AccOpts {
  r?: boolean;
  keys?: MappingKey[];
  ck?: ControlKind;
  tags?: string[];
}

function acc(code: string, type: AccountType, names: TemplateNames, o: AccOpts = {}): AccountTemplate {
  const keys = o.keys ?? [];
  return {
    code,
    parentCode: code.slice(0, 1),
    type,
    reconcile: o.r ?? false,
    controlKind: o.ck ?? null,
    mappingKeys: keys,
    tags: o.tags ?? [],
    cashFlowTag: CASH_EQUIVALENT_CODES.includes(code) ? 'CASH_EQUIVALENT' : null,
    isSystem: keys.length > 0 || o.ck !== undefined,
    isActive: true,
    templateRef: code,
    names,
    description: SA_6D_ACCOUNT_DESCRIPTIONS[code] ?? '',
  };
}

// ═══ الحسابات (§4.2 بترتيب الجدول) ═══

export const SA_6D_ACCOUNTS: readonly AccountTemplate[] = [
  // ── 1 الأصول ──
  acc('111001', 'asset_cash', n('الصندوق الرئيسي', 'Main Cash', 'Caisse principale', 'Ana Kasa', '主现金'), { keys: ['MAIN_CASH'] }),
  acc('111002', 'asset_cash', n('صندوق المصروفات النثرية', 'Petty Cash', 'Petite caisse', 'Küçük Kasa', '备用金'), { keys: ['PETTY_CASH'] }),
  acc('111003', 'asset_cash', n('عهدة تحصيلات المناديب', 'Sales Rep Collections Custody', 'Encaissements des commerciaux en dépôt', 'Satış Temsilcisi Tahsilat Emaneti', '销售代表收款保管'), { keys: ['REP_CUSTODY'], ck: 'CUSTODY' }),
  acc('111101', 'asset_cash', n('البنك الرئيسي', 'Main Bank', 'Banque principale', 'Ana Banka', '主银行账户'), { keys: ['MAIN_BANK'] }),
  acc('112001', 'asset_current', n('مقبوضات قيد الإيداع', 'Outstanding Receipts', 'Encaissements en attente de dépôt', 'Yatırılmayı Bekleyen Tahsilatlar', '待存入收款'), { r: true, keys: ['OUTSTANDING_RECEIPTS', 'PAYLINK_PAYOUT_ACCOUNT'] }),
  acc('112002', 'asset_current', n('مدفوعات قيد الصرف', 'Outstanding Payments', 'Paiements en cours', 'Bekleyen Ödemeler', '待付款项'), { r: true, keys: ['OUTSTANDING_PAYMENTS'] }),
  acc('112003', 'asset_current', n('شيكات تحت التحصيل', 'Cheques Under Collection', 'Chèques à l’encaissement', 'Tahsildeki Çekler', '托收中支票'), { r: true, keys: ['CHEQUES_UNDER_COLLECTION'] }),
  acc('112004', 'asset_current', n('مدى ونقاط البيع تحت التسوية', 'mada and POS Clearing', 'Mada et TPE en compensation', 'Mada ve POS Mutabakat Hesabı', 'mada及POS待清算'), { r: true, keys: ['POS_CLEARING'] }),
  acc('112005', 'asset_current', n('أمانات الدفع الإلكتروني لدى فيلد سيلز', 'Online Payments Held by Field Sales', 'Paiements en ligne détenus par Field Sales', 'Field Sales Nezdindeki Çevrimiçi Ödemeler', 'Field Sales代收的在线付款'), { r: true, keys: ['PAYLINK_CLEARING'], ck: 'PAYLINK' }),
  acc('112006', 'asset_current', n('أموال قيد التحويل', 'Internal Transfers', 'Virements internes en cours', 'Transferdeki Fonlar', '在途资金'), { r: true, keys: ['INTERNAL_TRANSFER'] }),
  acc('112009', 'asset_current', n('الحساب البنكي المعلّق', 'Bank Suspense Account', 'Compte d’attente bancaire', 'Banka Askı Hesabı', '银行暂记账户'), { r: true, keys: ['BANK_SUSPENSE'] }),
  acc('113001', 'asset_receivable', n('ذمم العملاء', 'Accounts Receivable', 'Clients', 'Alıcılar', '应收账款'), { keys: ['AR_CONTROL'], ck: 'AR' }),
  acc('113002', 'asset_receivable', n('أوراق القبض', 'Notes Receivable', 'Effets à recevoir', 'Alacak Senetleri', '应收票据'), { r: true }),
  acc('113003', 'asset_current', n('سُلف وذمم الموظفين', 'Employee Advances and Receivables', 'Avances et créances du personnel', 'Personel Avansları ve Alacakları', '员工借款及应收款'), { r: true }),
  acc('113004', 'asset_current', n('ذمم مدينة أخرى', 'Other Receivables', 'Autres créances', 'Diğer Alacaklar', '其他应收款'), { r: true }),
  acc('113009', 'asset_current', n('مخصص الديون المشكوك في تحصيلها', 'Allowance for Doubtful Debts', 'Provision pour créances douteuses', 'Şüpheli Alacaklar Karşılığı', '坏账准备'), { keys: ['DOUBTFUL_ALLOWANCE'] }),
  acc('114001', 'asset_current', n('مخزون المستودع', 'Warehouse Inventory', 'Stock de l’entrepôt', 'Depo Stoku', '仓库存货'), { keys: ['INVENTORY_WAREHOUSE'], ck: 'INVENTORY' }),
  acc('114002', 'asset_current', n('بضاعة لدى المناديب (السيارات)', 'Van Stock with Sales Reps', 'Stock dans les véhicules des commerciaux', 'Temsilci Araçlarındaki Stok', '销售代表车辆存货'), { keys: ['INVENTORY_VAN'], ck: 'INVENTORY' }),
  acc('114003', 'asset_current', n('بضاعة بالطريق', 'Goods in Transit', 'Marchandises en transit', 'Yoldaki Mallar', '在途物资')),
  acc('115001', 'asset_prepayments', n('مصروفات مدفوعة مقدماً', 'Prepaid Expenses', 'Charges constatées d’avance', 'Peşin Ödenmiş Giderler', '预付费用'), { keys: ['DEFERRED_EXPENSE'] }),
  acc('115002', 'asset_prepayments', n('إيجار مدفوع مقدماً', 'Prepaid Rent', 'Loyer payé d’avance', 'Peşin Ödenmiş Kira', '预付租金')),
  acc('115003', 'asset_prepayments', n('دفعات مقدمة للموردين', 'Advances to Suppliers', 'Avances aux fournisseurs', 'Satıcılara Verilen Avanslar', '预付供应商款项'), { r: true, keys: ['VENDOR_ADVANCES'] }),
  acc('115004', 'asset_prepayments', n('تأمينات مستردة قصيرة الأجل', 'Short-term Refundable Deposits', 'Dépôts remboursables à court terme', 'Kısa Vadeli İade Edilebilir Depozitolar', '短期可退还押金')),
  acc('116001', 'asset_current', n('ضريبة القيمة المضافة: المدخلات', 'VAT Input', 'TVA déductible', 'İndirilecek KDV', '增值税进项税'), { keys: ['INPUT_VAT'], ck: 'VAT_IN' }),
  acc('116002', 'asset_current', n('ضريبة القيمة المضافة المستردة (صافي الإقرار)', 'VAT Receivable (Net Return)', 'Crédit de TVA (solde de la déclaration)', 'İade Alınacak KDV (Beyanname Neti)', '应退增值税（申报净额）'), { r: true, keys: ['VAT_RECEIVABLE'] }),
  acc('121001', 'asset_fixed', n('الأراضي', 'Land', 'Terrains', 'Arazi', '土地')),
  acc('121002', 'asset_fixed', n('المباني', 'Buildings', 'Constructions', 'Binalar', '房屋建筑物')),
  acc('121003', 'asset_fixed', n('تحسينات المباني المستأجرة', 'Leasehold Improvements', 'Agencements des locaux loués', 'Kiralık Bina İyileştirmeleri', '租入固定资产改良')),
  acc('121004', 'asset_fixed', n('الآلات والمعدات', 'Machinery and Equipment', 'Machines et équipements', 'Makine ve Ekipman', '机器设备')),
  acc('121005', 'asset_fixed', n('الأثاث والتجهيزات', 'Furniture and Fixtures', 'Mobilier et agencements', 'Mobilya ve Demirbaşlar', '家具及装置')),
  acc('121006', 'asset_fixed', n('أجهزة الحاسب والبرمجيات', 'Computers and Software', 'Matériel informatique et logiciels', 'Bilgisayar ve Yazılımlar', '电脑及软件')),
  acc('121007', 'asset_fixed', n('السيارات ووسائل النقل والتوزيع', 'Vehicles and Distribution Transport', 'Véhicules et matériel de distribution', 'Taşıtlar ve Dağıtım Araçları', '车辆及配送运输工具')),
  acc('121008', 'asset_fixed', n('العدد والأدوات', 'Tools and Implements', 'Outillage', 'Alet ve Edevat', '工具器具')),
  acc('122002', 'asset_fixed', n('مجمع إهلاك المباني', 'Accumulated Depreciation - Buildings', 'Amortissements cumulés - constructions', 'Birikmiş Amortisman - Binalar', '累计折旧－房屋建筑物')),
  acc('122003', 'asset_fixed', n('مجمع إهلاك تحسينات المباني المستأجرة', 'Accumulated Depreciation - Leasehold Improvements', 'Amortissements cumulés - agencements des locaux loués', 'Birikmiş Amortisman - Kiralık Bina İyileştirmeleri', '累计折旧－租入固定资产改良')),
  acc('122004', 'asset_fixed', n('مجمع إهلاك الآلات والمعدات', 'Accumulated Depreciation - Machinery and Equipment', 'Amortissements cumulés - machines et équipements', 'Birikmiş Amortisman - Makine ve Ekipman', '累计折旧－机器设备')),
  acc('122005', 'asset_fixed', n('مجمع إهلاك الأثاث والتجهيزات', 'Accumulated Depreciation - Furniture and Fixtures', 'Amortissements cumulés - mobilier et agencements', 'Birikmiş Amortisman - Mobilya ve Demirbaşlar', '累计折旧－家具及装置')),
  acc('122006', 'asset_fixed', n('مجمع إهلاك أجهزة الحاسب', 'Accumulated Depreciation - Computers', 'Amortissements cumulés - matériel informatique', 'Birikmiş Amortisman - Bilgisayarlar', '累计折旧－电脑')),
  acc('122007', 'asset_fixed', n('مجمع إهلاك السيارات', 'Accumulated Depreciation - Vehicles', 'Amortissements cumulés - véhicules', 'Birikmiş Amortisman - Taşıtlar', '累计折旧－车辆')),
  acc('122008', 'asset_fixed', n('مجمع إهلاك العدد والأدوات', 'Accumulated Depreciation - Tools', 'Amortissements cumulés - outillage', 'Birikmiş Amortisman - Alet ve Edevat', '累计折旧－工具器具')),
  acc('123001', 'asset_fixed', n('أصول حق الاستخدام (IFRS 16)', 'Right-of-Use Assets (IFRS 16)', 'Actifs au titre du droit d’utilisation (IFRS 16)', 'Kullanım Hakkı Varlıkları (TFRS 16)', '使用权资产（IFRS 16）'), { keys: ['ROU_ASSET'] }),
  acc('123009', 'asset_fixed', n('مجمع استهلاك أصول حق الاستخدام', 'Accumulated Depreciation - Right-of-Use Assets', 'Amortissements cumulés - droits d’utilisation', 'Birikmiş Amortisman - Kullanım Hakkı Varlıkları', '累计折旧－使用权资产'), { keys: ['ROU_ACCUMULATED'] }),
  acc('124001', 'asset_non_current', n('برمجيات وتراخيص (غير ملموسة)', 'Software and Licences (Intangible)', 'Logiciels et licences (incorporels)', 'Yazılım ve Lisanslar (Maddi Olmayan)', '软件及许可（无形资产）')),
  acc('124009', 'asset_non_current', n('مجمع إطفاء الأصول غير الملموسة', 'Accumulated Amortisation - Intangible Assets', 'Amortissements cumulés - immobilisations incorporelles', 'Birikmiş İtfa Payları - Maddi Olmayan Varlıklar', '累计摊销－无形资产')),
  acc('125001', 'asset_non_current', n('مصروفات تأسيس ومشروعات تحت التنفيذ', 'Pre-operating Costs and Projects in Progress', 'Frais d’établissement et immobilisations en cours', 'Kuruluş Giderleri ve Yapılmakta Olan Yatırımlar', '开办费及在建工程')),
  acc('125002', 'asset_non_current', n('تأمينات مستردة طويلة الأجل', 'Long-term Refundable Deposits', 'Dépôts remboursables à long terme', 'Uzun Vadeli İade Edilebilir Depozitolar', '长期可退还押金')),

  // ── 2 الالتزامات ──
  acc('211001', 'liability_payable', n('ذمم الموردين', 'Accounts Payable', 'Fournisseurs', 'Satıcılar', '应付账款'), { r: true, keys: ['AP_CONTROL'], ck: 'AP' }),
  acc('211002', 'liability_current', n('مشتريات مستلمة لم تُفوتر', 'Goods Received Not Invoiced', 'Marchandises reçues non facturées', 'Faturası Gelmemiş Alımlar', '已收货未开票'), { r: true, keys: ['GRNI'] }),
  acc('211003', 'liability_payable', n('أوراق الدفع', 'Notes Payable', 'Effets à payer', 'Borç Senetleri', '应付票据'), { r: true }),
  acc('212001', 'liability_current', n('ضريبة القيمة المضافة: المخرجات', 'VAT Output', 'TVA collectée', 'Hesaplanan KDV', '增值税销项税'), { keys: ['OUTPUT_VAT'], ck: 'VAT_OUT' }),
  acc('212002', 'liability_current', n('ضريبة القيمة المضافة المستحقة (صافي الإقرار)', 'VAT Payable (Net Return)', 'TVA à payer (solde de la déclaration)', 'Ödenecek KDV (Beyanname Neti)', '应交增值税（申报净额）'), { r: true, keys: ['VAT_PAYABLE'] }),
  acc('212003', 'liability_current', n('ضريبة المخرجات: احتساب عكسي', 'Output VAT - Reverse Charge', 'TVA collectée - autoliquidation', 'Hesaplanan KDV - Sorumlu Sıfatıyla', '销项税－反向征收'), { keys: ['VAT_RC_OUTPUT'] }),
  acc('212004', 'liability_current', n('ضريبة الاستقطاع المستحقة', 'Withholding Tax Payable', 'Retenue à la source à payer', 'Ödenecek Stopaj Vergisi', '应交代扣税'), { r: true, keys: ['WHT_PAYABLE'] }),
  acc('212005', 'liability_current', n('مخصص الزكاة', 'Zakat Provision', 'Provision pour zakat', 'Zekât Karşılığı', '天课准备'), { keys: ['ZAKAT_PROVISION'] }),
  acc('212006', 'liability_current', n('تصحيحات ضريبية لفترات سابقة', 'Prior Period VAT Corrections', 'Corrections de TVA des périodes antérieures', 'Önceki Dönem KDV Düzeltmeleri', '以前期间增值税更正'), { keys: ['VAT_CORRECTIONS'] }),
  acc('213001', 'liability_current', n('رواتب وأجور مستحقة', 'Salaries and Wages Payable', 'Salaires à payer', 'Ödenecek Maaş ve Ücretler', '应付工资'), { r: true }),
  acc('213002', 'liability_current', n('مصروفات مستحقة', 'Accrued Expenses', 'Charges à payer', 'Gider Tahakkukları', '应计费用'), { r: true, keys: ['ACCRUED_EXPENSES'] }),
  acc('213003', 'liability_current', n('التأمينات الاجتماعية المستحقة', 'Social Insurance Payable', 'Cotisations sociales à payer', 'Ödenecek Sosyal Sigorta Primleri', '应付社会保险'), { r: true }),
  acc('214001', 'liability_current', n('إيرادات مؤجلة', 'Deferred Revenue', 'Produits constatés d’avance', 'Ertelenmiş Gelirler', '递延收入'), { keys: ['DEFERRED_REVENUE'] }),
  acc('215001', 'liability_current', n('قروض قصيرة الأجل', 'Short-term Loans', 'Emprunts à court terme', 'Kısa Vadeli Krediler', '短期借款')),
  acc('215002', 'liability_current', n('الجزء المتداول من القروض طويلة الأجل', 'Current Portion of Long-term Loans', 'Part à court terme des emprunts à long terme', 'Uzun Vadeli Kredilerin Kısa Vadeli Kısmı', '一年内到期的长期借款')),
  acc('215003', 'liability_current', n('التزامات عقود الإيجار (متداولة)', 'Lease Liabilities (Current)', 'Dettes locatives (courantes)', 'Kiralama Yükümlülükleri (Kısa Vadeli)', '租赁负债（流动）')),
  acc('216001', 'liability_credit_card', n('بطاقة ائتمان الشركة', 'Company Credit Card', 'Carte de crédit de la société', 'Şirket Kredi Kartı', '公司信用卡'), { r: true }),
  acc('217001', 'liability_current', n('جاري الشركاء (دائن)', 'Partners Current Account (Credit)', 'Comptes courants des associés (créditeurs)', 'Ortaklar Cari Hesabı (Alacak)', '合伙人往来（贷方）')),
  acc('221001', 'liability_non_current', n('قروض طويلة الأجل', 'Long-term Loans', 'Emprunts à long terme', 'Uzun Vadeli Krediler', '长期借款')),
  acc('221002', 'liability_non_current', n('التزامات عقود الإيجار (غير متداولة)', 'Lease Liabilities (Non-current)', 'Dettes locatives (non courantes)', 'Kiralama Yükümlülükleri (Uzun Vadeli)', '租赁负债（非流动）'), { keys: ['LEASE_LIABILITY'] }),
  acc('222001', 'liability_non_current', n('مخصص مكافأة نهاية الخدمة', 'End of Service Benefits Provision', 'Provision pour indemnités de fin de service', 'Kıdem Tazminatı Karşılığı', '离职补偿准备'), { keys: ['EOSB_PROVISION'] }),

  // ── 3 حقوق الملكية ──
  acc('311001', 'equity', n('رأس المال', 'Share Capital', 'Capital social', 'Sermaye', '实收资本')),
  acc('312001', 'equity', n('الاحتياطي النظامي', 'Statutory Reserve', 'Réserve légale', 'Yasal Yedekler', '法定盈余公积')),
  acc('313001', 'equity', n('الأرباح المبقاة', 'Retained Earnings', 'Résultats reportés', 'Geçmiş Yıllar Kârları', '留存收益'), { keys: ['RETAINED_EARNINGS'] }),
  acc('314001', 'equity', n('جاري الملاك والشركاء', 'Owners and Partners Current Account', 'Comptes courants des propriétaires et associés', 'Sahipler ve Ortaklar Cari Hesabı', '业主及合伙人往来')),
  acc('315001', 'equity', n('مسحوبات وتوزيعات الملاك', 'Owner Drawings and Distributions', 'Prélèvements et distributions des propriétaires', 'Sahip Çekişleri ve Kâr Dağıtımları', '业主提款及分配'), { keys: ['DRAWINGS'], tags: ['DRAWINGS'] }),
  acc('319001', 'equity_unaffected', n('أرباح السنة الجارية غير الموزعة', 'Current Year Earnings', 'Résultat de l’exercice en cours', 'Cari Yıl Kârı', '本年利润'), { keys: ['CURRENT_YEAR_EARNINGS'] }),
  acc('319002', 'equity', n('أرصدة افتتاحية (تُصفّى)', 'Opening Balances (To Clear)', 'Soldes d’ouverture (à solder)', 'Açılış Bakiyeleri (Kapatılacak)', '期初余额（待清理）'), { keys: ['OPENING_EQUITY'] }),

  // ── 4 الإيرادات ──
  acc('411001', 'income', n('إيرادات المبيعات', 'Sales Revenue', 'Ventes de marchandises', 'Satış Gelirleri', '销售收入'), { keys: ['SALES_REVENUE'] }),
  acc('411002', 'income', n('إيرادات الخدمات', 'Service Revenue', 'Prestations de services', 'Hizmet Gelirleri', '服务收入')),
  acc('412001', 'income', n('مردودات المبيعات', 'Sales Returns', 'Retours sur ventes', 'Satıştan İadeler', '销售退回'), { keys: ['SALES_RETURNS'] }),
  acc('413001', 'income', n('خصم مسموح به على المبيعات', 'Sales Discounts', 'Remises accordées sur ventes', 'Satış İskontoları', '销售折扣'), { keys: ['SALES_DISCOUNT'] }),
  acc('421001', 'income_other', n('إيرادات أخرى', 'Other Income', 'Autres produits', 'Diğer Gelirler', '其他收入')),
  acc('421002', 'income_other', n('أرباح بيع أصول ثابتة', 'Gain on Disposal of Fixed Assets', 'Plus-values de cession d’immobilisations', 'Sabit Kıymet Satış Kârları', '固定资产处置收益'), { keys: ['ASSET_GAIN'] }),
  acc('421003', 'income_other', n('أرباح فروقات العملة', 'Foreign Exchange Gains', 'Gains de change', 'Kambiyo Kârları', '汇兑收益'), { keys: ['FX_GAIN'] }),
  acc('421004', 'income_other', n('خصم مكتسب للدفع المبكر', 'Early Payment Discounts Received', 'Escomptes obtenus', 'Erken Ödeme İskontosu Kazançları', '提前付款获得的折扣'), { keys: ['EARLY_DISCOUNT_GAIN'] }),
  acc('421009', 'income_other', n('فروقات التقريب', 'Rounding Differences', 'Écarts d’arrondi', 'Yuvarlama Farkları', '舍入差额'), { keys: ['ROUNDING'] }),

  // ── 5 تكلفة الإيرادات ──
  acc('511001', 'expense_direct_cost', n('تكلفة البضاعة المباعة', 'Cost of Goods Sold', 'Coût des marchandises vendues', 'Satılan Malın Maliyeti', '已售商品成本'), { keys: ['COGS'] }),
  acc('512001', 'expense_direct_cost', n('المشتريات (جرد دوري)', 'Purchases (Periodic Inventory)', 'Achats (inventaire intermittent)', 'Alışlar (Aralıklı Envanter)', '采购（定期盘存）'), { keys: ['PURCHASES'] }),
  acc('512002', 'expense_direct_cost', n('مردودات وخصم المشتريات', 'Purchase Returns and Discounts', 'Retours et remises sur achats', 'Alış İadeleri ve İskontoları', '采购退回及折扣'), { keys: ['PURCHASE_RETURNS'] }),
  acc('512003', 'expense_direct_cost', n('شحن وتخليص المشتريات', 'Freight and Clearance on Purchases', 'Transport et dédouanement sur achats', 'Alış Nakliye ve Gümrükleme Giderleri', '采购运费及清关费')),
  acc('513001', 'expense_direct_cost', n('التغيّر في المخزون (إقفال دوري)', 'Change in Inventory (Periodic Closing)', 'Variation des stocks (clôture intermittente)', 'Stok Değişimi (Dönemsel Kapanış)', '存货变动（定期结账）'), { keys: ['INVENTORY_CHANGE'] }),
  acc('514001', 'expense_direct_cost', n('تالف وعجز المخزون', 'Inventory Damage and Shortage', 'Casse et manquants de stock', 'Stok Firesi ve Eksikleri', '存货损毁及短缺'), { keys: ['INVENTORY_WRITEOFF'] }),
  acc('514002', 'expense_direct_cost', n('فروقات جرد المخزون', 'Inventory Count Differences', 'Écarts d’inventaire', 'Stok Sayım Farkları', '存货盘点差异'), { keys: ['INVENTORY_ADJUSTMENT'] }),

  // ── 6 المصروفات التشغيلية ──
  acc('611001', 'expense', n('رواتب وأجور المناديب', 'Sales Rep Salaries and Wages', 'Salaires des commerciaux', 'Satış Temsilcisi Maaş ve Ücretleri', '销售代表工资')),
  acc('611002', 'expense', n('عمولات وحوافز المبيعات', 'Sales Commissions and Incentives', 'Commissions et primes sur ventes', 'Satış Komisyonları ve Teşvikleri', '销售佣金及奖励')),
  acc('611003', 'expense', n('وقود وزيوت السيارات', 'Vehicle Fuel and Oil', 'Carburant et huiles des véhicules', 'Araç Yakıt ve Yağları', '车辆燃油及机油'), { keys: ['FUEL'] }),
  acc('611004', 'expense', n('صيانة سيارات التوزيع', 'Distribution Vehicle Maintenance', 'Entretien des véhicules de distribution', 'Dağıtım Aracı Bakımı', '配送车辆维修')),
  acc('611005', 'expense', n('تأمين السيارات ورسومها', 'Vehicle Insurance and Fees', 'Assurance et frais des véhicules', 'Araç Sigortası ve Harçları', '车辆保险及规费')),
  acc('611006', 'expense', n('دعاية وإعلان', 'Advertising and Promotion', 'Publicité et promotion', 'Reklam ve Tanıtım', '广告宣传')),
  acc('611007', 'expense', n('عمولات بوابات الدفع الإلكتروني', 'Online Payment Gateway Fees', 'Commissions des passerelles de paiement en ligne', 'Çevrimiçi Ödeme Geçidi Komisyonları', '在线支付网关手续费'), { keys: ['PAYLINK_FEE_EXPENSE'] }),
  acc('611008', 'expense', n('رسوم بنكية ونقاط البيع', 'Bank and POS Charges', 'Frais bancaires et TPE', 'Banka ve POS Masrafları', '银行及POS手续费'), { keys: ['BANK_FEES'] }),
  acc('611009', 'expense', n('عينات وهدايا ترويجية', 'Samples and Promotional Gifts', 'Échantillons et cadeaux promotionnels', 'Numune ve Promosyon Hediyeleri', '样品及促销礼品')),
  acc('611010', 'expense', n('نقل وشحن المبيعات', 'Sales Freight and Delivery', 'Transport et livraison des ventes', 'Satış Nakliye ve Teslimat Giderleri', '销售运输费')),
  acc('621001', 'expense', n('رواتب وأجور إدارية', 'Administrative Salaries and Wages', 'Salaires administratifs', 'İdari Personel Maaş ve Ücretleri', '管理人员工资')),
  acc('621002', 'expense', n('التأمينات الاجتماعية', 'Social Insurance', 'Cotisations sociales', 'Sosyal Sigorta Primleri', '社会保险费')),
  acc('621003', 'expense', n('مكافأة نهاية الخدمة', 'End of Service Benefits', 'Indemnités de fin de service', 'Kıdem Tazminatı Gideri', '离职补偿')),
  acc('621004', 'expense', n('الإيجار', 'Rent', 'Loyers', 'Kira Giderleri', '租金')),
  acc('621005', 'expense', n('سكن الموظفين', 'Staff Housing', 'Logement du personnel', 'Personel Konut Giderleri', '员工住房')),
  acc('621006', 'expense', n('الكهرباء والمياه', 'Electricity and Water', 'Électricité et eau', 'Elektrik ve Su', '水电费')),
  acc('621007', 'expense', n('الهاتف والإنترنت', 'Telephone and Internet', 'Téléphone et internet', 'Telefon ve İnternet', '电话及网络费')),
  acc('621008', 'expense', n('اشتراكات البرامج والأنظمة', 'Software and System Subscriptions', 'Abonnements logiciels et systèmes', 'Yazılım ve Sistem Abonelikleri', '软件及系统订阅费')),
  acc('621009', 'expense', n('أدوات مكتبية ومطبوعات', 'Office Supplies and Printing', 'Fournitures de bureau et impression', 'Kırtasiye ve Basılı Malzemeler', '办公用品及印刷')),
  acc('621010', 'expense', n('الصيانة والإصلاحات', 'Maintenance and Repairs', 'Entretien et réparations', 'Bakım ve Onarım', '维修费')),
  acc('621011', 'expense', n('النظافة', 'Cleaning', 'Nettoyage', 'Temizlik', '清洁费')),
  acc('621012', 'expense', n('الضيافة', 'Hospitality', 'Réception et hospitalité', 'Ağırlama Giderleri', '招待费')),
  acc('621013', 'expense', n('رسوم حكومية وتراخيص', 'Government Fees and Licences', 'Taxes administratives et licences', 'Resmi Harçlar ve Lisanslar', '政府规费及许可')),
  acc('621014', 'expense', n('أتعاب مهنية واستشارات', 'Professional and Consulting Fees', 'Honoraires et conseil', 'Profesyonel Hizmet ve Danışmanlık Ücretleri', '专业服务及咨询费')),
  acc('621015', 'expense', n('التأمين الطبي', 'Medical Insurance', 'Assurance maladie', 'Sağlık Sigortası', '医疗保险')),
  acc('621016', 'expense', n('مصروفات عمومية متنوعة', 'Miscellaneous General Expenses', 'Charges générales diverses', 'Çeşitli Genel Giderler', '其他一般费用')),
  acc('621017', 'expense', n('مكافآت', 'Bonuses', 'Primes', 'İkramiyeler', '奖金')),
  acc('621018', 'expense', n('خدمات خارجية', 'Outsourced Services', 'Services extérieurs', 'Dış Hizmetler', '外包服务')),
  acc('631001', 'expense_depreciation', n('إهلاك المباني والتحسينات', 'Depreciation - Buildings and Improvements', 'Dotations aux amortissements - constructions et agencements', 'Amortisman - Binalar ve İyileştirmeler', '折旧－房屋及改良')),
  acc('631002', 'expense_depreciation', n('إهلاك الآلات والمعدات', 'Depreciation - Machinery and Equipment', 'Dotations aux amortissements - machines et équipements', 'Amortisman - Makine ve Ekipman', '折旧－机器设备')),
  acc('631003', 'expense_depreciation', n('إهلاك الأثاث والتجهيزات', 'Depreciation - Furniture and Fixtures', 'Dotations aux amortissements - mobilier et agencements', 'Amortisman - Mobilya ve Demirbaşlar', '折旧－家具及装置')),
  acc('631004', 'expense_depreciation', n('إهلاك أجهزة الحاسب', 'Depreciation - Computers', 'Dotations aux amortissements - matériel informatique', 'Amortisman - Bilgisayarlar', '折旧－电脑')),
  acc('631005', 'expense_depreciation', n('إهلاك السيارات', 'Depreciation - Vehicles', 'Dotations aux amortissements - véhicules', 'Amortisman - Taşıtlar', '折旧－车辆')),
  acc('631006', 'expense_depreciation', n('استهلاك أصول حق الاستخدام', 'Depreciation - Right-of-Use Assets', 'Dotations aux amortissements - droits d’utilisation', 'Amortisman - Kullanım Hakkı Varlıkları', '折旧－使用权资产')),
  acc('631007', 'expense_depreciation', n('إطفاء الأصول غير الملموسة', 'Amortisation - Intangible Assets', 'Dotations aux amortissements - immobilisations incorporelles', 'İtfa Payları - Maddi Olmayan Varlıklar', '摊销－无形资产')),

  // ── 7 مصروفات أخرى وزكاة ──
  acc('711001', 'expense_other', n('مصاريف تمويلية وفوائد', 'Finance Costs and Interest', 'Charges financières et intérêts', 'Finansman Giderleri ve Faizler', '财务费用及利息'), { keys: ['LOAN_INTEREST'] }),
  acc('711002', 'expense_other', n('خسائر فروقات العملة', 'Foreign Exchange Losses', 'Pertes de change', 'Kambiyo Zararları', '汇兑损失'), { keys: ['FX_LOSS'] }),
  acc('711003', 'expense_other', n('خسائر بيع أصول ثابتة', 'Loss on Disposal of Fixed Assets', 'Moins-values de cession d’immobilisations', 'Sabit Kıymet Satış Zararları', '固定资产处置损失'), { keys: ['ASSET_LOSS'] }),
  acc('711004', 'expense_other', n('خصم مسموح به للدفع المبكر', 'Early Payment Discounts Granted', 'Escomptes accordés', 'Verilen Erken Ödeme İskontoları', '提前付款给予的折扣'), { keys: ['EARLY_DISCOUNT_LOSS'] }),
  acc('711005', 'expense_other', n('ديون معدومة', 'Bad Debts', 'Créances irrécouvrables', 'Tahsil Edilemeyen Alacaklar', '坏账损失'), { keys: ['BAD_DEBT'] }),
  acc('711006', 'expense_other', n('مخصص ديون مشكوك فيها', 'Doubtful Debts Expense', 'Dotations aux provisions pour créances douteuses', 'Şüpheli Alacak Karşılık Gideri', '计提坏账准备')),
  acc('711007', 'expense_other', n('غرامات ومخالفات', 'Fines and Penalties', 'Amendes et pénalités', 'Cezalar ve Para Cezaları', '罚款及违约金')),
  acc('721001', 'expense_zakat', n('الزكاة الشرعية', 'Zakat', 'Zakat', 'Zekât', '天课'), { keys: ['ZAKAT_EXPENSE'] }),
  acc('721002', 'expense_zakat', n('ضريبة الدخل', 'Income Tax', 'Impôt sur le revenu', 'Gelir Vergisi', '所得税')),

  // ── 9 حسابات النظام ──
  acc('911001', 'asset_current', n('معلّق: فروقات الترحيل الآلي', 'Suspense: Automatic Posting Differences', 'Attente : écarts de comptabilisation automatique', 'Askı: Otomatik Kayıt Farkları', '暂记：自动过账差异'), { r: true, keys: ['POSTING_SUSPENSE'], ck: 'SUSPENSE' }),
  acc('991001', 'off_balance', n('شيكات ضمان مستلمة', 'Guarantee Cheques Received', 'Chèques de garantie reçus', 'Alınan Teminat Çekleri', '收到的保证支票')),
  acc('991002', 'off_balance', n('مقابل شيكات الضمان', 'Guarantee Cheques Contra', 'Contrepartie des chèques de garantie', 'Teminat Çekleri Karşılığı', '保证支票对应科目')),
];

// ═══ مرادفات البحث عن الحسابات (م‑1) ═══

/**
 * الكلمات التي يستعملها المحاسب ولا تطابق أسماء القالب: «بنزين» ⇐ 611003، «أجرة» ⇐ 621004…
 * رمز الحساب ⇒ كلمات بديلة عربية. يستعملها بحث الخادم `GET /ledger/accounts?search=` وبحث الواجهة معاً،
 * بعد تطبيع عربي (ألف/همزة/تاء مربوطة/تشكيل/مسافات). **لا يتكرر مرادف على حسابين** (يفرضه الاختبار).
 */
export const SA_6D_ACCOUNT_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  // ── النقد والبنوك ──
  '111001': ['كاش', 'خزنة', 'خزينة', 'نقدية', 'الدرج'],
  '111002': ['نثريات', 'نثرية', 'مصروف نثري', 'بتي كاش'],
  '111003': ['عهدة المندوب', 'تحصيلات المناديب', 'عهدة التحصيل', 'نقدية المندوب'],
  '111101': ['بنك', 'مصرف', 'حساب جاري', 'الراجحي', 'الأهلي'],
  '112001': ['نقد لم يودع', 'مقبوضات معلقة', 'إيداع قيد التحصيل'],
  '112002': ['مدفوعات معلقة', 'شيكات صادرة لم تُصرف', 'أوامر صرف'],
  '112003': ['شيكات واردة', 'شيكات العملاء', 'شيك برسم التحصيل'],
  '112004': ['شبكة', 'نقاط البيع', 'مدى', 'جهاز الشبكة'],
  '112005': ['أمانات ميسر', 'روابط الدفع', 'دفع إلكتروني معلق'],
  '112006': ['تحويل داخلي', 'تحويل بين الصناديق', 'نقد بالطريق'],
  '112009': ['معلق البنك', 'حركة بنكية غير معروفة'],

  // ── الذمم والمخزون ──
  '113001': ['مدينون', 'مستحق على العملاء', 'فواتير آجلة', 'رصيد العميل'],
  '113002': ['كمبيالات', 'سندات لأمر', 'شيكات آجلة للعملاء'],
  '113003': ['سلفة موظف', 'سلف', 'عهدة موظف', 'سلفيات'],
  '113004': ['مدينون آخرون', 'مطالبات', 'مستحق على الغير'],
  '113009': ['مخصص ديون', 'احتياطي ديون مشكوك فيها'],
  '114001': ['مخزن', 'مخزون', 'ستوك', 'بضاعة المستودع'],
  '114002': ['بضاعة السيارة', 'مخزون السيارة', 'حمولة المندوب', 'عهدة بضاعة'],
  '114003': ['بضاعة في الطريق', 'شحنة واردة'],
  '115001': ['مصروف مقدم', 'مدفوع مقدماً', 'اشتراك مقدم'],
  '115002': ['إيجار مقدم', 'أجرة مقدمة'],
  '115003': ['مقدم للمورد', 'دفعة للمورد', 'عربون مورد'],
  '115004': ['تأمين مسترد', 'وديعة تأمين', 'تأمين الإيجار'],
  '116001': ['ضريبة المشتريات', 'ضريبة مدخلات', 'ضريبة قابلة للخصم'],
  '116002': ['استرداد ضريبة', 'ضريبة مستحقة لنا'],

  // ── الأصول الثابتة ──
  '121001': ['أرض', 'قطعة أرض'],
  '121002': ['مبنى', 'عمارة', 'عقار'],
  '121003': ['ديكور', 'تشطيب المحل', 'تجهيز محل مستأجر'],
  '121004': ['معدات', 'ماكينة', 'ثلاجات', 'آلة'],
  '121005': ['أثاث', 'مكاتب', 'رفوف', 'كراسي'],
  '121006': ['كمبيوتر', 'لابتوب', 'طابعة', 'جهاز نقطة بيع'],
  '121007': ['سيارة', 'مركبة', 'شاحنة', 'وانيت'],
  '121008': ['عدة', 'أدوات', 'معدات يدوية'],

  // ── الالتزامات ──
  '211001': ['دائنون', 'الموردين', 'مستحق للموردين', 'فواتير الموردين'],
  '211002': ['بضاعة بلا فاتورة', 'استلام بلا فاتورة'],
  '211003': ['شيكات صادرة آجلة', 'كمبيالات علينا'],
  '212001': ['ضريبة المبيعات', 'ضريبة مخرجات', 'قيمة مضافة على المبيعات'],
  '212002': ['ضريبة مستحقة', 'سداد الضريبة', 'ضريبة الإقرار'],
  '212004': ['استقطاع', 'ضريبة مورد غير مقيم'],
  '212005': ['مخصص زكاة', 'زكاة مستحقة'],
  '213001': ['رواتب مستحقة', 'أجور مستحقة', 'مرتبات مستحقة'],
  '213002': ['مستحقات', 'مصاريف مستحقة', 'فواتير لم تُدفع'],
  '213003': ['اشتراك التأمينات المستحق'],
  '214001': ['إيراد مقدم', 'دفعة مقدمة من العميل', 'مقدم عميل'],
  '215001': ['قرض قصير', 'تسهيلات بنكية', 'سلفة بنكية'],
  '215002': ['قسط القرض المتداول'],
  '216001': ['بطاقة ائتمان', 'فيزا الشركة', 'كرت الشركة'],
  '217001': ['جاري شريك', 'حساب الشريك'],
  '221001': ['قرض طويل', 'تمويل طويل الأجل'],
  '222001': ['مخصص نهاية الخدمة', 'التزام نهاية الخدمة'],

  // ── حقوق الملكية ──
  '311001': ['رأسمال', 'حصص الشركاء', 'رأس مال الشركاء'],
  '312001': ['احتياطي', 'احتياطي نظامي'],
  '313001': ['أرباح مرحلة', 'أرباح سابقة'],
  '314001': ['جاري المالك', 'حساب المالك'],
  '315001': ['مسحوبات', 'سحب شخصي', 'سحوبات المالك', 'توزيعات أرباح'],

  // ── الإيرادات ──
  '411001': ['مبيعات', 'بيع', 'إيراد المبيعات', 'فواتير البيع'],
  '411002': ['إيراد خدمة', 'أجور خدمات', 'رسوم توصيل'],
  '412001': ['مرتجع مبيعات', 'مرتجعات', 'إشعار دائن'],
  '413001': ['خصم مبيعات', 'خصم للعميل', 'تخفيض على الفاتورة'],
  '421001': ['إيراد متنوع', 'دخل آخر', 'إيراد عرضي'],
  '421002': ['ربح بيع أصل', 'مكسب بيع سيارة'],
  '421003': ['ربح صرف', 'فرق عملة دائن'],
  '421004': ['خصم من المورد', 'خصم تعجيل السداد'],
  '421009': ['كسور', 'هللات', 'تقريب'],

  // ── تكلفة الإيرادات ──
  '511001': ['تكلفة المبيعات', 'كلفة البضاعة المباعة', 'تكلفة البيع'],
  '512001': ['مشتريات', 'شراء بضاعة', 'فواتير الشراء'],
  '512002': ['مرتجع مشتريات', 'خصم مشتريات', 'إشعار مدين للمورد'],
  '512003': ['شحن المشتريات', 'تخليص جمركي', 'نولون', 'جمارك'],
  '513001': ['تسوية مخزون دوري', 'فرق أول وآخر المدة'],
  '514001': ['تالف', 'هالك', 'منتهي الصلاحية', 'كسر بضاعة'],
  '514002': ['فرق جرد', 'عجز وزيادة', 'جرد'],

  // ── مصروفات البيع والتوزيع ──
  '611001': ['رواتب المناديب', 'أجور المندوبين', 'مرتبات المناديب'],
  '611002': ['عمولة المندوب', 'عمولات البيع', 'حافز مبيعات'],
  '611003': ['بنزين', 'محروقات', 'وقود', 'سولار', 'ديزل', 'تعبئة وقود', 'زيت السيارة'],
  '611004': ['صيانة السيارات', 'ورشة', 'قطع غيار', 'إطارات', 'كفرات', 'غسيل سيارة'],
  '611005': ['تأمين السيارة', 'استمارة', 'فحص دوري', 'مخالفات مرورية', 'ساهر'],
  '611006': ['دعاية', 'إعلان', 'تسويق', 'لوحة إعلانية', 'حملة إعلانية'],
  '611007': ['عمولة بوابة الدفع', 'رسوم الدفع الإلكتروني', 'عمولة ميسر'],
  '611008': ['رسوم بنكية', 'عمولة البنك', 'رسوم الشبكة', 'مصاريف بنكية'],
  '611009': ['عينات', 'هدايا', 'مجانيات'],
  '611010': ['توصيل', 'شحن المبيعات', 'أجرة توصيل', 'مندوب توصيل'],

  // ── المصروفات الإدارية والعمومية ──
  '621001': ['رواتب', 'مرتبات', 'أجور', 'رواتب الموظفين', 'بدلات'],
  '621002': ['تأمينات', 'جوسي', 'اشتراك التأمينات'],
  '621003': ['عبء نهاية الخدمة', 'مصروف نهاية الخدمة'],
  '621004': ['إيجار', 'أجرة', 'إيجار المحل', 'إيجار المستودع', 'أجرة المحل', 'كراء'],
  '621005': ['سكن العمال', 'إيجار سكن الموظفين', 'مسكن الموظفين'],
  '621006': ['كهربا', 'كهرباء', 'فاتورة الكهرباء', 'ماء', 'مياه', 'فاتورة الماء'],
  '621007': ['تليفون', 'جوال', 'هاتف', 'انترنت', 'إنترنت', 'اتصالات', 'فاتورة الجوال'],
  '621008': ['اشتراك برنامج', 'رخصة برنامج', 'نظام محاسبي', 'استضافة', 'اشتراك شهري'],
  '621009': ['قرطاسية', 'طباعة', 'أحبار', 'حبر الطابعة', 'دفاتر'],
  '621010': ['صيانة', 'إصلاح', 'تصليح', 'صيانة المكيفات', 'عقد صيانة'],
  '621011': ['تنظيف', 'عاملة نظافة', 'مكافحة حشرات', 'مواد تنظيف'],
  '621012': ['قهوة', 'شاي', 'بوفيه', 'ضيافة الزوار'],
  '621013': ['سجل تجاري', 'بلدية', 'رخصة', 'تجديد السجل', 'رسوم حكومية', 'مكتب العمل'],
  '621014': ['أتعاب', 'محاسب قانوني', 'محامي', 'استشارات', 'مراجع حسابات'],
  '621015': ['تأمين طبي', 'تأمين صحي', 'وثيقة طبية'],
  '621016': ['مصاريف متنوعة', 'مصاريف عامة', 'نثريات عامة'],
  '621017': ['مكافأة', 'بونص', 'حوافز الموظفين', 'مكرمة'],
  '621018': ['متعاقد خارجي', 'عمالة مؤقتة', 'حراسة', 'أمن', 'مقاول باطن'],

  // ── الإهلاك والمصروفات الأخرى ──
  '631001': ['إهلاك العقار', 'إهلاك التحسينات'],
  '631002': ['إهلاك المعدات', 'إهلاك الماكينات'],
  '631003': ['إهلاك المكاتب والرفوف'],
  '631004': ['إهلاك الكمبيوتر', 'إهلاك الأجهزة'],
  '631005': ['استهلاك السيارات', 'قسط إهلاك السيارة'],
  '631007': ['إطفاء البرمجيات'],
  '711001': ['فوائد', 'فائدة القرض', 'مصاريف تمويل', 'رسوم تمويل'],
  '711002': ['خسارة صرف', 'فرق عملة مدين'],
  '711003': ['خسارة بيع أصل'],
  '711005': ['دين معدوم', 'شطب دين', 'ديون هالكة'],
  '711007': ['غرامة', 'مخالفة', 'جزاء تأخير'],
  '721001': ['زكاة', 'زكاة الشركة'],
  '721002': ['ضريبة دخل', 'ضريبة الأرباح'],

  // ── حسابات النظام ──
  '911001': ['حساب معلق', 'وسيط مؤقت'],
  '991001': ['شيك ضمان', 'ضمان مستلم'],
};

// ═══ الدفاتر (§4.3) ═══

interface JrnOpts {
  refund?: string;
  def?: string;
  outstanding?: boolean;
  dash?: boolean;
}

function jrn(
  code: string, type: JournalType, systemKey: JournalSystemKey, reset: SequenceReset,
  names: TemplateNames, o: JrnOpts = {},
): JournalTemplate {
  return {
    code,
    type,
    systemKey,
    sequenceReset: reset,
    sequencePrefix: code,
    refundSequencePrefix: o.refund ?? null,
    defaultAccountCode: o.def ?? null,
    suspenseAccountCode: null,
    useOutstandingAccounts: o.outstanding ?? false,
    showOnDashboard: o.dash ?? false,
    isSystem: true,
    names,
  };
}

export const SA_6D_JOURNALS: readonly JournalTemplate[] = [
  jrn('INV', 'SALE', 'SALES', 'MONTHLY', n('المبيعات والمرتجعات', 'Sales and Returns', 'Ventes et retours', 'Satışlar ve İadeler', '销售及退货'), { refund: 'RINV', def: '411001', dash: true }),
  jrn('RCPT', 'GENERAL', 'RECEIPTS', 'YEARLY', n('مقبوضات العملاء', 'Customer Receipts', 'Encaissements clients', 'Müşteri Tahsilatları', '客户收款')),
  jrn('CUST', 'GENERAL', 'CUSTODY', 'YEARLY', n('عهدة المناديب واستلام التحصيل', 'Sales Rep Custody and Collection Handover', 'Dépôts des commerciaux et remise des encaissements', 'Temsilci Emaneti ve Tahsilat Teslimi', '销售代表保管及收款交接'), { def: '111003', dash: true }),
  jrn('BILL', 'PURCHASE', 'PURCHASES', 'MONTHLY', n('فواتير الموردين', 'Vendor Bills', 'Factures fournisseurs', 'Satıcı Faturaları', '供应商账单'), { refund: 'RBILL', def: '512001', dash: true }),
  jrn('PAY', 'GENERAL', 'PAYMENTS', 'YEARLY', n('مدفوعات الموردين', 'Vendor Payments', 'Paiements fournisseurs', 'Satıcı Ödemeleri', '供应商付款'), { def: '112002' }),
  jrn('EXP', 'GENERAL', 'EXPENSES', 'MONTHLY', n('المصروفات', 'Expenses', 'Dépenses', 'Giderler', '费用')),
  jrn('CSH1', 'CASH', 'CASH_MAIN', 'YEARLY', n('الصندوق الرئيسي', 'Main Cash', 'Caisse principale', 'Ana Kasa', '主现金'), { def: '111001', dash: true }),
  jrn('BNK1', 'BANK', 'BANK_MAIN', 'YEARLY', n('البنك الرئيسي', 'Main Bank', 'Banque principale', 'Ana Banka', '主银行'), { def: '111101', outstanding: true, dash: true }),
  jrn('PLNK', 'GENERAL', 'PAYLINK', 'YEARLY', n('أمانات الدفع الإلكتروني', 'Online Payments Held', 'Paiements en ligne détenus', 'Emanetteki Çevrimiçi Ödemeler', '代收在线付款'), { def: '112005', dash: true }),
  jrn('MISC', 'GENERAL', 'MISC', 'MONTHLY', n('عمليات متنوعة', 'Miscellaneous Operations', 'Opérations diverses', 'Çeşitli İşlemler', '杂项业务'), { dash: true }),
  jrn('STK', 'GENERAL', 'STOCK', 'MONTHLY', n('تقييم المخزون', 'Inventory Valuation', 'Valorisation des stocks', 'Stok Değerleme', '存货计价'), { def: '114001' }),
  jrn('TAX', 'GENERAL', 'TAX', 'MONTHLY', n('الإقرارات وتسويات الضريبة', 'Tax Returns and Adjustments', 'Déclarations et régularisations fiscales', 'Vergi Beyannameleri ve Düzeltmeleri', '纳税申报及调整'), { def: '212002', dash: true }),
  jrn('DEP', 'GENERAL', 'DEPRECIATION', 'MONTHLY', n('الأصول والإهلاك', 'Assets and Depreciation', 'Immobilisations et amortissements', 'Duran Varlıklar ve Amortisman', '资产及折旧')),
  jrn('ZKT', 'GENERAL', 'ZAKAT', 'YEARLY', n('الزكاة', 'Zakat', 'Zakat', 'Zekât', '天课'), { def: '212005', dash: true }),
  jrn('OPEN', 'GENERAL', 'OPENING', 'YEARLY', n('الأرصدة الافتتاحية', 'Opening Balances', 'Soldes d’ouverture', 'Açılış Bakiyeleri', '期初余额'), { def: '319002' }),
  jrn('FX', 'GENERAL', 'FX', 'YEARLY', n('فروقات العملة', 'Exchange Differences', 'Écarts de change', 'Kur Farkları', '汇兑差额')),
];

// ═══ مفاتيح الربط (§4.5) — مشتقة من الحسابات ═══

/**
 * يبني خريطة «مفتاح ← رمز» من mappingKeys الحسابات.
 * يرمي إن تكرر مفتاح أو نقص مفتاح من MAPPING_KEYS — القالب ناقص لا يُزرع.
 */
export function mappingsFromAccounts(accounts: readonly AccountTemplate[]): Record<MappingKey, string> {
  const out: Partial<Record<MappingKey, string>> = {};
  for (const a of accounts) {
    for (const k of a.mappingKeys) {
      if (out[k] !== undefined) throw new Error(`مفتاح ربط مكرر في القالب: ${k} (${out[k]}، ${a.code})`);
      out[k] = a.code;
    }
  }
  const missing = MAPPING_KEYS.filter((k) => out[k] === undefined);
  if (missing.length) throw new Error(`مفاتيح ربط بلا حساب في القالب: ${missing.join(', ')}`);
  return out as Record<MappingKey, string>;
}

export const SA_6D_MAPPINGS: Readonly<Record<MappingKey, string>> = mappingsFromAccounts(SA_6D_ACCOUNTS);

export const SA_6D_TEMPLATE: ChartTemplate = {
  key: 'SA_6D',
  groups: SA_6D_ACCOUNT_GROUPS,
  accounts: SA_6D_ACCOUNTS,
  journals: SA_6D_JOURNALS,
  mappings: SA_6D_MAPPINGS,
};

/**
 * الأنواع المقبولة لحساب كل مفتاح ربط — يتحقق منها اختبار القالب، ويصلح لتحقق `PUT /mappings` (M2).
 * الأول في كل قائمة هو نوع حساب القالب.
 */
export const MAPPING_KEY_ALLOWED_TYPES: Readonly<Record<MappingKey, readonly AccountType[]>> = {
  AR_CONTROL: ['asset_receivable'],
  AP_CONTROL: ['liability_payable'],
  SALES_REVENUE: ['income'],
  SALES_RETURNS: ['income'],
  SALES_DISCOUNT: ['income'],
  OUTPUT_VAT: ['liability_current'],
  INPUT_VAT: ['asset_current'],
  VAT_PAYABLE: ['liability_current'],
  VAT_RECEIVABLE: ['asset_current'],
  VAT_RC_OUTPUT: ['liability_current'],
  REP_CUSTODY: ['asset_cash'],
  MAIN_CASH: ['asset_cash'],
  PETTY_CASH: ['asset_cash'],
  MAIN_BANK: ['asset_cash'],
  OUTSTANDING_RECEIPTS: ['asset_current'],
  OUTSTANDING_PAYMENTS: ['asset_current'],
  CHEQUES_UNDER_COLLECTION: ['asset_current'],
  POS_CLEARING: ['asset_current'],
  PAYLINK_CLEARING: ['asset_current'],
  PAYLINK_FEE_EXPENSE: ['expense', 'expense_other'],
  PAYLINK_PAYOUT_ACCOUNT: ['asset_current', 'asset_cash'],
  BANK_SUSPENSE: ['asset_current'],
  BANK_FEES: ['expense', 'expense_other'],
  INTERNAL_TRANSFER: ['asset_current'],
  OPENING_EQUITY: ['equity'],
  CURRENT_YEAR_EARNINGS: ['equity_unaffected'],
  RETAINED_EARNINGS: ['equity'],
  DRAWINGS: ['equity'],
  ROUNDING: ['income_other', 'expense_other'],
  POSTING_SUSPENSE: ['asset_current', 'liability_current'],
  INVENTORY_WAREHOUSE: ['asset_current'],
  INVENTORY_VAN: ['asset_current'],
  GRNI: ['liability_current'],
  COGS: ['expense_direct_cost'],
  PURCHASES: ['expense_direct_cost'],
  PURCHASE_RETURNS: ['expense_direct_cost'],
  INVENTORY_CHANGE: ['expense_direct_cost'],
  INVENTORY_WRITEOFF: ['expense_direct_cost', 'expense_other'],
  INVENTORY_ADJUSTMENT: ['expense_direct_cost', 'expense_other'],
  VENDOR_ADVANCES: ['asset_prepayments', 'asset_current'],
  EARLY_DISCOUNT_GAIN: ['income_other'],
  EARLY_DISCOUNT_LOSS: ['expense_other'],
  DEFERRED_REVENUE: ['liability_current', 'liability_non_current'],
  DEFERRED_EXPENSE: ['asset_prepayments', 'asset_current', 'asset_non_current'],
  ASSET_GAIN: ['income_other'],
  ASSET_LOSS: ['expense_other'],
  LOAN_INTEREST: ['expense_other'],
  LEASE_LIABILITY: ['liability_non_current', 'liability_current'],
  ROU_ASSET: ['asset_fixed', 'asset_non_current'],
  ROU_ACCUMULATED: ['asset_fixed', 'asset_non_current'],
  FX_GAIN: ['income_other'],
  FX_LOSS: ['expense_other'],
  WHT_PAYABLE: ['liability_current'],
  ZAKAT_EXPENSE: ['expense_zakat'],
  ZAKAT_PROVISION: ['liability_current'],
  BAD_DEBT: ['expense_other', 'expense'],
  DOUBTFUL_ALLOWANCE: ['asset_current', 'asset_receivable'],
  ACCRUED_EXPENSES: ['liability_current'],
  EOSB_PROVISION: ['liability_non_current', 'liability_current'],
  FUEL: ['expense'],
  VAT_CORRECTIONS: ['liability_current', 'asset_current'],
};

/** الحساب الرئيسي المتوقع لمفاتيح الربط الرئيسية (I4، I7). */
export const MAPPING_KEY_CONTROL_KIND: Readonly<Partial<Record<MappingKey, ControlKind>>> = {
  AR_CONTROL: 'AR',
  AP_CONTROL: 'AP',
  REP_CUSTODY: 'CUSTODY',
  PAYLINK_CLEARING: 'PAYLINK',
  INVENTORY_WAREHOUSE: 'INVENTORY',
  INVENTORY_VAN: 'INVENTORY',
  OUTPUT_VAT: 'VAT_OUT',
  INPUT_VAT: 'VAT_IN',
  POSTING_SUSPENSE: 'SUSPENSE',
};
