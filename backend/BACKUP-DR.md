# النسخ الاحتياطي والتعافي من الكوارث (Backup & DR)

## النسخ الاحتياطي (آلي)
- **الآلية:** ورك فلو `.github/workflows/backup.yml` يأخذ نسخة `pg_dump` مضغوطة يومياً (02:00 UTC) ويرفعها كـartifact (يُحتفظ بها 30 يوماً).
- **التفعيل (مرة واحدة، بيد المالك):** أضِف سرّ المستودع `DATABASE_URL` = External Connection String من Render + `?sslmode=require`. قبل ذلك لا يعمل الورك فلو (لا يمسّ قاعدة البيانات).
- **التشغيل اليدوي:** GitHub → Actions → «Database Backup» → Run workflow.
- **نسخة يدوية بديلة (Prisma، قراءة فقط):** `DATABASE_URL="<External>?sslmode=require" node backend/_backup.cjs "<مجلد>"` → JSON لكل الجداول في `backups/`.

## الاسترجاع (Restore)
1. نزّل أحدث artifact `db-backup` من صفحة Actions وفكّ الضغط: `gunzip backup-YYYYMMDD-HHMMSS.sql.gz`.
2. استرجاع إلى قاعدة (جديدة/بديلة):
   ```bash
   psql "<TARGET_DATABASE_URL>?sslmode=require" < backup-YYYYMMDD-HHMMSS.sql
   ```
   > للاسترجاع فوق قاعدة موجودة راجِع المخطّط أولاً؛ يُفضَّل قاعدة نظيفة ثم توجيه الخدمة إليها.
3. حدّث `DATABASE_URL` في خدمات Render لتشير للقاعدة المسترجَعة، ثم أعِد النشر.

## الأهداف (مبدئية)
- **RPO** (أقصى فقد بيانات): ≤ 24 ساعة (نسخة يومية) — يُقلَّص بزيادة تكرار الجدولة.
- **RTO** (زمن الاستعادة): ≤ 1 ساعة (تنزيل + psql + إعادة توجيه).

## ملاحظات
- artifacts تنتهي بعد 30 يوماً — للأرشفة الأطول، وجّه النسخ إلى تخزين خارجي (S3/Drive) بمفتاح المالك.
- تأكّد أن `pg_dump` ≥ إصدار خادم Render (الورك فلو يثبّت 16).
