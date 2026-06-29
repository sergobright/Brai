# Android / Web / OTA Release Checklist

- [ ] Confirm whether the change is web/OTA-only or requires APK.
- [ ] Confirm public version bump rules for `X.Y.Z.S`.
- [ ] Run client lint/tests/build.
- [ ] Verify OTA manifest metadata when publishing OTA.
- [ ] For Preview native-boundary changes, verify exact `minApkVersionCode` and `maxApkVersionCode`.
- [ ] For preview native-boundary changes, verify slot APK file and `versionCode` are recorded.
- [ ] Verify APK signing env is external when building APK.
- [ ] Confirm no generated artifacts or signing files are staged.
