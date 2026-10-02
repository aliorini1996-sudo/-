# حزمة الأفعال الخارجية — ما ينفّذه المالك بنفسه

كل ما في هذا الملف **جاهز للنسخ واللصق**. الأفعال هنا تحتاج حساباتك أو هويتك،
فلا يستطيع أحد تنفيذها نيابةً عنك. مرتّبة **بترتيب العائد لا بترتيب الخطة**.

> ⚠️ قاعدة عامة: أي منصّة تطلب رقم واتساب استعمل **+966 58 183 5269**، وأي وصف
> يذكر السعر اكتب **٢٩٩ / ٥٩٩ ر.س لكل شركة** (وباقة المؤسسات «حسب الطلب»).
> **لا تكتب أي رقم آخر** — الأسعار مصدرها واحد ومربوطة بحارس آلي.

---

## ١) تطبيق Google Play — الأعلى عائداً والأرخص (ابدأ اليوم)

**لماذا أولاً:** الحزمة مرفوعة ومقبولة فعلاً، والمتبقّي بشري بحت. وعدّاد الـ١٤
يوماً **لا يبدأ قبلك**، ويعمل في الخلفية بينما تفعل أي شيء آخر. كل يوم تأخير
يوم إضافي قبل أن يصير التطبيق قابلاً للتسويق.

**الحالة الآن:** `net.fieldsa.twa` يُرجع **404** (تحقّقتُ منه) — التطبيق عالق في
الاختبار المغلق، لا في مشكلة تقنية.

### الخطوات
1. جهّز **١٢ شخصاً حقيقياً** لكلٍّ حساب Gmail (موظّفوك وأقاربك ومعارفك يكفون).
2. في Play Console → **Testing → Closed testing** → أضف بريدهم في قائمة المختبرين.
3. أرسل لكلٍّ منهم رابط الانضمام:
   ```
   https://play.google.com/apps/testing/net.fieldsa.twa
   ```
4. **الأهمّ:** كلٌّ منهم يجب أن يضغط الرابط ويقبل الانضمام فعلياً — الدعوة وحدها
   لا تكفي. تأكّد أن العدّاد في Play Console يقرأ **١٢**.
5. اتركهم ١٤ يوماً متّصلة يفتحون التطبيق أحياناً. أي انقطاع في العدد قد يعيد
   النافذة للصفر.
6. بعد ١٤ يوماً: اطلب **Production access** من Play Console.

### نصّ دعوة جاهز (انسخه)
> السلام عليكم، أحتاج مساعدتك في اختبار تطبيق شركتنا على Google Play.
> الأمر لا يستغرق دقيقتين:
> ١. افتح هذا الرابط من جوالك: https://play.google.com/apps/testing/net.fieldsa.twa
> ٢. اضغط «Become a tester» ثم حمّل التطبيق.
> ٣. افتحه بين حين وآخر خلال الأسبوعين القادمين.
> يشترط Google وجود ١٢ مختبراً لمدة ١٤ يوماً قبل النشر العلني. شكراً لك.

### وبالتوازي — رفع الحزمة المحدّثة (موعد ٣١ أغسطس ٢٠٢٦)
الملف جاهز على سطح مكتبك:
```
تطبيق المندوب\FieldSales-تحديث-API35-versionCode2.aab
```
Play Console → الإنتاج → إنشاء إصدار → ارفع الملف → ملاحظة «تحديث مستوى واجهة
برمجة التطبيق (API 35)» → مراجعة → طرح.

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
**ستة أوصاف متمايزة**، كلٌّ بزاويته.

🚫 **G2 وCapterra مؤجّلان** حتى ٥ عملاء (سياستهما تشترط مراجعة خلال السنة الأولى).

### البيانات الثابتة (لكل المواقع)
| الحقل | القيمة |
|---|---|
| الاسم | Field Sales |
| الموقع | https://fieldsa.net |
| الفئة | Field Sales / Van Sales / DSD Management Software |
| التسعير | من 299 SAR/شهر لكل شركة (لا لكل مستخدم) |
| التجربة | 10 أيام بلا بطاقة ائتمان |
| اللغات | العربية · English · Français |
| البلد | السعودية |
| التواصل | info@fieldsa.net · +966 58 183 5269 |

---

### ٣-١ SourceForge — زاوية «العمل دون اتصال»
> Field Sales is a field sales and distribution (DSD/van sales) platform built for
> Arab markets. Its distinguishing capability is **full offline operation**: reps
> issue and print tax invoices and payment receipts directly at the customer, with
> no internet, and everything uploads automatically once connectivity returns —
> with no duplicates. Van stock is tracked per vehicle with classified returns
> (normal / damaged / exchange). Pricing is published and charged **per company,
> not per user**, starting at 299 SAR/month. Arabic-first RTL interface, with
> English and French. In Saudi Arabia it issues tax invoices with a QR code and
> supports **Phase 2 integration with ZATCA's Fatoora platform**; for companies
> with Phase 2 integration enabled, tax invoices need a connection at issuance.
> ZATCA does not certify software vendors, so we claim no certification from it.

### ٣-٢ SoftwareSuggest — زاوية «التسعير لكل شركة»
> Most field-sales tools charge per rep, so your bill grows every time your team
> does. Field Sales charges **per company**: adding a rep within your plan limit
> costs nothing extra. Published plans start at 299 SAR/month (up to 5 reps) and
> 599 SAR/month (up to 20 reps), with no setup or onboarding fees and no annual
> lock-in. Built for distributors in Arab markets: field invoicing, collections
> and customer statements, van stock, GPS route tracking, and offline-first
> operation. 10-day free trial, no credit card.

### ٣-٣ AlternativeTo — زاوية «البديل العربي RTL»
> An Arabic-first alternative for field sales and distribution teams. Unlike
> global tools retrofitted with Arabic, Field Sales is built RTL from the ground
> up — including printed invoices, receipts and statements. Designed for
> distributors in Saudi Arabia and the wider Arab region, with QR tax invoicing
> and **Phase 2 integration with ZATCA's Fatoora platform** in Saudi Arabia, van
> stock management, and offline operation for reps working in low-coverage areas
> (tax invoices need a connection for companies with Phase 2 integration enabled).
> Transparent per-company pricing from 299 SAR/month.

**اربطه كبديل لـ:** Pepperi · Repsly · bMobile Route · SimplyDepo · Zetes · BeatRoute

### ٣-٤ SaaSHub — زاوية «إدارة المبيعات والتوزيع»
> Field Sales is a multi-tenant SaaS for distribution companies managing field
> sales teams. Reps work from a mobile app: invoices, receipts, customer
> statements, barcode scanning, classified returns, and documented field visits
> with photos and GPS. Managers get live dashboards, rep performance and working
> hours reports, credit limits with over-limit alerts, tiered and per-customer
> pricing, and ERP integration via API. Published pricing per company from 299
> SAR/month; 10-day trial without a card.

**اربطه كبديل لـ:** نفس القائمة أعلاه (بصياغة الوصف هذه لا صياغة AlternativeTo)

### ٣-٥ Slashdot — زاوية تقنية
> A multi-tenant field sales platform with an offline-first architecture: the rep
> app keeps a local outbox and reference cache, issues and prints documents with
> no connectivity, and syncs idempotently on reconnect (client-generated
> references prevent duplicate submissions). REST API for ERP integration,
> role-based permissions per rep, and per-tenant data isolation. Saudi e-invoicing:
> TLV-encoded QR, plus Phase 2 integration with ZATCA's Fatoora platform (tax
> invoices are issued online for companies with it enabled). Arabic RTL, English
> and French interfaces.

### ٣-٦ TrustRadius — زاوية القطاعات
> Field Sales serves distributors across seven sectors with different daily
> realities: FMCG and food (expiry and damaged returns), dairy (short shelf life
> and exchange returns), water and beverages (thin margins on volume), bakery
> (high natural return rates), medical supplies (long payment cycles and
> receivables), building materials (on-site negotiated orders), and auto parts
> (dense SKU catalogs). Each is handled through classified returns, van stock,
> tiered pricing, credit limits, and offline field invoicing. Per-company pricing
> from 299 SAR/month.

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

## ٦٫٥) تحويل الشرطة الختامية — ٥ دقائق في لوحة Render (اختياري)

**الحالة الآن سليمة ولا تستدعي قلقاً:** كل روابط خريطة الموقع الـ١١٦١ وكل
وسوم canonical تنتهي بشرطة (`/free/`)، وهذا هو الشكل الذي يخدمه المضيف
بالنسخة المُصيَّرة كاملةً. الزواحف تحصل على الصفحة الصحيحة.

**الأثر المتبقّي صغير ومحدّد:** إن كتب أحدهم الرابط بلا شرطة
(`fieldsa.net/free`) فالخادم يردّ ٢٠٠ بصفحة التطبيق العامّة بدل تحويله.
النتيجة الوحيدة الملموسة: مشاركة هذا الشكل على واتساب تُظهر بطاقة معاينة
عامّة بدل عنوان الأداة. المستخدم نفسه لا يتأثّر — التطبيق يعرض الصفحة
الصحيحة بعد التحميل.

**الإصلاح إن أردته:** في لوحة Render → خدمة الموقع الثابت → Redirect/Rewrite
Rules، أضف قاعدة **قبل** قاعدة `/*` القائمة:

| Source | Destination | Action |
|---|---|---|
| `/free` | `/free/` | Redirect |
| `/pricing` | `/pricing/` | Redirect |

وكرّرها لأي رابط تنوي مشاركته يدوياً. لا تلمس قاعدة `/*` نفسها — هي التي
تُبقي التطبيق يعمل على مساراته الداخلية (`/login`، `/app/...`).

**لا تفعل شيئاً إن لم تكن تشارك الروابط يدوياً** — لا أثر على SEO ولا على
محرّكات الذكاء، لأن ما نرسله لها يحمل الشرطة أصلاً.

---

## ٧) ما لا يُقال أبداً — في أي منصّة

| ممنوع | السبب |
|---|---|
| «معتمد/مصادق/مرخّص من الهيئة» أو «من منصة فاتورة» · «حاصلون على اعتماد الهيئة» | الهيئة تنصّ صراحةً أنها **لا تعتمد ولا تصادق** المزوّدين — ولو بعد تفعيل الربط |
| «شريك رسمي للهيئة» · «بالشراكة مع الهيئة» · «ZATCA-certified» | لا شراكة رسمية مع الهيئة ولا شهادة منها |
| أي موعد أو موجة أو رقم مقرون بربط المرحلة الثانية («منذ…» · «قبل الموجة…» · «لـN شركة» · «قريباً») | لا موعد ولا رقم مثبت — المسموح «ندعم ربط المرحلة الثانية مع منصة فاتورة» أو «ربط المرحلة الثانية مفعّل» وحدهما |
| «المرحلة الأولى فقط» · نفي المرحلة الثانية | صار قديماً بعد التفعيل |
| دعم ETA المصرية | غير مبنية (stub) |
| SOC2 أو ISO | لا نملكها |
| أي عدد عملاء أو نسبة نجاح | لا عملاء مرجعيون بعد |
| رابط متجر Play | يُرجع 404 حتى الآن |
| «اشترك الآن» | لا اشتراك ذاتي — كل نداء ينتهي بمحادثة أو تجربة |
| أي سعر غير ٢٩٩ / ٥٩٩ | مصدر السعر واحد ومحروس آلياً |

> هذه القائمة مفروضة آلياً على الموقع عبر `scripts/verify-claims.mjs` (يُفشل
> البناء عند أي مخالفة). لكن **المنصّات الخارجية خارج نطاق الحارس** — فالالتزام
> بها هناك مسؤوليتك المباشرة.

---

## ٨) بعد اكتمال تفعيل ربط المرحلة الثانية فعلياً — تحرير CMS ثم قلب علم الحارس

**التفعيل الفعلي اكتمل — نفّذ الآن.** نصوص الكود صارت بالصيغة الجديدة، لكن ما يراه الزائر
العربي في الرئيسية والمدونة يأتي من **CMS الحي** (يعلو على نصوص الكود)، فتعديل الكود وحده لا يظهر.

**الخطوات بالترتيب:**
1. حرّر البنود أدناه من لوحة المالك ← محتوى الموقع (النص معروض بلا وسوم HTML؛ قد تتخلّل الجملة
   في المحرّر وسوم مثل `<strong>` أو `<a>` — أبقِها واستبدل النص وحده).
2. ابنِ الموقع: `verify-claims` يجلب CMS الحي ويُسند كل نفي قديم لمصدره — الآتي من **نصوص المستودع**
   حاجب للبناء من الآن، والآتي من **CMS** يُطبع تحذيراً `zatca-phase2-stale-denial (نصّ CMS)` لأي بند فات.
3. حين لا يبقى تحذير: اقلب `PHASE2_CMS_CLEANED` إلى `true` في `web-admin/scripts/claims-rules.mjs`
   (خطوة واحدة — الاختبار يقرأ العلم نفسه فلا يفشل). بعدها يصير أي نفي قديم أو «المرحلة الأولى فقط» حاجباً للبناء أياً كان مصدره.

**ممنوع في أي بديل تكتبه بنفسك:** «معتمد/مصادق/مرخّص من الهيئة» · «شريك رسمي» · أي موعد أو موجة أو رقم للربط ·
«خلال دقائق/أيام» بجوار ذكر الربط. والشركات المفعّل لها الربط تحتاج فيها الفاتورة الضريبية والمرتجع اتصالاً
لحظة الإصدار (قرار المالك) — فلا تَعِد بفاتورة ضريبية دون اتصال بجوار ذكر الربط.

| # | الحقل في CMS | النص الحالي حرفياً | البديل |
|---|---|---|---|
| 1 | `faq.items[0].a` | نعم، يصدر النظام فواتير ضريبية  متوافقة مع متطلبات الفوترة الإلكترونية ZATCA مع رمز QR بشكل نظامي متكامل. | نعم، يصدر النظام فاتورة ضريبية برمز QR، وندعم ربط المرحلة الثانية مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك. والهيئة لا تعتمد مزوّدي البرمجيات، فلا ندّعي اعتماداً منها. |
| 2 | `faq.items[4].a` | نعم، يعمل تطبيق المندوب طوال جولة اليوم بلا إنترنت: يصدر الفواتير وسندات القبض ويطبعها برمز QR ويسلّمها للعملاء، ثم ترتفع كل المستندات تلقائياً للإدارة فور عودة الاتصال — بلا تكرار ولا فقدان بيانات. | نعم، يعمل تطبيق المندوب طوال جولة اليوم بلا إنترنت: يصدر الفواتير وسندات القبض ويطبعها برمز QR ويسلّمها للعملاء، ثم ترتفع كل المستندات تلقائياً للإدارة فور عودة الاتصال — بلا تكرار ولا فقدان بيانات. أما الشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة فتحتاج فيها الفاتورة الضريبية والمرتجع اتصالاً لحظة الإصدار، وتبقى سندات القبض والزيارات متاحة بلا إنترنت. |
| 3 | `features.items[«العمل دون اتصال بالإنترنت»].desc` | يعمل تطبيق المندوب طوال جولة اليوم بلا إنترنت: يصدر الفواتير وسندات القبض ويطبعها برمز QR ويسلّمها للعملاء، ثم ترتفع كل المستندات تلقائياً للإدارة فور عودة الاتصال — بلا تكرار ولا فقدان. | يعمل تطبيق المندوب طوال جولة اليوم بلا إنترنت: يصدر الفواتير وسندات القبض ويطبعها برمز QR ويسلّمها للعملاء، ثم ترتفع كل المستندات تلقائياً للإدارة فور عودة الاتصال — بلا تكرار ولا فقدان. وللشركات المفعّل لها ربط المرحلة الثانية تحتاج الفاتورة الضريبية والمرتجع اتصالاً لحظة الإصدار. |
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
| 16 | `blog[offline-invoicing-for-reps].contentHtml` | أما المرحلة الثانية (الربط والتكامل) فغير مبنية لدينا حتى الآن — نذكر ذلك بوضوح لأن الدقة في هذا الباب التزام لا خيار. | أما الشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة فتحتاج فيها الفاتورة الضريبية اتصالاً لحظة الإصدار، وتبقى سندات القبض متاحة دون اتصال — نذكر ذلك بوضوح لأن الدقة في هذا الباب التزام لا خيار. |
| 17 | `blog[thermal-printing-field-invoices].contentHtml` | المعوَّل عليه ليس نوع الورق بل بيانات الفاتورة : أن تصدر من نظام فوترة ببياناتها المكتملة ورمز QR وفق المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية — وهو ما يفعله التطبيق مع كل فاتورة، ورقية الطباعة أو مرسلة رقمياً. | المعوَّل عليه ليس نوع الورق بل بيانات الفاتورة: أن تصدر من نظام فوترة ببياناتها المكتملة ورمز QR — وهو ما يفعله التطبيق مع كل فاتورة، ورقية الطباعة أو مرسلة رقمياً. |
| 18 | `blog[thermal-printing-field-invoices].contentHtml` | (المرحلة الثانية — الربط والتكامل — غير مبنية لدينا حتى الآن، ونذكر ذلك صراحةً.) وتبقى نسخة كل فاتورة محفوظة في النظام لا تُعدَّل بأثر رجعي، فالورقة للعميل والسجل للنظام. | (وندعم ربط المرحلة الثانية مع منصة فاتورة، وللشركات المفعّل لها تحتاج الفاتورة الضريبية اتصالاً لحظة الإصدار ثم تُطبع من الجهاز.) وتبقى نسخة كل فاتورة محفوظة في النظام لا تُعدَّل بأثر رجعي، فالورقة للعميل والسجل للنظام. |
| 19 | `blog[distributor-network-management-software].contentHtml` | يُصدر النظام فاتورة ضريبية مبسّطة برمز QR وفق المرحلة الأولى (مرحلة الإصدار) من متطلبات الفوترة الإلكترونية، وتُطبع للعميل في الموقع عبر الطابعة الحرارية. | يُصدر النظام فاتورة ضريبية مبسّطة برمز QR ويدعم ربط المرحلة الثانية مع منصة فاتورة، وتُطبع للعميل في الموقع عبر الطابعة الحرارية. |
| 20 | `blog[cash-van-software-guide].contentHtml` | فاتورة مبسّطة برمز QR — حتى بلا إنترنت: تصدر الفاتورة من الجوال وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية، وإن انقطع الاتصال تُحفَظ على الجهاز وترتفع تلقائياً عند عودته. | فاتورة مبسّطة برمز QR: تصدر الفاتورة من الجوال، وإن انقطع الاتصال تُحفَظ على الجهاز وترتفع تلقائياً عند عودته — إلا للشركات المفعّل لها ربط المرحلة الثانية مع منصة فاتورة، فالفاتورة الضريبية فيها تحتاج اتصالاً لحظة الإصدار. |
| 21 | `blog[cash-van-software-guide].contentHtml` | يُصدر النظام فاتورة ضريبية مبسّطة برمز QR وفق متطلبات المرحلة الأولى (مرحلة الإصدار) من الفوترة الإلكترونية. | يُصدر النظام فاتورة ضريبية مبسّطة برمز QR، ويدعم ربط المرحلة الثانية مع منصة فاتورة. |
| 22 | `blog[cash-van-software-saudi].contentHtml` | برنامج كاش فان مصمّم للسوق السعودي: يُصدر مندوبك فاتورة ضريبية مبسّطة برمز QR وفق المرحلة الأولى (مرحلة الإصدار) بضريبة قيمة مضافة 15% محسوبة تلقائياً، ويعمل أوف-لاين بالكامل في الطرق الطويلة والمناطق ضعيفة التغطية ثم يرفع العمليات وحده عند عودة الاتصال، ويطبع الفاتورة حرارياً عبر البلوتوث عند باب العميل. | برنامج كاش فان مصمّم للسوق السعودي: يُصدر مندوبك فاتورة ضريبية مبسّطة برمز QR بضريبة قيمة مضافة 15% محسوبة تلقائياً، ويدعم ربط المرحلة الثانية مع منصة فاتورة، ويعمل أوف-لاين في الطرق الطويلة والمناطق ضعيفة التغطية ثم يرفع العمليات وحده عند عودة الاتصال (عدا الفاتورة الضريبية للشركات المفعّل لها الربط)، ويطبع الفاتورة حرارياً عبر البلوتوث عند باب العميل. |
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
