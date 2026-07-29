"""اختبارات التخطيط — تعمل بـpython وحده بلا Odoo ولا قاعدة بيانات.

    python integrations/odoo/fieldsales_connector/test_mapping.py

العيّنات مبنيّة على حقول Prisma الفعلية في backend/prisma/schema.prisma،
لا على تخمين. أي تغيير في تلك الحقول يجب أن يُكسر اختباراً هنا.
"""
import sys
import os
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mapping import (  # noqa: E402
    PayloadError, validate_payload, map_customer, map_product,
    map_invoice, map_invoice_line, map_receipt, map_all,
)


class TestValidation(unittest.TestCase):
    def test_يقبل_الحمولة_السليمة(self):
        resource, data = validate_payload({
            'source': 'field-sales', 'resource': 'customers', 'count': 1,
            'data': [{'id': 'x', 'name': 'متجر'}],
        })
        self.assertEqual(resource, 'customers')
        self.assertEqual(len(data), 1)

    def test_يرفض_مصدراً_غريباً(self):
        with self.assertRaises(PayloadError):
            validate_payload({'source': 'other', 'resource': 'customers', 'data': []})

    def test_يرفض_عدم_تطابق_العدد(self):
        # حمولة مقطوعة في النقل: count=5 لكن وصل صفّان — ترحيلها صامتاً يعني فقد ٣
        with self.assertRaises(PayloadError):
            validate_payload({'source': 'field-sales', 'resource': 'customers',
                              'count': 5, 'data': [{}, {}]})

    def test_يرفض_مورداً_غير_معروف(self):
        with self.assertRaises(PayloadError):
            validate_payload({'source': 'field-sales', 'resource': 'orders', 'data': []})


class TestCustomer(unittest.TestCase):
    ROW = {
        'id': 'cus-1', 'code': 'C-001', 'name': 'بقالة النور',
        'businessName': 'مؤسسة النور التجارية', 'phone': '0555',
        'altPhone': '0566', 'email': 'a@b.c', 'city': 'الرياض',
        'district': 'العليا', 'address': 'شارع 1', 'taxNumber': '300',
        'lat': 24.7, 'lng': 46.6, 'status': 'ACTIVE',
        'balance': 5000, 'totalSales': 90000, 'creditLimit': 10000,
    }

    def test_الحقول_الأساسية(self):
        v = map_customer(self.ROW)
        self.assertEqual(v['name'], 'بقالة النور')
        self.assertEqual(v['ref'], 'C-001')
        self.assertEqual(v['vat'], '300')
        self.assertEqual(v['company_type'], 'company')
        self.assertEqual(v['fs_id'], 'cus-1')

    def test_لا_يرحّل_الرصيد_ولا_المبيعات(self):
        # Odoo يحسبهما من قيوده؛ ترحيلهما يُنتج رقمين متضاربين لنفس العميل
        v = map_customer(self.ROW)
        for banned in ('balance', 'credit', 'total_invoiced', 'credit_limit'):
            self.assertNotIn(banned, v)

    def test_غير_النشط_يصير_مؤرشفاً(self):
        v = map_customer(dict(self.ROW, status='INACTIVE'))
        self.assertFalse(v['active'])

    def test_يسقط_للكود_عند_غياب_الاسم(self):
        v = map_customer({'id': 'x', 'code': 'C-9', 'name': ''})
        self.assertEqual(v['name'], 'C-9')

    def test_يرفض_بلا_اسم_ولا_كود(self):
        with self.assertRaises(PayloadError):
            map_customer({'id': 'x'})

    def test_فرد_لا_شركة_بلا_اسم_تجاري(self):
        v = map_customer({'id': 'x', 'name': 'أبو محمد', 'phone': '05'})
        self.assertEqual(v['company_type'], 'person')


class TestProduct(unittest.TestCase):
    ROW = {'id': 'p1', 'code': 'SKU-1', 'name': 'عصير برتقال',
           'barcode': '628', 'basePrice': 12.5, 'taxPct': 15,
           'unit': 'كرتون', 'status': 'ACTIVE'}

    def test_الحقول(self):
        v = map_product(self.ROW)
        self.assertEqual(v['default_code'], 'SKU-1')
        self.assertEqual(v['list_price'], 12.5)
        self.assertEqual(v['fs_tax_pct'], 15)
        self.assertEqual(v['barcode'], '628')

    def test_سعر_غير_رقمي_يصير_صفراً_لا_يُسقط_الصفّ(self):
        v = map_product(dict(self.ROW, basePrice='غير رقمي'))
        self.assertEqual(v['list_price'], 0.0)


class TestInvoice(unittest.TestCase):
    ROW = {
        'id': 'inv-1', 'number': 'INV-1001', 'type': 'SALE',
        'invoiceDate': '2026-07-29T10:15:00.000Z', 'dueDate': '2026-08-28T00:00:00.000Z',
        'total': 115.0, 'taxAmt': 15.0, 'paidAmt': 50.0, 'notes': 'تسليم صباحاً',
        'customerId': 'cus-1', 'customer': {'id': 'cus-1', 'code': 'C-001'},
        'items': [{'productId': 'p1', 'product': {'id': 'p1', 'code': 'SKU-1', 'name': 'عصير'},
                   'qty': 10, 'unitPrice': 10, 'discountPct': 0, 'discountAmt': 0,
                   'taxPct': 15, 'taxAmt': 15, 'lineTotal': 115}],
    }

    def test_مسودّة_دائماً_ولا_دفعة(self):
        v = map_invoice(self.ROW)
        # لا حالة posted ولا مبلغ مدفوع: كلاهما قرار محاسبي لا مزامنة آلية
        self.assertNotIn('state', v)
        self.assertNotIn('payment_state', v)
        self.assertNotIn('amount_paid', v)

    def test_التاريخ_يُقتطع_لصيغة_Odoo(self):
        v = map_invoice(self.ROW)
        self.assertEqual(v['invoice_date'], '2026-07-29')
        self.assertEqual(v['invoice_date_due'], '2026-08-28')

    def test_المرتجع_يصير_إشعار_دائن(self):
        v = map_invoice(dict(self.ROW, type='RETURN', returnReason='تالف'))
        self.assertEqual(v['move_type'], 'out_refund')
        self.assertIn('تالف', v['narration'])

    def test_يرفض_نوعاً_غير_معروف(self):
        with self.assertRaises(PayloadError):
            map_invoice(dict(self.ROW, type='TRANSFER'))

    def test_يرفض_فاتورة_بلا_بنود(self):
        with self.assertRaises(PayloadError):
            map_invoice(dict(self.ROW, items=[]))

    def test_رسوم_الخدمة_تُذكر_ولا_تُلفَّق_بنداً(self):
        v = map_invoice(dict(self.ROW, serviceChargeAmt=10, tipAmt=5))
        self.assertEqual(len(v['fs_lines']), 1)
        self.assertIn('رسوم خدمة', v['narration'])
        self.assertIn('إكرامية', v['narration'])


class TestInvoiceLine(unittest.TestCase):
    def test_نسبة_الخصم_تُشتقّ_من_المبلغ_عند_غيابها(self):
        # ١٠ × ١٠ = ١٠٠، خصم ٢٠ ⇒ ٢٠٪. بدون هذا الاشتقاق يضيع الخصم
        # ويصير إجمالي Odoo أعلى من إجمالي Field Sales.
        line = map_invoice_line({'qty': 10, 'unitPrice': 10, 'discountPct': 0, 'discountAmt': 20})
        self.assertAlmostEqual(line['discount'], 20.0)

    def test_النسبة_الصريحة_تفوز_على_المبلغ(self):
        line = map_invoice_line({'qty': 10, 'unitPrice': 10, 'discountPct': 5, 'discountAmt': 20})
        self.assertAlmostEqual(line['discount'], 5.0)

    def test_الخصم_لا_يتجاوز_مئة(self):
        line = map_invoice_line({'qty': 1, 'unitPrice': 10, 'discountPct': 0, 'discountAmt': 999})
        self.assertEqual(line['discount'], 100.0)

    def test_كمّية_صفر_لا_تُقسّم_على_صفر(self):
        line = map_invoice_line({'qty': 0, 'unitPrice': 0, 'discountPct': 0, 'discountAmt': 5})
        self.assertEqual(line['discount'], 0.0)

    def test_بند_مطعم_بلا_منتج_يُرحَّل_وصفياً(self):
        # مسار المطاعم: menuItemId بدل productId — الإسقاط يعني فاتورة ناقصة
        line = map_invoice_line({'menuItemId': 'm1', 'menuItem': {'name': 'برجر'},
                                 'qty': 2, 'unitPrice': 25})
        self.assertEqual(line['name'], 'برجر')
        self.assertEqual(line['fs_product_id'], '')

    def test_بند_بلا_اسم_إطلاقاً_لا_ينهار(self):
        line = map_invoice_line({'qty': 1, 'unitPrice': 5})
        self.assertEqual(line['name'], 'بند')


class TestReceipt(unittest.TestCase):
    ROW = {'id': 'r1', 'number': 'REC-1', 'amount': 500,
           'receiptDate': '2026-07-29T08:00:00.000Z', 'paymentMethod': 'CHEQUE',
           'chequeNumber': '9911', 'bankName': 'الأهلي', 'customerId': 'cus-1',
           'status': 'CONFIRMED'}

    def test_الحقول_ووسم_الطريقة(self):
        v = map_receipt(self.ROW)
        self.assertEqual(v['amount'], 500)
        self.assertEqual(v['payment_method'], 'شيك')
        self.assertIn('9911', v['note'])
        self.assertIn('الأهلي', v['note'])
        self.assertEqual(v['receipt_date'], '2026-07-29')

    def test_يرفض_مبلغاً_غير_موجب(self):
        with self.assertRaises(PayloadError):
            map_receipt(dict(self.ROW, amount=0))
        with self.assertRaises(PayloadError):
            map_receipt(dict(self.ROW, amount=-10))

    def test_طريقة_غير_معروفة_تُمرَّر_كما_هي(self):
        v = map_receipt(dict(self.ROW, paymentMethod='STC_PAY'))
        self.assertEqual(v['payment_method'], 'STC_PAY')


class TestMapAll(unittest.TestCase):
    def test_صفّ_تالف_لا_يُسقط_البقيّة(self):
        mapped, errors = map_all('customers', [
            {'id': '1', 'name': 'أ'},
            {'id': '2'},               # بلا اسم ولا كود ⇒ خطأ
            {'id': '3', 'name': 'ج'},
        ])
        self.assertEqual(len(mapped), 2)
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]['id'], '2')

    def test_قائمة_فارغة_لا_تنهار(self):
        mapped, errors = map_all('invoices', [])
        self.assertEqual(mapped, [])
        self.assertEqual(errors, [])

    def test_صفّ_None_يُسجَّل_خطأً_لا_انهياراً(self):
        mapped, errors = map_all('customers', [None])
        self.assertEqual(len(mapped), 0)
        self.assertEqual(len(errors), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
