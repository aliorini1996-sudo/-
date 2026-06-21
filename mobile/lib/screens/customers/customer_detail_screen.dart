import 'package:flutter/material.dart';
import '../../utils/format.dart';
import '../../services/api_service.dart';
import '../invoices/create_invoice_screen.dart';
import '../receipts/create_receipt_screen.dart';

class CustomerDetailScreen extends StatefulWidget {
  final Map<String, dynamic> customer;
  const CustomerDetailScreen({super.key, required this.customer});

  @override
  State<CustomerDetailScreen> createState() => _CustomerDetailScreenState();
}

class _CustomerDetailScreenState extends State<CustomerDetailScreen> with SingleTickerProviderStateMixin {
  late TabController _tabs;
  List<Map<String, dynamic>> _statement = [];
  bool _loadingStatement = false;

  @override
  void initState() {
    super.initState();
    _tabs = TabController(length: 2, vsync: this);
    _loadStatement();
  }

  Future<void> _loadStatement() async {
    setState(() => _loadingStatement = true);
    try {
      final res = await ApiService.get('/customers/${widget.customer['id']}/statement');
      setState(() => _statement = (res['data']['entries'] as List).cast<Map<String, dynamic>>());
    } catch (_) {}
    if (mounted) setState(() => _loadingStatement = false);
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.customer;
    final balance = c['balance'] as num;
    final creditLimit = c['creditLimit'] as num;

    return Scaffold(
      appBar: AppBar(title: Text(c['name'] as String)),
      body: Column(
        children: [
          // Summary Card
          Container(
            margin: const EdgeInsets.all(16),
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              gradient: const LinearGradient(colors: [Color(0xFF1E3A8A), Color(0xFF2563EB)]),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(c['name'] as String, style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold)),
                      if (c['businessName'] != null) Text(c['businessName'] as String, style: const TextStyle(color: Colors.white70, fontSize: 14)),
                      Text(c['phone'] as String, style: const TextStyle(color: Colors.white70, fontSize: 13)),
                    ])),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                      decoration: BoxDecoration(color: Colors.white.withOpacity(0.2), borderRadius: BorderRadius.circular(8)),
                      child: Text(c['status'] == 'ACTIVE' ? 'نشط' : 'غير نشط', style: const TextStyle(color: Colors.white, fontSize: 12)),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(child: _statItem('الرصيد', formatCurrency(balance), balance > 0 ? Colors.redAccent : Colors.greenAccent)),
                    Expanded(child: _statItem('الحد الائتماني', formatCurrency(creditLimit), Colors.white70)),
                    Expanded(child: _statItem('فترة السداد', '${c['paymentDays']} يوم', Colors.white70)),
                  ],
                ),
              ],
            ),
          ),

          // Actions
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Expanded(child: ElevatedButton.icon(
                  icon: const Icon(Icons.receipt_long, size: 18),
                  label: const Text('فاتورة جديدة'),
                  onPressed: () => Navigator.push(context, MaterialPageRoute(
                    builder: (_) => CreateInvoiceScreen(customer: c),
                  )),
                )),
                const SizedBox(width: 12),
                Expanded(child: ElevatedButton.icon(
                  style: ElevatedButton.styleFrom(backgroundColor: Colors.green),
                  icon: const Icon(Icons.payment, size: 18),
                  label: const Text('سند قبض'),
                  onPressed: () => Navigator.push(context, MaterialPageRoute(
                    builder: (_) => CreateReceiptScreen(customer: c),
                  )),
                )),
              ],
            ),
          ),
          const SizedBox(height: 12),

          // Tabs
          TabBar(
            controller: _tabs,
            tabs: const [Tab(text: 'كشف الحساب'), Tab(text: 'معلومات')],
          ),
          Expanded(
            child: TabBarView(
              controller: _tabs,
              children: [
                // Statement
                _loadingStatement
                    ? const Center(child: CircularProgressIndicator())
                    : _statement.isEmpty
                        ? const Center(child: Text('لا توجد حركات', style: TextStyle(color: Colors.grey)))
                        : ListView.builder(
                            padding: const EdgeInsets.all(12),
                            itemCount: _statement.length,
                            itemBuilder: (ctx, i) {
                              final e = _statement[i];
                              final isDebit = (e['debit'] as num) > 0;
                              return Card(
                                child: ListTile(
                                  dense: true,
                                  leading: Icon(isDebit ? Icons.arrow_upward : Icons.arrow_downward,
                                    color: isDebit ? Colors.red : Colors.green, size: 20),
                                  title: Text(e['description'] as String, style: const TextStyle(fontSize: 13)),
                                  subtitle: Text(formatDate(e['entryDate'] as String?), style: const TextStyle(fontSize: 11)),
                                  trailing: Column(
                                    mainAxisAlignment: MainAxisAlignment.center,
                                    crossAxisAlignment: CrossAxisAlignment.end,
                                    children: [
                                      Text(isDebit ? formatCurrency(e['debit']) : formatCurrency(e['credit']),
                                        style: TextStyle(color: isDebit ? Colors.red : Colors.green, fontWeight: FontWeight.bold, fontSize: 12)),
                                      Text('رصيد: ${formatCurrency(e['balance'])}', style: const TextStyle(fontSize: 10, color: Colors.grey)),
                                    ],
                                  ),
                                ),
                              );
                            },
                          ),

                // Info
                ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    _infoRow('رقم العميل', c['code'] as String?),
                    _infoRow('الجوال', c['phone'] as String?),
                    _infoRow('البريد', c['email'] as String?),
                    _infoRow('المدينة', c['city'] as String?),
                    _infoRow('الحي', c['district'] as String?),
                    _infoRow('العنوان', c['address'] as String?),
                    _infoRow('السجل التجاري', c['commercialReg'] as String?),
                    _infoRow('الرقم الضريبي', c['taxNumber'] as String?),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _statItem(String label, String value, Color color) {
    return Column(children: [
      Text(value, style: TextStyle(color: color, fontWeight: FontWeight.bold, fontSize: 14)),
      Text(label, style: const TextStyle(color: Colors.white54, fontSize: 11)),
    ]);
  }

  Widget _infoRow(String label, String? value) {
    if (value == null || value.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          SizedBox(width: 120, child: Text(label, style: const TextStyle(color: Colors.grey, fontSize: 13))),
          Expanded(child: Text(value, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500))),
        ],
      ),
    );
  }
}
