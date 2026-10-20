# Integration artwork

## BigBrain

`bigbrain-app-icon.svg` is an unmodified copy of the BigBrain desktop app icon,
[`desktop/icon/app-icon.svg`](https://github.com/elsehow/bigbrain/blob/cb61ea00bf9b85cb4cea1c8717cedfb0a40896ed/desktop/icon/app-icon.svg)
at `elsehow/bigbrain@cb61ea00bf9b85cb4cea1c8717cedfb0a40896ed` (checked
2026-10-20). It replaces the red and white social avatar
(`brand/social/avatar-light.png`) used briefly before.

Upstream's `desktop/icons.sh` renders this SVG into the desktop bundle icons
(`desktop/src-tauri/icons/*.png`, `icon.icns`, `icon.ico`) with `tauri icon`, so
it is the source of the icon people see for the BigBrain app. The tilted
multicolour cube sits on the app's own near-white rounded plate, which keeps it
visible on light and dark cards. The plate is inset inside a transparent margin
(the macOS icon grid), so the card draws the image at 40 × 40 CSS pixels to give
the plate about the same visible size as the other provider logos.

The file was checked before inclusion: it contains only `rect`, `g` and `path`
elements, a `title` and a comment, with no scripts, event handlers, links,
embedded images or external references. It is rendered with `<img>` as a
decorative image beside the accessible BigBrain card label.

- Format: static SVG, 1024 × 1024 viewBox, 1,344 bytes
- SHA-256: `2eed99b8143439599579bec68b620ed53acf48772743f50ac1bf7beacf4f8ae9`
- Source license: AGPL-3.0-only, as declared by upstream's root `LICENSE` and
  `package.json` at that revision. BigBrain branding remains its owner's mark;
  inclusion identifies the integration and does not imply endorsement.

`IntegrationLogo.test.tsx` pins the exact reviewed SVG bytes and rejects active
or external content. Recheck the upstream asset, license and light/dark/mobile
presentation before updating it.
