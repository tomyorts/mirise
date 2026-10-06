Pod::Spec.new do |s|
  s.name           = 'BleButton'
  s.version        = '1.0.0'
  s.summary        = 'iTag-style BLE GATT button bridge for lock-screen PTT'
  s.description    = 'Connects to a cheap BLE tag button via CoreBluetooth so presses reach the app even while the phone is locked (unlike HID keyboard remotes).'
  s.author         = ''
  s.homepage       = 'https://github.com/tomyorts/mirise'
  # 重要: アプリ本体(15.1)と揃える。これより高くすると Expo autolinking が
  # モジュールを黙って除外し、requireNativeModule が null になる(PttChannelで実証済み)。
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
