# 🎯 صيد العملاء المحتملين — FieldSales (Google Places)

يبحث **يوميًا** عن شركات التوزيع/الجملة في مدن السعودية عبر **Google Places**، يؤهّلها بـ**Claude**، ويحفظ **الجدد فقط** في **Google Sheet خاص** — قائمة مؤهّلة لفريق مبيعاتك (الأعلى ملاءمة أولًا).

- المنطق: [`leads/find_leads.py`](find_leads.py) — الجدولة: [`.github/workflows/leads.yml`](../.github/workflows/leads.yml).

## 💰 التكلفة
Google Places ضمن **$200/شهر مجانًا** (استخدامنا ~16 بحثًا/يوم → **$0 فعليًا**) · Sheets API مجاني · Claude سنتات · GitHub Actions مجاني.

---

## ⚠️ مهم للسعودية: مفتاح Google Maps
حسابات Google Cloud ذات عنوان فوترة سعودي **تتعاقد عبر موزّع** (Maps reseller). خياراتك للحصول على `GOOGLE_MAPS_API_KEY`:
- **موزّع Maps معتمد** (الأسرع منهم للـMaps فقط): Searce (`googlemaps@searce.com`) · SoftwareONE (`maps@g.softwareone.com`) · CNTXT (`maps@cntxt.com`) · iSolutions · OniGroup. راسلهم لطلب «Google Maps Platform API key».
- **أو** حساب Google Cloud بعنوان فوترة خارج السعودية (إن كان لديك كيان/حساب كذلك) → تفعيل مباشر بلا موزّع.

> بمجرد حصولك على المفتاح، تابع الخطوات التالية.

---

## 🧪 الخطوة الأولى: اختبار التغطية (مفتاح Maps فقط)
1. أضِف السرّ `GOOGLE_MAPS_API_KEY` في GitHub (**Settings → Secrets and variables → Actions**).
2. فعّل في مشروع Google: **Places API (New)**.
3. **Actions → «FieldSales — صيد العملاء المحتملين» → Run workflow** → السجل سيطبع **عدد النتائج + عيّنات** (وضع اختبار، بلا كتابة).
4. تغطية جيدة؟ → أكمل إعداد Google Sheet أدناه.

## ⚙️ الإعداد الكامل (سرّان إضافيان)
### Service Account + JSON
**console.cloud.google.com** → فعّل **Google Sheets API** → **Credentials → Create credentials → Service account → Keys → JSON** → الصق محتواه في سرّ `GOOGLE_SERVICE_ACCOUNT_JSON`، وانسخ بريد الحساب.
### Google Sheet
[sheets.new](https://sheets.new) → **Share** مع بريد الـService Account (Editor) → انسخ المعرّف من الرابط → سرّ `GOOGLE_SHEET_ID`.

`ANTHROPIC_API_KEY` موجود مسبقًا. ✅ بعدها التشغيل يكتب العملاء يوميًا تلقائيًا.

---

## 🛠️ تخصيص
المدن/القطاعات: `CITIES` و`QUERIES` في `find_leads.py`. التكرار: `cron` في `leads.yml`.

## 🔒 الامتثال
بيانات أعمال عامّة فقط (اسم، هاتف عمل، عنوان) — لا بيانات شخصية. للمراجعة والتواصل المهني B2B، لا إرسال آلي. التزم بشروط Google Places وPDPL.
