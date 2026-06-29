# 🎯 صيد العملاء المحتملين — FieldSales (HERE الآن · Google لاحقًا)

يبحث **يوميًا** عن شركات التوزيع/الجملة في مدن السعودية، يؤهّلها بـ**Claude**، ويحفظ **الجدد فقط** في **Google Sheet خاص** (الأعلى ملاءمة أولًا).

## مصدران — تبديل تلقائي 🔄
- إن وُجد سرّ **`GOOGLE_MAPS_API_KEY`** → يستخدم **Google Places** (تغطية أفضل).
- وإلا إن وُجد **`HERE_API_KEY`** → يستخدم **HERE Maps** (مجاني، بلا موزّع، بلا بطاقة).

> **الخطة:** ابدأ بـHERE اليوم مجانًا. متى حصلت على مفتاح Google لاحقًا، أضِفه فقط — يتحوّل النظام إليه تلقائيًا.

- المنطق: [`leads/find_leads.py`](find_leads.py) — الجدولة: [`.github/workflows/leads.yml`](../.github/workflows/leads.yml).

---

## 🟢 المسار السريع: HERE الآن (مجاني، بلا بطاقة)
1. [platform.here.com](https://platform.here.com) → **Sign up** (مجاني، بلا بطاقة).
2. **Access Manager / Projects → Create app → Create API key** → انسخ المفتاح.
3. GitHub: **Settings → Secrets and variables → Actions → New repository secret** → `HERE_API_KEY` = المفتاح.
4. **Actions → «FieldSales — صيد العملاء المحتملين» → Run workflow** → السجل يطبع عدد النتائج (وضع اختبار).

## 🔵 المسار الأفضل لاحقًا: Google Maps
> في السعودية يتطلّب موزّع Maps (Searce `googlemaps@searce.com` / SoftwareONE `maps@g.softwareone.com`) أو حساب بفوترة خارج السعودية.
- بعد الحصول على المفتاح: فعّل **Places API (New)** + أضِف سرّ `GOOGLE_MAPS_API_KEY`. النظام يفضّله تلقائيًا على HERE.

---

## 📊 الحفظ التلقائي في Google Sheet (بعد نجاح الاختبار)
سرّان إضافيان (مجاني، بلا فوترة):
1. **Service Account + JSON:** console.cloud.google.com → فعّل **Google Sheets API** → Credentials → Create → Service account → Keys → JSON → الصق محتواه في `GOOGLE_SERVICE_ACCOUNT_JSON`، وانسخ بريد الحساب.
2. **Sheet:** [sheets.new](https://sheets.new) → Share مع بريد الـService Account (Editor) → انسخ المعرّف من الرابط → `GOOGLE_SHEET_ID`.

بعدها التشغيل يكتب العملاء يوميًا تلقائيًا. `ANTHROPIC_API_KEY` موجود مسبقًا. ✅

---

## 🛠️ تخصيص
المدن/القطاعات: `CITIES` و`QUERIES` في `find_leads.py`. التكرار: `cron` في `leads.yml`.

## 🔒 الامتثال
بيانات أعمال عامّة فقط (اسم، هاتف عمل، عنوان) — لا بيانات شخصية. للمراجعة والتواصل المهني B2B، لا إرسال آلي. التزم بشروط المصدر وPDPL.
