# 🚀 تسويق FieldSales التلقائي على X (مجاني · GitHub Actions)

ينشر **يوميًا** تغريدة عربية + صورة على حساب شركتك في X، تلقائيًا على خوادم GitHub — **بلا خادم، بلا إبقاء جهازك مفتوحًا، مجاني للأبد.**

## كيف يعمل
`اختيار ميزة حقيقية → Claude يكتب تغريدة + وصف صورة → Pollinations يولّد الصورة (مجاناً) → نشر على X`

- المنطق في [`marketing/post.py`](post.py)، والجدولة في [`.github/workflows/marketing.yml`](../.github/workflows/marketing.yml).
- يعمل عبر **cron** على GitHub Actions (مجاني: ~30 تشغيلة/شهر × دقيقة ≈ لا شيء).

## 💰 التكلفة
| المكوّن | التكلفة |
|---|---|
| GitHub Actions (التشغيل) | **مجاني** |
| Pollinations (الصور) | **مجاني، بلا مفتاح** |
| Claude Haiku (النص) | ~**0.07$/شهر** (رصيد 5$ يكفي سنوات) |
| X API | **الطبقة المجانية** تكفي للنشر اليومي |

## ⚙️ الإعداد (مرّة واحدة)

### 1) أضِف الأسرار في GitHub
في مستودعك على GitHub: **Settings → Secrets and variables → Actions → New repository secret**، أضِف الخمسة:

| الاسم | من أين |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) ← API Keys (أضِف ~5$ رصيد) |
| `X_API_KEY` | X Developer Portal ← تطبيقك ← Keys and tokens ← **API Key** |
| `X_API_SECRET` | نفس المكان ← **API Key Secret** |
| `X_ACCESS_TOKEN` | نفس المكان ← **Access Token** |
| `X_ACCESS_SECRET` | نفس المكان ← **Access Token Secret** |

> **مهم في X:** اضبط صلاحيات التطبيق على **Read and write** أولًا، ثم **أعد توليد Access Token** (وإلا يبقى للقراءة فقط ويفشل النشر).

### 2) اختبر
**Actions ← «FieldSales — تسويق X اليومي» ← Run workflow** → راقب السجل → تحقّق من ظهور التغريدة على X.

### 3) فعّل
الجدولة شغّالة تلقائيًا (يوميًا 7م بتوقيت السعودية). لتغيير الوقت، عدّل سطر `cron` في `marketing.yml` (بتوقيت UTC).

## 🛠️ ملاحظات
- **لا يتأثر بدفعات الكود** ولا يُشغّل أي نشر آخر — يعمل بالجدولة أو الزر اليدوي فقط.
- إن لم تتح الطبقة المجانية رفع الصور، **يَنشر السكربت نصًا تلقائيًا** (لا يتعطّل).
- المواضيع: عدّل قائمة `TOPICS` في `post.py` — **ميزات حقيقية فقط**.
- نص أقوى: غيّر `claude-haiku-4-5` إلى `claude-sonnet-4-6` في `post.py`.
