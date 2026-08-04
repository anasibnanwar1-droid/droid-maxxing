{
  "targets": [
    {
      "target_name": "sparkle_updater",
      "sources": ["src/sparkle_updater.mm"],
      "defines": ["NAPI_VERSION=8"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++20",
        "MACOSX_DEPLOYMENT_TARGET": "11.0",
        "OTHER_LDFLAGS": ["-framework Foundation", "-framework AppKit"]
      }
    }
  ]
}
