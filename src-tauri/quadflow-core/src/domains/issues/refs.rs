//! Issue display references (data-layer.md §3.4): `CODE-n`, `#n`, `n` or an id.

use super::model::Issue;
use crate::domains::project_config::{self, ProjectConfig};
use crate::error::{CoreError, Result};
use crate::ids::Id;
use crate::store::ProjectStore;

/// The one place an issue reference string is built: `{code}-{number}`.
pub fn display_ref(config: &ProjectConfig, issue: &Issue) -> String {
    format_ref(&config.code, issue.number)
}

pub fn format_ref(code: &str, number: u64) -> String {
    format!("{code}-{number}")
}

/// What an input names, before looking anything up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefInput {
    Id(Id),
    Number(u64),
}

/// Parse `input` against the project `code`: an `Id`; `CODE-n` (code matched
/// case-insensitively); `#n`; `n`. A different prefix is `not_found`.
pub fn parse(code: &str, input: &str) -> Result<RefInput> {
    let s = input.trim();
    if s.is_empty() {
        return Err(CoreError::invalid_input("empty issue reference"));
    }
    if s.len() == 26 {
        if let Ok(id) = Id::parse(s) {
            return Ok(RefInput::Id(id));
        }
    }
    let num = |t: &str| t.parse::<u64>().ok().filter(|n| *n > 0);
    if let Some(rest) = s.strip_prefix('#') {
        return num(rest).map(RefInput::Number).ok_or_else(|| bad(input));
    }
    if let Some(n) = num(s) {
        return Ok(RefInput::Number(n));
    }
    if let Some((prefix, rest)) = s.rsplit_once('-') {
        if let Some(n) = num(rest) {
            if prefix.eq_ignore_ascii_case(code) {
                return Ok(RefInput::Number(n));
            }
            return Err(CoreError::not_found(format!(
                "issue {input} not found (this project's issue prefix is {code})"
            )));
        }
    }
    if s.starts_with("builtin-") {
        return Ok(RefInput::Id(Id::parse(s)?));
    }
    Err(bad(input))
}

fn bad(input: &str) -> CoreError {
    CoreError::invalid_input(format!(
        "invalid issue reference {input:?}: expected an id, CODE-n, #n or n"
    ))
}

/// Find the issue an input refers to among `issues`.
pub fn find<'a>(issues: &'a [Issue], r: &RefInput) -> Option<&'a Issue> {
    match r {
        RefInput::Id(id) => issues.iter().find(|i| &i.id == id),
        // Duplicate numbers (two clones) resolve to the oldest; `doctor --fix` renumbers.
        RefInput::Number(n) => issues.iter().filter(|i| i.number == *n).min_by(|a, b| a.id.cmp(&b.id)),
    }
}

/// Resolve `input` to an issue id in `store`.
pub fn resolve(store: &ProjectStore, input: &str) -> Result<Id> {
    let cfg = project_config::read(store)?;
    match parse(&cfg.code, input)? {
        RefInput::Id(id) => {
            // Existence check so a stale id is `not_found`, not a later surprise.
            store.get::<Issue>(&id)?;
            Ok(id)
        }
        r @ RefInput::Number(_) => {
            let list = store.list::<Issue>()?;
            find(&list.items, &r).map(|i| i.id.clone()).ok_or_else(|| {
                CoreError::not_found(format!("issue {input} not found"))
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ref_forms() {
        assert_eq!(parse("WEB", "WEB-12").unwrap(), RefInput::Number(12));
        assert_eq!(parse("WEB", "web-12").unwrap(), RefInput::Number(12));
        assert_eq!(parse("WEB", "#3").unwrap(), RefInput::Number(3));
        assert_eq!(parse("WEB", " 7 ").unwrap(), RefInput::Number(7));
        let id = crate::ids::new_id();
        assert_eq!(parse("WEB", id.as_str()).unwrap(), RefInput::Id(id));
        assert_eq!(parse("WEB", "QX-9").unwrap_err().code, crate::ErrorCode::NotFound);
        assert_eq!(parse("WEB", "WEB-0").unwrap_err().code, crate::ErrorCode::InvalidInput);
        assert_eq!(parse("WEB", "hello").unwrap_err().code, crate::ErrorCode::InvalidInput);
        assert_eq!(parse("WEB", "").unwrap_err().code, crate::ErrorCode::InvalidInput);
    }
}
