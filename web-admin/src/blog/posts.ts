// مقالات المدوّنة — محتوى ثابت محسّن لمحركات البحث (يُدرَج في sitemap ويُفهرَس مباشرةً).
// لإضافة مقال: أضِف عنصراً هنا + أضِف رابطه في public/sitemap.xml.
// الحقول الأساسية عربية؛ والمقالات ثنائية اللغة تضيف نسخة إنجليزية في الحقل en (تظهر على /en/blog).
export interface BlogL10n {
  title: string;
  description: string;
  keywords: string;
  excerpt: string;
  contentHtml: string;
}
export interface BlogPost extends BlogL10n {
  slug: string;
  date: string;            // YYYY-MM-DD
  readMinutes: number;
  en?: BlogL10n;           // النسخة الإنجليزية (اختيارية) — للمقالات ثنائية اللغة
}

// يعيد حقول المقال باللغة المطلوبة (إنجليزي إن توفّر، وإلا العربي)
export function postView(p: BlogPost, lang: 'ar' | 'en'): BlogL10n {
  return lang === 'en' && p.en ? p.en : p;
}

export const POSTS: BlogPost[] = [
  {
    slug: 'zatca-einvoicing-distribution',
    title: 'دليل الفوترة الإلكترونية ZATCA لشركات التوزيع (المرحلة الثانية)',
    description: 'كل ما تحتاجه شركات التوزيع عن الفوترة الإلكترونية ZATCA: المرحلة الثانية، رمز QR، الفواتير الضريبية المبسطة، وكيف تلتزم بسهولة من الميدان.',
    date: '2026-06-29',
    readMinutes: 6,
    keywords: 'الفوترة الإلكترونية, ZATCA, هيئة الزكاة والضريبة, فاتورة ضريبية, المرحلة الثانية, رمز QR, فاتورة مبسطة',
    excerpt: 'ما هي الفوترة الإلكترونية ZATCA؟ وما الفرق بين المرحلتين؟ وكيف تلتزم بها شركات التوزيع من الميدان مباشرةً دون تعقيد؟',
    contentHtml: `
      <p>فرضت <strong>هيئة الزكاة والضريبة والجمارك (ZATCA)</strong> في المملكة العربية السعودية الفوترة الإلكترونية على المنشآت الخاضعة لضريبة القيمة المضافة. وبالنسبة لشركات التوزيع التي تصدر فواتير من الميدان عبر المناديب، فإن الالتزام الصحيح يحمي شركتك من الغرامات ويبسّط محاسبتك.</p>

      <h2>ما الفرق بين المرحلة الأولى والثانية؟</h2>
      <p><strong>المرحلة الأولى (الإصدار):</strong> إصدار وحفظ الفواتير إلكترونياً بصيغة منظّمة مع رمز QR، وإيقاف الفواتير اليدوية.</p>
      <p><strong>المرحلة الثانية (الربط والتكامل):</strong> ربط أنظمة الفوترة مباشرةً بمنصّة «فاتورة» التابعة للهيئة، مع توقيع تشفيري ومتطلبات فنية إضافية، وتُطبَّق على دفعات حسب حجم المنشأة.</p>

      <h2>متطلبات الفاتورة الضريبية المتوافقة</h2>
      <ul>
        <li><strong>رمز QR</strong> يحتوي بيانات البائع والرقم الضريبي والطابع الزمني والإجمالي ومبلغ الضريبة.</li>
        <li>اسم البائع ورقمه الضريبي بوضوح.</li>
        <li>التاريخ والوقت، وتفاصيل الأصناف والكميات والأسعار.</li>
        <li>تمييز نوع الفاتورة: <strong>فاتورة ضريبية مبسّطة</strong> (للأفراد B2C) أو <strong>فاتورة ضريبية</strong> (للمنشآت B2B).</li>
      </ul>

      <h2>التحدّي الخاص بشركات التوزيع</h2>
      <p>المندوب يصدر الفاتورة في موقع العميل، فيحتاج إلى نظام جوّال يُصدر فاتورة متوافقة مع ZATCA فوراً، ويطبعها حرارياً، ويزامنها مع الإدارة لحظياً. الفوترة اليدوية أو الأنظمة غير المتوافقة تعرّضك للمخالفات.</p>

      <h2>كيف تلتزم بسهولة؟</h2>
      <p>اختر نظام مبيعات ميدانية يولّد فاتورة ضريبية برمز QR متوافقة تلقائياً، ويصنّف نوع الفاتورة، ويربط الرقم الضريبي لكل شركة. <a href="/signup">منصّة FieldSales</a> تُصدر فواتير ZATCA (مرحلة أولى) برمز QR وطباعة حرارية 58مم من جوال المندوب مباشرةً.</p>

      <p><strong>ابدأ تجربتك المجانية 10 أيام وأصدر أول فاتورة متوافقة خلال دقائق.</strong></p>
    `,
  },
  {
    slug: 'manage-field-sales-reps',
    title: 'كيف تدير مناديب التوزيع الميدانيين بكفاءة؟ 7 خطوات عملية',
    description: '7 خطوات عملية لإدارة مناديب التوزيع الميدانيين: الصلاحيات، التحصيل، مخزون السيارة، التتبّع، والتقارير اللحظية لرفع كفاءة فريقك ومبيعاتك.',
    date: '2026-06-29',
    readMinutes: 7,
    keywords: 'إدارة مناديب, مناديب التوزيع, مبيعات ميدانية, تحصيل, مخزون المندوب, تتبع المناديب, نظام توزيع',
    excerpt: 'إدارة فريق ميداني موزّع تحدٍّ حقيقي. إليك 7 خطوات عملية ترفع كفاءة مناديبك وتحصيلك ومبيعاتك — مدعومة بالأرقام لا التخمين.',
    contentHtml: `
      <p>نجاح شركة التوزيع يبدأ من المندوب الميداني. لكن إدارة فريق موزّع جغرافياً — بين الطلبات والتحصيل والمخزون — تتحوّل لفوضى دون نظام منظّم. إليك 7 خطوات عملية:</p>

      <h2>1) حدّد صلاحيات كل مندوب بدقّة</h2>
      <p>من يحقّ له منح خصم؟ وكم نسبته القصوى؟ من يبيع بأقل من السعر أو بالآجل؟ ضبط الصلاحيات يمنع التلاعب ويحمي هوامشك.</p>

      <h2>2) اربط الطلب بالفاتورة بالتحصيل</h2>
      <p>كل عملية بيع يجب أن تنتج فاتورة ضريبية وسند قبض موثّقين، مرتبطين بكشف حساب العميل تلقائياً — لا أوراق متفرّقة.</p>

      <h2>3) راقب مخزون سيارة كل مندوب</h2>
      <p>سجّل ما حمَّله المندوب، وتابع ما تبقّى بعد كل بيع. هذا يمنع النقص والعجز ويكشف الفروقات فوراً.</p>

      <h2>4) فعّل حدود الائتمان والتنبيهات</h2>
      <p>اضبط حدّ ائتمان لكل عميل، واحصل على تنبيه فوري عند تجاوزه — قبل أن يتحوّل لدين متعثّر.</p>

      <h2>5) تابع الأداء بالأرقام لحظياً</h2>
      <p>مبيعات اليوم، التحصيل، عدد الزيارات، وأداء كل مندوب على لوحة واحدة — قرارات مبنية على بيانات لا انطباعات.</p>

      <h2>6) استخدم التتبّع لتحسين خطوط السير</h2>
      <p>معرفة مواقع المناديب وخطوط سيرهم يساعد على تنظيم التغطية وتقليل الوقت الضائع.</p>

      <h2>7) وحّد كل ذلك في منصّة واحدة</h2>
      <p>تفرّق الأدوات يضيّع البيانات. منصّة واحدة تربط المندوب بالإدارة لحظياً ترفع الكفاءة فعلياً.</p>

      <p><a href="/signup">FieldSales</a> تجمع هذه الخطوات السبع في نظام واحد: فواتير ZATCA، تحصيل، مخزون السيارة، صلاحيات دقيقة، وتقارير لحظية. <strong>جرّبها مجاناً 10 أيام.</strong></p>
    `,
  },
  {
    slug: 'choose-field-sales-system',
    title: 'كيف تختار نظام إدارة مبيعات ميدانية مناسباً لشركتك؟',
    description: 'معايير اختيار نظام إدارة مبيعات ميدانية لشركات التوزيع: التوافق مع ZATCA، تطبيق المندوب، التقارير، التكامل مع ERP، والتكلفة — دليل عملي.',
    date: '2026-06-29',
    readMinutes: 6,
    keywords: 'نظام مبيعات ميدانية, نظام توزيع, برنامج إدارة مناديب, برنامج مبيعات, اختيار نظام توزيع',
    excerpt: 'سوق أنظمة المبيعات الميدانية مزدحم. ما المعايير التي تضمن اختياراً صحيحاً يناسب شركة التوزيع ولا تندم عليه لاحقاً؟',
    contentHtml: `
      <p>اختيار نظام إدارة مبيعات ميدانية قرار يؤثّر على كفاءة فريقك لسنوات. إليك المعايير الأساسية التي يجب تقييمها قبل الاشتراك:</p>

      <h2>1) التوافق مع الفوترة الإلكترونية ZATCA</h2>
      <p>غير قابل للتفاوض في السعودية. تأكّد أن النظام يُصدر فاتورة ضريبية برمز QR متوافقة، ويميّز الفاتورة المبسّطة عن الضريبية.</p>

      <h2>2) تطبيق جوال عملي للمندوب</h2>
      <p>المندوب يعمل من الميدان. يجب أن يُصدر الفاتورة وسند القبض، ويطبع حرارياً، ويدير عملاءه بسهولة من جواله.</p>

      <h2>3) التحصيل وكشوف الحساب</h2>
      <p>تسجيل المدفوعات (نقد/تحويل/شيك)، حدود الائتمان، وكشف حساب دقيق لكل عميل يُحدَّث تلقائياً.</p>

      <h2>4) إدارة المخزون والمناديب</h2>
      <p>مخزون سيارة المندوب، صلاحيات دقيقة، وإدارة فريق بأدوار (مدير/مشرف/محاسب) ميزات تفصل النظام الاحترافي عن الأساسي.</p>

      <h2>5) التقارير والتكامل</h2>
      <p>تقارير لحظية للمبيعات والتحصيل والأداء، وإمكانية المزامنة مع نظام ERP أو محاسبة لديك.</p>

      <h2>6) سهولة الإعداد والتكلفة</h2>
      <p>هل يمكنك التشغيل خلال دقائق؟ هل توجد تجربة مجانية؟ هل التسعير واضح ويناسب نموّك؟</p>

      <h2>قائمة تحقّق سريعة</h2>
      <ul>
        <li>✅ فواتير ZATCA برمز QR</li>
        <li>✅ تطبيق مندوب + طباعة حرارية</li>
        <li>✅ تحصيل وكشوف حساب</li>
        <li>✅ مخزون السيارة وصلاحيات</li>
        <li>✅ تقارير لحظية وتكامل ERP</li>
        <li>✅ تجربة مجانية وتسعير واضح</li>
      </ul>

      <p><a href="/signup">FieldSales</a> تستوفي هذه المعايير كلها في منصّة سعودية واحدة. <strong>جرّبها مجاناً 10 أيام بلا بطاقة ائتمان.</strong></p>
    `,
  },
  {
    slug: 'simplified-vs-tax-invoice',
    title: 'الفرق بين الفاتورة الضريبية والفاتورة الضريبية المبسّطة',
    description: 'متى تُصدر فاتورة ضريبية ومتى تُصدر فاتورة ضريبية مبسّطة؟ شرح الفروق وفق متطلبات ZATCA لشركات التوزيع، مع أمثلة عملية من الميدان.',
    date: '2026-06-28',
    readMinutes: 5,
    keywords: 'فاتورة ضريبية مبسطة, الفرق بين الفاتورة الضريبية والمبسطة, ZATCA, فاتورة B2B, فاتورة B2C, الفوترة الإلكترونية',
    excerpt: 'فاتورة ضريبية أم مبسّطة؟ الخطأ في النوع يسبّب مخالفات. إليك الفرق الدقيق ومتى تستخدم كلًّا منهما وفق متطلبات هيئة الزكاة والضريبة.',
    contentHtml: `
      <p>من أكثر الأخطاء شيوعاً في الفوترة الميدانية إصدار <strong>نوع خاطئ</strong> من الفاتورة. هيئة الزكاة والضريبة والجمارك (ZATCA) تفرّق بوضوح بين الفاتورة الضريبية والفاتورة الضريبية المبسّطة، ولكلٍّ حالات استخدام ومتطلبات بيانات مختلفة.</p>

      <h2>الفاتورة الضريبية المبسّطة (B2C)</h2>
      <p>تُصدر عند البيع <strong>للمستهلك النهائي</strong> (فرد لا يطلب خصم ضريبة المدخلات). هذه هي الحالة الأكثر شيوعاً لمندوب التوزيع الذي يبيع لبقالة أو عميل تجزئة. تتطلّب: اسم البائع ورقمه الضريبي، التاريخ، تفاصيل الأصناف، الإجمالي ومبلغ الضريبة، و<strong>رمز QR</strong>.</p>

      <h2>الفاتورة الضريبية (B2B)</h2>
      <p>تُصدر عند البيع <strong>لمنشأة مسجّلة في ضريبة القيمة المضافة</strong> تريد خصم ضريبة المدخلات. تتطلّب إضافةً لما سبق: <strong>الرقم الضريبي للمشتري</strong>، وعنوانه، وبيانات أوفى. لا تكفي الفاتورة المبسّطة هنا.</p>

      <h2>متى يقرّر المندوب النوع؟</h2>
      <ul>
        <li>العميل فرد/تجزئة بلا رقم ضريبي ← <strong>مبسّطة</strong>.</li>
        <li>العميل منشأة لديها رقم ضريبي ويطلب فاتورة باسمها ← <strong>ضريبية</strong>.</li>
        <li>عند الشك، اسأل العميل إن كان يريد فاتورة برقمه الضريبي.</li>
      </ul>

      <h2>كيف يبسّط النظام هذا القرار؟</h2>
      <p>نظام المبيعات الميدانية الجيّد يجعل المندوب يختار نوع الفاتورة بنقرة، ويُدرج رمز QR ويحسب الضريبة تلقائياً، ويخزّن الرقم الضريبي للعميل المنشأة تلقائياً للمرّات القادمة. <a href="/signup">FieldSales</a> تُصدر النوعين برمز QR وطباعة حرارية من جوال المندوب.</p>

      <p>اقرأ أيضاً: <a href="/blog/zatca-einvoicing-distribution">دليل الفوترة الإلكترونية ZATCA لشركات التوزيع</a>.</p>

      <p><strong>ابدأ تجربتك المجانية 10 أيام وأصدر فواتيرك بالنوع الصحيح من أول يوم.</strong></p>
    `,
  },
  {
    slug: 'van-sales-guide',
    title: 'البيع المتنقّل (Van Sales): دليل إدارة مخزون سيارة المندوب',
    description: 'ما هو البيع المتنقّل Van Sales؟ وكيف تدير مخزون سيارة المندوب وتمنع العجز والفروقات؟ دليل عملي لشركات التوزيع لرفع الكفاءة وتقليل الهدر.',
    date: '2026-06-27',
    readMinutes: 6,
    keywords: 'البيع المتنقل, Van Sales, مخزون سيارة المندوب, جرد المندوب, إدارة المخزون الميداني, التوزيع',
    excerpt: 'في البيع المتنقّل تتحوّل سيارة المندوب إلى مستودع متحرّك. كيف تتابع ما حُمِّل وما بِيع وما تبقّى — وتمنع العجز قبل وقوعه؟',
    contentHtml: `
      <p><strong>البيع المتنقّل (Van Sales)</strong> نموذج توزيع يحمل فيه المندوب البضاعة في سيارته ويبيعها مباشرةً للعملاء في جولته، فيُصدر الفاتورة ويسلّم الصنف فوراً. هذا النموذج سريع وفعّال، لكنه يضع تحدّياً كبيراً: <strong>كيف تتابع مخزوناً يتحرّك بين عشرات النقاط يومياً؟</strong></p>

      <h2>التحدّي: مستودع على عجلات</h2>
      <p>كل سيارة مندوب هي مخزون مستقل. دون نظام دقيق، تظهر الفروقات: بضاعة محمّلة لا تُباع، عجز غير مبرّر، ومرتجعات غير مسجّلة. النتيجة هدر مالي وصعوبة في المحاسبة.</p>

      <h2>دورة مخزون السيارة الصحيحة</h2>
      <ul>
        <li><strong>التحميل:</strong> يسجّل المندوب (أو المستودع) ما حُمِّل في السيارة من كل صنف بداية اليوم.</li>
        <li><strong>البيع:</strong> ينقص المخزون تلقائياً مع كل فاتورة — لا إدخال يدوي مزدوج.</li>
        <li><strong>المتابعة اللحظية:</strong> تعرف الإدارة المتبقّي في كل سيارة وحركة كل صنف (ماذا نزل ومتى).</li>
        <li><strong>التسوية:</strong> في نهاية اليوم يُطابَق المتبقّي الفعلي مع المتبقّي بالنظام، فتظهر أي فروقات فوراً.</li>
      </ul>

      <h2>فوائد إدارة مخزون السيارة رقمياً</h2>
      <ul>
        <li>منع العجز واكتشاف الفروقات في وقتها لا بعد أسابيع.</li>
        <li>قرارات تحميل أذكى: تحمّل ما يُباع فعلاً فتقلّل البضاعة الراكدة في السيارات.</li>
        <li>شفافية كاملة بين المندوب والإدارة تقلّل النزاعات.</li>
      </ul>

      <h2>كيف تطبّقه عملياً؟</h2>
      <p>تحتاج نظاماً يربط <strong>فاتورة المندوب</strong> بـ<strong>مخزون سيارته</strong> لحظياً. <a href="/signup">FieldSales</a> توفّر ميزة «مخزون سيارة المندوب»: يسجّل المندوب ما حمَّله، فينقص تلقائياً مع كل بيع، وتتابع الإدارة المتبقّي والحركة من لوحة التحكم.</p>

      <p>اقرأ أيضاً: <a href="/blog/manage-field-sales-reps">كيف تدير مناديب التوزيع الميدانيين بكفاءة؟</a></p>

      <p><strong>جرّب FieldSales مجاناً 10 أيام وأحكم سيطرتك على كل سيارة في أسطولك.</strong></p>
    `,
  },
  {
    slug: 'collection-receivables-distribution',
    title: 'إدارة التحصيل والذمم المدينة في التوزيع: 6 ممارسات تقلّل الديون المتعثّرة',
    description: 'الديون المتعثّرة تقتل السيولة. 6 ممارسات عملية لإدارة التحصيل والذمم المدينة في شركات التوزيع: حدود الائتمان، سندات القبض، وكشوف الحساب اللحظية.',
    date: '2026-06-26',
    readMinutes: 6,
    keywords: 'إدارة التحصيل, الذمم المدينة, حدود الائتمان, سندات القبض, كشف حساب العميل, الديون المتعثرة, التوزيع',
    excerpt: 'أكبر تهديد لسيولة شركة التوزيع ليس ضعف المبيعات، بل ضعف التحصيل. إليك 6 ممارسات عملية تحمي أموالك من التعثّر.',
    contentHtml: `
      <p>تبيع شركتك جيّداً لكن السيولة مخنوقة؟ المشكلة غالباً في <strong>التحصيل لا المبيعات</strong>. البيع بالآجل دون انضباط يراكم ذمماً مدينة تتحوّل تدريجياً إلى ديون متعثّرة. إليك 6 ممارسات تحمي أموالك:</p>

      <h2>1) اضبط حدّ ائتمان لكل عميل</h2>
      <p>لا تترك الآجل مفتوحاً. حدّد سقفاً لكل عميل بناءً على تاريخه وحجمه، واجعل النظام <strong>ينبّه أو يمنع</strong> البيع عند تجاوزه.</p>

      <h2>2) وثّق كل تحصيل بسند قبض فوري</h2>
      <p>كل مبلغ يُحصّل يجب أن ينتج سند قبض رقمي يُرسل للعميل ويُخصم من رصيده تلقائياً — لا مبالغ «في ذمّة المندوب» بلا أثر.</p>

      <h2>3) اجعل كشف الحساب لحظياً</h2>
      <p>كشف حساب يُحدَّث تلقائياً مع كل فاتورة ودفعة يمنع الخلافات ويُظهر الرصيد الحقيقي لكل عميل في أي لحظة.</p>

      <h2>4) صنّف الأعمار (Aging) للذمم</h2>
      <p>افرز المستحقات حسب تأخّرها: مستحق، متأخّر 30 يوماً، 60، 90+. هذا يوجّه جهد التحصيل نحو الأخطر أولاً.</p>

      <h2>5) اربط أداء المندوب بالتحصيل لا البيع فقط</h2>
      <p>المندوب الذي يبيع كثيراً ويحصّل قليلاً يصنع مشكلة لا إنجازاً. اجعل التحصيل مؤشّر أداء رئيسياً.</p>

      <h2>6) راقب المؤشّرات لحظياً</h2>
      <p>إجمالي المستحق، المحصّل اليوم، ونسبة المتأخّر — على لوحة واحدة لتتدخّل قبل تفاقم التعثّر.</p>

      <h2>كيف تطبّقها بنظام واحد؟</h2>
      <p><a href="/signup">FieldSales</a> تجمع حدود الائتمان، سندات القبض الرقمية، كشوف الحساب اللحظية، وتقارير التحصيل في منصّة واحدة تربط المندوب بالإدارة.</p>

      <p>اقرأ أيضاً: <a href="/blog/choose-field-sales-system">كيف تختار نظام إدارة مبيعات ميدانية مناسباً؟</a></p>

      <p><strong>ابدأ مجاناً 10 أيام وأعد سيولتك تحت السيطرة.</strong></p>
    `,
  },
  {
    slug: 'gps-tracking-sales-reps',
    title: 'تتبّع المناديب عبر GPS: الفائدة، الخصوصية، وأثره على الإنتاجية',
    description: 'هل تتبّع المناديب عبر GPS مفيد أم تطفّل؟ شرح فوائد التتبّع لشركات التوزيع، حدوده الأخلاقية والقانونية، وكيف يرفع الإنتاجية دون إضرار بالثقة.',
    date: '2026-06-25',
    readMinutes: 5,
    keywords: 'تتبع المناديب, GPS, تتبع مندوب المبيعات, خطوط سير المناديب, إنتاجية الفريق الميداني, التوزيع',
    excerpt: 'تتبّع المناديب عبر GPS سلاح ذو حدّين: يرفع الإنتاجية والشفافية، لكنه يحتاج توازناً مع الخصوصية والثقة. كيف تطبّقه بشكل صحيح؟',
    contentHtml: `
      <p>يثير <strong>تتبّع المناديب عبر GPS</strong> جدلاً: أداة إدارة فعّالة أم رقابة مفرطة؟ الحقيقة أنه — حين يُطبَّق بوضوح وعدالة — يخدم المندوب والشركة معاً. إليك الصورة الكاملة.</p>

      <h2>الفوائد الحقيقية للتتبّع</h2>
      <ul>
        <li><strong>تحسين خطوط السير:</strong> معرفة المواقع تساعد على تنظيم التغطية وتقليل الوقت والوقود الضائعين.</li>
        <li><strong>الشفافية والإنصاف:</strong> سجلّ موضوعي لجولة كل مندوب يحمي المجتهد ويكشف التقصير بالأدلة لا الظنّ.</li>
        <li><strong>الأمان:</strong> معرفة موقع المندوب مفيدة في حالات الطوارئ أو الأعطال.</li>
        <li><strong>التحقّق من الزيارات:</strong> تأكيد أن الزيارات تمّت فعلاً في مواقع العملاء.</li>
      </ul>

      <h2>الخصوصية والحدود الأخلاقية</h2>
      <p>التتبّع يجب أن يكون <strong>أثناء ساعات العمل فقط</strong>، بعلم المندوب وموافقته ضمن سياسة واضحة، وللأغراض المهنية لا الشخصية. الشفافية مع الفريق حول ما يُتابَع ولماذا تبني الثقة بدل أن تهدمها.</p>

      <h2>كيف ترفع الإنتاجية دون إضرار بالثقة؟</h2>
      <ul>
        <li>اعرض التتبّع كأداة لتحسين التوزيع لا «لمراقبة» الأشخاص.</li>
        <li>اربطه بمؤشّرات إيجابية (زيارات أكثر، مسافات أقل) لا بالعقاب فقط.</li>
        <li>فعّله بشكل اختياري لكل مندوب حسب الحاجة.</li>
      </ul>

      <h2>التطبيق العملي</h2>
      <p><a href="/signup">FieldSales</a> توفّر تتبّعاً للمواقع الحيّة وخطّ سير اليوم عبر GPS أثناء العمل الميداني، مع تحكّم في تفعيله لكل مندوب — أداة إدارة شفّافة تخدم الطرفين.</p>

      <p>اقرأ أيضاً: <a href="/blog/manage-field-sales-reps">7 خطوات عملية لإدارة المناديب الميدانيين</a>.</p>

      <p><strong>جرّب FieldSales مجاناً 10 أيام وأدِر فريقك الميداني بشفافية وكفاءة.</strong></p>
    `,
  },
  {
    slug: 'field-sales-software-egypt',
    date: '2026-06-30',
    readMinutes: 7,
    title: 'أفضل نظام لإدارة مناديب المبيعات والتوزيع في مصر',
    description: 'دليل شركات التوزيع في مصر لاختيار نظام إدارة مناديب المبيعات: الطلبات، التحصيل وإدارة الذمم، مخزون سيارة المندوب، وتتبّع المناديب — لرفع كفاءة فريقك الميداني.',
    keywords: 'نظام مبيعات مصر, إدارة مناديب مصر, نظام توزيع مصر, برنامج مبيعات مصر, البيع المتنقل, تحصيل الذمم, الفاتورة الإلكترونية مصر',
    excerpt: 'سوق التوزيع في مصر ضخم وتنافسي. كيف تدير مناديبك من الطلب حتى التحصيل بنظام واحد يرفع الكفاءة ويمنع التسرّب؟',
    contentHtml: `
      <p>سوق التوزيع المصري من أكبر أسواق المنطقة وأكثرها تنافسية — آلاف المناديب يجوبون المحافظات يوميًا. لكن إدارة فريق ميداني بهذا الحجم بالورق أو بجداول منفصلة تتحوّل إلى فوضى وتسرّب مالي. إليك ما يحتاجه نظام إدارة المبيعات الميدانية في مصر.</p>

      <h2>تحدّيات التوزيع في السوق المصري</h2>
      <ul>
        <li>تغطية جغرافية واسعة (القاهرة، الدلتا، الصعيد) يصعب متابعتها مركزيًا.</li>
        <li>بيع آجل كثيف يراكم ذممًا مدينة ويهدّد السيولة.</li>
        <li>صعوبة معرفة ما بِيع وما تبقّى في سيارة كل مندوب لحظيًا.</li>
      </ul>

      <h2>ما يجب أن يوفّره النظام للمندوب المصري</h2>
      <ul>
        <li><strong>تطبيق جوال</strong> ينشئ الطلب ويصدر الفاتورة وسند القبض من الميدان.</li>
        <li><strong>تحصيل وإدارة ذمم</strong> بحدود ائتمان وكشف حساب لحظي لكل عميل.</li>
        <li><strong>مخزون سيارة المندوب</strong> (البيع المتنقّل Van Sales) ينقص تلقائيًا مع كل بيع.</li>
        <li><strong>تتبّع GPS</strong> للمواقع وخطوط السير أثناء العمل.</li>
      </ul>

      <h2>والفوترة الإلكترونية في مصر؟</h2>
      <p>الفوترة الإلكترونية إلزامية في مصر عبر منظومة <strong>مصلحة الضرائب المصرية (ETA)</strong>. <a href="/signup">FieldSales</a> ينظّم فوترتك وتحصيلك ومخزونك ميدانيًا ويصدر فواتير برمز QR وسجلات رقمية موثّقة؛ ويبقى ربط منظومة ETA الرسمية حسب متطلبات كل منشأة. ميزة النظام الأساسية: ضبط الفريق الميداني من الطلب حتى التحصيل في منصّة واحدة.</p>

      <p>اقرأ أيضًا: <a href="/blog/collection-receivables-distribution">إدارة التحصيل والذمم المدينة</a> و<a href="/blog/van-sales-guide">دليل البيع المتنقّل</a>.</p>

      <p><strong>جرّب FieldSales مجانًا 10 أيام وأحكم سيطرتك على فريقك الميداني في مصر.</strong></p>
    `,
    en: {
      title: 'Best Field Sales & Distribution Rep Management Software in Egypt',
      description: 'A guide for distribution companies in Egypt to choose field sales rep management software: orders, collection and receivables, van stock, and GPS tracking to boost field team efficiency.',
      keywords: 'field sales software Egypt, sales rep management Egypt, distribution software Egypt, van sales, accounts receivable, e-invoicing Egypt',
      excerpt: 'Egypt’s distribution market is huge and competitive. How do you run your reps from order to collection in one system that boosts efficiency and stops leakage?',
      contentHtml: `
        <p>Egypt has one of the region’s largest, most competitive distribution markets — thousands of reps cover the governorates daily. Running a field team this size on paper or scattered spreadsheets turns into chaos and financial leakage. Here is what field sales management software needs to deliver in Egypt.</p>

        <h2>Distribution challenges in the Egyptian market</h2>
        <ul>
          <li>Wide geographic coverage (Cairo, the Delta, Upper Egypt) that is hard to manage centrally.</li>
          <li>Heavy credit sales that pile up receivables and threaten cash flow.</li>
          <li>Difficulty knowing what each rep sold and what is left in the van in real time.</li>
        </ul>

        <h2>What the system must give the Egyptian rep</h2>
        <ul>
          <li>A <strong>mobile app</strong> to create orders and issue invoices and receipt vouchers from the field.</li>
          <li><strong>Collection and receivables</strong> with credit limits and a live statement per customer.</li>
          <li><strong>Van stock</strong> (van sales) that decreases automatically with every sale.</li>
          <li><strong>GPS tracking</strong> of locations and daily routes during work.</li>
        </ul>

        <h2>What about e-invoicing in Egypt?</h2>
        <p>E-invoicing is mandatory in Egypt through the <strong>Egyptian Tax Authority (ETA)</strong> system. <a href="/signup">FieldSales</a> organizes your field billing, collection and stock and issues QR-coded invoices and verifiable digital records; connecting the official ETA platform depends on each company’s requirements. The core value: control your field team from order to collection in one platform.</p>

        <p>Read also: <a href="/en/blog/what-is-field-sales-management-software">What is field sales management software?</a></p>

        <p><strong>Try FieldSales free for 10 days and take control of your field team in Egypt.</strong></p>
      `,
    },
  },
  {
    slug: 'van-sales-distribution-maghreb',
    date: '2026-06-30',
    readMinutes: 7,
    title: 'إدارة التوزيع والبيع المتنقّل في المغرب والجزائر وتونس',
    description: 'كيف تدير شركات التوزيع في المغرب العربي مناديبها وسياراتها؟ دليل البيع المتنقّل Van Sales، التحصيل، ومخزون السيارة لرفع كفاءة الفرق الميدانية وتقليل الهدر.',
    keywords: 'نظام توزيع المغرب, البيع المتنقل المغرب, إدارة مناديب الجزائر, نظام مبيعات تونس, Van Sales, توزيع المغرب العربي',
    excerpt: 'في المغرب العربي تعتمد شركات التوزيع على البيع المتنقّل من السيارة. كيف تضبط المخزون والتحصيل وأداء كل مندوب؟',
    contentHtml: `
      <p>تعتمد شركات التوزيع في <strong>المغرب والجزائر وتونس</strong> بكثافة على نموذج <strong>البيع المتنقّل (Van Sales)</strong>: يحمّل المندوب البضاعة في سيارته ويبيعها مباشرةً في جولته. النموذج سريع لكنه يحتاج نظامًا يضبط المخزون المتحرّك والتحصيل.</p>

      <h2>لماذا يحتاج المغرب العربي نظامًا ميدانيًا؟</h2>
      <ul>
        <li>سيارة كل مندوب = مستودع متحرّك يصعب جرده يدويًا.</li>
        <li>التحصيل النقدي والآجل يحتاج توثيقًا فوريًا بسند قبض.</li>
        <li>الإدارة تحتاج رؤية لحظية لمبيعات اليوم في كل مدينة.</li>
      </ul>

      <h2>دورة البيع المتنقّل الصحيحة</h2>
      <ul>
        <li><strong>تحميل:</strong> تسجيل ما حُمِّل في السيارة بداية اليوم.</li>
        <li><strong>بيع:</strong> فاتورة فورية تنقص المخزون تلقائيًا.</li>
        <li><strong>تحصيل:</strong> سند قبض رقمي يُخصم من رصيد العميل.</li>
        <li><strong>تسوية:</strong> مطابقة المتبقّي آخر اليوم لكشف أي فرق.</li>
      </ul>

      <h2>كيف يساعد FieldSales؟</h2>
      <p><a href="/signup">FieldSales</a> يجمع مخزون السيارة، التحصيل وإدارة الذمم، صلاحيات المناديب، وتتبّع GPS في منصّة واحدة تناسب أسواق المغرب العربي — بالعربية وبتطبيق جوال خفيف يعمل على أي جهاز.</p>

      <p>اقرأ أيضًا: <a href="/blog/van-sales-guide">دليل إدارة مخزون سيارة المندوب</a>.</p>

      <p><strong>ابدأ تجربتك المجانية 10 أيام وأحكم سيطرتك على أسطول التوزيع.</strong></p>
    `,
    en: {
      title: 'Van Sales & Field Distribution Management in North Africa (Maghreb)',
      description: 'How do distribution companies in Morocco, Algeria and Tunisia manage their reps and vans? A guide to van sales, collection and van stock to boost field efficiency and cut waste.',
      keywords: 'van sales Morocco, distribution software Maghreb, sales rep management Algeria, field sales Tunisia, van stock, North Africa distribution',
      excerpt: 'In the Maghreb, distributors rely on selling from the van. How do you control stock, collection and each rep’s performance?',
      contentHtml: `
        <p>Distribution companies across <strong>Morocco, Algeria and Tunisia</strong> rely heavily on the <strong>van sales</strong> model: the rep loads goods into the van and sells directly on the route. It is fast, but it needs a system to control mobile stock and collection.</p>

        <h2>Why the Maghreb needs a field system</h2>
        <ul>
          <li>Each rep’s van is a moving warehouse that is hard to count manually.</li>
          <li>Cash and credit collection need instant documentation with a receipt voucher.</li>
          <li>Management needs a live view of today’s sales in each city.</li>
        </ul>

        <h2>The correct van sales cycle</h2>
        <ul>
          <li><strong>Load:</strong> record what was loaded into the van at the start of the day.</li>
          <li><strong>Sell:</strong> an instant invoice decreases stock automatically.</li>
          <li><strong>Collect:</strong> a digital receipt voucher is deducted from the customer balance.</li>
          <li><strong>Reconcile:</strong> match the remaining stock at day end to reveal any gap.</li>
        </ul>

        <h2>How FieldSales helps</h2>
        <p><a href="/signup">FieldSales</a> combines van stock, collection and receivables, rep permissions and GPS tracking in one platform suited to Maghreb markets — in Arabic, with a lightweight mobile app that runs on any device.</p>

        <p>Read also: <a href="/en/blog/field-sales-software-egypt">Field sales software in Egypt</a>.</p>

        <p><strong>Start your free 10-day trial and take control of your distribution fleet.</strong></p>
      `,
    },
  },
  {
    slug: 'what-is-field-sales-management-software',
    date: '2026-06-30',
    readMinutes: 6,
    title: 'ما هو نظام إدارة المبيعات الميدانية؟ دليل شامل',
    description: 'شرح مبسّط لنظام إدارة المبيعات الميدانية: ما هو، كيف يعمل، وأهم مميزاته لشركات التوزيع — الطلبات، الفواتير، التحصيل، مخزون السيارة، وتتبّع المناديب.',
    keywords: 'نظام إدارة المبيعات الميدانية, ما هو نظام المبيعات الميدانية, field sales management, نظام مناديب, أتمتة قوة المبيعات SFA',
    excerpt: 'ما هو نظام إدارة المبيعات الميدانية ولماذا تحتاجه شركات التوزيع؟ دليل مبسّط يشرح المفهوم والمميزات الأساسية.',
    contentHtml: `
      <p><strong>نظام إدارة المبيعات الميدانية</strong> (Field Sales Management / SFA) هو برنامج يربط مندوب التوزيع في الميدان بالإدارة لحظيًا — من إنشاء الطلب حتى إصدار الفاتورة والتحصيل والتقارير، عبر تطبيق جوال ولوحة تحكّم.</p>

      <h2>ما المشكلة التي يحلّها؟</h2>
      <p>بدونه، تعتمد شركة التوزيع على الورق والمكالمات: طلبات تضيع، تحصيل بلا أثر، ومخزون سيارة مجهول. النظام يجعل كل عملية رقمية وموثّقة ولحظية.</p>

      <h2>أهم المميزات</h2>
      <ul>
        <li>إدارة الطلبات الميدانية من تطبيق المندوب.</li>
        <li>فواتير ضريبية برمز QR وسندات قبض رقمية.</li>
        <li>تحصيل المدفوعات وإدارة الذمم وحدود الائتمان.</li>
        <li>مخزون سيارة المندوب (البيع المتنقّل).</li>
        <li>تتبّع المناديب عبر GPS وتقارير لحظية.</li>
      </ul>

      <h2>من يحتاجه؟</h2>
      <p>أي شركة لديها مناديب يبيعون ويحصّلون ميدانيًا: التوزيع الغذائي، المشروبات، مواد البناء، الأدوية، ومستلزمات التجزئة.</p>

      <p><a href="/signup">FieldSales</a> منصّة عربية متكاملة تجمع هذه المميزات كلها. <strong>جرّبها مجانًا 10 أيام.</strong></p>
    `,
    en: {
      title: 'What Is Field Sales Management Software? A Complete Guide',
      description: 'A simple explanation of field sales management software (SFA): what it is, how it works, and its key features for distribution companies — orders, invoices, collection, van stock and rep tracking.',
      keywords: 'field sales management software, what is field sales software, SFA, sales force automation, distribution software, rep management',
      excerpt: 'What is field sales management software and why do distribution companies need it? A simple guide to the concept and core features.',
      contentHtml: `
        <p><strong>Field sales management software</strong> (also called SFA — sales force automation) is software that connects the field distribution rep to management in real time — from creating the order to issuing the invoice, collecting payment and reporting, through a mobile app and a dashboard.</p>

        <h2>What problem does it solve?</h2>
        <p>Without it, a distribution company relies on paper and phone calls: orders get lost, collection has no trail, and van stock is unknown. The system makes every transaction digital, documented and real time.</p>

        <h2>Key features</h2>
        <ul>
          <li>Field order management from the rep’s app.</li>
          <li>QR tax invoices and digital receipt vouchers.</li>
          <li>Payment collection, receivables and credit limits.</li>
          <li>Van stock (van sales).</li>
          <li>GPS rep tracking and real-time reports.</li>
        </ul>

        <h2>Who needs it?</h2>
        <p>Any company with reps that sell and collect in the field: food and beverage distribution, building materials, pharma and retail supplies.</p>

        <p><a href="/signup">FieldSales</a> is a complete platform that bundles all of these. <strong>Try it free for 10 days.</strong></p>
      `,
    },
  },
];

export const getPost = (slug: string) => POSTS.find(p => p.slug === slug);

// ===== تحرير المدوّنة من لوحة السوبر أدمن =====
// المقالات تُخزَّن في محتوى الـCMS العام تحت المفتاح blog (مصفوفة). عند غيابها تُستخدم المقالات الافتراضية أعلاه.

// تحويل صياغة مبسّطة (Markdown-lite) إلى HTML — ليكتب السوبر أدمن بسهولة دون معرفة HTML
const inlineMd = (s: string): string => s
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

export function mdLiteToHtml(raw: string): string {
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  return blocks.map(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length && lines.every(l => l.startsWith('- '))) {
      return '<ul>' + lines.map(l => `<li>${inlineMd(l.slice(2))}</li>`).join('') + '</ul>';
    }
    if (lines[0]?.startsWith('## ')) {
      const head = `<h2>${inlineMd(lines[0].slice(3))}</h2>`;
      const rest = lines.slice(1).join(' ');
      return head + (rest ? `<p>${inlineMd(rest)}</p>` : '');
    }
    return `<p>${inlineMd(lines.join(' '))}</p>`;
  }).join('\n');
}

// يعيد HTML جاهزاً للعرض: إن كان المحتوى HTML أصلاً يُترك كما هو، وإلا يُحوَّل من الصياغة المبسّطة
export function normalizeContent(raw?: string): string {
  if (!raw) return '';
  const t = raw.trim();
  if (/<(p|h2|h3|ul|ol|div|section|article|blockquote)[ >]/i.test(t)) return raw;
  return mdLiteToHtml(raw);
}

// تنظيف المُعرّف (slug) ليكون صالحاً في الرابط: حروف لاتينية صغيرة وأرقام وشَرطات
export const slugify = (s: string): string => s.toLowerCase().trim()
  .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

// مقال فارغ جديد
export const emptyPost = (): BlogPost => ({
  slug: '', title: '', description: '',
  date: new Date().toISOString().slice(0, 10),
  readMinutes: 5, keywords: '', excerpt: '', contentHtml: '',
});

// قائمة المقالات الفعّالة: محتوى الـCMS إن وُجد، وإلا الافتراضي — مرتّبة بالأحدث
export function effectivePosts(cmsBlog: unknown): BlogPost[] {
  const list = Array.isArray(cmsBlog) && cmsBlog.length
    ? (cmsBlog as BlogPost[]).filter(p => p && p.slug && p.title)
    : POSTS;
  return [...list].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
