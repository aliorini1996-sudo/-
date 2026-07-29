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
> English and French. E-invoicing supports **phase one (TLV QR)** in Saudi Arabia.

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
> distributors in Saudi Arabia and the wider Arab region, with Saudi e-invoicing
> **phase one (QR)** support, van stock management, and complete offline
> operation for reps working in low-coverage areas. Transparent per-company
> pricing from 299 SAR/month.

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
> role-based permissions per rep, and per-tenant data isolation. Saudi e-invoicing
> phase one (TLV-encoded QR). Arabic RTL, English and French interfaces.

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

**الحالة:** الوحدة نفسها لم تُبنَ بعد (تحتاج عملاً هندسياً منفصلاً). حين تقرّر
بناءها أخبرني — الرفّ شبه فارغ (٨ وحدات فقط بتنزيلات مفردة) فالفرصة قائمة.

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
> إفصاح: أنا من فريق Field Sales، والأداة مجانية ومفتوحة. وللإنصاف نحن ندعم
> **المرحلة الأولى فقط**؛ إن كان سؤالك عن الربط والتكامل فذلك خارج ما نغطّيه اليوم.

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
| «معتمد من هيئة الزكاة» | الهيئة تنصّ صراحةً أنها **لا تعتمد ولا تصادق** المزوّدين |
| دعم ZATCA المرحلة الثانية | غير مبنية لدينا |
| دعم ETA المصرية | غير مبنية (stub) |
| SOC2 أو ISO | لا نملكها |
| أي عدد عملاء أو نسبة نجاح | لا عملاء مرجعيون بعد |
| رابط متجر Play | يُرجع 404 حتى الآن |
| «اشترك الآن» | لا اشتراك ذاتي — كل نداء ينتهي بمحادثة أو تجربة |
| أي سعر غير ٢٩٩ / ٥٩٩ | مصدر السعر واحد ومحروس آلياً |

> هذه القائمة مفروضة آلياً على الموقع عبر `scripts/verify-claims.mjs` (يُفشل
> البناء عند أي مخالفة). لكن **المنصّات الخارجية خارج نطاق الحارس** — فالالتزام
> بها هناك مسؤوليتك المباشرة.
