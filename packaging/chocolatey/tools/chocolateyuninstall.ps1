$ErrorActionPreference = 'Stop'

# NSIS يسجّل مزيل تثبيت في سجلّ ويندوز؛ نعثر عليه بالاسم المعروض بدل مسار مكتوب بيد.
$key = Get-UninstallRegistryKey -SoftwareName 'FieldSales Admin*'

if ($key.Count -eq 1) {
  $key | ForEach-Object {
    Uninstall-ChocolateyPackage -PackageName 'fieldsales-admin' `
      -FileType 'EXE' -SilentArgs '/S' -File $_.UninstallString.Trim('"')
  }
} elseif ($key.Count -eq 0) {
  Write-Warning 'FieldSales Admin غير مثبّت — لا شيء لإزالته.'
} else {
  Write-Warning "وُجد $($key.Count) تطابقاً. أزِلها يدوياً:"
  $key | ForEach-Object { Write-Warning "  $($_.DisplayName)" }
}
