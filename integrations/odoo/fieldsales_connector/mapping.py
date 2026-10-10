"""تخطيط حمولة Field Sales إلى قواميس Odoo — **بلا استيراد odoo إطلاقاً**.

لماذا منفصل: تركيب الحمولة وقواعد الترحيل هي ما يمكن أن يُخطئ صامتاً (حقل
ناقص، تاريخ بصيغة أخرى، بند فاتورة بلا منتج). فصلها عن طبقة Odoo يجعلها
قابلة للاختبار بـpython وحده، فتُكتشف الأخطاء قبل التثبيت على خادم حيّ.
والاختبار الحيّ على Odoo 17 حقيقي في .github/workflows/odoo-connector.yml.

عقد الحمولة الذي يرسله Field Sales (backend/src/services/erpPayload.ts):

    POST <رابط /fieldsales/sync>
    X-API-Key: <المفتاح>
    {
      "source": "field-sales",
      "resource": "customers" | "products" | "invoices" | "receipts" | "ping",
      "exportedAt": "2026-07-29T...Z",
      "count": 120,
      "data": [ ... صفوف بأسماء حقول Prisma ... ]
    }

يرسل Field Sales على دفعات (٢٠٠ صفّ) كل ما تغيّر منذ آخر مزامنة نظيفة، وأول
مرة كل السجلات — وقد يُعاد إرسال صفّ وصل من قبل (مزامنة جزئية لا تُقدّم المؤشر).
فالترحيل upsert بمفتاح خارجي ثابت هو `id` (UUID)، لا `code`/`number` القابلين للتعديل.
"""

RESOURCES = ('customers', 'products', 'invoices', 'receipts', 'ping')


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
        # المحظور (BLOCKED) يبقى نشطاً في Odoo: الحظر قيد بيع في Field Sales لا أرشفة
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

    الضريبة تُمرَّر كنسبة في `fs_tax_pct`، وطبقة Odoo تربطها بضريبة بيعٍ بالنسبة نفسها
    في شركة الربط (taxes_id). والوحدة نصّاً في `fs_unit`: مطابقة وحدات القياس بالاسم
    غير موثوقة بين التنصيبات واللغات، وخطؤها يُفسد الكميات.
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
        # المؤرشف في Field Sales (deletedAt) أو غير النشط ⇒ مؤرشف في Odoo
        'active': _s(row.get('status'), 'ACTIVE').upper() != 'INACTIVE' and not row.get('deletedAt'),
        'fs_id': _s(row.get('id')),
        'fs_tax_pct': _f(row.get('taxPct')),
        'fs_unit': _s(row.get('unit')),
    }


# ---------------------------------------------------------------- الفواتير

# نوع الفاتورة في Field Sales (Invoice.type: CASH | CREDIT | RETURN) ⇒ نوع الحركة في Odoo.
# SALE مقبولٌ لحمولاتٍ قديمة أو أنظمة أخرى ترسل العقد نفسه.
_MOVE_TYPE = {
    'CASH': 'out_invoice',
    'CREDIT': 'out_invoice',
    'SALE': 'out_invoice',
    'RETURN': 'out_refund',
}


def map_invoice(row):
    """فاتورة Field Sales ⇒ account.move (مسودّة دائماً).

    قرار متعمّد: لا تُرحَّل مُرحَّلة (posted). الترحيل يُنشئ قيوداً محاسبية
    ولا يُلغى إلا بعكس القيد؛ فقرار ترحيلها للمحاسب لا للمزامنة الآلية.

    قرار ثانٍ: `paidAmt` لا يُرحَّل كدفعة. الدفعة في Odoo تحتاج حساباً
    ودفتر يومية، وتلفيقها آلياً يُفسد التسوية البنكية.

    الفاتورة الملغاة في Field Sales (status = CANCELLED) تُلغى مسودّتها في Odoo،
    ولا تُنشأ إن لم تصل من قبل.
    """
    kind = _s(row.get('documentKind')).upper()
    if kind == 'CREDIT_NOTE':
        move_type = 'out_refund'
    else:
        move_type = _MOVE_TYPE.get(_s(row.get('type'), 'CREDIT').upper())
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
    if _s(row.get('einvoiceUuid')):
        # الفاتورة صدرت ومُبلَّغة للهيئة من Field Sales — لا تُرسَل من Odoo مرة ثانية
        notes.append('فاتورة إلكترونية صادرة من Field Sales — UUID: %s' % _s(row.get('einvoiceUuid')))
    if _s(row.get('originalInvoiceNumber')):
        notes.append('مرجع الفاتورة الأصلية: %s' % _s(row.get('originalInvoiceNumber')))

    status = _s(row.get('status'), 'CONFIRMED').upper()
    return {
        'move_type': move_type,
        'ref': _s(row.get('number')),
        # التاريخ المحلي للشركة (يرسله Field Sales بتوقيتها) — اقتطاع UTC يُرجع فواتير
        # منتصف الليل إلى اليوم السابق
        'invoice_date': _date(row.get('invoiceDateLocal')) or _date(row.get('invoiceDate')),
        'invoice_date_due': _date(row.get('dueDate')),
        'narration': '\n'.join(notes) or False,
        'fs_id': _s(row.get('id')),
        'fs_customer_id': _s((row.get('customer') or {}).get('id')) or _s(row.get('customerId')),
        'fs_total': _f(row.get('total')),
        'fs_tax_amt': _f(row.get('taxAmt')),
        'fs_status': status,
        'fs_cancelled': status == 'CANCELLED',
        'fs_lines': lines,
    }


def map_invoice_line(item):
    """بند فاتورة ⇒ account.move.line.

    السعر **صافٍ قبل الضريبة** دائماً: Odoo يحسب الضريبة فوق السعر. فواتير تطبيق
    المندوب أسعارها شاملة، ولذلك يرسل Field Sales `unitPriceNet` (الصافي) و`netAmount`
    (صافي البند بعد خصم البند وحصّته من خصم الفاتورة الكلّي). والخصم في Odoo نسبةٌ
    فقط، فتُشتقّ النسبة الفعلية من الصافي: qty × السعر × (1 − الخصم) = الصافي.
    وحمولةٌ قديمة بلا الحقلين: السعر كما هو وخصم البند (نسبة أو مبلغ).
    """
    qty = _f(item.get('qty'))
    has_net = item.get('unitPriceNet') is not None
    unit_price = _f(item.get('unitPriceNet')) if has_net else _f(item.get('unitPrice'))
    gross = qty * unit_price
    if item.get('netAmount') is not None and gross > 0:
        discount_pct = (1.0 - _f(item.get('netAmount')) / gross) * 100.0
    else:
        discount_pct = _f(item.get('discountPct'))
        discount_amt = _f(item.get('discountAmt'))
        if discount_pct <= 0 and discount_amt > 0 and gross > 0:
            discount_pct = discount_amt / gross * 100.0
    discount_pct = max(0.0, min(100.0, discount_pct))

    product = item.get('product') or {}
    menu_item = item.get('menuItem') or {}
    # بند بلا منتج يقع فعلاً في مسار المطاعم (menuItemId بدل productId)،
    # فيُرحَّل كسطر وصفي بدل إسقاطه أو اختراع منتج له.
    name = _s(item.get('itemName')) or _s(product.get('name')) or _s(menu_item.get('name')) or 'بند'

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

# طريقة الدفع في Field Sales (Receipt.paymentMethod: CASH | BANK_TRANSFER | POS | CHEQUE)
# ⇒ وسم يُعرض في Odoo (لا ربط بدفتر يومية: اختيار اليومية إعداد محاسبي لكل شركة)
_PAYMENT_LABEL = {
    'CASH': 'نقداً',
    'BANK_TRANSFER': 'تحويل بنكي',
    'BANK': 'تحويل بنكي',
    'TRANSFER': 'تحويل بنكي',
    'POS': 'شبكة / نقاط بيع',
    'CARD': 'بطاقة',
    'CHEQUE': 'شيك',
    'CHECK': 'شيك',
}

_RECEIPT_STATE = {'ACTIVE': 'ساري', 'CONFIRMED': 'ساري', 'CANCELLED': 'ملغى'}


def _allocations(row):
    """مقابل أي فواتير دُفع السند: [(fs_invoice_id, رقمها، المبلغ)] من `allocations` أو `invoiceItems`."""
    out = []
    for a in row.get('allocations') or []:
        out.append((_s(a.get('invoiceId')), _s(a.get('invoiceNumber')), _f(a.get('amount'))))
    if not out:
        for a in row.get('invoiceItems') or []:
            out.append((_s(a.get('invoiceId')), _s((a.get('invoice') or {}).get('number')), _f(a.get('amount'))))
    return [a for a in out if a[0]]


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
    allocations = _allocations(row)
    extra = []
    if allocations:
        extra.append('مقابل: ' + '، '.join('%s (%s)' % (num or fid[:8], amt) for fid, num, amt in allocations))
    if _s(row.get('chequeNumber')):
        extra.append('شيك رقم %s' % _s(row.get('chequeNumber')))
    if _s(row.get('bankName')):
        extra.append(_s(row.get('bankName')))
    if _s(row.get('notes')):
        extra.append(_s(row.get('notes')))
    status = _s(row.get('status'), 'ACTIVE').upper()
    return {
        'fs_id': _s(row.get('id')),
        'name': _s(row.get('number')) or _s(row.get('id')),
        'amount': amount,
        'receipt_date': _date(row.get('receiptDateLocal')) or _date(row.get('receiptDate')),
        'payment_method': _PAYMENT_LABEL.get(method, method),
        'fs_customer_id': _s((row.get('customer') or {}).get('id')) or _s(row.get('customerId')),
        'note': ' · '.join(extra) or False,
        'state': _RECEIPT_STATE.get(status, status),
        'fs_invoice_ids': [fid for fid, _num, _amt in allocations],
    }


MAPPERS = {
    'customers': map_customer,
    'products': map_product,
    'invoices': map_invoice,
    'receipts': map_receipt,
}


def map_all(resource, data):
    """يُخطّط الحمولة كلها ويُعيد (المُخطَّطة، الأخطاء).

    لا يرفع عند فشل صفّ واحد: صفّ تالف وسط ٢٠٠ لا يجوز أن يمنع الـ١٩٩
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
