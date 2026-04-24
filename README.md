# MatrixRustRnPoc

React Native proof-of-concept for a Matrix mobile client backed by `matrix-rust-sdk`.

This POC is intended as a reference implementation for a production React Native app that:

- logs into Synapse directly
- restores Matrix sessions locally
- starts the Rust SDK sync service
- lists rooms and opens timelines
- sends text messages
- uploads files and images
- downloads media from Matrix content URIs
- joins and opens bridge-backed rooms created by `mautrix-whatsapp` and `postmoogle`

## What this POC demonstrates

The app talks to Synapse as a normal Matrix client. WhatsApp and email channels are not handled with custom mobile code paths. If the bridges are already connected to Synapse, those conversations appear as normal Matrix rooms and can be joined with a room alias or room ID.

## Stack

- React Native `0.76.9`
- `@unomed/react-native-matrix-sdk`
- `@react-native-async-storage/async-storage`
- `react-native-document-picker`
- `react-native-fs`

## Local setup

1. Install system prerequisites that are not currently installed on this Windows machine:
   - Rust toolchain
   - JDK 17+
   - Android Studio with Android SDK / emulator
   - Xcode if your teammate wants to run iOS from macOS
2. Start Synapse and your bridges.
3. Update the default homeserver URL in [App.tsx](C:/Users/Admin/Desktop/MatrixRustRnPoc/App.tsx) if `http://10.0.2.2:8008` is not correct for your emulator/device setup.
4. Install CocoaPods on macOS before building iOS.

## Run

```bash
npm install
npm run start
npm run android
```

## POC flow

1. Log in with a Matrix user provisioned on Synapse.
2. Wait for the sync service to load your rooms.
3. Open a room to attach a live timeline listener.
4. Send text or upload a file/image from the composer.
5. Download media by tapping the message action.
6. Join a bridged WhatsApp or email room by Matrix alias or room ID.

## Notes for production follow-up

- This POC keeps the UI in JavaScript and uses the Rust SDK only for Matrix protocol/state work.
- Session persistence is stored in AsyncStorage, while SDK data/cache paths live under the app document directory.
- The room list is refreshed on an interval for simplicity. A production app should deepen room list subscriptions and move more list/state modeling behind native-side abstractions where appropriate.
- The bridge join box assumes the bridge has already created or exposed the target Matrix rooms.
