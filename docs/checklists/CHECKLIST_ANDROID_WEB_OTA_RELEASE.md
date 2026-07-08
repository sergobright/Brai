# Android / Web / OTA Release Checklist

- [ ] Confirm whether the change is web/OTA-only or requires APK.
- [ ] If APK is required, follow the canonical shipped APK ledger order in [05-android-web-ota-releases.md](../guidelines/05-android-web-ota-releases.md#shipped-apk-ledger-order).
- [ ] If release/deploy/native-boundary behavior changes, explicitly decide whether compact `logs` writer/fields/test need updating.
- [ ] Run client lint/tests/build.
- [ ] Verify OTA manifest metadata when publishing OTA.
- [ ] For Preview native-boundary changes, verify exact target release key, build kind, stable `N`, and preview `M`.
- [ ] For preview native-boundary changes, verify slot APK file `brai-vN-previewM.apk` and APK `vN` are recorded.
- [ ] Verify APK signing env is external when building APK.
- [ ] Confirm no generated artifacts or signing files are staged.
