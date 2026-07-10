Pod::Spec.new do |s|
  s.name           = 'PttChannel'
  s.version        = '1.0.0'
  s.summary        = 'Apple PushToTalk (PTChannelManager) bridge for background PTT'
  s.description    = 'Small Expo module wrapping the PushToTalk framework for pocket/background PTT.'
  s.author         = ''
  s.homepage       = 'https://github.com/tomyorts/mirise'
  s.platforms      = { :ios => '16.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
