import 'package:intl/intl.dart';

String formatCurrency(dynamic amount) {
  final n = double.tryParse(amount.toString()) ?? 0;
  return NumberFormat.currency(locale: 'ar_SA', symbol: 'ر.س', decimalDigits: 2).format(n);
}

String formatDate(String? dateStr) {
  if (dateStr == null) return '';
  return DateFormat('yyyy/MM/dd', 'ar').format(DateTime.parse(dateStr));
}

String formatDateTime(String? dateStr) {
  if (dateStr == null) return '';
  return DateFormat('yyyy/MM/dd hh:mm a', 'ar').format(DateTime.parse(dateStr).toLocal());
}
