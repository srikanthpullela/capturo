# Capturo

Capturo is a desktop screenshot beautifier built with Tauri, React, and TypeScript. It can capture screenshots, add annotations, apply presentation styling, copy the final image, save locally, and keep running quietly from the menu bar/system tray.

## Download installers

GitHub Actions builds installers for macOS and Windows.

- Every push to `main` creates downloadable workflow artifacts.
- Every tag that starts with `v`, such as `v1.0.0`, publishes the installers to a GitHub Release.

## Development

```sh
npm install
npm run tauri dev
```

## Build locally

```sh
npm run tauri build
```

The app version and bundle settings live in [src-tauri/tauri.conf.json](src-tauri/tauri.conf.json).
