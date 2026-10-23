//! CLI output contract (data-layer.md §11): JSON envelope, human output, exit codes.

use super::Io;
use crate::error::CoreError;
use crate::model::CorruptEntry;
use serde::Serialize;
use std::io::Write;

pub const EXIT_OK: i32 = 0;
pub const EXIT_USAGE: i32 = 2;

#[derive(Serialize)]
struct OkEnvelope<'a, T: Serialize> {
    ok: bool,
    data: &'a T,
    #[serde(skip_serializing_if = "<[CorruptEntry]>::is_empty")]
    warnings: &'a [CorruptEntry],
}

#[derive(Serialize)]
struct ErrEnvelope<'a> {
    ok: bool,
    error: &'a CoreError,
}

/// Writes results in the selected mode.
pub struct Out<'a, 'io> {
    pub io: &'a mut Io<'io>,
    pub json: bool,
    /// Notices raised before the command ran (e.g. 1.x project data moved aside):
    /// printed to stderr already, added to the JSON envelope's `warnings`.
    pub notices: Vec<CorruptEntry>,
}

impl<'a, 'io> Out<'a, 'io> {
    pub fn new(io: &'a mut Io<'io>, json: bool) -> Self {
        Self { io, json, notices: Vec::new() }
    }

    /// Success: `{"ok":true,"data":…,"warnings":[…]}` in JSON mode, else `human`.
    /// Warnings also go to stderr in both modes.
    pub fn ok<T: Serialize>(
        &mut self,
        data: &T,
        warnings: &[CorruptEntry],
        human: impl FnOnce(&mut dyn Write) -> std::io::Result<()>,
    ) -> i32 {
        for w in warnings {
            let _ = writeln!(self.io.stderr, "warning: could not read {}: {}", w.path, w.message);
        }
        let all: Vec<CorruptEntry> = self.notices.iter().chain(warnings).cloned().collect();
        let res = if self.json {
            match serde_json::to_string_pretty(&OkEnvelope { ok: true, data, warnings: &all }) {
                Ok(s) => writeln!(self.io.stdout, "{s}"),
                Err(e) => return self.err(&CoreError::internal(format!("encode JSON: {e}"))),
            }
        } else {
            human(&mut *self.io.stdout)
        };
        let _ = self.io.stdout.flush();
        match res {
            Ok(()) => EXIT_OK,
            Err(_) => 1,
        }
    }

    /// Failure: `{"ok":false,"error":{…}}` on stdout in JSON mode, else a message on
    /// stderr. Returns the exit code for the error class.
    pub fn err(&mut self, e: &CoreError) -> i32 {
        if self.json {
            let s = serde_json::to_string_pretty(&ErrEnvelope { ok: false, error: e })
                .unwrap_or_else(|_| r#"{"ok":false,"error":{"code":"internal","message":"encode failed"}}"#.into());
            let _ = writeln!(self.io.stdout, "{s}");
            let _ = self.io.stdout.flush();
        } else {
            let _ = writeln!(self.io.stderr, "quadflow: {}", e.message);
            if let Some(hint) = e.details.as_ref().and_then(|d| d.get("hint")).and_then(|h| h.as_str()) {
                let _ = writeln!(self.io.stderr, "hint: {hint}");
            }
        }
        e.exit_code()
    }

    pub fn result<T: Serialize>(
        &mut self,
        r: crate::error::Result<T>,
        human: impl FnOnce(&mut dyn Write, &T) -> std::io::Result<()>,
    ) -> i32 {
        match r {
            Ok(v) => self.ok(&v, &[], |w| human(w, &v)),
            Err(e) => self.err(&e),
        }
    }
}
