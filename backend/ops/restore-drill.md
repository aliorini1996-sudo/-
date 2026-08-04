# تمرين استرجاع النسخة الاحتياطية (Restore Drill)

> **القاعدة:** نسخة احتياطية لم تُسترجع مرة واحدة على الأقل = أملٌ لا خطة. يُنفَّذ هذا التمرين مرة كل ربع سنة، **على قاعدة مؤقتة معزولة — لا يلمس الإنتاج أبداً**.
> أول تنفيذ: بعد تفعيل سرّ `DATABASE_URL` وتوفر أول نسخة آلية. ينفّذه الوكيل بإذن صريح أو المالك.

## الخطوات

1. **جلب النسخة:** GitHub → Actions → «Database Backup» → آخر تشغيلة ناجحة → Artifacts → نزّل `db-backup-*` وفك الضغط عن `backup-YYYYMMDD-HHMMSS.sql.gz`.

2. **قاعدة مؤقتة معزولة** (محلياً عبر Docker — لا تقترب من رابط الإنتاج):
```bash
docker run --name fs-restore-test -e POSTGRES_PASSWORD=drill -p 5499:5432 -d postgres:18
```

3. **الاسترجاع:**
```bash
gunzip -c backup-*.sql.gz | docker exec -i fs-restore-test psql -U postgres -d postgres
```

4. **فحوص القبول (كلها يجب أن تنجح):**
```bash
docker exec -i fs-restore-test psql -U postgres -d postgres -c "\dt" | head -30
docker exec -i fs-restore-test psql -U postgres -d postgres -c "SELECT count(*) AS tenants FROM tenants;"
docker exec -i fs-restore-test psql -U postgres -d postgres -c "SELECT count(*) AS invoices FROM invoices;"
docker exec -i fs-restore-test psql -U postgres -d postgres -c "SELECT count(*) AS entries, coalesce(sum(debit),0) AS total_debit, coalesce(sum(credit),0) AS total_credit FROM account_entries;"
```
   - الجداول تظهر، والأعداد منطقية مقارنة بالإنتاج، ومجاميع القيود غير صفرية إن كان ثمة نشاط.

5. **التنظيف:**
```bash
docker rm -f fs-restore-test
```
   واحذف ملف النسخة من الجهاز بعد التمرين (يحوي بيانات عملاء حقيقية).

6. **التوثيق:** أضف سطراً في الجدول أدناه.

## سجل التمارين

| التاريخ | نسخة بتاريخ | النتيجة | المنفّذ | ملاحظات |
|---|---|---|---|---|
| ⬜ | ⬜ | ⬜ | ⬜ | أول تمرين — بعد تفعيل السرّ |
