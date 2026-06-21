import 'package:flutter/material.dart';
import '../../services/api_service.dart';
import '../../utils/format.dart';
import 'create_invoice_screen.dart';

class InvoicesScreen extends StatefulWidget {
  const InvoicesScreen({super.key});

  @override
  State<InvoicesScreen> createState() => _InvoicesScreenState();
}

class _InvoicesScreenState extends State<InvoicesScreen> {
  List<Map<String, dynamic>> _invoices = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final res = await ApiService.get('/invoices', params: {'status': 'CONFIRMED', 'limit': '30'});
      setState(() => _invoices = (res['data'] as List).cast<Map<String, dynamic>>());
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () async {
          await Navigator.push(context, MaterialPageRoute(builder: (_) => const CreateInvoiceScreen()));
          _load();
        },
        icon: const Icon(Icons.add),
        label: const Text('فاتورة جديدة'),
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _invoices.isEmpty
                ? const Center(child: Text('لا توجد فواتير', style: TextStyle(color: Colors.grey)))
                : ListView.builder(
                    padding: const EdgeInsets.all(12),
                    itemCount: _invoices.length,
                    itemBuilder: (ctx, i) {
                      final inv = _invoices[i];
                      final remaining = inv['remainingAmt'] as num;
                      final type = inv['type'] as String;
                      return Card(
                        child: ListTile(
                          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                          title: Row(
                            children: [
                              Text(inv['number'] as String, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
                              const SizedBox(width: 8),
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                decoration: BoxDecoration(
                                  color: type == 'CASH' ? Colors.green.shade50 : Colors.orange.shade50,
                                  borderRadius: BorderRadius.circular(6),
                                ),
                                child: Text(type == 'CASH' ? 'نقدي' : 'آجل',
                                  style: TextStyle(fontSize: 11, color: type == 'CASH' ? Colors.green.shade700 : Colors.orange.shade700)),
                              ),
                            ],
                          ),
                          subtitle: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text((inv['customer'] as Map)['name'] as String, style: const TextStyle(fontWeight: FontWeight.w500)),
                              Text(formatDate(inv['invoiceDate'] as String?), style: const TextStyle(fontSize: 11, color: Colors.grey)),
                            ],
                          ),
                          trailing: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Text(formatCurrency(inv['total']), style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14)),
                              if (remaining > 0)
                                Text('متبقي: ${formatCurrency(remaining)}', style: const TextStyle(color: Colors.red, fontSize: 11)),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
      ),
    );
  }
}
