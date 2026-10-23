//! Permission strings (plugin-system.md §11): grammar, risk, human descriptions,
//! diffs and sandbox restrictions. The grammar here and the `permission`
//! pattern in `quadflow-plugin.schema.json` must agree (tested).

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fmt;
use std::str::FromStr;

/// Domains a `data:<domain>:<access>` permission can name.
pub const DATA_DOMAINS: &[&str] = &["ideas", "issues", "plans", "discovery", "scripts", "ship", "chat", "missions"];

/// A validated permission string, e.g. `data:issues:write`, `shell:exec:git`.
/// Ordered and compared by its canonical string.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, specta::Type)]
#[specta(transparent)]
pub struct Permission(String);

/// Parsed form of a [`Permission`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PermissionKind {
    Data { domain: String, write: bool },
    ProjectConfigWrite,
    TerminalSpawn,
    TerminalIo,
    AgentsLaunch,
    AgentsRead,
    Fs { write: bool, scope: FsScope },
    ShellExec { program: String },
    ShellOpenExternal,
    /// `None` = `network:*`.
    Network { host: Option<String>, port: Option<u16> },
    Notifications,
    Clipboard { write: bool },
    Secrets,
    Native(NativeKind),
    SidecarRuntimeNode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsScope {
    Project,
    Home,
    Any,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeKind {
    Windows,
    Webview,
    ScreenCapture,
}

/// Risk shown in consent dialogs (§11.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    Medium,
    High,
    Critical,
}

impl Permission {
    pub fn parse(s: &str) -> Result<Self, String> {
        parse_kind(s)?;
        Ok(Self(s.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn kind(&self) -> PermissionKind {
        parse_kind(&self.0).expect("Permission holds a validated string")
    }

    pub fn risk(&self) -> Risk {
        risk(&self.kind())
    }

    pub fn describe(&self) -> String {
        describe(&self.kind())
    }

    /// Permissions a sandboxed plugin may never hold (§11.1): `native:*`,
    /// `terminal:io`, `fs:*:any`.
    pub fn forbidden_for_sandbox(&self) -> bool {
        matches!(
            self.kind(),
            PermissionKind::Native(_) | PermissionKind::TerminalIo | PermissionKind::Fs { scope: FsScope::Any, .. }
        )
    }

    /// Does holding `self` satisfy a requirement for `required`?
    /// (`data:<d>:write` implies `data:<d>:read`.)
    pub fn satisfies(&self, required: &Permission) -> bool {
        if self == required {
            return true;
        }
        match (self.kind(), required.kind()) {
            (PermissionKind::Data { domain: a, write: true }, PermissionKind::Data { domain: b, write: false }) => a == b,
            _ => false,
        }
    }
}

impl fmt::Display for Permission {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for Permission {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        Permission::parse(s)
    }
}

impl Serialize for Permission {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for Permission {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Permission::parse(&s).map_err(serde::de::Error::custom)
    }
}

fn bad(s: &str) -> String {
    format!("unknown permission {s:?}")
}

fn parse_kind(s: &str) -> Result<PermissionKind, String> {
    use PermissionKind as K;
    let parts: Vec<&str> = s.split(':').collect();
    let k = match parts.as_slice() {
        ["data", domain, access] if DATA_DOMAINS.contains(domain) => match *access {
            "read" => K::Data { domain: domain.to_string(), write: false },
            "write" => K::Data { domain: domain.to_string(), write: true },
            _ => return Err(bad(s)),
        },
        ["project", "config", "write"] => K::ProjectConfigWrite,
        ["terminal", "spawn"] => K::TerminalSpawn,
        ["terminal", "io"] => K::TerminalIo,
        ["agents", "launch"] => K::AgentsLaunch,
        ["agents", "read"] => K::AgentsRead,
        ["fs", access, scope] => {
            let write = match *access {
                "read" => false,
                "write" => true,
                _ => return Err(bad(s)),
            };
            let scope = match *scope {
                "project" => FsScope::Project,
                "home" => FsScope::Home,
                "any" => FsScope::Any,
                _ => return Err(bad(s)),
            };
            K::Fs { write, scope }
        }
        ["shell", "exec", program] => {
            if program.is_empty()
                || !program.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            {
                return Err(format!("{s:?}: shell:exec needs a program basename ([A-Za-z0-9._-]+)"));
            }
            K::ShellExec { program: program.to_string() }
        }
        ["shell", "open-external"] => K::ShellOpenExternal,
        ["network", "*"] => K::Network { host: None, port: None },
        ["network", host] => K::Network { host: Some(check_host(s, host)?), port: None },
        ["network", host, port] => {
            let host = check_host(s, host)?;
            if port.is_empty() || !port.chars().all(|c| c.is_ascii_digit()) {
                return Err(bad(s));
            }
            let port: u16 = port.parse().map_err(|_| format!("{s:?}: port out of range"))?;
            if port == 0 {
                return Err(format!("{s:?}: port out of range"));
            }
            K::Network { host: Some(host), port: Some(port) }
        }
        ["notifications"] => K::Notifications,
        ["clipboard", "read"] => K::Clipboard { write: false },
        ["clipboard", "write"] => K::Clipboard { write: true },
        ["secrets"] => K::Secrets,
        ["native", "windows"] => K::Native(NativeKind::Windows),
        ["native", "webview"] => K::Native(NativeKind::Webview),
        ["native", "screen-capture"] => K::Native(NativeKind::ScreenCapture),
        ["sidecar", "runtime", "node"] => K::SidecarRuntimeNode,
        _ => return Err(bad(s)),
    };
    Ok(k)
}

fn check_host(full: &str, host: &str) -> Result<String, String> {
    if host.is_empty() || !host.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '-')) {
        return Err(format!(
            "{full:?}: network host must be lowercase [a-z0-9.-] (no wildcards; list each host or use network:*)"
        ));
    }
    Ok(host.to_string())
}

pub fn risk(k: &PermissionKind) -> Risk {
    use PermissionKind as K;
    match k {
        K::Data { write: false, .. } | K::AgentsRead | K::ShellOpenExternal | K::Notifications => Risk::Low,
        K::Clipboard { write: true } => Risk::Low,
        K::Data { write: true, .. } | K::ProjectConfigWrite | K::Secrets | K::SidecarRuntimeNode => Risk::Medium,
        K::Clipboard { write: false } => Risk::Medium,
        K::Fs { write: false, scope: FsScope::Project } => Risk::Medium,
        K::Network { host: Some(_), .. } => Risk::Medium,
        K::TerminalSpawn | K::TerminalIo | K::AgentsLaunch | K::ShellExec { .. } => Risk::High,
        K::Fs { write: true, scope: FsScope::Project } | K::Fs { scope: FsScope::Home, .. } => Risk::High,
        K::Network { host: None, .. } => Risk::High,
        K::Native(NativeKind::Webview) | K::Native(NativeKind::ScreenCapture) => Risk::High,
        K::Fs { scope: FsScope::Any, .. } | K::Native(NativeKind::Windows) => Risk::Critical,
    }
}

/// Human description for consent dialogs.
pub fn describe(k: &PermissionKind) -> String {
    use PermissionKind as K;
    match k {
        K::Data { domain, write: false } => format!("Read {domain} in any registered project"),
        K::Data { domain, write: true } => format!("Read and change {domain} in any registered project"),
        K::ProjectConfigWrite => "Edit project configuration (.quadflow/config.json)".into(),
        K::TerminalSpawn => "Create terminals and read/write/kill the terminals it created".into(),
        K::TerminalIo => "Read and write any terminal, including agent sessions".into(),
        K::AgentsLaunch => "Start AI agent CLIs in terminals".into(),
        K::AgentsRead => "List agent providers, models and detection results".into(),
        K::Fs { write, scope } => {
            let what = match scope {
                FsScope::Project => "files in the current project",
                FsScope::Home => "files in your home folder",
                FsScope::Any => "any file on this computer",
            };
            format!("{} {what}", if *write { "Read and write" } else { "Read" })
        }
        K::ShellExec { program } => format!("Run the program `{program}`"),
        K::ShellOpenExternal => "Open web and mail links in your browser".into(),
        K::Network { host: None, .. } => "Connect to any internet host".into(),
        K::Network { host: Some(h), port: None } => format!("Connect to {h}"),
        K::Network { host: Some(h), port: Some(p) } => format!("Connect to {h}:{p}"),
        K::Notifications => "Show system notifications".into(),
        K::Clipboard { write: false } => "Read the clipboard".into(),
        K::Clipboard { write: true } => "Write to the clipboard".into(),
        K::Secrets => "Store secrets in the OS keychain (its own entries only)".into(),
        K::Native(NativeKind::Windows) => "Access the main window handle and embed native windows".into(),
        K::Native(NativeKind::Webview) => "Show child web views in tiles".into(),
        K::Native(NativeKind::ScreenCapture) => "Capture regions of the screen".into(),
        K::SidecarRuntimeNode => "Run its helper process with the system Node.js".into(),
    }
}

/// Requested permissions not covered by `granted`.
pub fn missing(requested: &BTreeSet<Permission>, granted: &BTreeSet<Permission>) -> BTreeSet<Permission> {
    requested.iter().filter(|r| !granted.iter().any(|g| g.satisfies(r))).cloned().collect()
}

/// `(added, removed)` going from `old` to `new` (update consent, §11.2).
pub fn diff(old: &BTreeSet<Permission>, new: &BTreeSet<Permission>) -> (BTreeSet<Permission>, BTreeSet<Permission>) {
    (new.difference(old).cloned().collect(), old.difference(new).cloned().collect())
}

#[cfg(test)]
pub(crate) mod tests_corpus {
    pub(crate) const VALID: &[&str] = &[
        "data:ideas:read", "data:missions:write", "project:config:write", "terminal:spawn", "terminal:io",
        "agents:launch", "agents:read", "fs:read:project", "fs:write:home", "fs:read:any", "shell:exec:git",
        "shell:exec:node.exe", "shell:open-external", "network:*", "network:api.example.com",
        "network:localhost:8080", "notifications", "clipboard:read", "clipboard:write", "secrets",
        "native:windows", "native:webview", "native:screen-capture", "sidecar:runtime:node",
    ];
    pub(crate) const INVALID: &[&str] = &[
        "", "data:teams:read", "data:ideas:delete", "data:ideas", "fs:read:root", "fs:exec:project",
        "shell:exec:", "shell:exec:a/b", "shell:exec:rm -rf", "network:*.example.com", "network:API.example.com",
        "network:", "network:host:", "network:host:abc", "network:host:99999", "network:host:0",
        "clipboard", "native:gpu", "terminal:spawn:extra", "Secrets", "sidecar:runtime:python", " notifications",
    ];
}

#[cfg(test)]
mod tests {
    use super::tests_corpus::{INVALID, VALID};
    use super::*;

    #[test]
    fn grammar() {
        for s in VALID {
            assert!(Permission::parse(s).is_ok(), "{s} should be valid");
        }
        for s in INVALID {
            assert!(Permission::parse(s).is_err(), "{s:?} should be invalid");
        }
    }

    #[test]
    fn serde_round_trip_validates() {
        let p: Permission = serde_json::from_str("\"data:issues:write\"").unwrap();
        assert_eq!(serde_json::to_string(&p).unwrap(), "\"data:issues:write\"");
        assert!(serde_json::from_str::<Permission>("\"data:nope:write\"").is_err());
    }

    #[test]
    fn risk_and_sandbox() {
        let p = |s: &str| Permission::parse(s).unwrap();
        assert_eq!(p("fs:write:any").risk(), Risk::Critical);
        assert_eq!(p("network:*").risk(), Risk::High);
        assert_eq!(p("notifications").risk(), Risk::Low);
        assert!(p("native:webview").forbidden_for_sandbox());
        assert!(p("terminal:io").forbidden_for_sandbox());
        assert!(p("fs:read:any").forbidden_for_sandbox());
        assert!(!p("fs:read:home").forbidden_for_sandbox());
        assert!(!p("secrets").forbidden_for_sandbox());
        for s in VALID {
            assert!(!p(s).describe().is_empty());
        }
    }

    #[test]
    fn write_implies_read_and_diff() {
        let p = |s: &str| Permission::parse(s).unwrap();
        let req: BTreeSet<_> = [p("data:issues:read"), p("terminal:spawn")].into();
        let granted: BTreeSet<_> = [p("data:issues:write")].into();
        assert_eq!(missing(&req, &granted), [p("terminal:spawn")].into());
        let (added, removed) = diff(&granted, &req);
        assert_eq!(added.len(), 2);
        assert_eq!(removed, [p("data:issues:write")].into());
    }
}
