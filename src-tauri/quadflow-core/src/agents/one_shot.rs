//! Non-interactive runs (agent-providers.md §8.7): spawn `program + oneShot.args`
//! directly (no shell), write the prompt to stdin, capture stdout (≤ 1 MiB).

use super::detect::{hidden_command, run_capture, AgentDetection, ProcessEnv};
use super::launch::launch_program;
use super::spec::{is_safe_arg, AgentProviderSpec};
use crate::error::{CoreError, Result};
use std::path::Path;
use std::time::Duration;

pub const MAX_STDOUT: usize = 1024 * 1024;
const MAX_PROMPT: usize = 4 * 1024 * 1024;

pub fn one_shot(spec: &AgentProviderSpec, det: &AgentDetection, prompt: &str, cwd: &Path, env: &ProcessEnv) -> Result<String> {
    let os = spec
        .launch
        .one_shot
        .as_ref()
        .ok_or_else(|| CoreError::unsupported(format!("{} has no one-shot mode", spec.display_name)))?;
    if !det.installed {
        return Err(CoreError::unsupported(format!("{} is not installed", spec.display_name)));
    }
    if prompt.len() > MAX_PROMPT {
        return Err(CoreError::invalid_input("one-shot prompt is too large"));
    }
    if let Some(bad) = os.args.iter().find(|a| a.contains('{') || !is_safe_arg(a)) {
        return Err(CoreError::invalid_input(format!("unsupported one-shot argument {bad:?}")));
    }
    if !cwd.is_dir() {
        return Err(CoreError::invalid_input(format!("{} is not a directory", cwd.display())));
    }
    let program = launch_program(spec, det, env)?;
    let mut cmd = hidden_command(&program);
    cmd.args(&os.args).current_dir(cwd).envs(&spec.launch.env);
    let (code, out, err, timed_out) = run_capture(cmd, Some(prompt.as_bytes().to_vec()), Duration::from_millis(os.timeout_ms), MAX_STDOUT)
        .map_err(|e| CoreError::external(format!("failed to run {}: {e}", program.display())))?;
    if timed_out {
        return Err(CoreError::external(format!("{} timed out after {} ms", spec.display_name, os.timeout_ms)));
    }
    if code != Some(0) {
        let tail: String = {
            let s = String::from_utf8_lossy(&err);
            let chars: Vec<char> = s.chars().collect();
            chars[chars.len().saturating_sub(2000)..].iter().collect()
        };
        return Err(CoreError::external(format!(
            "{} exited with {}: {}",
            spec.display_name,
            code.map(|c| c.to_string()).unwrap_or_else(|| "a signal".into()),
            tail.trim()
        )));
    }
    Ok(String::from_utf8_lossy(&out).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::spec::{fixtures, parse_spec};

    /// A fake CLI that echoes stdin back uppercased-ish (via `sort`-free tools).
    fn fake(dir: &Path) -> std::path::PathBuf {
        if cfg!(windows) {
            // `more` copies stdin to stdout; `%*` is ignored.
            let p = dir.join("alpha.cmd");
            std::fs::write(&p, "@echo off\r\nmore\r\n").unwrap();
            p
        } else {
            let p = dir.join("alpha");
            std::fs::write(&p, "#!/bin/sh\ncat\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            p
        }
    }

    #[test]
    fn prompt_goes_through_stdin_not_argv() {
        let tmp = tempfile::tempdir().unwrap();
        let prog = fake(tmp.path());
        let spec = parse_spec(&fixtures::preassign()).unwrap();
        let det = AgentDetection {
            provider_id: "alpha".into(),
            installed: true,
            path: Some(prog.to_string_lossy().to_string()),
            version: None,
            meets_min_version: true,
            error: None,
            checked_at: 0,
        };
        let prompt = "diff: $(rm -rf ~) & \"quotes\" ; `id`";
        let out = one_shot(&spec, &det, prompt, tmp.path(), &ProcessEnv::default()).unwrap();
        assert!(out.contains(prompt), "{out:?}");

        let mut no = spec.clone();
        no.launch.one_shot = None;
        assert!(one_shot(&no, &det, "x", tmp.path(), &ProcessEnv::default()).is_err());
    }
}
