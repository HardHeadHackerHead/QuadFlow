// Prevents additional console window on Windows in release, DO NOT REMOVE!!
// CLI-mode invocations (e.g. `quadflow ideas list`) run fine regardless of
// subsystem — parent-provided stdio pipes work for GUI-subsystem exes too.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    // Route to GUI if: no subcommand, or explicit `gui` subcommand.
    let launch_gui = match args.get(1).and_then(|a| a.to_str()) {
        None => args.len() < 2,
        Some("gui") => true,
        Some(_) => false,
    };
    if launch_gui {
        quadflow_tauri_lib::run();
    } else {
        let mut io = quadflow_core::cli::Io::std();
        let env = quadflow_core::cli::CliEnv::from_process();
        std::process::exit(quadflow_core::cli::run(args, &mut io, &env));
    }
}
