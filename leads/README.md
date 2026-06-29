# 🎯 صيد العملاء المحتملين — FieldSales (تلقائي · GitHub Actions)

يبحث **يوميًا** عن شركات التوزيع/الجملة في مدن السعودية عبر **Google Places**، يؤهّلها بـ**Claude**، ويحفظ **الجدد فقط** في **Google Sheet خاص** — قائمة مؤهّلة جاهزة لفريق مبيعاتك.

## كيف يعمل
`استعلام اليوم × كل المدن (Google Places) → استبعاد المكرّر → تأهيل وترتيب بالملاءمة (Claude) → إضافة الجدد إلى Google Sheet`

- المنطق: [`leads/find_leads.py`](find_leads.py) — الجدولة: [`.github/workflows/leads.yml`](../.github/workflows/leads.yml).
- يدوّر استعلامًا مختلفًا كل يوم عبر كل المدن، فيغطّي كل القطاعات×المدن خلال ~10 أيام ثم يلتقط الجديد باستمرار.

## 💰 التكلفة
| المكوّن | التكلفة |
|---|---|
| GitHub Actions | **مجاني** |
| Google Places API | **ضمن 200$/شهر مجانًا** — استخدامنا بضعة دولارات كحدّ أقصى → **$0 فعليًا** |
| Google Sheets API | **مجاني** |
| Claude (تأهيل) | ~سنتات/شهر |

> البطاقة في Google **للتحقّق فقط** — لن تُحاسب ضمن الطبقة المجانية لاستخدامنا.

---

## ⚙️ الإعداد (مرّة واحدة) — 3 أسرار

### 1) فعّل حساب Google Cloud + مفتاح Places
1. [console.cloud.google.com](https://console.cloud.google.com) → **Try for free** (تجربة $300/90 يومًا، بلا محاسبة) → أدخل بطاقتك (تحقّق فقط).
2. أنشئ مشروعًا `FieldSales` (أو استخدم الافتراضي).
3. **APIs & Services → Library** → فعّل **«Places API (New)»** و**«Google Sheets API»**.
4. **APIs & Services → Credentials → Create credentials → API key** → انسخه.
→ سرّ `GOOGLE_MAPS_API_KEY`.

### 2) Google Service Account + مفتاح JSON
1. **Credentials → Create credentials → Service account** → أنشئه → Done.
2. افتح الحساب → **Keys → Add key → JSON** → ينزّل ملف.
3. انسخ **محتواه كاملًا** → سرّ `GOOGLE_SERVICE_ACCOUNT_JSON`.
4. انسخ **بريد الحساب** (`xxx@yyy.iam.gserviceaccount.com`).

### 3) Google Sheet
1. أنشئ جدولًا على [sheets.new](https://sheets.new) (سمّه «عملاء FieldSales المحتملون»).
2. **Share** → أضِف **بريد الـService Account** بصلاحية **Editor**.
3. من الرابط انسخ المعرّف: `docs.google.com/spreadsheets/d/`**`الـID`**`/edit` → سرّ `GOOGLE_SHEET_ID`.

### 4) Claude
`ANTHROPIC_API_KEY` — موجود مسبقًا. ✅

### أضِف الأسرار الثلاثة في GitHub
**Settings → Secrets and variables → Actions → New repository secret**:
`GOOGLE_MAPS_API_KEY` · `GOOGLE_SERVICE_ACCOUNT_JSON` · `GOOGLE_SHEET_ID`

---

## ▶️ التشغيل
**Actions → «FieldSales — صيد العملاء المحتملين» → Run workflow** → راقب السجل → افتح الجدول (الأعلى ملاءمة أولًا). يعمل يوميًا تلقائيًا بعدها.

## 🛠️ تخصيص
- المدن/القطاعات: عدّل `CITIES` و`QUERIES` في `find_leads.py`.
- التكرار: عدّل `cron` في `leads.yml`.

## 🔒 الامتثال
- **بيانات أعمال عامّة فقط** (اسم، هاتف عمل، عنوان) — **لا بيانات شخصية**. القائمة لمراجعة فريقك والتواصل المهني B2B، **لا إرسال آلي مزعج**.
- التزم بشروط **Google Places** (قيود تخزين البيانات) و**نظام حماية البيانات السعودي (PDPL)**.
