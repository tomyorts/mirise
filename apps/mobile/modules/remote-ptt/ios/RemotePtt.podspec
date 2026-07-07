Pod::Spec.new do |s|
  s.name           = 'RemotePtt'
  s.version        = '1.0.0'
  s.summary        = 'Bluetooth remote command (play/pause) to PTT toggle bridge'
  s.description     = 'Small Expo module that forwards MPRemoteCommandCenter events to JS.'
  s.author         = ''
  s.homepage       = 'https://github.com/tomyorts/mirise'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
