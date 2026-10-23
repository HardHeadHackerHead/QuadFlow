//! Per-shell command lines (agent-providers.md §4.1 `command_line`).
//!
//! Quoting is only safe because every argv element is first re-validated
//! against the launch safe charset (no quotes, `$`, `;`, whitespace, …) and the
//! program path against a deny list; anything else is rejected, never escaped.

use super::spec::is_safe_arg;
use crate::error::{CoreError, Result};

use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShellKind {
    Cmd,
    PowerShell,
    Pwsh,
    Bash,
    Zsh,
    Sh,
    Fish,
}

impl ShellKind {
    /// From a terminal's `shell` option (`"cmd"`, `"powershell"`, `"bash"`, … or
    /// an absolute executable path). `None` = the platform default shell.
    pub fn from_shell_option(shell: Option<&str>) -> ShellKind {
        let name = shell
            .map(|s| {
                Path::new(s)
                    .file_stem()
                    .map(|n| n.to_string_lossy().to_lowercase())
                    .unwrap_or_else(|| s.to_lowercase())
            })
            .unwrap_or_default();
        match name.as_str() {
            "cmd" => ShellKind::Cmd,
            "powershell" => ShellKind::PowerShell,
            "pwsh" => ShellKind::Pwsh,
            "bash" => ShellKind::Bash,
            "zsh" => ShellKind::Zsh,
            "sh" | "dash" | "ash" => ShellKind::Sh,
            "fish" => ShellKind::Fish,
            _ => Self::platform_default(),
        }
    }

    /// What a terminal without an explicit shell runs (see `src-tauri/src/terminal.rs`).
    pub fn platform_default() -> ShellKind {
        if cfg!(windows) {
            ShellKind::PowerShell
        } else {
            let shell = std::env::var("SHELL").unwrap_or_default();
            match Path::new(&shell).file_name().and_then(|n| n.to_str()) {
                Some("zsh") => ShellKind::Zsh,
                Some("fish") => ShellKind::Fish,
                Some("sh") => ShellKind::Sh,
                _ => ShellKind::Bash,
            }
        }
    }
}

/// Characters a program path may never contain (§4.1 rule 4).
pub fn program_path_ok(p: &str) -> bool {
    !p.is_empty() && !p.chars().any(|c| c.is_control() || "\"'`$%!;&|<>^".contains(c))
}

/// The line typed into the PTY (caller appends `\r`).
pub fn command_line(shell: ShellKind, program: &Path, argv: &[String]) -> Result<String> {
    let prog = program.to_string_lossy();
    if !program_path_ok(&prog) {
        return Err(CoreError::invalid_input(format!("unsafe agent program path {prog:?}")));
    }
    if let Some(bad) = argv.iter().find(|a| !is_safe_arg(a)) {
        return Err(CoreError::invalid_input(format!("unsafe agent argument {bad:?}")));
    }
    let q = |s: &str| match shell {
        ShellKind::Cmd => format!("\"{s}\""),
        _ => format!("'{s}'"),
    };
    let mut parts = Vec::with_capacity(argv.len() + 2);
    if matches!(shell, ShellKind::PowerShell | ShellKind::Pwsh) {
        parts.push("&".to_string());
    }
    parts.push(q(&prog));
    parts.extend(argv.iter().map(|a| q(a)));
    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn opus_1m_quoted_per_shell() {
        let a = args(&["--model", "opus[1m]"]);
        let p = Path::new("/usr/local/bin/agent");
        for sh in [ShellKind::Bash, ShellKind::Zsh, ShellKind::Sh, ShellKind::Fish] {
            assert_eq!(command_line(sh, p, &a).unwrap(), "'/usr/local/bin/agent' '--model' 'opus[1m]'");
        }
        let w = Path::new(r"C:\Users\me\AppData\Roaming\npm\agent.cmd");
        assert_eq!(
            command_line(ShellKind::PowerShell, w, &a).unwrap(),
            r"& 'C:\Users\me\AppData\Roaming\npm\agent.cmd' '--model' 'opus[1m]'"
        );
        assert_eq!(
            command_line(ShellKind::Pwsh, w, &a).unwrap(),
            r"& 'C:\Users\me\AppData\Roaming\npm\agent.cmd' '--model' 'opus[1m]'"
        );
        assert_eq!(
            command_line(ShellKind::Cmd, w, &a).unwrap(),
            r#""C:\Users\me\AppData\Roaming\npm\agent.cmd" "--model" "opus[1m]""#
        );
    }

    #[test]
    fn program_with_spaces_is_quoted() {
        let p = Path::new(r"C:\Program Files\Agent\agent.exe");
        assert_eq!(command_line(ShellKind::Cmd, p, &[]).unwrap(), r#""C:\Program Files\Agent\agent.exe""#);
    }

    #[test]
    fn injection_rejected() {
        let p = Path::new("agent");
        for bad in ["x; rm -rf ~", "$(whoami)", "`id`", "a\nb", "it's", "say \"hi\"", "a b", "%PATH%", "a&b", "a|b", ""] {
            for sh in [ShellKind::Bash, ShellKind::PowerShell, ShellKind::Cmd] {
                assert!(command_line(sh, p, &args(&["--model", bad])).is_err(), "{sh:?} accepted {bad:?}");
            }
        }
        for bad in ["/bin/a'b", "C:\\x\"y", "a$b", "a%b%", "a;b", "a\rb", "a^b", "a!b"] {
            assert!(command_line(ShellKind::Bash, Path::new(bad), &[]).is_err(), "accepted program {bad:?}");
        }
    }

    #[test]
    fn shell_kind_from_option() {
        assert_eq!(ShellKind::from_shell_option(Some("cmd")), ShellKind::Cmd);
        assert_eq!(ShellKind::from_shell_option(Some("pwsh")), ShellKind::Pwsh);
        assert_eq!(ShellKind::from_shell_option(Some(r"C:\Program Files\Git\bin\bash.exe")), ShellKind::Bash);
        assert_eq!(ShellKind::from_shell_option(Some("/bin/zsh")), ShellKind::Zsh);
        assert_eq!(ShellKind::from_shell_option(None), ShellKind::platform_default());
    }
}
