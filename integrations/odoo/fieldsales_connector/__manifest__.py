{
    'name': 'Field Sales Connector',
    'version': '17.0.1.0.0',
    'summary': 'Receive customers, products, invoices and receipts from Field Sales '
               '(field sales & distribution platform for Arab markets).',
    'description': """
Field Sales Connector
=====================

Receives data pushed by `Field Sales <https://fieldsa.net>`_ — a field sales and
distribution platform used by wholesalers and FMCG distributors in Arab markets —
and creates the matching records in Odoo.

What it does
------------
* Exposes one authenticated endpoint that Field Sales pushes to.
* Upserts **customers** into ``res.partner`` and **products** into ``product.template``.
* Creates **invoices** in ``account.move`` as **drafts only** — never posted.
* Records **receipts** in a dedicated model for the accountant to review.
* Logs every sync with per-row errors, so a single bad row never hides.

What it deliberately does NOT do
--------------------------------
* It never posts an invoice. Posting creates accounting entries and is the
  accountant's decision, not an automatic sync's.
* It never creates payments. A payment needs a journal and an account; choosing
  them automatically produces entries in the wrong accounts.
* It never overwrites customer balances or totals. Odoo computes those from its
  own entries; copying them in produces two conflicting numbers per customer.

Setup
-----
1. Install this module.
2. Go to **Settings → Field Sales Connector**, generate an API key and copy the
   endpoint URL.
3. In Field Sales: **Settings → ERP integration**, set provider to *Odoo*, paste
   the URL and the key, choose ``API_KEY`` as the auth type.
""",
    'author': 'Field Sales',
    'website': 'https://fieldsa.net',
    'license': 'LGPL-3',
    'category': 'Sales',
    'depends': ['base', 'account', 'product'],
    'data': [
        'security/ir.model.access.csv',
        'views/receipt_views.xml',
        'views/log_views.xml',
        'views/settings_views.xml',
    ],
    'installable': True,
    'application': False,
}
