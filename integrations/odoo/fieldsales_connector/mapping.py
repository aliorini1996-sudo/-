"""تخطيط حمولة Field Sales إلى قواميس Odoo — **بلا استيراد odoo إطلاقاً**.

لماذا منفصل: تركيب الحمولة وقواعد الترحيل هي ما يمكن أن يُخطئ صامتاً (حقل
ناقص، تاريخ بصيغة أخرى، بند فاتورة بلا منتج). فصلها عن طبقة Odoo يجعلها
قابلة للاختبار بـpython وحده، فتُكتشف الأخطاء قبل التثبيت على خادم حيّ.

عقد الحمولة الذي يرسله Field Sales (backend/src/services/erp.ts):

    POST <baseUrl>/<endpoint>
    X-API-Key: <المفتاح>
    {
      "source": "field-sales",
      "resource": "customers" | "products" | "invoices" | "receipts",
      "exportedAt": "2026-07-29T...Z",
      "count": 120,
      "data": [ ... صفوف كما هي من قاعدة البيانات ... ]
    }

ملاحظة جوهرية: Field Sales يُرسل آخر ٥٠٠ صفّاً في **كل** مزامنة، لا الجديد
منها فقط. فالترحيل يجب أن يكون upsert بمفتاح خارجي ثابت وإلا تضاعفت
السجلات مع كل مزامنة. المفتاح المعتمد هنا هو `id` (UUID) لأنه لا يتغيّر،
بينما `code`/`number` قابلان للتعديل من لوحة التحكّم.
"""

RESOURCES = ('customers', 'products', 'invoices', 'receipts')


class PayloadError(ValueError):
    """حمولة مرفوضة — تُعاد للمُرسِل برمز 400 لا 500."""


def validate_payload(payload):
    """يتحقّق من الشكل قبل أي كتابة. يرفع PayloadError برسالة صريحة.

    يُعيد (resource, data). الصرامة مقصودة: قبول حمولة نصف صحيحة يُنتج
    سجلات نصف مكتملة يصعب تنظيفها لاحقاً أكثر من رفضها الآن.
    """
    if not isinstance(payload, dict):
        raise PayloadError('الحمولة يجب أن تكون كائن JSON')
    if payload.get('source') != 'field-sales':
        raise PayloadError("الحقل source يجب أن يساوي 'field-sales'")
    resource = payload.get('resource')
    if resource not in RESOURCES:
        raise PayloadError('resource غير معروف: %s' % (resource,))
    data = payload.get('data')
    if not isinstance(data, list):
        raise PayloadError('الحقل data يجب أن يكون مصفوفة')
    count = payload.get('count')
    # عدم التطابق يعني حمولة مقطوعة في النقل — الرفض أأمن من ترحيل جزئي صامت
    if isinstance(count, int) and count != len(data):
        raise PayloadError('count=%s لا يطابق طول data=%s' % (count, len(data)))
    return resource, data


def _f(value, default=0.0):
    """رقم عشري آمن: None أو نصّ فارغ أو قيمة غير رقمية ⇒ الافتراضي."""
    if value is None or value == '':
        return default
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    # NaN و inf يمرّان من float() ويفسدان الحسابات لاحقاً بصمت
    if out != out or out in (float('inf'), float('-inf')):
        return default
    return out


def _s(value, default=''):
    """نصّ آمن ومُشذَّب."""
    if value is None:
        return default
    return str(value).strip() or default


def _date(value):
    """يقتطع الجزء التاريخي من ISO. Odoo يتوقّع 'YYYY-MM-DD' للحقول date."""
    text = _s(value)
    return text[:10] if len(text) >= 10 else False


def _datetime(value):
    """ISO ⇒ 'YYYY-MM-DD HH:MM:SS' الذي يقبله Odoo. المنطقة الزمنية تُسقَط
    لأن Odoo يخزّن UTC والحمولة أصلاً UTC (toISOString)."""
    text = _s(value).replace('Z', '')
    if len(text) < 19:
        return False
    return text[:10] + ' ' + text[11:19]


# ---------------------------------------------------------------- العملاء

def map_customer(row):
    """عميل Field Sales ⇒ res.partner.

    التخطيط محافظ عمداً: الرصيد والمبيعات التراكمية **لا** تُرحَّل، لأن
    Odoo يحسبها من قيوده هو. ترحيلها يُنتج رقمين متضاربين لنفس العميل.
    """
    name = _s(row.get('name')) or _s(row.get('businessName')) or _s(row.get('code'))
    if not name:
        raise PayloadError('عميل بلا اسم ولا كود: %s' % (row.get('id'),))
    vals = {
        'name': name,
        'ref': _s(row.get('code')) or False,
        'phone': _s(row.get('phone')) or False,
        'mobile': _s(row.get('altPhone')) or False,
        'email': _s(row.get('email')) or False,
        'street': _s(row.get('address')) or False,
        'street2': _s(row.get('district')) or False,
        'city': _s(row.get('city')) or False,
        'vat': _s(row.get('taxNumber')) or False,
        'company_type': 'company' if _s(row.get('businessName')) else 'person',
        'active': _s(row.get('status'), 'ACTIVE').upper() != 'INACTIVE',
        'partner_latitude': _f(row.get('lat'), 0.0),
        'partner_longitude': _f(row.get('lng'), 0.0),
        'fs_id': _s(row.get('id')),
    }
    if _s(row.get('businessName')) and _s(row.get('businessName')) != name:
        vals['comment'] = 'الاسم التجاري: %s' % _s(row.get('businessName'))
    return vals


# ---------------------------------------------------------------- المنتجات

def map_product(row):
    """منتج Field Sales ⇒ product.template.

    الضريبة تُمرَّر كنسبة في `fs_tax_pct` لا كمعرّف ضريبة: ربطها بضريبة
    Odoo يعتمد على إعداد الشركة المحاسبي، ويُحسم في طبقة Odoo لا هنا.
    """
    name = _s(row.get('name')) or _s(row.get('code'))
    if not name:
        raise PayloadError('منتج بلا اسم ولا كود: %s' % (row.get('id'),))
    return {
        'name': name,
        'default_code': _s(row.get('code')) or False,
        'barcode': _s(row.get('barcode')) or False,
        'list_price': _f(row.get('basePrice')),
        'type': 'consu',
        'sale_ok': True,
        'purchase_ok': True,
        'active': _s(row.get('status'), 'ACTIVE').upper() != 'INACTIVE',
        'fs_id': _s(row.get('id')),
        'fs_tax_pct': _f(row.get('taxPct')),
        'fs_unit': _s(row.get('unit')),
    }


# ---------------------------------------------------------------- الفواتير

# نوع الفاتورة في Field Sales ⇒ نوع الحركة في Odoo
_MOVE_TYPE = {
    'SALE': 'out_invoice',
    'RETURN': 'out_refund',
}


def map_invoice(row):
    """فاتورة Field Sales ⇒ account.move (مسودّة دائماً).

    قرار متعمّد: لا تُرحَّل مُرحَّلة (posted). الترحيل يُنشئ قيوداً محاسبية
    ولا يُلغى إلا بعكس القيد؛ فقرار ترحيلها للمحاسب لا للمزامنة الآلية.

    قرار ثانٍ: `paidAmt` لا يُرحَّل كدفعة. الدفعة في Odoo تحتاج حساباً
    ودفتر يومية، وتلفيقها آلياً يُفسد التسوية البنكية.
    """
    move_type = _MOVE_TYPE.get(_s(row.get('type'), 'SALE').upper())
    if not move_type:
        raise PayloadError('نوع فاتورة غير معروف: %s' % (row.get('type'),))
    lines = [map_invoice_line(item) for item in (row.get('items') or [])]
    if not lines:
        raise PayloadError('فاتورة بلا بنود: %s' % (row.get('number') or row.get('id'),))

    notes = []
    if _s(row.get('notes')):
        notes.append(_s(row.get('notes')))
    # رسوم الخدمة والإكرامية (مسار المطاعم) تُذكر ولا تُلفَّق كبنود منتجات
    if _f(row.get('serviceChargeAmt')) > 0:
        notes.append('رسوم خدمة: %s' % _f(row.get('serviceChargeAmt')))
    if _f(row.get('tipAmt')) > 0:
        notes.append('إكرامية: %s' % _f(row.get('tipAmt')))
    if _s(row.get('returnReason')):
        notes.append('سبب المرتجع: %s' % _s(row.get('returnReason')))

    return {
        'move_type': move_type,
        'ref': _s(row.get('number')),
        'invoice_date': _date(row.get('invoiceDate')),
        'invoice_date_due': _date(row.get('dueDate')),
        'narration': '\n'.join(notes) or False,
        'fs_id': _s(row.get('id')),
        'fs_customer_id': _s((row.get('customer') or {}).get('id')) or _s(row.get('customerId')),
        'fs_total': _f(row.get('total')),
        'fs_tax_amt': _f(row.get('taxAmt')),
        'fs_lines': lines,
    }


def map_invoice_line(item):
    """بند فاتورة ⇒ account.move.line.

    الخصم: Field Sales يحمل نسبة ومبلغاً معاً. Odoo يقبل نسبة فقط، فإن
    وُجد مبلغ خصم بلا نسبة تُشتقّ النسبة منه — وإلا ضاع الخصم صامتاً
    وصار إجمالي الفاتورة في Odoo أعلى من الأصل.
    """
    qty = _f(item.get('qty'))
    unit_price = _f(item.get('unitPrice'))
    discount_pct = _f(item.get('discountPct'))
    discount_amt = _f(item.get('discountAmt'))
    gross = qty * unit_price
    if discount_pct <= 0 and discount_amt > 0 and gross > 0:
        discount_pct = min(100.0, discount_amt / gross * 100.0)

    product = item.get('product') or {}
    menu_item = item.get('menuItem') or {}
    # بند بلا منتج يقع فعلاً في مسار المطاعم (menuItemId بدل productId)،
    # فيُرحَّل كسطر وصفي بدل إسقاطه أو اختراع منتج له.
    name = _s(product.get('name')) or _s(menu_item.get('name')) or 'بند'

    return {
        'name': name,
        'quantity': qty,
        'price_unit': unit_price,
        'discount': round(discount_pct, 4),
        'fs_product_id': _s(product.get('id')) or _s(item.get('productId')),
        'fs_product_code': _s(product.get('code')),
        'fs_tax_pct': _f(item.get('taxPct')),
        'fs_line_total': _f(item.get('lineTotal')),
    }


# ---------------------------------------------------------------- السندات

# طريقة الدفع في Field Sales ⇒ وسم يُعرض في Odoo (لا ربط بدفتر يومية:
# اختيار اليومية إعداد محاسبي لكل شركة)
_PAYMENT_LABEL = {
    'CASH': 'نقداً',
    'BANK': 'تحويل بنكي',
    'TRANSFER': 'تحويل بنكي',
    'CHEQUE': 'شيك',
    'CHECK': 'شيك',
    'CARD': 'بطاقة',
}


def map_receipt(row):
    """سند قبض ⇒ سجل fieldsales.receipt (لا account.payment).

    السبب: إنشاء دفعة في Odoo يتطلّب دفتر يومية وحساباً وسيطاً، واختيارهما
    قرار محاسبي يخصّ كل شركة. الترحيل الآلي لهما يُنتج قيوداً في حسابات
    خاطئة يصعب تتبّعها. فيُسجَّل السند للمراجعة، ويُنشئ المحاسب الدفعة.
    """
    amount = _f(row.get('amount'))
    if amount <= 0:
        raise PayloadError('سند بمبلغ غير صالح: %s' % (row.get('number') or row.get('id'),))
    method = _s(row.get('paymentMethod'), 'CASH').upper()
    extra = []
    if _s(row.get('chequeNumber')):
        extra.append('شيك رقم %s' % _s(row.get('chequeNumber')))
    if _s(row.get('bankName')):
        extra.append(_s(row.get('bankName')))
    if _s(row.get('notes')):
        extra.append(_s(row.get('notes')))
    return {
        'fs_id': _s(row.get('id')),
        'name': _s(row.get('number')),
        'amount': amount,
        'receipt_date': _date(row.get('receiptDate')),
        'payment_method': _PAYMENT_LABEL.get(method, method),
        'fs_customer_id': _s((row.get('customer') or {}).get('id')) or _s(row.get('customerId')),
        'note': ' · '.join(extra) or False,
        'state': _s(row.get('status'), 'CONFIRMED').upper(),
    }


MAPPERS = {
    'customers': map_customer,
    'products': map_product,
    'invoices': map_invoice,
    'receipts': map_receipt,
}


def map_all(resource, data):
    """يُخطّط الحمولة كلها ويُعيد (المُخطَّطة، الأخطاء).

    لا يرفع عند فشل صفّ واحد: صفّ تالف وسط ٥٠٠ لا يجوز أن يمنع الـ٤٩٩
    الباقية. الأخطاء تُعاد لتُسجَّل ويراها المستخدم.
    """
    mapper = MAPPERS[resource]
    mapped, errors = [], []
    for row in data:
        try:
            mapped.append(mapper(row))
        except PayloadError as exc:
            errors.append({'id': (row or {}).get('id'), 'error': str(exc)})
        except Exception as exc:  # noqa: BLE001 — صفّ واحد لا يُسقط المزامنة
            errors.append({'id': (row or {}).get('id'), 'error': '%s: %s' % (type(exc).__name__, exc)})
    return mapped, errors
