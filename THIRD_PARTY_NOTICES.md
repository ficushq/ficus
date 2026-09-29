# Third-party notices

Ficus's source license does not replace the licenses of its dependencies. Package distributions retain their own license files.

The browser voice denoiser includes a compiled dependency (DataDog/dtln-rs with TensorFlow Lite, built to WebAssembly). It is built from pinned sources by `apps/web/scripts/dtln/`; its [provenance, component inventory and license texts](apps/web/public/voice/dtln/README.md) are shipped alongside the asset, and `provenance.json` there is verified against the shipped file by a test. The TensorFlow Lite libraries inside it are the prebuilt archive upstream committed; their own build is not reproduced here.

Generated server, CLI, mobile and browser artifacts need a distribution-specific notice inventory before publication. The installed dependency manifest audit is supporting evidence, not that inventory: it includes development dependencies, examples and host-specific optional packages that may not ship.
