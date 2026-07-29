"""طبقة Odoo: الحقول المضافة، سجلّ المزامنة، ومحرّك الترحيل.

منطق التخطيط كلّه في mapping.py (بلا odoo، مختبَر). هنا القراءة والكتابة فقط.
"""
import logging
import secrets

from odoo import api, fields, models, _
from odoo.exceptions import UserError

from ..mapping import validate_payload, map_all

_logger = logging.getLogger(__name__)

# اسم المَعلمة التي تحمل مفتاح API في ir.config_parameter
API_KEY_PARAM = 'fieldsales_connector.api_key'


class ResPartner(models.Model):
    _inherit = 'res.partner'

    # فهرس لأن كل مزامنة تبحث بهذا الحقل ٥٠٠ مرّة
    fs_id = fields.Char(string='Field Sales ID', index=True, copy=False)


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    fs_id = fields.Char(string='Field Sales ID', index=True, copy=False)
    fs_tax_pct = fields.Float(string='Field Sales tax %', copy=False)
    fs_unit = fields.Char(string='Field Sales unit', copy=False)


class AccountMove(models.Model):
    _inherit = 'account.move'

    fs_id = fields.Char(string='Field Sales ID', index=True, copy=False)


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
        """يُرحّل حمولة كاملة ويُعيد ملخّصاً. يفترض أن المفتاح تُحقّق منه."""
        resource, data = validate_payload(payload)
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
            # ٢٠ خطأً تكفي للتشخيص؛ تخزين ٥٠٠ يُثقل السجلّ بلا فائدة
            'errors': '\n'.join('%s: %s' % (e.get('id'), e.get('error')) for e in errors[:20]) or False,
            'exported_at': payload.get('exportedAt'),
        })
        return {
            'ok': True, 'resource': resource, 'received': len(data),
            'created': created, 'updated': updated, 'errors': len(errors),
        }

    def _upsert(self, model, vals_list, extra=None):
        """يبحث بـfs_id ثم يُنشئ أو يُحدّث. يُعيد (منشأ، محدَّث، أخطاء).

        البحث بـfs_id لا بالكود: الكود قابل للتعديل من لوحة Field Sales،
        فالمطابقة به تُنشئ سجلاً جديداً كلّما عدّل المستخدم كوداً.
        """
        Model = self.env[model].sudo()
        created = updated = 0
        errors = []
        for vals in vals_list:
            vals = dict(vals)
            fs_id = vals.get('fs_id')
            if not fs_id:
                errors.append({'id': None, 'error': 'صفّ بلا معرّف Field Sales'})
                continue
            if extra:
                vals.update(extra(vals))
            try:
                # savepoint لكل صفّ: خطأ قيد فريد في صفّ لا يُبطل الـ٤٩٩ الباقية
                with self.env.cr.savepoint():
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
        return self._upsert('product.template', mapped)

    def _apply_receipts(self, mapped):
        partners = self._partner_index()

        def link(vals):
            return {'partner_id': partners.get(vals.get('fs_customer_id'), False)}

        return self._upsert('fieldsales.receipt', mapped, extra=link)

    def _partner_index(self):
        """خريطة fs_id ⇒ معرّف Odoo، بقراءة واحدة بدل بحث لكل صفّ."""
        partners = self.env['res.partner'].sudo().search([('fs_id', '!=', False)])
        return {p.fs_id: p.id for p in partners}

    def _product_index(self):
        products = self.env['product.product'].sudo().search([('fs_id', '!=', False)])
        return {p.fs_id: p.id for p in products}

    def _apply_invoices(self, mapped):
        """ينشئ الفواتير مسودّةً فقط.

        الفاتورة المُرحَّلة (posted) لا تُحدَّث — تخطّيها مقصود: الكتابة فوق
        قيد محاسبي مُرحَّل تغيير للدفاتر بلا أثر تدقيقي.
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
                        # ضريبة بلا مقابل في Odoo: نتركها بلا ضريبة بدل اختيار
                        # ضريبة قريبة — الإجمالي الأصلي محفوظ في fs_total للمقارنة
                        line_vals['tax_ids'] = [(6, 0, [tax_id])] if tax_id else [(5, 0, 0)]
                        lines.append((0, 0, line_vals))

                    move = Move.search([('fs_id', '=', fs_id)], limit=1)
                    if move:
                        if move.state != 'draft':
                            errors.append({'id': fs_id, 'error': 'الفاتورة مُرحَّلة في Odoo — لم تُحدَّث'})
                            continue
                        move.write({
                            'partner_id': partner_id,
                            'ref': vals['ref'],
                            'invoice_date': vals['invoice_date'],
                            'invoice_date_due': vals['invoice_date_due'],
                            'narration': vals['narration'],
                            'invoice_line_ids': [(5, 0, 0)] + lines,
                        })
                        updated += 1
                    else:
                        Move.create({
                            'move_type': vals['move_type'],
                            'partner_id': partner_id,
                            'ref': vals['ref'],
                            'invoice_date': vals['invoice_date'],
                            'invoice_date_due': vals['invoice_date_due'],
                            'narration': vals['narration'],
                            'fs_id': fs_id,
                            'invoice_line_ids': lines,
                        })
                        created += 1
            except Exception as exc:  # noqa: BLE001
                _logger.warning('Field Sales invoice failed for %s: %s', fs_id, exc)
                errors.append({'id': fs_id, 'error': str(exc)[:200]})
        return created, updated, errors

    def _tax_index(self):
        """خريطة نسبة ⇒ ضريبة بيع في شركة المستخدم.

        المطابقة بالنسبة لا بالاسم: الأسماء تختلف بين التنصيبات واللغات،
        أما ١٥٪ فهي ١٥٪ في كل تنصيب.
        """
        taxes = self.env['account.tax'].sudo().search([
            ('type_tax_use', '=', 'sale'),
            ('amount_type', '=', 'percent'),
            ('company_id', '=', self.env.company.id),
        ])
        index = {}
        for tax in taxes:
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
