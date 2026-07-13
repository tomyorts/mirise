Pod::Spec.new do |s|
  s.name           = 'PttChannel'
  s.version        = '1.0.0'
  s.summary        = 'Apple PushToTalk (PTChannelManager) bridge for background PTT'
  s.description    = 'Small Expo module wrapping the PushToTalk framework for pocket/background PTT.'
  s.author         = ''
  s.homepage       = 'https://github.com/tomyorts/mirise'
  # アプリ本体(15.1)と揃える。16.0にすると autolinking がモジュールを除外し、
  # requireNativeModule が null になる。iOS16専用APIは @available で実行時保護済み。
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # PushToTalk(iOS16+)を強制リンクする。弱リンクではモジュールが実行時に読み込めず
  # requireNativeModule が null を返していたため、OTHER_LDFLAGS で確実にリンクする。
  s.frameworks = 'PushToTalk'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'OTHER_LDFLAGS' => '-framework PushToTalk'
  }
  s.user_target_xcconfig = {
    'OTHER_LDFLAGS' => '-framework PushToTalk'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
