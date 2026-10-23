//! `quadflow-cli`: the `quadflow` command tree without the GUI. Identical to running the app exe
//! with a subcommand (src-tauri/src/main.rs); used by repo tooling such as scripts/release.mjs.

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    let mut io = quadflow_core::cli::Io::std();
    let env = quadflow_core::cli::CliEnv::from_process();
    std::process::exit(quadflow_core::cli::run(args, &mut io, &env));
}
