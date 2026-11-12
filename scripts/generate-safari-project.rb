require 'xcodeproj'
require 'pathname'

root = File.expand_path(ARGV.fetch(0))
bundle_id = ENV.fetch('SAFARI_BUNDLE_ID', 'dev.arcjapanese.listening')
abort 'Use a reverse-domain bundle identifier.' unless bundle_id.match?(/\A[a-zA-Z][a-zA-Z0-9-]*(\.[a-zA-Z0-9-]+)+\z/)
path = File.join(root, 'JapaneseListening.xcodeproj')
project = Xcodeproj::Project.new(path)
app = project.new_target(:application, 'JapaneseListening', :ios, '17.0')
extension = project.new_target(:app_extension, 'JapaneseListeningExtension', :ios, '17.0')

[[app, 'App', bundle_id], [extension, 'Extension', bundle_id + '.Extension']].each do |target, folder, identifier|
  group = project.main_group.new_group(folder, folder)
  Dir.glob(File.join(root, folder, '*.swift')).sort.each do |file|
    target.source_build_phase.add_file_reference(group.new_file(File.basename(file)))
  end
  group.new_file('Info.plist')
  target.build_configurations.each do |config|
    config.build_settings.merge!({
      'SWIFT_VERSION' => '5.0', 'CODE_SIGN_STYLE' => 'Automatic',
      'DEVELOPMENT_TEAM' => ENV.fetch('APPLE_DEVELOPMENT_TEAM', ''),
      'PRODUCT_BUNDLE_IDENTIFIER' => identifier, 'INFOPLIST_FILE' => folder + '/Info.plist',
      'GENERATE_INFOPLIST_FILE' => 'NO', 'TARGETED_DEVICE_FAMILY' => '2',
      'SUPPORTED_PLATFORMS' => 'iphoneos iphonesimulator', 'SDKROOT' => 'iphoneos',
      'IPHONEOS_DEPLOYMENT_TARGET' => '17.0', 'CURRENT_PROJECT_VERSION' => '1',
      'MARKETING_VERSION' => '1.0.0',
      'LD_RUNPATH_SEARCH_PATHS' => ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
    })
  end
end
extension.build_configurations.each do |config|
  config.build_settings['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  config.build_settings['SKIP_INSTALL'] = 'YES'
end
resources = project.main_group.new_group('WebExtension', 'WebExtension')
Dir.children(File.join(root, 'WebExtension')).sort.each do |name|
  reference = resources.new_file(name)
  reference.last_known_file_type = 'folder' if File.directory?(File.join(root, 'WebExtension', name))
  extension.resources_build_phase.add_file_reference(reference)
end
app.add_dependency(extension)
embed = app.new_copy_files_build_phase('Embed App Extensions')
embed.dst_subfolder_spec = '13'
embed.add_file_reference(extension.product_reference).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.set_launch_target(app)
scheme.save_as(project.path, 'JapaneseListening', true)
puts "Xcode project ready: #{path}"
