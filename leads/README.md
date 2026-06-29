# 🎯 صيد العملاء المحتملين — FieldSales (مجاني · HERE Maps)

يبحث **يوميًا** عن شركات التوزيع/الجملة في مدن السعودية عبر **HERE Maps** (مجاني، بلا موزّع، بلا بطاقة)، يؤهّلها بـ**Claude**، ويحفظ **الجدد فقط** في **Google Sheet خاص**.

> Google Places محجوب في السعودية (يتطلّب موزّعًا) — لذا نستخدم HERE.

## كيف يعمل
`استعلام اليوم × كل المدن (HERE) → استبعاد المكرّر → تأهيل وترتيب بالملاءمة (Claude) → إضافة الجدد إلى Google Sheet`

- المنطق: [`leads/find_leads.py`](find_leads.py) — الجدولة: [`.github/workflows/leads.yml`](../.github/workflows/leads.yml).

## 💰 التكلفة
| المكوّن | التكلفة |
|---|---|
| GitHub Actions | **مجاني** |
| HERE Maps | **طبقة مجانية 1000 طلب/يوم — بلا بطاقة** (استخدامنا ~16/يوم) |
| Google Sheets API | **مجاني** |
| Claude (تأهيل) | ~سنتات/شهر |

---

## 🧪 الخطوة الأولى: اختبار التغطية (مفتاح HERE فقط)
قبل إعداد الجدول، نتأكّد أن HERE يغطّي السعودية جيدًا:

1. أنشئ حسابًا مجانيًا على [platform.here.com](https://platform.here.com) (Freemium — بلا بطاقة).
2. من **Access Manager → Apps → Create app** → ثم **Create API key** → انسخ المفتاح.
3. في GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
   - `HERE_API_KEY` = المفتاح.
4. **Actions → «FieldSales — صيد العملاء المحتملين» → Run workflow.**
5. افتح السجل → سيطبع **عدد النتائج وعيّنات** (وضع اختبار، بلا كتابة).
   - تغطية جيدة؟ → أكمل الإعداد أدناه.
   - ضعيفة؟ → أخبرني، نعود لـOpenStreetMap أو نفكّر ببديل.

---

## ⚙️ الإعداد الكامل (بعد نجاح الاختبار) — سرّان إضافيان

### Google Service Account + JSON
1. [console.cloud.google.com](https://console.cloud.google.com) → مشروع `FieldSales` (تجاهل عروض الفوترة — لا نحتاجها لـSheets).
2. **APIs & Services → Library** → فعّل **«Google Sheets API»**.
3. **Credentials → Create credentials → Service account** → أنشئه → **Keys → Add key → JSON**.
4. انسخ محتوى الـJSON كاملًا → سرّ `GOOGLE_SERVICE_ACCOUNT_JSON`. وانسخ بريد الحساب.

### Google Sheet
1. أنشئ جدولًا على [sheets.new](https://sheets.new).
2. **Share** → أضِف بريد الـService Account (Editor).
3. انسخ المعرّف من الرابط → سرّ `GOOGLE_SHEET_ID`.

بعد إضافة السرّين، التشغيل التالي **يكتب العملاء في الجدول** تلقائيًا (الأعلى ملاءمة أولًا)، يوميًا.

`ANTHROPIC_API_KEY` موجود مسبقًا. ✅

---

## 🛠️ تخصيص
- المدن/القطاعات: عدّل `CITIES` و`QUERIES` في `find_leads.py`. التكرار: `cron` في `leads.yml`.

## 🔒 الامتثال
بيانات أعمال عامّة فقط (اسم، هاتف عمل، عنوان) — لا بيانات شخصية. للمراجعة والتواصل المهني B2B، لا إرسال آلي. التزم بـPDPL وشروط HERE.
