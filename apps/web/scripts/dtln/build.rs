// Replacement for upstream dtln-rs's build.rs, overlaid by the Ficus denoiser
// build (apps/web/scripts/dtln/Dockerfile). Upstream only defines `main` for
// macOS and Windows hosts, so a Linux container cannot build the WebAssembly
// target at all. The logic is upstream's: unpack the prebuilt TensorFlow Lite
// archives that ship in the repository for the target being built, then link
// every static library they contain.

#[cfg(target_os = "windows")]
fn main() {
    // NOP on windows
}

#[cfg(not(target_os = "windows"))]
fn main() {
    use std::{env, process::Command};

    use build_target::Arch;

    let target_arch = build_target::target_arch().unwrap();
    let prebuilt = match target_arch {
        Arch::WASM32 => Some("./tflite/tflite-prebuilt.wasm.tar.bz2"),
        Arch::AARCH64 if cfg!(target_os = "macos") => Some("./tflite/tflite-prebuilt.osx.arm64.tar.bz2"),
        Arch::X86_64 if cfg!(target_os = "macos") => Some("./tflite/tflite-prebuilt.osx.x64.tar.bz2"),
        _ => None,
    };
    match prebuilt {
        Some(archive) => {
            let status = Command::new("tar")
                .arg("-xjf")
                .arg(archive)
                .arg("-C")
                .arg("./tflite/")
                .status()
                .expect("failed to run tar");
            assert!(status.success(), "failed to unpack {archive}");
        }
        None => {
            // No prebuilt for this host/target pair: build TensorFlow Lite with cmake.
            Command::new("cmake")
                .current_dir("tflite")
                .arg(".")
                .arg("-DCMAKE_BUILD_TYPE=Release")
                .status()
                .expect("Failed to run cmake");
        }
    }

    let root_dir = env::var("CARGO_MANIFEST_DIR").unwrap();
    println!("cargo:rustc-link-search=native={}/tflite/lib/", root_dir);

    // Link to all archives in lib directory.
    std::fs::read_dir(format!("{}/tflite/lib", root_dir))
        .unwrap()
        .for_each(|entry| {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|ext| ext == "a") {
                let lib_name = path.file_stem().unwrap().to_str().unwrap();
                if let Some(lib_name) = lib_name.strip_prefix("lib") {
                    println!("cargo:rustc-link-lib=dylib={}", lib_name);
                }
            }
        });
}
