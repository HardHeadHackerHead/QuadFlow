//! Build script.
//!
//! Standard `tauri_build::build()` PLUS exposes compile-time constants for
//! crash-report metadata. We capture git SHA + build timestamp + cargo
//! profile + target triple here so they're embedded in the binary and
//! every crash report can attach an exact provenance.
fn main() {
    // Git short SHA. We try `git rev-parse --short HEAD` first; if it fails
    // (sandboxed builds, source tarballs without .git), fall back to the
    // string "unknown" so the diagnostics module always has *something*.
    let git_sha = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok()
            } else {
                None
            }
        })
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "unknown".into());

    // Best-effort dirty flag — non-empty `git status --porcelain` means
    // uncommitted local changes are baked into the binary.
    let git_dirty = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);

    // Wall-clock timestamp at build time. Bypasses cargo's incremental
    // caching (we always re-run when build.rs runs).
    let build_ts = chrono::Utc::now().to_rfc3339();

    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "unknown".into());
    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".into());

    println!("cargo:rustc-env=QUADFLOW_GIT_SHA={git_sha}");
    println!("cargo:rustc-env=QUADFLOW_GIT_DIRTY={git_dirty}");
    println!("cargo:rustc-env=QUADFLOW_BUILD_TIMESTAMP={build_ts}");
    println!("cargo:rustc-env=QUADFLOW_BUILD_PROFILE={profile}");
    println!("cargo:rustc-env=QUADFLOW_BUILD_TARGET={target}");

    // Re-run if HEAD or index change so SHA stays current. The `cargo:rerun`
    // directives narrow the rebuild trigger so we don't always invalidate.
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/index");

    // Integration tests (e.g. tests/export_bindings.rs) link the whole app;
    // tauri-build only embeds the Common Controls v6 manifest into bins, so
    // embed it into test executables too (MSVC linker only).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-test-manifest.xml");
        println!("cargo:rerun-if-changed=windows-test-manifest.xml");
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
    }

    tauri_build::build()
}
