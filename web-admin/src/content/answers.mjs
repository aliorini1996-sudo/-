/**
 * أجوبة مباشرة قابلة للاقتباس لمحرّكات الإجابة (بند L1). منها يبني scripts/gen-llms.mjs قسمي الأسئلة
 * الشائعة في public/llms.txt بالعربية والإنجليزية، ومنها جملة التعريف في رأس الملف.
 *
 * لماذا ملف مستقل: محرّك الإجابة يقتبس الجواب حرفياً، فكل جواب هنا مكتوب ليقوم بنفسه في نحو
 * أربعين إلى ستين كلمة، ومبني على ما يفعله المنتج فعلاً (src/content/features.mjs وsrc/rep/RepApp.tsx)
 * لا على وصف تسويقي.
 *
 * قواعد الصدق (scripts/claims-rules.mjs، وgen-llms يفحص مخرجه بها قبل الكتابة):
 *  - صيغة الربط الوحيدة «ندعم ربط المرحلة الثانية مع منصة فاتورة»، للسعودية وحدها، بلا «معتمد» ولا شراكة.
 *    وجوابها خالٍ من السنوات والمهل والأعداد، لأن حارس zatca-phase2-dated ينظر 80 حرفاً قبل العبارة
 *    و120 بعدها (تصحيح الناقد 8). لذلك لا تُنقل إلى هنا أجوبة شرح اللائحة التي فيها مهلة الإبلاغ.
 *  - للشركات المفعّل لها الربط تحتاج الفواتير القياسية والمبسطة والمرتجعات اتصالاً لحظة الإصدار
 *    (RepApp.tsx يمنعها دون اتصال حين phase === 2)، فكل وعد «دون اتصال» هنا مقيَّد بذلك.
 *  - لا سعر مكتوب يدوياً: جواب السعر يُبنى من باقات CMS الممرَّرة (tiers)، ولا سعر سنوي. ولا رقم يليه
 *    «ريال» أو «SAR» إلا سعر حيّ (verify-pricing يحجب غيره)، لذلك مثال العمولة مكتوب بالكلمات.
 *  - لا اسم منافس ولا عدد عملاء أو فواتير.
 *  - الأسلوب: لا يبدأ جواب بـ«نعم» أو «لا» يليهما فعل (بلا فاصلة يُقرأ نفياً)، والترقيم في حدّه الأدنى.
 *
 * الملف نقيّ بلا استيراد ولا fs ولا نظرة خلفية في أنماطه: يصلح للمتصفح إن احتاجته صفحة يوماً.
 */

/**
 * تاريخ آخر تعديل للنصوص المكتوبة يدوياً في llms.txt: الأجوبة هنا والحقائق الثابتة في scripts/gen-llms.mjs.
 * يدخل في «Last updated» مع CONTENT_VERSION وتواريخ المقالات، فارفعه عند تعديل أي منها.
 */
export const TEXT_VERSION = '2026-10-05';

/** جملة التعريف المستقلة: ما يُقتبس جواباً عن «ما هي فيلد سيلز؟» */
export const WHAT_IS = {
  ar: 'فيلد سيلز (FieldSales) منصة سحابية لإدارة مناديب المبيعات والتوزيع الميداني لشركات التوزيع في الأسواق العربية، يصدر فيها المندوب من جواله الفاتورة وسند القبض ويطبعهما أمام العميل، ويسجّل زيارته بموقعها وصورها، ويرى مخزون سيارته لكل صنف، وتتابع الإدارة المبيعات والتحصيل وأرصدة العملاء لحظة حدوثها.',
  en: 'FieldSales (Arabic name فيلد سيلز, fieldsa.net) is a cloud platform for managing field sales reps and van sales in distribution companies across Arab markets. Reps issue and print invoices and receipt vouchers from their phone, log visits with location and photos and see their van stock per item, while managers follow sales, collections and customer balances as they happen.',
};

/** تمييز العدد العربي: ٣–١٠ جمع، و١١–٩٩ مفرد منصوب، وغيرهما مفرد */
const countAr = (n, { few, many, other }) => {
  const r = n % 100;
  if (r >= 3 && r <= 10) return `${n} ${few}`;
  if (r >= 11 && r <= 99) return `${n} ${many}`;
  return `${n} ${other}`;
};
const repsAr = (n) => (n === 1 ? 'مندوب واحد' : n === 2 ? 'مندوبين' : countAr(n, { few: 'مناديب', many: 'مندوباً', other: 'مندوب' }));
const riyalAr = (n) => countAr(n, { few: 'ريالات', many: 'ريالاً', other: 'ريال' });
const listAr = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join('، و')}، و${xs[xs.length - 1]}`);
const listEn = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * جواب السعر من باقات CMS.
 * @param {'ar'|'en'} lang
 * @param {Array<{ price: string, reps: number|null }>} tiers الباقات الرقمية مرتّبة بالسعر (reps من repsCap)
 */
function priceAnswer(lang, tiers) {
  const top = tiers.length ? tiers[tiers.length - 1].reps : null;
  if (lang === 'ar') {
    const tail = 'لا رسوم تأسيس ولا التزام سنوي، والتجربة المجانية 10 أيام بلا بطاقة ائتمان.';
    if (!tiers.length) return `في فيلد سيلز الاشتراك شهري لكل الشركة لا لكل مندوب، والأسعار منشورة في صفحة الأسعار شاملة ضريبة القيمة المضافة. ${tail}`;
    const list = listAr(tiers.map((t) => `${riyalAr(Number(t.price))}${t.reps ? ` حتى ${repsAr(t.reps)}` : ''}`));
    const above = top ? ` وما فوق ${repsAr(top)} يُحدَّد سعره بالمحادثة.` : '';
    return `في فيلد سيلز الاشتراك شهري لكل الشركة لا لكل مندوب، والأسعار شاملة ضريبة القيمة المضافة وهي ${list}.${above} ${tail}`;
  }
  const tail = 'No setup fees, no annual lock-in, and a 10-day free trial without a credit card.';
  if (!tiers.length) return `FieldSales is priced per company, not per user, with monthly plans published on the pricing page and VAT included. ${tail}`;
  const list = listEn(tiers.map((t, i) => `${t.price} SAR${i === 0 ? ' a month' : ''}${t.reps ? ` for up to ${t.reps} reps` : ''}`));
  const above = top ? ` Above ${top} reps the price is set in a conversation.` : '';
  return `Pricing is per company, not per user, and includes VAT: ${list}.${above} ${tail}`;
}

/**
 * الأسئلة وأجوبتها بلغة القسم. الروابط مسارات نسبية بشرطة أخيرة، وgen-llms يتحقق أن كلاً منها صفحة قانونية.
 * الترتيب مقصود: جواب الربط بين التعريف (بلا أرقام) وجواب دون اتصال، وجواب السعر بعدهما بعيداً عن عبارة الربط.
 * @param {'ar'|'en'} lang
 * @param {{ tiers?: Array<{ price: string, reps: number|null }> }} [opts]
 * @returns {Array<{ q: string, a: string, href?: string, label?: string }>}
 */
export function answersFor(lang, { tiers = [] } = {}) {
  if (lang === 'ar') {
    return [
      {
        q: 'ما هو برنامج إدارة المناديب؟',
        a: 'برنامج إدارة المناديب نظام يربط مندوب المبيعات في الميدان بإدارة الشركة لحظة بلحظة. يصدر المندوب من جواله الفاتورة وسند القبض ويطبعهما أمام العميل، ويسجّل زيارته بموقعها وصورها، ويُحسب مخزون سيارته لكل صنف. وترى الإدارة المبيعات والتحصيل وأرصدة العملاء وخط سير كل مندوب في لوحة واحدة بدل الدفاتر والمكالمات.',
        href: '/مزايا/', label: 'مزايا فيلد سيلز',
      },
      {
        q: 'هل تدعم فيلد سيلز ربط المرحلة الثانية مع منصة فاتورة؟',
        a: 'ندعم ربط المرحلة الثانية مع منصة فاتورة للشركات في السعودية. يُجري مدير الشركة خطوات الربط من إعدادات الشركة، ثم يختم الخادم كل فاتورة ويرقّمها ويرسلها إلى المنصة، وتتابع الإدارة حالة كل مستند ضريبي من شاشة المتابعة. والهيئة لا تعتمد مزوّدي البرمجيات ولا تصادق عليهم، لذلك لا ندّعي اعتماداً منها ولا شراكة رسمية معها.',
        href: '/مزايا/ربط-المرحلة-الثانية/', label: 'كيف يعمل الربط وما حدوده',
      },
      {
        q: 'هل يصدر المندوب فاتورة ضريبية دون إنترنت؟',
        a: 'يعتمد ذلك على ربط شركتك بمنصة فاتورة. في الشركة غير المفعّل لها الربط يصدر المندوب الفاتورة وسند القبض ويطبعهما دون اتصال، ثم تُرفع تلقائياً بلا تكرار عند عودة الشبكة. أما الشركات السعودية المفعّل لها ربط المرحلة الثانية مع منصة فاتورة فتحتاج فيها الفواتير القياسية والمبسطة والمرتجعات اتصالاً لحظة الإصدار، وتبقى سندات القبض والزيارات وإضافة العملاء متاحة دون اتصال.',
        href: '/مزايا/فوترة-بدون-إنترنت/', label: 'الفوترة بدون إنترنت وحدودها',
      },
      {
        q: 'كم سعر برنامج إدارة المناديب في فيلد سيلز؟',
        a: priceAnswer('ar', tiers),
        href: '/pricing/', label: 'صفحة الأسعار',
      },
      {
        q: 'ما هو الكاش فان؟',
        a: 'الكاش فان أسلوب توزيع يحمّل فيه المندوب البضاعة في سيارته، فيبيع ويسلّم ويصدر الفاتورة ويحصّل القيمة في الزيارة نفسها، بدل أخذ الطلب اليوم وتسليمه لاحقاً من المستودع كما في البيع المسبق. يناسب السلع سريعة الحركة كالمواد الغذائية والمشروبات، ويحتاج مطابقة يومية لعهدة السيارة والنقد حتى لا تتسرّب البضاعة أو المال.',
        href: '/blog/van-sales-app/', label: 'دليل تطبيق الكاش فان',
      },
      {
        q: 'ما هو نظام إدارة الموزعين DMS؟',
        a: 'نظام إدارة الموزعين DMS منصة واحدة تضبط الدورة المحيطة بالبيع لا البيع وحده، فتعرف ما حُمِّل على كل سيارة، ومن باع بأي سعر وخصم، ومن حصّل وكم بقي على كل عميل، وماذا رجع ولماذا. يحتاجه من يدير أكثر من سيارة أو يبيع بالآجل، أما برنامج الفواتير وحده فيوثّق البيع ولا يضبط ما حوله.',
        href: '/blog/distribution-management-system/', label: 'دليل نظام إدارة التوزيع',
      },
      {
        q: 'كيف تتابع مناديب المبيعات في الميدان؟',
        a: 'تابع المندوب بالمستندات لا بالمكالمات. كل زيارة تُسجَّل بموقعها وصور من كاميرا الجوال، وكل بيع بفاتورة، وكل تحصيل بسند قبض مرقّم. وفي فيلد سيلز ترى الإدارة مبيعات كل مندوب وتحصيله لحظة حدوثهما، وخط سيره بين الزيارات مرسوماً على الطرق، ومخزون سيارته لكل صنف، فتراجع كل يوم المبيعات مقابل التحصيل وفروق العهدة وعدد الزيارات.',
        href: '/مزايا/إثبات-زيارة-المندوب/', label: 'إثبات زيارة المندوب',
      },
      {
        q: 'كيف تحسب عمولة مندوب المبيعات؟',
        a: 'العمولة تساوي أساس العمولة مضروباً في النسبة، والأساس الأعدل لمندوب التوزيع هو المبيعات الصافية بعد خصم المرتجعات حتى لا يأخذ عمولة على بضاعة عادت. فمبيعات صافية قدرها مئة ألف بنسبة 2٪ تعطي عمولة قدرها ألفان. وفي الشرائح المتدرّجة تُحسب كل نسبة على الجزء الواقع في شريحتها فقط، ويمكن وضع أرضية وسقف للعمولة.',
        href: '/free/commission/', label: 'حاسبة العمولة المجانية',
      },
      {
        q: 'كيف تدير عهدة سيارة المندوب؟',
        a: 'عهدة المندوب هي البضاعة المسجّلة باسمه في سيارته، وتُدار بثلاث حركات موثّقة هي التحميل من المستودع إلى السيارة والتنزيل منها إلى المستودع والتسوية بسبب مكتوب. وفي فيلد سيلز يُحسب المتبقّي من كل صنف في كل سيارة لحظياً على أنه المحمّل ناقص المباع، وتقارنه أنت آخر اليوم بالعدّ الفعلي وتسجّل أي فرق تسويةً في يومه.',
        href: '/مزايا/عهدة-سيارة-المندوب/', label: 'عهدة سيارة المندوب',
      },
    ];
  }
  return [
    {
      q: 'What is FieldSales?',
      a: WHAT_IS.en,
      href: '/en/', label: 'FieldSales home page',
    },
    {
      q: 'Does FieldSales support ZATCA Phase 2 integration?',
      a: 'We support Phase 2 integration with ZATCA’s Fatoora platform for companies in Saudi Arabia. The company admin runs the integration steps from company settings, then the server stamps, numbers and sends each invoice to the platform, and managers track every tax document on a monitoring screen. ZATCA does not certify software vendors, so we claim no certification.',
      href: '/en/blog/einvoicing-compliance-sa/', label: 'E-invoicing in Saudi Arabia',
    },
    {
      q: 'Can reps issue invoices offline?',
      a: 'It depends on the company’s Phase 2 integration. Without it, reps issue and print invoices and receipts offline, and they sync without duplicates when the connection returns. Saudi companies with Phase 2 integration enabled need a connection at the moment of issue for invoices (standard and simplified) and returns, while receipts, visits and new customers still work offline.',
      href: '/en/blog/offline-field-sales-app/', label: 'Offline field sales app',
    },
    {
      q: 'How much does FieldSales cost?',
      a: priceAnswer('en', tiers),
      href: '/en/pricing/', label: 'Pricing',
    },
    {
      q: 'What is van sales (cash van)?',
      a: 'Van sales, or cash van, is a distribution model where the rep carries stock in the vehicle and sells, delivers, invoices and collects payment in one visit, instead of taking an order for later delivery from the warehouse as in pre-sales. It suits fast-moving goods such as food and beverages and needs a daily check of van stock and cash.',
      href: '/en/blog/van-sales-app/', label: 'Van sales app guide',
    },
    {
      q: 'What is a distributor management system (DMS)?',
      a: 'A distributor management system (DMS) controls the cycle around each sale, not only the sale: what was loaded on each van, who sold at what price and discount, who collected and what each customer owes, and what came back and why. Companies running several vans or selling on credit need one, while an invoicing app records only the sale.',
      href: '/en/blog/distribution-management-system/', label: 'Distribution management system guide',
    },
    {
      q: 'How do you track field sales reps?',
      a: 'Track reps through documents rather than phone calls. In FieldSales every visit is logged with its location and photos from the phone camera, every sale with an invoice and every collection with a numbered receipt voucher. Managers see each rep’s sales and collections as they happen, the route between visits drawn on roads and the van stock per item.',
      href: '/en/blog/gps-rep-tracking/', label: 'GPS rep tracking guide',
    },
    {
      q: 'How do you calculate a sales rep’s commission?',
      a: 'Commission is the commission base times the rate. The fairest base for distribution reps is net sales after returns, so no commission is paid on goods that came back. Net sales of one hundred thousand at 2% give two thousand. With tiered rates each rate applies only to sales inside its tier, with an optional floor and cap.',
      href: '/free/commission/', label: 'free commission calculator (Arabic)',
    },
    {
      q: 'How do you manage van stock custody?',
      a: 'Van stock custody is the stock recorded against a rep in their vehicle. It is managed through three documented movements: loading from the warehouse, unloading back to it, and adjustments with a written reason. FieldSales computes the remaining quantity of each item in each van live as loaded minus sold, to compare with the physical count at day end.',
      href: '/en/blog/van-stock-inventory/', label: 'Van stock guide',
    },
    {
      q: 'What hardware does a rep need?',
      a: 'Any smartphone. The rep app works in the phone browser without installation and is also available on Google Play and the App Store. A 58 mm Bluetooth thermal printer is optional for printing invoices and receipts in front of the customer, and FieldSales neither requires a specific model nor sells hardware.',
      href: '/rep-app/', label: 'Rep app (Arabic page)',
    },
    {
      q: 'Which countries and languages does FieldSales cover?',
      a: 'FieldSales serves distribution companies across all 22 Arab countries, with country guides covering currency, VAT and the tax authority. The website is in Arabic, English and French, with Turkish and Chinese home pages, and the apps are Arabic-first and also run in English and French.',
      href: '/en/blog/field-sales-software/', label: 'Field sales software in Arab markets',
    },
  ];
}
