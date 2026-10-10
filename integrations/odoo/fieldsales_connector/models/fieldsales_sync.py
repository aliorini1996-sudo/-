"""طبقة Odoo: الحقول المضافة، سجلّ المزامنة، ومحرّك الترحيل.

منطق التخطيط كلّه في mapping.py (بلا odoo، مختبَر). هنا القراءة والكتابة فقط،
ومختبرةٌ على Odoo 17 حقيقي في .github/workflows/odoo-connector.yml (e2e/run_e2e.py).
"""
import logging
import secrets

from odoo import api, fields, models, _
from odoo.exceptions import UserError

from ..mapping import validate_payload, map_all

_logger = logging.getLogger(__name__)

# اسم المَعلمة التي تحمل مفتاح API في ir.config_parameter
API_KEY_PARAM = 'fieldsales_connector.api_key'

# فرقٌ بين إجمالي Odoo وإجمالي Field Sales حتى هذا الحدّ = تقريب (دقّة السعر والخصم في Odoo
# خانتان) فيُسوّى بسطر «فرق تقريب»؛ وما فوقه فرقٌ حقيقي يُترك ظاهراً في fs_total_diff للمراجعة
ROUNDING_TOLERANCE = 1.0

# كم خطأً يُعاد للمُرسِل ويُخزَّن في السجلّ — تكفي للتشخيص بلا إثقال
MAX_ERRORS = 20

_FS_ID_UNIQ = ('fs_id_uniq', 'unique(fs_id)', 'A record with this Field Sales ID already exists.')


class ResPartner(models.Model):
    _inherit = 'res.partner'

    # فهرس لأن كل مزامنة تبحث بهذا الحقل لكل صفّ؛ وفريد كي لا يُنشئ تزامنان متوازيان نسختين
    fs_id = fields.Char(string='Field Sales ID', index=True, copy=False)

    _sql_constraints = [_FS_ID_UNIQ]


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    fs_id = fields.Char(string='Field Sales ID', index=True, copy=False)
    fs_tax_pct = fields.Float(string='Field Sales tax %', copy=False)
    fs_unit = fields.Char(string='Field Sales unit', copy=False)

    _sql_constraints = [_FS_ID_UNIQ]


class AccountMove(models.Model):
    _inherit = 'account.move'

    fs_id = fields.Char(string='Field Sales ID', index=True, copy=False)
    fs_total = fields.Monetary(string='Field Sales total', copy=False, currency_field='currency_id',
                               help='The invoice total as issued in Field Sales (tax included).')
    fs_tax_amt = fields.Monetary(string='Field Sales tax', copy=False, currency_field='currency_id')
    fs_total_diff = fields.Monetary(string='Difference vs Field Sales', copy=False, currency_field='currency_id',
                                    help='Field Sales total minus the Odoo total. Zero when they match.')
    fs_status = fields.Char(string='Field Sales status', copy=False)

    _sql_constraints = [_FS_ID_UNIQ]


class FieldSalesReceipt(models.Model):
    """سند قبض وارد — يُراجَع ثم يُحوّل لدفعة يدوياً.

    نموذج مستقلّ لا account.payment: الدفعة تحتاج دفتر يومية وحساباً وسيطاً،
    واختيارهما قرار محاسبي لكل شركة. اختيارهما آلياً يُنتج قيوداً في حسابات
    خاطئة يصعب تتبّعها بعد أشهر.
    """
    _name = 'fieldsales.receipt'
    _description = 'Field Sales Receipt'
    _order = 'receipt_date desc, id desc'

    name = fields.Char(string='Number', required=True, index=True)
    fs_id = fields.Char(string='Field Sales ID', index=True, copy=False)
    partner_id = fields.Many2one('res.partner', string='Customer', ondelete='restrict')
    fs_customer_id = fields.Char(string='Field Sales customer ID')
    amount = fields.Float(string='Amount', required=True)
    receipt_date = fields.Date(string='Date')
    payment_method = fields.Char(string='Payment method')
    note = fields.Char(string='Note')
    state = fields.Char(string='Field Sales status')
    invoice_ids = fields.Many2many('account.move', string='Paid invoices',
                                   help='The Field Sales invoices this receipt was allocated to.')

    _sql_constraints = [
        ('fs_id_uniq', 'unique(fs_id)', 'A receipt with this Field Sales ID already exists.'),
    ]


class FieldSalesSyncLog(models.Model):
    _name = 'fieldsales.sync.log'
    _description = 'Field Sales Sync Log'
    _order = 'create_date desc'

    resource = fields.Char(string='Resource', index=True)
    received = fields.Integer(string='Rows received')
    created_count = fields.Integer(string='Created')
    updated_count = fields.Integer(string='Updated')
    error_count = fields.Integer(string='Errors')
    errors = fields.Text(string='Error details')
    exported_at = fields.Char(string='Exported at (source)')


class FieldSalesConnector(models.AbstractModel):
    """محرّك الترحيل. يُستدعى من المتحكّم بعد التحقّق من المفتاح."""
    _name = 'fieldsales.connector'
    _description = 'Field Sales Connector engine'

    # ------------------------------------------------------------ المفتاح

    @api.model
    def _get_api_key(self):
        return self.env['ir.config_parameter'].sudo().get_param(API_KEY_PARAM, '')

    @api.model
    def _generate_api_key(self):
        key = secrets.token_urlsafe(32)
        self.env['ir.config_parameter'].sudo().set_param(API_KEY_PARAM, key)
        return key

    # ------------------------------------------------------------ الترحيل

    @api.model
    def process(self, payload):
        """يُرحّل حمولة كاملة ويُعيد ملخّصاً. يفترض أن المفتاح تُحقّق منه.

        `ping` (زرّ «اختبار الاتصال» في Field Sales) لا يكتب شيئاً: وصوله إلى هنا يعني أن
        الرابط صحيح والمفتاح صحيح.
        """
        resource, data = validate_payload(payload)
        if resource == 'ping':
            return {'ok': True, 'resource': 'ping', 'received': 0, 'created': 0, 'updated': 0, 'errors': 0,
                    'error_details': []}
        mapped, errors = map_all(resource, data)

        handler = {
            'customers': self._apply_customers,
            'products': self._apply_products,
            'invoices': self._apply_invoices,
            'receipts': self._apply_receipts,
        }[resource]
        created, updated, apply_errors = handler(mapped)
        errors = errors + apply_errors

        self.env['fieldsales.sync.log'].sudo().create({
            'resource': resource,
            'received': len(data),
            'created_count': created,
            'updated_count': updated,
            'error_count': len(errors),
            'errors': '\n'.join('%s: %s' % (e.get('id'), e.get('error')) for e in errors[:MAX_ERRORS]) or False,
            'exported_at': payload.get('exportedAt'),
        })
        return {
            'ok': True, 'resource': resource, 'received': len(data),
            'created': created, 'updated': updated, 'errors': len(errors),
            # تفاصيل أول الأخطاء ليعرضها Field Sales لمستخدمه — لا عدّاداً صامتاً
            'error_details': [{'id': e.get('id'), 'error': e.get('error')} for e in errors[:MAX_ERRORS]],
        }

    def _upsert(self, model, vals_list, extra=None):
        """يبحث بـfs_id (والمؤرشف معه) ثم يُنشئ أو يُحدّث. يُعيد (منشأ، محدَّث، أخطاء).

        البحث بـfs_id لا بالكود: الكود قابل للتعديل من لوحة Field Sales، فالمطابقة به
        تُنشئ سجلاً جديداً كلّما عدّل المستخدم كوداً. والبحث يشمل المؤرشف (active_test=False):
        وإلا أُنشئ عميلٌ أو منتجٌ غير نشط من جديد في كل مزامنة.
        """
        Model = self.env[model].sudo().with_context(active_test=False)
        created = updated = 0
        errors = []
        for vals in vals_list:
            vals = dict(vals)
            fs_id = vals.get('fs_id')
            if not fs_id:
                errors.append({'id': None, 'error': 'صفّ بلا معرّف Field Sales'})
                continue
            try:
                # savepoint لكل صفّ: خطأ في صفّ لا يُبطل بقية الدفعة
                with self.env.cr.savepoint():
                    if extra:
                        vals.update(extra(vals))
                    record = Model.search([('fs_id', '=', fs_id)], limit=1)
                    if record:
                        record.write(vals)
                        updated += 1
                    else:
                        Model.create(vals)
                        created += 1
            except Exception as exc:  # noqa: BLE001
                _logger.warning('Field Sales upsert failed for %s: %s', fs_id, exc)
                errors.append({'id': fs_id, 'error': str(exc)[:200]})
        return created, updated, errors

    def _apply_customers(self, mapped):
        return self._upsert('res.partner', mapped)

    def _apply_products(self, mapped):
        taxes = self._tax_index()

        def tax(vals):
            pct = round(vals.get('fs_tax_pct') or 0.0, 4)
            tax_id = taxes.get(pct)
            if tax_id:
                return {'taxes_id': [(6, 0, [tax_id])]}
            # منتجٌ معفى/صفري بلا ضريبة صفرية في Odoo: بلا ضريبة لا ضريبة الشركة الافتراضية (١٥٪)
            return {'taxes_id': [(5, 0, 0)]} if pct == 0 else {}

        return self._upsert('product.template', mapped, extra=tax)

    def _apply_receipts(self, mapped):
        partners = self._partner_index()
        moves = self._move_index([fid for vals in mapped for fid in vals.get('fs_invoice_ids') or []])

        def link(vals):
            fs_invoice_ids = vals.pop('fs_invoice_ids', None) or []
            partner_id = partners.get(vals.get('fs_customer_id'))
            if not partner_id:
                raise ValueError('العميل غير مُزامَن بعد — زامن العملاء أولاً')
            return {
                'partner_id': partner_id,
                'invoice_ids': [(6, 0, [moves[f] for f in fs_invoice_ids if f in moves])],
            }

        return self._upsert('fieldsales.receipt', mapped, extra=link)

    def _partner_index(self):
        """خريطة fs_id ⇒ معرّف Odoo، بقراءة واحدة بدل بحث لكل صفّ (والمؤرشف معها)."""
        partners = self.env['res.partner'].sudo().with_context(active_test=False).search([('fs_id', '!=', False)])
        return {p.fs_id: p.id for p in partners}

    def _product_index(self):
        products = self.env['product.product'].sudo().with_context(active_test=False).search([('fs_id', '!=', False)])
        return {p.fs_id: p.id for p in products}

    def _move_index(self, fs_ids):
        if not fs_ids:
            return {}
        moves = self.env['account.move'].sudo().search([('fs_id', 'in', list(set(fs_ids)))])
        return {m.fs_id: m.id for m in moves}

    def _apply_invoices(self, mapped):
        """ينشئ الفواتير مسودّةً فقط، ويلغي مسودّة ما أُلغي في Field Sales.

        الفاتورة المُرحَّلة (posted) لا تُحدَّث ولا تُلغى — تخطّيها مقصود: الكتابة فوق
        قيد محاسبي مُرحَّل تغيير للدفاتر بلا أثر تدقيقي. وبعد كل إنشاء أو تحديث يُطابَق
        الإجمالي بإجمالي Field Sales (`_match_total`).
        """
        Move = self.env['account.move'].sudo()
        partners = self._partner_index()
        products = self._product_index()
        taxes = self._tax_index()
        created = updated = 0
        errors = []

        for vals in mapped:
            fs_id = vals.get('fs_id')
            try:
                with self.env.cr.savepoint():
                    move = Move.search([('fs_id', '=', fs_id)], limit=1)
                    fs_vals = {'fs_total': vals['fs_total'], 'fs_tax_amt': vals['fs_tax_amt'], 'fs_status': vals['fs_status']}

                    # ملغاة في Field Sales: لا تُنشأ، ومسودّتها تُلغى، والمرحّلة تُترك مع خطأ واضح
                    if vals.get('fs_cancelled'):
                        if not move or move.state == 'cancel':
                            if move:
                                move.write(fs_vals)
                            continue
                        if move.state != 'draft':
                            errors.append({'id': fs_id, 'error': 'أُلغيت في Field Sales وهي مُرحَّلة في Odoo — اعكسها بإشعار دائن'})
                            continue
                        move.write(fs_vals)
                        move.button_cancel()
                        updated += 1
                        continue

                    partner_id = partners.get(vals.get('fs_customer_id'))
                    if not partner_id:
                        errors.append({'id': fs_id, 'error': 'العميل غير مُزامَن بعد — زامن العملاء أولاً'})
                        continue

                    lines = []
                    for line in vals.get('fs_lines', []):
                        line_vals = {
                            'name': line['name'],
                            'quantity': line['quantity'],
                            'price_unit': line['price_unit'],
                            'discount': line['discount'],
                        }
                        product_id = products.get(line.get('fs_product_id'))
                        if product_id:
                            line_vals['product_id'] = product_id
                        tax_id = taxes.get(round(line.get('fs_tax_pct') or 0.0, 4))
                        # ضريبة بلا مقابل في Odoo: بلا ضريبة بدل اختيار ضريبة قريبة — والفرق
                        # يظهر في fs_total_diff للمراجعة
                        line_vals['tax_ids'] = [(6, 0, [tax_id])] if tax_id else [(5, 0, 0)]
                        lines.append((0, 0, line_vals))

                    header = {
                        'partner_id': partner_id,
                        'ref': vals['ref'],
                        'invoice_date': vals['invoice_date'],
                        'invoice_date_due': vals['invoice_date_due'],
                        'narration': vals['narration'],
                    }
                    if move:
                        if move.state == 'cancel':
                            move.button_draft()  # أُعيد تفعيلها في Field Sales
                        if move.state != 'draft':
                            errors.append({'id': fs_id, 'error': 'الفاتورة مُرحَّلة في Odoo — لم تُحدَّث'})
                            continue
                        move.write(dict(header, **fs_vals, invoice_line_ids=[(5, 0, 0)] + lines))
                        updated += 1
                    else:
                        move = Move.create(dict(header, **fs_vals, move_type=vals['move_type'], fs_id=fs_id,
                                                invoice_line_ids=lines))
                        created += 1
                    self._match_total(move, vals['fs_total'])
            except Exception as exc:  # noqa: BLE001
                _logger.warning('Field Sales invoice failed for %s: %s', fs_id, exc)
                errors.append({'id': fs_id, 'error': str(exc)[:200]})
        return created, updated, errors

    def _match_total(self, move, fs_total):
        """يطابق إجمالي المسودّة بإجمالي Field Sales.

        Odoo يقرّب السعر والخصم إلى خانتين ويحسب الضريبة فوقهما، وField Sales يوزّع الضريبة
        والخصم الكلّي بالهللة — فقد يختلف الإجماليان بهللات. الفرق حتى ROUNDING_TOLERANCE
        يُسوّى بسطر «فرق تقريب» بلا ضريبة فيطابق الإجمالي حرفياً؛ وما فوقه يُترك ظاهراً في
        fs_total_diff (فرقٌ حقيقي: ضريبة بلا مقابل في Odoo مثلاً) ولا يُخفى.
        """
        currency = move.currency_id
        diff = currency.round(fs_total - move.amount_total)
        if diff and abs(diff) <= ROUNDING_TOLERANCE:
            move.write({'invoice_line_ids': [(0, 0, {
                'name': 'فرق تقريب Field Sales',
                'quantity': 1.0,
                'price_unit': diff,
                'tax_ids': [(5, 0, 0)],
            })]})
            diff = currency.round(fs_total - move.amount_total)
        move.fs_total_diff = diff

    def _tax_index(self):
        """خريطة نسبة ⇒ ضريبة بيع غير شاملة في شركة الربط.

        المطابقة بالنسبة لا بالاسم: الأسماء تختلف بين التنصيبات واللغات، أما ١٥٪ فهي ١٥٪ في
        كل تنصيب. والشاملة تُستبعد: السعر المُرسَل صافٍ قبل الضريبة دائماً.
        """
        taxes = self.env['account.tax'].sudo().search([
            ('type_tax_use', '=', 'sale'),
            ('amount_type', '=', 'percent'),
            ('company_id', '=', self.env.company.id),
        ], order='sequence, id')
        index = {}
        for tax in taxes:
            if getattr(tax, 'price_include', False):
                continue
            index.setdefault(round(tax.amount, 4), tax.id)
        return index


class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    fs_api_key = fields.Char(
        string='Field Sales API key',
        config_parameter=API_KEY_PARAM,
        help='Paste this key into Field Sales → Settings → ERP integration.',
    )

    def action_fs_generate_key(self):
        self.ensure_one()
        if not self.env.user.has_group('base.group_system'):
            raise UserError(_('Only a system administrator can regenerate the API key.'))
        key = self.env['fieldsales.connector']._generate_api_key()
        self.fs_api_key = key
        return {'type': 'ir.actions.client', 'tag': 'reload'}
