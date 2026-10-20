# Integration artwork

## BigBrain

`bigbrain-mark.png` is an unmodified copy of the official static
[`brand/social/avatar-light.png`](https://github.com/elsehow/bigbrain/blob/cb61ea00bf9b85cb4cea1c8717cedfb0a40896ed/brand/social/avatar-light.png)
at `elsehow/bigbrain@cb61ea00bf9b85cb4cea1c8717cedfb0a40896ed` (upstream main
checked 2026-10-20), replacing the older multicolor email mark.

Upstream's [`brand/social/README.md`](https://github.com/elsehow/bigbrain/blob/cb61ea00bf9b85cb4cea1c8717cedfb0a40896ed/brand/social/README.md)
identifies it as the actual cube avatar in the Light palette. Its opaque light
background is part of the official artwork and keeps the mark visible on both
light and dark cards. The image is rendered decoratively beside the accessible
BigBrain card label; no animated mark code or external image request is used.

- Format: static PNG, 1024 × 1024 (rendered at 32 × 32 CSS pixels)
- SHA-256: `aaa4ec568b3b81697482963b2961db2f812a2a97b1a79606915ab2fb8f71c0d9`
- Source license: AGPL-3.0-only, as declared by upstream's root `LICENSE` and
  `package.json` at that revision. BigBrain branding remains its owner's mark;
  inclusion identifies the integration and does not imply endorsement.

`IntegrationLogo.test.tsx` pins the exact reviewed PNG bytes. Recheck the
upstream asset, license and light/dark/mobile presentation before updating it.
