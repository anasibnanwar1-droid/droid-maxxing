#include <node_api.h>
#include <objc/message.h>
#include <objc/runtime.h>

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

namespace {

id updaterController = nil;
NSBundle *sparkleFramework = nil;

napi_value throwError(napi_env env, NSString *message) {
  napi_throw_error(env, nullptr, message.UTF8String);
  return nullptr;
}

bool readBoolean(napi_env env, napi_value value, bool fallback) {
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_boolean) return fallback;
  bool result = fallback;
  return napi_get_value_bool(env, value, &result) == napi_ok ? result : fallback;
}

bool loadSparkle(NSString **failure) {
  if (sparkleFramework != nil) return true;
  NSString *frameworksPath = NSBundle.mainBundle.privateFrameworksPath;
  if (frameworksPath == nil) {
    *failure = @"DROIDEX has no private Frameworks directory.";
    return false;
  }
  NSBundle *framework = [NSBundle
      bundleWithPath:[frameworksPath stringByAppendingPathComponent:@"Sparkle.framework"]];
  NSError *error = nil;
  if (framework == nil || ![framework loadAndReturnError:&error]) {
    *failure = error.localizedDescription ?: @"Sparkle.framework could not be loaded.";
    return false;
  }
  sparkleFramework = framework;
  return true;
}

bool ensureUpdater(NSString **failure) {
  if (updaterController != nil) return true;
  if (![NSThread isMainThread]) {
    *failure = @"Sparkle must be initialized on Electron's main thread.";
    return false;
  }
  if (!loadSparkle(failure)) return false;

  Class controllerClass = NSClassFromString(@"SPUStandardUpdaterController");
  if (controllerClass == Nil) {
    *failure = @"Sparkle's updater controller is unavailable.";
    return false;
  }
  id allocated = ((id (*)(id, SEL))objc_msgSend)((id)controllerClass, sel_registerName("alloc"));
  updaterController = ((id (*)(id, SEL, BOOL, id, id))objc_msgSend)(
      allocated,
      sel_registerName("initWithStartingUpdater:updaterDelegate:userDriverDelegate:"),
      NO,
      nil,
      nil);
  if (updaterController == nil) {
    *failure = @"Sparkle's updater controller could not be initialized.";
    return false;
  }
  return true;
}

napi_value checkForUpdates(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t argumentCount = 3;
    napi_value arguments[3];
    if (napi_get_cb_info(env, info, &argumentCount, arguments, nullptr, nullptr) != napi_ok) {
      return throwError(env, @"Sparkle update options could not be read.");
    }
    const bool interactive = argumentCount > 0 ? readBoolean(env, arguments[0], false) : false;
    const bool enableBackgroundChecks =
        argumentCount > 1 ? readBoolean(env, arguments[1], true) : true;
    const bool configureBackgroundChecks =
        argumentCount > 2 ? readBoolean(env, arguments[2], true) : true;

    NSString *failure = nil;
    if (!ensureUpdater(&failure)) return throwError(env, failure);

    id updater = ((id (*)(id, SEL))objc_msgSend)(updaterController, sel_registerName("updater"));
    if (configureBackgroundChecks) {
      ((void (*)(id, SEL, BOOL))objc_msgSend)(
          updater, sel_registerName("setAutomaticallyChecksForUpdates:"), enableBackgroundChecks);
    }
    ((void (*)(id, SEL, BOOL))objc_msgSend)(
        updater, sel_registerName("setAutomaticallyDownloadsUpdates:"), NO);
    ((void (*)(id, SEL))objc_msgSend)(updaterController, sel_registerName("startUpdater"));

    if (interactive) {
      ((void (*)(id, SEL, id))objc_msgSend)(
          updaterController, sel_registerName("checkForUpdates:"), nil);
    } else {
      ((void (*)(id, SEL))objc_msgSend)(updater, sel_registerName("checkForUpdatesInBackground"));
    }

    napi_value result;
    napi_get_undefined(env, &result);
    return result;
  }
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_value check;
  if (napi_create_function(env, "checkForUpdates", NAPI_AUTO_LENGTH, checkForUpdates, nullptr, &check) !=
      napi_ok) {
    return nullptr;
  }
  napi_set_named_property(env, exports, "checkForUpdates", check);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
