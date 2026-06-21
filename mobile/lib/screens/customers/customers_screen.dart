import 'package:flutter/material.dart';
import '../../services/api_service.dart';
import '../../services/sync_service.dart';
import '../../utils/format.dart';
import 'customer_detail_screen.dart';

class CustomersScreen extends StatefulWidget {
  const CustomersScreen({super.key});

  @override
  State<CustomersScreen> createState() => _CustomersScreenState();
}

class _CustomersScreenState extends State<CustomersScreen> {
  final _searchCtrl = TextEditingController();
  List<Map<String, dynamic>> _customers = [];
  bool _loading = false;
  bool _offline = false;

  @override
  void initState() {
    super.initState();
    _search('');
  }

  Future<void> _search(String q) async {
    setState(() => _loading = true);
    try {
      final res = await ApiService.get('/customers', params: {'search': q, 'limit': '30'});
      setState(() {
        _customers = (res['data'] as List).cast<Map<String, dynamic>>();
        _offline = false;
      });
    } catch (_) {
      final local = await LocalDatabase.searchCustomers(q);
      setState(() { _customers = local; _offline = true; });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        if (_offline)
          Container(
            color: Colors.orange.shade100,
            padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 16),
            child: const Row(
              children: [Icon(Icons.wifi_off, size: 16, color: Colors.orange), SizedBox(width: 8),
                Text('وضع عدم الاتصال - بيانات محلية', style: TextStyle(fontSize: 12, color: Colors.orange))],
            ),
          ),
        Padding(
          padding: const EdgeInsets.all(12),
          child: TextField(
            controller: _searchCtrl,
            onChanged: _search,
            decoration: const InputDecoration(
              hintText: 'بحث عن عميل...',
              prefixIcon: Icon(Icons.search),
              isDense: true,
            ),
          ),
        ),
        Expanded(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : _customers.isEmpty
                  ? const Center(child: Text('لا توجد نتائج', style: TextStyle(color: Colors.grey)))
                  : ListView.builder(
                      itemCount: _customers.length,
                      itemBuilder: (ctx, i) {
                        final c = _customers[i];
                        return ListTile(
                          contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                          leading: CircleAvatar(
                            backgroundColor: Colors.blue.shade100,
                            child: Text((c['name'] as String).substring(0, 1), style: const TextStyle(color: Color(0xFF1E3A8A), fontWeight: FontWeight.bold)),
                          ),
                          title: Text(c['name'] as String, style: const TextStyle(fontWeight: FontWeight.w600)),
                          subtitle: Text('${c['phone']} • ${c['city'] ?? ''}'),
                          trailing: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            crossAxisAlignment: CrossAxisAlignment.end,
                            children: [
                              Text(formatCurrency(c['balance']),
                                style: TextStyle(
                                  color: (c['balance'] as num) > 0 ? Colors.red.shade600 : Colors.green.shade600,
                                  fontWeight: FontWeight.bold,
                                  fontSize: 13,
                                )),
                              const Text('الرصيد', style: TextStyle(fontSize: 10, color: Colors.grey)),
                            ],
                          ),
                          onTap: () => Navigator.push(context, MaterialPageRoute(
                            builder: (_) => CustomerDetailScreen(customer: c),
                          )),
                        );
                      },
                    ),
        ),
      ],
    );
  }
}
