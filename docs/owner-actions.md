# حزمة الأفعال الخارجية — ما ينفّذه المالك بنفسه

كل ما في هذا الملف **جاهز للنسخ واللصق**. الأفعال هنا تحتاج حساباتك أو هويتك،
فلا يستطيع أحد تنفيذها نيابةً عنك. مرتّبة **بترتيب العائد لا بترتيب الخطة**.

> ⚠️ قاعدة عامة: الاسم في كل منصّة **FieldSales (فيلد سيلز) — fieldsa.net** بهذا الشكل وحده،
> وأي منصّة تطلب رقم واتساب استعمل **+966 58 183 5269**، وأي وصف يذكر السعر اكتب الباقات الثلاث
> كما في لوحة المالك: **٢٩٩ ر.س حتى ٥ مناديب، و٣٩٩ حتى ١٠، و٥٩٩ حتى ٢٠ — شهرياً لكل الشركة لا لكل
> مستخدم** (وفوق ٢٠ مندوباً بالمحادثة). **لا تكتب أي رقم آخر ولا سعراً سنوياً** — الأسعار مصدرها واحد
> (لوحة المالك ← محتوى الموقع، ويقرؤها البناء عبر `web-admin/scripts/pricing-source.mjs`) ومربوطة بحارس آلي.

---

## ١) Google Play — تطبيق المندوب منشور، والمتبقّي تطبيق الإدارة

**الحالة الآن (تحقّق ٣ سبتمبر ٢٠٢٦، موثّق في `web-admin/scripts/claims-rules.mjs`):**
- **تطبيق المندوب `net.fieldsa.twa` منشور** على Play: صفحته تُرجع 200 وفيها زرّ التثبيت، وتطبيق
  المندوب على App Store (`net.fieldsa.rep`) منشور كذلك. فقرة «Play يُرجع 404» القديمة لم تعد صحيحة،
  ورابطا المتجرين يظهران في صفحة `/rep-app/`.
- **تطبيق الإدارة `net.fieldsa.admin`** (غلاف `/m`): إن كان ما زال في الاختبار المغلق فالخطوات أدناه
  تخصّه. إن كان قد نُشر فاحذف هذا القسم.

### خطوات الاختبار المغلق (لتطبيق الإدارة إن لم يُنشر بعد)
1. جهّز **١٢ شخصاً حقيقياً** لكلٍّ حساب Gmail (موظّفوك وأقاربك ومعارفك يكفون).
2. في Play Console → تطبيق الإدارة → **Testing → Closed testing** → أضف بريدهم في قائمة المختبرين.
3. أرسل لكلٍّ منهم رابط الانضمام:
   ```
   https://play.google.com/apps/testing/net.fieldsa.admin
   ```
4. **الأهمّ:** كلٌّ منهم يضغط الرابط ويقبل الانضمام فعلياً — الدعوة وحدها لا تكفي. تأكّد أن
   العدّاد في Play Console يقرأ **١٢**.
5. اتركهم ١٤ يوماً متّصلة يفتحون التطبيق أحياناً. أي انقطاع في العدد قد يعيد النافذة للصفر.
6. بعد ١٤ يوماً: اطلب **Production access** من Play Console.

### نصّ دعوة جاهز (انسخه)
> السلام عليكم، أحتاج مساعدتك في اختبار تطبيق شركتنا على Google Play.
> الأمر لا يستغرق دقيقتين:
> ١. افتح هذا الرابط من جوالك: https://play.google.com/apps/testing/net.fieldsa.admin
> ٢. اضغط «Become a tester» ثم حمّل التطبيق.
> ٣. افتحه بين حين وآخر خلال الأسبوعين القادمين.
> يشترط Google وجود ١٢ مختبراً لمدة ١٤ يوماً قبل النشر العلني. شكراً لك.

> ملاحظة: بند «رفع الحزمة المحدّثة API 35 قبل ٣١ أغسطس» انتهى — أُعيد بناء تطبيق المندوب ونُشر.
> وإن طلب Play رفع مستوى واجهة البرمجة مجدداً فستصلك رسالة في Play Console.

---

## ٢) Bing Webmaster + IndexNow — أسرع مسار للظهور في محرّكات الذكاء

**لماذا:** Bing يغذّي ChatGPT وCopilot. الفهرسة فيه شرط عملي للاقتباس، وبياناته
تظهر خلال ٢–٤ أسابيع.

1. افتح <https://www.bing.com/webmasters> وسجّل الدخول.
2. **الأسهل:** استيراد من Google Search Console (النطاق موثّق لديك أصلاً) — زر
   «Import from GSC».
3. أرسل خريطة الموقع: `https://fieldsa.net/sitemap.xml`
4. **مفتاح IndexNow** (يولّده أنت — أنا لا أُدخل مفاتيح):
   - أنشئ مفتاحاً عشوائياً (٣٢ محرفاً hex) من Bing Webmaster → IndexNow.
   - أنشئ ملفاً باسم `<KEY>.txt` محتواه المفتاح نفسه فقط، وضعه في:
     `web-admin/public/<KEY>.txt`
   - أخبرني بالمفتاح لأربط الإرسال التلقائي بعد كل نشر — أو ضعه في متغيّر بيئة
     `INDEXNOW_KEY` في لوحة Render وسأقرأه.

---

## ٣) الأدلّة الستّة — سلطة نطاق لا زيارات

**لماذا:** سلطة النطاق هي الأقوى ارتباطاً بالظهور في إجابات الذكاء الاصطناعي.
الهدف **رابط وسلطة**، لا زيارات مباشرة.

⚠️ **لا تنسخ الوصف نفسه بين موقعين** — التكرار الحرفي مصيدة موثّقة. لذلك أدناه
**ستة أوصاف متمايزة**، كلٌّ بزاويته. وكلها تحمل الصيغة المسموحة للربط وقيد الاتصال معها:
«ندعم ربط المرحلة الثانية مع منصة فاتورة»، وللشركات المفعّل لها الربط تحتاج الفواتير
(القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار.

❓ **سؤال لك قبل أي إدراج (تناقض قائم):** هذا الملف قال «G2 وCapterra مؤجّلان حتى ٥ عملاء»، بينما
`web-admin/index.html` يضع صفحة G2 (`g2.com/products/fieldsales/reviews`) في `sameAs` منذ مدة، وكانت
Capterra وGetApp وSoftware Advice «Published» في لوحتها منذ ٣ سبتمبر. أيّهما الصحيح الآن؟
- إن كانت صفحة G2 **عامة ومنشورة فعلاً**: أرسل رابطها كما يفتحه زائر غير مسجّل، فيبقى في `sameAs` ويُحذف سطر التأجيل.
- وإن **لم تُنشر**: يُحذف رابط G2 من `sameAs` (رابط كيان لا يفتح يضرّ ولا ينفع).
- وأرسل روابط Capterra وGetApp وSoftware Advice العلنية إن ظهرت، لتُضاف إلى `sameAs`.

### البيانات الثابتة (لكل المواقع)
| الحقل | القيمة |
|---|---|
| الاسم | FieldSales (فيلد سيلز) — fieldsa.net |
| الموقع | https://fieldsa.net |
| الفئة | Field Sales / Van Sales / DSD Management Software |
| التسعير | 299 / 399 / 599 SAR شهرياً لكل شركة حتى 5 / 10 / 20 مندوباً (لا لكل مستخدم، ولا سعر سنوي) |
| التجربة | 10 أيام بلا بطاقة ائتمان |
| اللغات | العربية · English · Français |
| البلد | السعودية |
| التواصل | info@fieldsa.net · +966 58 183 5269 |

---

### ٣-١ SourceForge — زاوية «العمل دون اتصال»
> FieldSales (fieldsa.net) is a field sales and distribution (DSD/van sales) platform
> built for Arab markets. Its distinguishing capability is **offline operation**: reps
> issue and print invoices and payment receipts at the customer with no internet, and
> everything uploads automatically once connectivity returns — with no duplicates. Van
> stock is tracked per vehicle with classified returns (normal / damaged / exchange).
> Pricing is published and charged **per company, not per user**: 299, 399 and 599
> SAR/month for up to 5, 10 and 20 reps. Arabic-first RTL interface, with English and
> French. In Saudi Arabia we support **Phase 2 integration with ZATCA's Fatoora
> platform**. For companies with it enabled, invoices (standard and simplified) and
> returns need a connection at the moment of issue; receipts and visits still work
> offline. ZATCA does not certify software vendors, so we claim no certification from it.

### ٣-٢ SoftwareSuggest — زاوية «التسعير لكل شركة»
> Most field-sales tools charge per rep, so your bill grows every time your team does.
> FieldSales charges **per company**: adding a rep within your plan limit costs nothing
> extra. Published plans: 299 SAR/month (up to 5 reps), 399 SAR/month (up to 10 reps)
> and 599 SAR/month (up to 20 reps), with no setup fees and no annual lock-in. Built for
> distributors in Arab markets: field invoicing, collections linked to invoices,
> customer statements, van stock and GPS route tracking. In Saudi Arabia we support
> Phase 2 integration with ZATCA's Fatoora platform; for companies with it enabled,
> invoices and returns need a connection at issue. 10-day free trial, no credit card.

### ٣-٣ AlternativeTo — زاوية «البديل العربي RTL»
> An Arabic-first alternative for field sales and distribution teams. Unlike global
> tools retrofitted with Arabic, FieldSales is built RTL from the ground up — including
> printed invoices, receipts and statements. Designed for distributors in Saudi Arabia
> and the wider Arab region, with QR tax invoicing, van stock management and offline
> operation for reps in low-coverage areas. In Saudi Arabia we support **Phase 2
> integration with ZATCA's Fatoora platform**; for companies with it enabled, invoices
> (standard and simplified) and returns need a connection at issue. Transparent
> per-company pricing: 299, 399 and 599 SAR/month for up to 5, 10 and 20 reps.

**اربطه كبديل لـ:** Pepperi · Repsly · bMobile Route · SimplyDepo · Zetes · BeatRoute

### ٣-٤ SaaSHub — زاوية «إدارة المبيعات والتوزيع»
> FieldSales is a multi-tenant SaaS for distribution companies managing field sales
> teams. Reps work from a mobile app: invoices, receipts linked to the invoices they
> pay, customer statements, barcode scanning, classified returns, and documented field
> visits with photos and GPS. Managers get live dashboards, rep performance and
> working-hours reports, credit limits with over-limit alerts, tiered and per-customer
> pricing, and ERP integration via API. Saudi e-invoicing: QR tax invoices, and we
> support Phase 2 integration with ZATCA's Fatoora platform. Published pricing per
> company: 299 / 399 / 599 SAR/month (up to 5 / 10 / 20 reps); 10-day trial without a card.

**اربطه كبديل لـ:** نفس القائمة أعلاه (بصياغة الوصف هذه لا صياغة AlternativeTo)

**وفي SaaSHub تحديداً:** اطلب ملكية الصفحة (Claim) ووثّقها (Verify)، وارفع الشعار والأسعار، ثم الصق
الوصف أعلاه بالإنجليزية ونسخته العربية. الصفحة اليوم «غير موثّقة» ورابط الموقع فيها nofollow.

### ٣-٥ Slashdot — زاوية تقنية
> A multi-tenant field sales platform with an offline-first architecture: the rep app
> keeps a local outbox and reference cache, issues and prints documents with no
> connectivity, and syncs idempotently on reconnect (client-generated references
> prevent duplicate submissions). REST API for ERP integration, role-based permissions
> per rep, and per-tenant data isolation. Saudi e-invoicing: TLV-encoded QR, and we
> support Phase 2 integration with ZATCA's Fatoora platform — documents are stamped
> and numbered server-side, so for companies with it enabled invoices and returns are
> issued online while receipts and visits stay offline-capable. Arabic RTL, English
> and French interfaces.

### ٣-٦ TrustRadius — زاوية القطاعات
> FieldSales serves distributors across seven sectors with different daily realities:
> FMCG and food (expiry and damaged returns), dairy (short shelf life and exchange
> returns), water and beverages (thin margins on volume), bakery (high natural return
> rates), medical supplies (long payment cycles and receivables), building materials
> (on-site negotiated orders), and auto parts (dense SKU catalogs). Each is handled
> through classified returns, van stock, tiered pricing, credit-limit alerts and field
> invoicing that also works offline. In Saudi Arabia we support Phase 2 integration
> with ZATCA's Fatoora platform; for companies with it enabled, invoices and returns
> need a connection at issue. Per-company pricing: 299 / 399 / 599 SAR/month for up to
> 5 / 10 / 20 reps.

---

## ٤) منصّة «مزايا» من منشآت — 🔴 اقرأ التحذير أولاً

**الفرصة:** لا يوجد عرض فان-سيلز واحد على المنصّة — فجوة صافية. والقطاع مؤهّل
(«جميع القطاعات» بالنصّ الرسمي).

### 🔴 الخطر الذي يجب أن تحسمه قبل أي تسجيل
سياسة مزايا تشترط خصماً **لا يقلّ عن ٢٥٪** مع **حصرية سعر ملزمة**: يُمنع البيع
بأرخص خارج المنصّة، والعقوبة **«إعادة فارق الأسعار إلى كافة المنشآت المستفيدة»**.

وقد سبق أن قُدّمت أسعار **٦٠ و٩٠ ر.س** لعملاء — فإدراج الباقات الشهرية يعرّضك
لإعادة فوارق لكل مستفيد.

**التوصية:** لا تُدرِج ٢٩٩/٥٩٩ إطلاقاً. صمّم **باقة سنوية مستقلة لمزايا وحدها**
(بقيمة أعلى: ترحيل بيانات وتدريب مضمّنان) ويُحتسب خصم الـ٢٥٪ على سعرها هي.

### الخطوات
1. **اتصل أولاً** واسأل السؤالين المجهولين قبل أي التزام:
   - هاتف: **8003018888**
   - بريد: **Discount@monshaat.gov.sa**
   - السؤال ١: ما آلية تأهّل العرض لقسيمة دعم منشآت النقدية (١٬٥٠٠ ر.س)؟
   - السؤال ٢: هل يُقبل اشتراك شهري متكرّر على المنصّة أصلاً؟
2. سجّل كمورّد: <https://mazaya.monshaat.gov.sa/provide>
   (يلزم سجل تجاري ساري مربوط بالحساب + النفاذ الوطني)
3. التزم بمهلة الردّ **≤٥ أيام عمل** — نسبة التزامك تُنشر علناً على ملفك.

---

## ٥) Odoo Apps — وحدة مجانية حصراً

⚠️ **لا ترفع وحدة مدفوعة:** عمولة ٣٠٪ + شرط «السعر الأدنى على الويب» يقيّد
تسعيرك خارج أودو نفسه.

**الحالة:** الوحدة **مبنيّة** في `integrations/odoo/fieldsales_connector/`
بترخيص LGPL-3 كما تشترط أودو للمجاني. الرفّ شبه فارغ (٨ وحدات فقط بتنزيلات
مفردة) فالفرصة قائمة.

⛔ **لا ترفعها قبل أن تُثبّتها وتُشغّل مزامنة واحدة حقيقية.** الكود مُتحقَّق
من بنيته ومنطق الترحيل مختبَر بـ٣٠ اختباراً، لكنّه **لم يُثبَّت على خادم Odoo
قطّ** — لا أملك تنصيباً لاختباره. وحدة معطوبة في متجر أودو تُنتج مراجعات
سلبية دائمة يصعب محوها.

**الاختبار — ٢٠ دقيقة:**

```bash
docker run -d --name odoo-test -p 8069:8069 odoo:17
```

انسخ مجلّد الوحدة إلى `addons/`، فعّل وضع المطوّر، ثبّتها، ولّد المفتاح من
**الإعدادات ← Field Sales Connector**، ثم أرسل عميل تجربة واحداً بالأمر
الموجود في `integrations/odoo/fieldsales_connector/README.md`. إن ظهر العميل
في Odoo فالوحدة تعمل ويمكن رفعها.

**فائدة ثانية غير المتجر:** الوحدة تجعل ربط عميل يستخدم Odoo ممكناً اليوم —
وهو اعتراض مبيعات متكرّر تجيب عنه الآن بشيء موجود لا بوعد.

---

## ٦) مجموعات فيسبوك المحاسبية

**القاعدة الوحيدة التي لا تُحذف:** انشر **أداة مجانية كإجابة على سؤال قائم**، لا
منشوراً ترويجياً مستقلاً.

- حساب باسمك الحقيقي وصفتك معلنة.
- ٥ إجابات نافعة بلا رابط مقابل كل إجابة تحمل رابطاً.
- لا تردّ على سؤال عمره أكثر من ٧٢ ساعة.
- لا تذكر السعر داخل المجموعة إطلاقاً.
- أفصح دائماً: «أنا من فريق Field Sales».

**نصّ جاهز (ردّ على سؤال عن QR الفاتورة):**
> المرحلة الأولى تتطلّب QR بترميز TLV يحمل: اسم البائع، الرقم الضريبي، الطابع
> الزمني، الإجمالي، وقيمة الضريبة. لو تريد التأكّد من فاتورة عندك الآن، عندنا
> أداة مجانية تولّدها وتتحقّق من الحقول بلا تسجيل: https://fieldsa.net/invoice-generator
> إفصاح: أنا من فريق Field Sales، والأداة مجانية ومفتوحة. وإن كان سؤالك عن الربط
> والتكامل فنحن **ندعم ربط المرحلة الثانية مع منصة فاتورة**، والهيئة لا تعتمد مزوّدي
> البرمجيات فلا ندّعي اعتماداً منها.

---

## ٦٫٥) تحويل الشرطة الختامية في لوحة Render — ليس اختيارياً لمحرّكات الإجابة

**ما يحدث الآن:** أي رابط بلا شرطة أخيرة (`fieldsa.net/pricing` أو `fieldsa.net/blog/cash-van-software-saudi`)
وأي رابط غير موجود يردّ **200 بقوقعة الرئيسية**: عنوانها عنوان الرئيسية، وcanonical فيها `/`، و`index, follow`.
خريطة الموقع وروابطنا الداخلية كلها بالشرطة فلا تتأثّر، والمتصفّح يُصحَّح بسكربت في `index.html`.

**لماذا لم يعد «اختيارياً» (تصحيح لما كُتب هنا سابقاً):** وكلاء الجلب عند الطلب — ChatGPT-User
وPerplexity-User وClaude-User — يجلبون الرابط الذي يكتبه النموذج، وكثيراً ما يسقطه بلا شرطة، و**لا يشغّلون
JavaScript**، فلا يصلهم تصحيح السكربت: يقرؤون الرئيسية بدل الصفحة المطلوبة ويجيبون منها. فحص حيّ بوكيل
ChatGPT-User أعاد قوقعة الرئيسية لـ`/pricing` و`/blog/field-sales-software-market-report-2026`. وظهرت في فهرس
البحث روابط بلا شرطة بعنوان الرئيسية (مثل `/blog/field-sales-software-ae`).

**الإصلاح: قواعد Render صريحة، لا Cloudflare.** الـCloudflare الظاهر أمام الموقع تابع لـRender لا لحسابك
(موثّق في تعليق `web-admin/index.html`)، فلا تملك فيه قواعد. الإصلاح الخادمي الوحيد في:
لوحة Render → خدمة الموقع الثابت → **Redirects/Rewrites** → أضف القواعد **قبل** قاعدة `/*` القائمة:

| Source | Destination | Action |
|---|---|---|
| `/pricing` | `/pricing/` | Redirect (301) |
| `/en/pricing` | `/en/pricing/` | Redirect (301) |
| `/about` | `/about/` | Redirect (301) |
| `/contact` | `/contact/` | Redirect (301) |
| `/rep-app` | `/rep-app/` | Redirect (301) |
| `/free` | `/free/` | Redirect (301) |
| `/blog/cash-van-software-saudi` | `/blog/cash-van-software-saudi/` | Redirect (301) |
| `/blog/field-sales-software-market-report-2026` | `/blog/field-sales-software-market-report-2026/` | Redirect (301) |
| `/مزايا/ربط-المرحلة-الثانية` | `/مزايا/ربط-المرحلة-الثانية/` | Redirect (301) |

**الترتيب الآمن:**
1. أضف **القاعدة الأولى وحدها** (`/pricing`)، وانتظر النشر، ثم افتح `fieldsa.net/pricing` من نافذة خاصة:
   يجب أن يتحوّل العنوان إلى `/pricing/` مرة واحدة وتظهر صفحة الأسعار. إن دار المتصفح في حلقة فاحذف القاعدة فوراً.
2. إن نجحت، أضف البقية. وإن كانت اللوحة تقبل بادئة بنجمة لمسارات المدونة (`/blog/*`) فلا تستعملها قبل أن
   تجرّبها على مسار واحد كذلك، لأن قاعدة عامة سبّبت حلقة من قبل.
3. **لا تلمس قاعدة `/*` نفسها** — هي التي تُبقي التطبيق يعمل على مساراته الداخلية (`/login` و`/rep` و`/m`
   و`/signup` و`/c/...` و`/pay/...`)، ولا تضع تحويلاً لأي منها.
4. بعد التطبيق: أرسل عبر IndexNow الرئيسية و`/en/` و`/en/contact/` والصفحات المعدّلة، ليستبدل Bing لقطاته القديمة.

---

## ٧) ما لا يُقال أبداً — في أي منصّة

| ممنوع | السبب |
|---|---|
| «معتمد/مصادق/مرخّص من الهيئة» أو «من منصة فاتورة» · «حاصلون على اعتماد الهيئة» | الهيئة تنصّ صراحةً أنها **لا تعتمد ولا تصادق** المزوّدين — ولو بعد تفعيل الربط |
| «شريك رسمي للهيئة» · «بالشراكة مع الهيئة» · «ZATCA-certified» | لا شراكة رسمية مع الهيئة ولا شهادة منها |
| أي موعد أو موجة أو رقم مقرون بربط المرحلة الثانية («منذ…» · «قبل الموجة…» · «لـN شركة» · «قريباً») | لا موعد ولا رقم مثبت — المسموح «ندعم ربط المرحلة الثانية مع منصة فاتورة» أو «ربط المرحلة الثانية مفعّل» وحدهما |
| «المرحلة الأولى فقط» · نفي المرحلة الثانية | صار قديماً بعد التفعيل |
| وعد «أوف-لاين بالكامل» أو «فاتورة بلا إنترنت» بلا قيد | للشركات المفعّل لها الربط تحتاج الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار، وتبقى سندات القبض والزيارات دون اتصال — فاذكر القيد بجوار الوعد |
| «النظام يمنع البيع لعميل تجاوز حدّه» | الخادم ينبّه الإدارة فوراً ولا يمنع الفاتورة؛ المنع بسحب صلاحية البيع الآجل من المندوب |
| «تقرير أعمار ديون بشرائح ٣٠/٦٠/٩٠» | غير مبني في المنصة اليوم؛ الشرائح في الأداة المجانية `/free/aging/` وحدها |
| دعم ETA المصرية | غير مبنية (stub) |
| SOC2 أو ISO | لا نملكها |
| أي عدد عملاء أو نسبة نجاح | لا عملاء مرجعيون بعد |
| رابط Play لتطبيق الإدارة `net.fieldsa.admin` قبل نشره | ما زال في الاختبار المغلق (تطبيق المندوب `net.fieldsa.twa` منشور ورابطه مسموح) |
| «اشترك الآن» | لا اشتراك ذاتي — كل نداء ينتهي بمحادثة أو تجربة |
| أي سعر غير ٢٩٩ / ٣٩٩ / ٥٩٩ (حتى ٥ / ١٠ / ٢٠ مندوباً)، أو أي سعر سنوي | مصدر السعر واحد (CMS) ومحروس آلياً، ولا حقل سنوي فيه |

> هذه القائمة مفروضة آلياً على الموقع عبر `scripts/verify-claims.mjs` (يُفشل
> البناء عند أي مخالفة). لكن **المنصّات الخارجية خارج نطاق الحارس** — فالالتزام
> بها هناك مسؤوليتك المباشرة.

---

## ٨) ربط المرحلة الثانية حيّ منذ ٢ أكتوبر ٢٠٢٦ — صحّح CMS ثم اقلب علم الحارس

**الحالة:** الربط حيّ (`ZATCA_GO_LIVE=on`)، ونصوص المستودع صارت بالصيغة المسموحة: صفحات الكتالوج السعودية،
والمزايا (ومنها صفحة جديدة `/مزايا/ربط-المرحلة-الثانية/` بقسم حدود صريح)، والقطاعات، والرئيسية. لكن ما يراه
الزائر العربي والإنجليزي في المدونة يأتي من **CMS الحي** (يعلو على نصوص الكود)، وفيه ما زال النفي القديم:
فحص ٤ أكتوبر ٢٠٢٦ وجد البنود الثلاثين أدناه كلها حرفياً، ونحو ٣٥ موضعاً إضافياً في ١٣ مقالاً، و٢٢ مقالاً بصيغة
«وفق المرحلة الأولى»، و١٥ صفحة تذكر ٢٩٩ و٥٩٩ وتُسقط باقة ٣٩٩. أي محرّك يقتبس هذه المقاطع يجيب بنفي يناقض
الرئيسية وllms.txt، فهذا شرط مسبق لكل ما سواه.

**الطريق الأسرع — زرّ في المحرّر (أُضيف في دفعة أكتوبر):**
1. لوحة المالك ← **محتوى الموقع** ← زرّ **«تطبيق تصحيحات الظهور (N)»**. يستبدل نصوصاً قديمة محددة سلفاً
   (`web-admin/src/content/cmsFixes.ts`) في **المسودة وحدها**: نفي المرحلة الثانية، وصيغة «المرحلة الأولى»،
   وجمل السعر التي تُسقط باقة ٣٩٩، ووعود العمل دون اتصال بلا قيد الربط، و«يمنع» في حدّ الائتمان.
2. يظهر «تقرير تصحيحات الظهور»: ما طُبّق، وما طُبّق من قبل، وما لم يُعثر عليه. البند لا يُطبَّق إلا إن وُجد نصّه
   الحالي مرة واحدة بالضبط، فما حرّرته بنفسك لا يُمسّ، وبند السعر لا يُطبَّق إن لم تطابق أسعاره باقات المسودة.
3. راجع المقالات المتأثرة ثم اضغط **«حفظ المحتوى ونشره»** — أو «إلغاء» للتراجع عن كل شيء.
4. ما بقي في «لم يُعثر عليه» حرّره يدوياً بالجدول أدناه وبقائمة §٨-ب.

⚠️ لا تضغط زرّ **«تنظيف النصوص»** قبل زرّ التصحيحات: التنظيف يحذف التشكيل وعلامات الترقيم، فلا تطابق
النصوص الحرفية ويظهر كل بند في «لم يُعثر عليه».

**بعد الحفظ:**
1. ابنِ الموقع: `verify-claims` يجلب CMS الحي ويُسند كل نفي قديم لمصدره — الآتي من **نصوص المستودع**
   حاجب للبناء من الآن، والآتي من **CMS** يُطبع تحذيراً `zatca-phase2-stale-denial (نصّ CMS)` لأي بند فات.
2. حين لا يبقى تحذير: اقلب `PHASE2_CMS_CLEANED` إلى `true` في `web-admin/scripts/claims-rules.mjs`
   (خطوة واحدة — الاختبار يقرأ العلم نفسه فلا يفشل). بعدها يصير أي نفي قديم أو «المرحلة الأولى فقط» حاجباً للبناء أياً كان مصدره.
3. أرسل الروابط المعدّلة بالعربية والإنجليزية عبر IndexNow (وركفلو الصيانة يرسل المتغيّر منها تلقائياً بعد النشر).

**ممنوع في أي بديل تكتبه بنفسك:** «معتمد/مصادق/مرخّص من الهيئة» · «شريك رسمي» · أي موعد أو موجة أو رقم للربط ·
«خلال دقائق/أيام» بجوار ذكر الربط. والشركات المفعّل لها الربط تحتاج فيها الفواتير (القياسية والمبسّطة) والمرتجعات
اتصالاً لحظة الإصدار (قرار المالك) — فلا تَعِد بفاتورة دون اتصال بجوار ذكر الربط دون هذا القيد.

| # | الحقل في CMS | النص الحالي حرفياً | البديل |
|---|---|---|---|
| 1 | `faq.items[0].a` | نعم، يصدر النظام فواتير ضريبية  متوافقة مع متطلبات الفوترة الإلكترونية ZATCA مع رمز QR بشكل نظامي متكامل. | نعم، يصدر النظام فاتورة ضريبية برمز QR، وندعم ربط المرحلة الثانية مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك. والهيئة لا تعتمد مزوّدي البرمجيات، فلا ندّعي اعتماداً منها. |
| 2 | `faq.items[4].a` | نعم، يعمل تطبيق المندوب طوال جولة اليوم بلا إنترنت: يصدر الفواتير وسندات القبض ويطبعها برمز QR ويسلّمها للعملاء، ثم ترتفع كل المستندات تلقائياً للإدارة فور عودة الاتصال — بلا تكرار ولا فقدان بيانات. | نعم، يعمل تطبيق المندوب طوال جولة اليوم بلا إنترنت: يصدر الفواتير وسندات القبض ويطبعها برمز QR ويسلّمها للعملاء، ثم ترتفع كل المستندات تلقائياً للإدارة فور عودة الاتصال — بلا تكرار ولا فقدان بيانات. أما الشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة فتحتاج فيها الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار، وتبقى سندات القبض والزيارات متاحة بلا إنترنت. |
| 3 | `features.items[«العمل دون اتصال بالإنترنت»].desc` | يعمل تطبيق المندوب طوال جولة اليوم بلا إنترنت: يصدر الفواتير وسندات القبض ويطبعها برمز QR ويسلّمها للعملاء، ثم ترتفع كل المستندات تلقائياً للإدارة فور عودة الاتصال — بلا تكرار ولا فقدان. | يعمل تطبيق المندوب طوال جولة اليوم بلا إنترنت: يصدر الفواتير وسندات القبض ويطبعها برمز QR ويسلّمها للعملاء، ثم ترتفع كل المستندات تلقائياً للإدارة فور عودة الاتصال — بلا تكرار ولا فقدان. وللشركات المفعّل لها ربط المرحلة الثانية تحتاج الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار. |
| 4 | `blog[sales-rep-tracking-saudi].en.contentHtml` | Phase 2 (Integration) of ZATCA e-invoicing is not built yet — we say that plainly. | We support Phase 2 integration with ZATCA’s Fatoora platform. |
| 5 | `blog[van-sales-software-saudi].en.contentHtml` | ZATCA Phase 2 (Integration) is not built yet, and ZATCA does not certify vendors — treat any such claim, from anyone, with caution. | We support Phase 2 integration with ZATCA’s Fatoora platform, and ZATCA does not certify vendors — treat any certification claim, from anyone, with caution. |
| 6 | `blog[dms-saudi-arabia].en.contentHtml` | ZATCA Phase 2 (Integration) is not built yet, and ZATCA certifies no vendor. | We support Phase 2 integration with ZATCA’s Fatoora platform, and ZATCA certifies no vendor. |
| 7 | `blog[zatca-invoicing-for-field-reps].title` | فاتورة المرحلة الأولى من الميدان: دليل مناديب التوزيع | فاتورة ZATCA من الميدان: دليل مناديب التوزيع |
| 8 | `blog[zatca-invoicing-for-field-reps].description` | كيف يُصدر المندوب فاتورة مبسّطة برمز QR وفق المرحلة الأولى من جواله — أوف-لاين وبطباعة حرارية، مع حدود صريحة لما هو غير مبنيّ. | كيف يُصدر المندوب فاتورة مبسّطة برمز QR من جواله بطباعة حرارية، مع ربط المرحلة الثانية مع منصة فاتورة وحدوده الصريحة. |
| 9 | `blog[zatca-invoicing-for-field-reps].contentHtml` | المرحلة الثانية (الربط والتكامل) غير مبنية لدينا حتى الآن ، والهيئة لا تعتمد ولا تصادق مزوّدي البرمجيات فلا ندّعي اعتماداً — وننصحك بالحذر من أي ادّعاء اعتماد أياً كان مصدره. | وندعم ربط المرحلة الثانية (الربط والتكامل) مع منصة فاتورة، والهيئة لا تعتمد ولا تصادق مزوّدي البرمجيات فلا ندّعي اعتماداً — وننصحك بالحذر من أي ادّعاء اعتماد أياً كان مصدره. |
| 10 | `blog[zatca-invoicing-for-field-reps].en.description` | How field reps issue simplified Phase-1 (Generation) QR invoices from a phone — offline, thermally printed at the customer — and what is honestly not built (Phase 2). | How field reps issue simplified QR tax invoices from a phone, thermally printed at the customer — with Phase 2 integration with ZATCA’s Fatoora platform supported. |
| 11 | `blog[zatca-invoicing-for-field-reps].en.contentHtml` | Phase 2 (Integration) is not built in FieldSales yet. | FieldSales supports Phase 2 integration with ZATCA’s Fatoora platform. |
| 12 | `blog[distribution-owners-questions].contentHtml` | (المرحلة الثانية — الربط والتكامل — شأن آخر، وغير مبنية لدينا حتى الآن.) — دليل الفوترة الميدانية | (وندعم ربط المرحلة الثانية — الربط والتكامل — مع منصة فاتورة.) — دليل الفوترة الميدانية |
| 13 | `blog[barcode-scanning-invoices].contentHtml` | قارئ الكاميرا يتعامل مع الرموز القياسية الشائعة في عبوات التوزيع، وفاتورتك أنت تصدر برمز QR وفق المرحلة الأولى. | قارئ الكاميرا يتعامل مع الرموز القياسية الشائعة في عبوات التوزيع، وفاتورتك أنت تصدر برمز QR، وندعم ربط المرحلة الثانية مع منصة فاتورة. |
| 14 | `blog[paper-to-digital-invoicing].contentHtml` | النتيجة النهائية: فاتورة تصدر من جوال المندوب لحظة البيع برمز QR وفق المرحلة الأولى (مرحلة الإصدار)، وتصل الإدارة فوراً، حتى بلا إنترنت — ودفترُ الكربون إلى الأرشيف. | النتيجة النهائية: فاتورة تصدر من جوال المندوب لحظة البيع برمز QR وتصل الإدارة فوراً، مع دعم ربط المرحلة الثانية مع منصة فاتورة — ودفترُ الكربون إلى الأرشيف. |
| 15 | `blog[offline-invoicing-for-reps].contentHtml` | الفاتورة الصادرة أوف-لاين ليست «مسودة»: تصدر مكتملة البيانات برمز QR للفاتورة المبسّطة وفق المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، وتُطبع للعميل في مكانه عبر طابعة حرارية بالبلوتوث . | الفاتورة الصادرة أوف-لاين ليست «مسودة»: تصدر مكتملة البيانات برمز QR للفاتورة المبسّطة، وتُطبع للعميل في مكانه عبر طابعة حرارية بالبلوتوث. |
| 16 | `blog[offline-invoicing-for-reps].contentHtml` | أما المرحلة الثانية (الربط والتكامل) فغير مبنية لدينا حتى الآن — نذكر ذلك بوضوح لأن الدقة في هذا الباب التزام لا خيار. | أما الشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة فتحتاج فيها الفواتير (القياسية والمبسّطة) والمرتجعات اتصالاً لحظة الإصدار، وتبقى سندات القبض متاحة دون اتصال — نذكر ذلك بوضوح لأن الدقة في هذا الباب التزام لا خيار. |
| 17 | `blog[thermal-printing-field-invoices].contentHtml` | المعوَّل عليه ليس نوع الورق بل بيانات الفاتورة : أن تصدر من نظام فوترة ببياناتها المكتملة ورمز QR وفق المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية — وهو ما يفعله التطبيق مع كل فاتورة، ورقية الطباعة أو مرسلة رقمياً. | المعوَّل عليه ليس نوع الورق بل بيانات الفاتورة: أن تصدر من نظام فوترة ببياناتها المكتملة ورمز QR — وهو ما يفعله التطبيق مع كل فاتورة، ورقية الطباعة أو مرسلة رقمياً. |
| 18 | `blog[thermal-printing-field-invoices].contentHtml` | (المرحلة الثانية — الربط والتكامل — غير مبنية لدينا حتى الآن، ونذكر ذلك صراحةً.) وتبقى نسخة كل فاتورة محفوظة في النظام لا تُعدَّل بأثر رجعي، فالورقة للعميل والسجل للنظام. | (وندعم ربط المرحلة الثانية مع منصة فاتورة، وللشركات المفعّل لها تحتاج الفواتير والمرتجعات اتصالاً لحظة الإصدار ثم تُطبع من الجهاز.) وتبقى نسخة كل فاتورة محفوظة في النظام لا تُعدَّل بأثر رجعي، فالورقة للعميل والسجل للنظام. |
| 19 | `blog[distributor-network-management-software].contentHtml` | يُصدر النظام فاتورة ضريبية مبسّطة برمز QR وفق المرحلة الأولى (مرحلة الإصدار) من متطلبات الفوترة الإلكترونية، وتُطبع للعميل في الموقع عبر الطابعة الحرارية. | يُصدر النظام فاتورة ضريبية مبسّطة برمز QR ويدعم ربط المرحلة الثانية مع منصة فاتورة، وتُطبع للعميل في الموقع عبر الطابعة الحرارية. |
| 20 | `blog[cash-van-software-guide].contentHtml` | فاتورة مبسّطة برمز QR — حتى بلا إنترنت: تصدر الفاتورة من الجوال وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، وإن انقطع الاتصال تُحفَظ على الجهاز وترتفع تلقائياً عند عودته. | فاتورة مبسّطة برمز QR: تصدر الفاتورة من الجوال، وإن انقطع الاتصال تُحفَظ على الجهاز وترتفع تلقائياً عند عودته — إلا للشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة، فالفواتير والمرتجعات فيها تحتاج اتصالاً لحظة الإصدار. |
| 21 | `blog[cash-van-software-guide].contentHtml` | يُصدر النظام فاتورة ضريبية مبسّطة برمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية. | يُصدر النظام فاتورة ضريبية مبسّطة برمز QR، ويدعم ربط المرحلة الثانية مع منصة فاتورة. |
| 22 | `blog[cash-van-software-saudi].contentHtml` | برنامج كاش فان مصمّم للسوق السعودي: يُصدر مندوبك فاتورة ضريبية مبسّطة برمز QR وفق المرحلة الأولى (مرحلة الإصدار) بضريبة قيمة مضافة 15% محسوبة تلقائياً، ويعمل أوف-لاين بالكامل في الطرق الطويلة والمناطق ضعيفة التغطية ثم يرفع العمليات وحده عند عودة الاتصال، ويطبع الفاتورة حرارياً عبر البلوتوث عند باب العميل. | برنامج كاش فان مصمّم للسوق السعودي: يُصدر مندوبك فاتورة ضريبية مبسّطة برمز QR بضريبة قيمة مضافة 15% محسوبة تلقائياً، ويدعم ربط المرحلة الثانية مع منصة فاتورة، ويعمل أوف-لاين في الطرق الطويلة والمناطق ضعيفة التغطية ثم يرفع العمليات وحده عند عودة الاتصال (عدا الفواتير والمرتجعات للشركات المفعّل لها الربط)، ويطبع الفاتورة حرارياً عبر البلوتوث عند باب العميل. |
| 23 | `blog[cash-van-software-saudi].contentHtml` | كل فاتورة تصدر من جوال المندوب تحمل رمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، مع حساب ضريبة القيمة المضافة 15% تلقائياً وإظهارها بوضوح — فلا اجتهاد من المندوب، ولا «سعر قبل الضريبة» يفاجئ العميل عند الدفع. | كل فاتورة تصدر من جوال المندوب تحمل رمز QR، مع حساب ضريبة القيمة المضافة 15% تلقائياً وإظهارها بوضوح — فلا اجتهاد من المندوب، ولا «سعر قبل الضريبة» يفاجئ العميل عند الدفع. |
| 24 | `blog[sales-reps-management-system].contentHtml` | نعم، يُصدر النظام فاتورة ضريبية مبسّطة برمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، وتُطبع حرارياً عبر البلوتوث من جوال المندوب. | نعم، يُصدر النظام فاتورة ضريبية مبسّطة برمز QR ويدعم ربط المرحلة الثانية مع منصة فاتورة، وتُطبع حرارياً عبر البلوتوث من جوال المندوب. |
| 25 | `blog[field-sales-system-for-companies].contentHtml` | البيع وإصدار الفاتورة: يصدر المندوب من جواله فاتورة ضريبية مبسّطة برمز QR وفق المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، ويطبعها للعميل عبر طابعة حرارية بالبلوتوث قبل مغادرة الموقع. | البيع وإصدار الفاتورة: يصدر المندوب من جواله فاتورة ضريبية مبسّطة برمز QR، ويطبعها للعميل عبر طابعة حرارية بالبلوتوث قبل مغادرة الموقع. |
| 26 | `blog[field-sales-system-for-companies].contentHtml` | يصدر النظام فاتورة ضريبية مبسّطة تتضمن رمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، وتُطبع للعميل في موقعه عبر الطابعة الحرارية. | يصدر النظام فاتورة ضريبية مبسّطة تتضمن رمز QR ويدعم ربط المرحلة الثانية مع منصة فاتورة، وتُطبع للعميل في موقعه عبر الطابعة الحرارية. |
| 27 | `blog[field-sales-software-market-report-2026].contentHtml` | وللشفافية الكاملة — وهي المبدأ الذي بُني عليه هذا التقرير — نظام FieldSales يُصدر فاتورة ضريبية مبسّطة برمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار)، وهذا هو النطاق الذي نعلنه حرفياً من دون زيادة. | وللشفافية الكاملة — وهي المبدأ الذي بُني عليه هذا التقرير — نظام FieldSales يُصدر فاتورة ضريبية مبسّطة برمز QR ويدعم ربط المرحلة الثانية مع منصة فاتورة، ولا ندّعي اعتماداً من الهيئة لأنها لا تعتمد مزوّدي البرمجيات. |
| 28 | `blog[zatca-einvoicing-distribution].contentHtml` | منصّة FieldSales تُصدر فواتير ZATCA (مرحلة أولى) برمز QR وطباعة حرارية 58مم من جوال المندوب مباشرةً. ابدأ تجربتك المجانية 10 أيام وأصدر أول فاتورة متوافقة خلال دقائق. | منصّة FieldSales تدعم ربط المرحلة الثانية مع منصة فاتورة، ويُفعَّل لكل شركة على حدة بعد إتمام خطوات الربط في منصة فاتورة، وتُصدر فواتير ZATCA برمز QR وطباعة حرارية 58مم من جوال المندوب مباشرةً. ابدأ تجربتك المجانية 10 أيام وأصدر أول فاتورة ضريبية برمز QR خلال دقائق. |
| 29 | `blog[order-to-cash-cycle].contentHtml` | وبصراحة عن النطاق: ندعم الفوترة الإلكترونية المرحلة الأولى — الفاتورة المطبوعة تحمل رمز QR بترميز TLV. المرحلة الثانية غير مبنيّة. | وبصراحة عن النطاق: الفاتورة المطبوعة تحمل رمز QR بترميز TLV، وندعم ربط المرحلة الثانية مع منصة فاتورة. |
| 30 | `blog[order-to-cash-cycle].en.contentHtml` | On scope, plainly: we support Phase 1 e-invoicing — the printed invoice carries the QR code in TLV encoding. Phase 2 integration is not built. | On scope, plainly: the printed invoice carries the QR code in TLV encoding, and we support Phase 2 integration with ZATCA’s Fatoora platform. |

> حُصرت القائمة من لقطة `/api/site-content` (١٧ سبتمبر ٢٠٢٦) بكل مطابقات القاعدة لا بأول مطابقة في كل ملف،
> وأُعيد فحصها على لقطة ٢ أكتوبر ٢٠٢٦: البنود الثلاثون كلها ما زالت حرفياً في CMS، ولا مطابقة جديدة خارجها.
> وفي `blog[zatca-invoicing-for-field-reps].en` عنوان فرعي «What is honestly not built» فوق البند ١١ — غيّره إلى «Phase 2 integration».
> المفتاح القديم `profile.ar.solution_col2` فيه «وفق المرحلة الاولى» لكنه لا يُقرأ (الصفحة تقرأ `profileV3`) — لا حاجة لتحريره.

### ٨-ب) بعد الزرّ: ما تراجعه بعينك

**أوصاف تظهر في نتائج البحث — تأكّد أن الزرّ طبّقها (تقرير التصحيحات يذكرها):**
`/en/blog/van-sales-software-saudi/` و`/en/blog/sales-rep-tracking-saudi/` و`/en/blog/dms-saudi-arabia/` (الوصف
والمقتطف)، و`/blog/paper-to-digital-invoicing/` (الوصف)، و`/blog/zatca-invoicing-for-field-reps/` بنسختيه (المقتطف).
فيها اليوم «Phase-1 QR» و«وفق المرحلة الأولى» — تصير «ندعم ربط المرحلة الثانية مع منصة فاتورة» وما يقابلها بالإنجليزية.

**المقالات الاثنان والعشرون بصيغة «وفق المرحلة الأولى» أو ما يماثلها (لقطة ٤ أكتوبر ٢٠٢٦):**
sales-rep-tracking-saudi · van-sales-software-saudi · dms-saudi-arabia · zatca-invoicing-for-field-reps ·
distribution-terms-glossary · barcode-scanning-invoices · paper-to-digital-invoicing · offline-invoicing-for-reps ·
thermal-printing-field-invoices · distributor-network-management-software · cash-van-software-guide ·
cash-van-software-saudi · sales-reps-management-system · sales-reps-management-saudi ·
distribution-companies-management-system · field-sales-system-for-companies · field-sales-software-market-report-2026 ·
repzo-alternative-field-reps · zatca-einvoicing-distribution · order-to-cash-cycle · distribution-owners-questions ·
how-to-create-free-tax-invoice-qr.

**ما يبقى عمداً:** الشرح التعليمي للمرحلتين («ما الفرق بين المرحلة الأولى والثانية؟» في zatca-einvoicing-distribution،
و«متطلب أساسي في المرحلة الأولى» في how-to-create-free-tax-invoice-qr) صحيح ولا يحتاج تغييراً. وأسئلة القارئ
(«هل تصدر وفق المرحلة الأولى؟») تبقى أو تُضاف إليها المرحلة الثانية.

**ما يبقى بعد الزرّ (قِيس على لقطة CMS ٤ أكتوبر ٢٠٢٦ بمحاكاة بنود الزرّ كلها):** لا شيء تلتقطه قاعدة النفي القديم إلا المفتاح
غير المقروء `profile.ar.solution_col2` (أعلاه). والذكر التعليمي الباقي سبعة مواضع صحيحة تُترك كما هي: `zatca-einvoicing-distribution`
(سؤال الفرق بين المرحلتين وجوابه)، و`how-to-create-free-tax-invoice-qr` بنسختيه («متطلب أساسي في المرحلة الأولى»)،
و`zatca-invoicing-for-field-reps` بنسختيه (تعريف المرحلة الأولى)، و`distribution-owners-questions` («مقتضى المرحلة الأولى»)،
و`sales-rep-tracking-saudi.en` (ما ينقص تطبيقات التتبّع العامة: «no simplified tax invoice with a QR code under Phase 1»). فإن ظهر في
«لم يُعثر عليه» بند، فالأرجح أنك حرّرت نصّه بيدك؛ راجعه بعينك بالجدول أعلاه.

**الصفحة المقترنة مؤقتاً:** صفحة ميزة الربط تحيل «دليلها الشامل» إلى `/blog/einvoicing-compliance-sa/` (كتالوج المستودع)
لا إلى zatca-einvoicing-distribution، وصفحة «تحصيل المناديب» إلى `/blog/collection-receivables-sa/` لا إلى order-to-cash-cycle،
لأن مقالَي CMS ما زالا ينفيان الربط. بعد تصحيحهما وقلب العلم يمكن إعادة الإحالة إليهما.

---

## ٩) إجراءات المالك من خطة الظهور (أكتوبر ٢٠٢٦) — بترتيب الأثر

1. **تصحيح CMS (§٨)** — الشرط المسبق لكل ما بعده.
2. **قواعد Render للشرطة الختامية (§٦٫٥)** — قاعدة واحدة أولاً ثم البقية.
3. **الكيان الخارجي** (نحو ١٥ دقيقة): LinkedIn يعرّف الشركة اليوم «Field» في إدارة الاستثمار. صحّح: الاسم «FieldSales | فيلد سيلز»،
   والقطاع Software Development، والنوع Privately Held، وسطر وصفي «نظام إدارة مناديب المبيعات والتوزيع: فواتير من الجوال،
   تحصيل، عهدة السيارة»، وفي About الأسعار لكل شركة وجملة «ندعم ربط المرحلة الثانية مع منصة فاتورة». والاسم نفسه في X.
4. **الأدلّة (§٣):** أجب سؤال G2، واطلب ملكية SaaSHub ووثّقها، وأدرج SourceForge وAlternativeTo بنصوص §٣ المصحّحة.
5. **مراجعات حقيقية:** اطلب من أكثر عملائك رضاً مراجعة على G2 ثم Capterra حين يُقبل الإدراج — بلا حوافز ولا مراجعات مصطنعة.

**قرارات تنتظرك (لا يُنفَّذ منها شيء دون إذنك):**
- **مقال المنافس** `/blog/repzo-alternative-field-reps/`: إعادة كتابته بلا الاسم مع توجيه canonical من الرابط القديم، أو حذفه من CMS.
- **نحو سبعين مقالاً رقيقاً** (بين ٨٦ و١٥٠ كلمة) غير مدموجة: لكلٍّ منها توسيع أو دمج أو حذف.
- **تقرير السوق** field-sales-software-market-report-2026: مثال شركة العشرة مناديب ما زال على ٥٩٩ وصحيحه ٣٩٩ شهرياً
  (ويُعاد حساب الوفر)، و`<h1>` داخل المحتوى يصير `<h2>` (H1 مزدوج).
- **أسعار سنوية في `/pricing/`:** لا تُنشر إلا بحقل سنوي في CMS وبقرارك، لأن مُصدِر عروض الأسعار يعرض أرقاماً سنوية مختلفة.
- **الكيان القانوني والهاتف** في البيانات المنظمة (legalName وtelephone): أكّد الاسم المسجّل والرقم الرسمي.
  ورقم الهاتف في البيانات المنظمة وllms.txt يختلف عن رقم واتساب في CMS: أيّهما الرسمي؟
- **«مصر والإمارات وتونس» في صفحة الفوترة بدون إنترنت:** تقول الصفحة إن التطبيق يمنع الإصدار دون اتصال هناك،
  والكود يمنع الإصدار دون اتصال بحسب مزوّد الفوترة المضبوط للشركة (eta أو peppol أو ttn في RepApp.tsx) لا بحسب الدولة نفسها،
  فالجملة صحيحة فقط للشركات المضبوط لها هذا المزوّد. تدقيق صياغتها ينتظر قرارك.
- **أخطاء نصية في CMS:** في مزايا الباقة الاحترافية «كل مميزات الاحترافية» والمقصود «كل مميزات المتوسطة»،
  وعنوان مقال building-materials-distribution فيه «توزiع».
- **علامات الترقيم** في الأجوبة العربية الموجّهة لمحرّكات الإجابة (كتلة الإجابة وأسئلة الكتالوج): السماح بها هناك وحدها، أو إبقاء الأسلوب الحالي.
- **تواريخ نشر الكتالوج** مرجَّعة إلى ما قبل وجود المستودع: ضبطها على تاريخ الإنشاء الحقيقي أو إبقاؤها.
- **«distributor management system» في السعودية:** تحقّق في Search Console أيّ رابط يأخذ الظهور (dms-saudi-arabia أم
  distribution-management-system-sa) قبل اختيار الصفحة الأساسية.
- **دليل مزوّدي حلول الفوترة لدى الهيئة:** هل تتقدّم إليه؟ إن أُدرجنا يبقى نصّ الموقع «ندعم ربط المرحلة الثانية مع منصة فاتورة» بلا «معتمد».
- **تفعيل الربط لكل شركة:** صفحة الميزة تقول «يُفتح تبويب الربط لشركتك بطلب منك» — أي أنك تفتح علم الشركة من لوحة المالك
  عند طلبها، ثم يجري مديرها الخطوات بنفسه.
