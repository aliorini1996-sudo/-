$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'fieldsales-admin'
  fileType       = 'EXE'
  url            = 'https://github.com/aliorini1996-sudo/-/releases/download/desktop-v1.0.0/FieldSales-Admin-Setup.exe'
  checksum       = '2503FA377FD122EE3019E93DCCE750746ECB9FEBF8B401E9C28AF090CE18FB18'
  checksumType   = 'sha256'
  # مثبّت NSIS: ‏/S تثبيت صامت، و‏/D يحدّد المجلد ويجب أن يكون الوسيط الأخير وبلا اقتباس
  silentArgs     = '/S'
  validExitCodes = @(0)
  softwareName   = 'FieldSales Admin*'
}

Install-ChocolateyPackage @packageArgs
