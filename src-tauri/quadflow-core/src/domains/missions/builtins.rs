//! Built-in mission templates and agent definitions (data-layer.md §6.8).
//!
//! These are Rust consts merged at read time — never written to disk or the
//! app DB, so nothing is reseeded on startup and nothing that references a
//! built-in (mission members) is ever deleted by a reseed.

use super::model::{MissionTemplate, MissionTemplateCategory, MissionWorkflowPhase};
use crate::domains::app::agent_definitions::AgentDefinition;
use crate::ids::Id;
use crate::model::Actor;

/// Provider of every built-in agent definition: the user's default provider
/// (resolved at launch), with that provider's default model.
pub const BUILTIN_AGENT_PROVIDER: &str = crate::agents::DEFAULT_PROVIDER_ALIAS;

struct AgentSpec {
    id: &'static str,
    name: &'static str,
    role: &'static str,
    description: &'static str,
    prompt: &'static str,
}

const AGENTS: &[AgentSpec] = &[
    AgentSpec { id: "scrum-master", name: "Scrum Master", role: "scrum_master",
        description: "Runs sprints, assigns issues, tracks progress, removes blockers. Does NOT write code.",
        prompt: "You are the SCRUM MASTER agent. Assign issues, track progress, remove blockers. Do NOT write code — only coordinate." },
    AgentSpec { id: "tech-lead", name: "Tech Lead", role: "tech_lead",
        description: "Makes architectural decisions, reviews critical code, guides technical direction.",
        prompt: "You are the TECH LEAD agent. Make architecture decisions, review critical code, guide the team technically." },
    AgentSpec { id: "product-owner", name: "Product Owner", role: "product_owner",
        description: "Defines requirements, prioritizes backlog, validates deliverables.",
        prompt: "You are the PRODUCT OWNER agent. Define requirements, prioritize backlog, validate deliverables. Do NOT write code." },
    AgentSpec { id: "frontend-dev", name: "Frontend Developer", role: "frontend",
        description: "UI components, styling, accessibility, responsive design, state management.",
        prompt: "You are a FRONTEND DEVELOPER agent. Build UI components, handle styling, accessibility, and state management." },
    AgentSpec { id: "backend-dev", name: "Backend Developer", role: "backend",
        description: "APIs, server logic, business rules, service architecture.",
        prompt: "You are a BACKEND DEVELOPER agent. Build APIs, server logic, business rules, and service layers." },
    AgentSpec { id: "fullstack-dev", name: "Full Stack Developer", role: "fullstack",
        description: "Works across the entire stack, frontend to database.",
        prompt: "You are a FULL STACK DEVELOPER agent. Work across the entire stack from UI to database." },
    AgentSpec { id: "devops-eng", name: "DevOps Engineer", role: "devops",
        description: "CI/CD, Docker, deployment, infrastructure, build systems.",
        prompt: "You are a DEVOPS ENGINEER agent. Handle CI/CD, Docker, deployment, and build infrastructure." },
    AgentSpec { id: "database-eng", name: "Database Engineer", role: "database",
        description: "Schema design, migrations, query optimization, data modeling.",
        prompt: "You are a DATABASE ENGINEER agent. Design schemas, write migrations, optimize queries." },
    AgentSpec { id: "qa-eng", name: "QA Engineer", role: "qa",
        description: "Tests, edge cases, acceptance criteria validation, regression testing.",
        prompt: "You are a QA ENGINEER agent. Write tests, find edge cases, validate acceptance criteria." },
    AgentSpec { id: "security-eng", name: "Security Engineer", role: "security",
        description: "Vulnerability audits, auth review, OWASP top 10, dependency scanning.",
        prompt: "You are a SECURITY ENGINEER agent. Audit for OWASP top 10, review auth flows, check dependencies." },
    AgentSpec { id: "tech-writer", name: "Technical Writer", role: "docs",
        description: "Documentation, READMEs, API docs, architecture decision records.",
        prompt: "You are a TECHNICAL WRITER agent. Write docs, READMEs, API docs, and decision records." },
    AgentSpec { id: "researcher", name: "Researcher", role: "research",
        description: "Investigates codebases, evaluates libraries, gathers context.",
        prompt: "You are a RESEARCHER agent. Investigate codebases, evaluate libraries, gather context for the team." },
];

/// Built-in agent definitions (`builtin-<name>` ids, provider default model).
pub fn builtin_agent_definitions() -> Vec<AgentDefinition> {
    AGENTS
        .iter()
        .map(|a| AgentDefinition {
            id: Id::builtin(a.id),
            name: a.name.to_string(),
            description: Some(a.description.to_string()),
            role: a.role.to_string(),
            provider_id: BUILTIN_AGENT_PROVIDER.to_string(),
            model: None,
            system_prompt: Some(a.prompt.to_string()),
            builtin: true,
            created_at: 0,
            updated_at: 0,
        })
        .collect()
}

pub fn builtin_agent_definition(id: &str) -> Option<AgentDefinition> {
    builtin_agent_definitions().into_iter().find(|d| d.id.as_str() == id)
}

type Phase = (&'static str, &'static str, &'static str, &'static [&'static str]);

struct TemplateSpec {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    category: MissionTemplateCategory,
    skills: &'static [&'static str],
    phases: &'static [Phase],
    criteria: &'static [&'static str],
    orchestrator: &'static str,
    member: &'static str,
}

use MissionTemplateCategory as C;

const TEMPLATES: &[TemplateSpec] = &[
    TemplateSpec {
        id: "feature-build", name: "Feature Build",
        description: "End-to-end feature implementation: plan, build, test, review.",
        category: C::Build,
        skills: &["issue-to-prompt", "run-script", "triage-issues", "create-rich-plan"],
        phases: &[
            ("Planning", "Tech lead breaks down the feature into issues", "plan_created", &["triage-issues", "create-rich-plan"]),
            ("Implementation", "Developers work through assigned issues", "all_issues_in_progress", &["issue-to-prompt", "run-script"]),
            ("Testing", "QA validates each completed issue", "all_issues_in_qa", &["issue-to-prompt", "run-script"]),
            ("Security Review", "Security engineer audits the changes", "security_approved", &["issue-to-prompt"]),
            ("Done", "All issues pass QA and security review", "all_issues_done", &[]),
        ],
        criteria: &["All linked issues reach QA or Done status", "Tests pass for all changed code", "Security review completed"],
        orchestrator: "You are leading a Feature Build mission. Use /triage-issues to prioritize, assign issues to members. Have developers use /issue-to-prompt and /run-script.",
        member: "Use /issue-to-prompt for context. Use /run-script to validate. Move issues to QA when complete.",
    },
    TemplateSpec {
        id: "bug-bash", name: "Bug Bash",
        description: "Focused bug-fixing sprint: triage, fix, verify, close.",
        category: C::Quality,
        skills: &["issue-to-prompt", "run-script", "triage-issues"],
        phases: &[
            ("Triage", "Prioritize bugs by severity", "issues_prioritized", &["triage-issues"]),
            ("Fixing", "Fix bugs in priority order", "all_issues_in_progress", &["issue-to-prompt", "run-script"]),
            ("Verification", "QA verifies fixes", "all_issues_in_qa", &["issue-to-prompt", "run-script"]),
            ("Done", "All bugs verified and closed", "all_issues_done", &[]),
        ],
        criteria: &["All bug issues reach QA or Done", "No regressions introduced", "Root causes documented"],
        orchestrator: "You are leading a Bug Bash. Prioritize by severity. Ensure root cause comments on each fix.",
        member: "Document root cause before fixing. Use /run-script to verify no regressions.",
    },
    TemplateSpec {
        id: "security-audit", name: "Security Audit",
        description: "Comprehensive security review: scan, audit, fix, verify.",
        category: C::Quality,
        skills: &["issue-to-prompt", "run-script", "triage-issues"],
        phases: &[
            ("Scanning", "Identify vulnerabilities and create issues", "audit_issues_created", &["triage-issues"]),
            ("Audit", "Deep-dive into each finding", "all_issues_in_progress", &["issue-to-prompt"]),
            ("Remediation", "Fix confirmed vulnerabilities", "fixes_applied", &["issue-to-prompt", "run-script"]),
            ("Verification", "Verify fixes and re-scan", "all_issues_in_qa", &["issue-to-prompt", "run-script"]),
            ("Done", "All findings addressed", "all_issues_done", &[]),
        ],
        criteria: &["All OWASP Top 10 reviewed", "Critical vulnerabilities fixed", "Remaining risks documented"],
        orchestrator: "You are leading a Security Audit. Scan for OWASP Top 10. Critical issues fixed first.",
        member: "Audit for vulnerabilities. Create issues for findings with severity and fix recommendations.",
    },
    TemplateSpec {
        id: "refactoring", name: "Refactoring Sprint",
        description: "Systematic code improvement: identify debt, refactor, verify.",
        category: C::Build,
        skills: &["issue-to-prompt", "run-script", "triage-issues", "create-rich-plan"],
        phases: &[
            ("Analysis", "Identify technical debt", "issues_created", &["triage-issues", "create-rich-plan"]),
            ("Refactoring", "Implement changes incrementally", "all_issues_in_progress", &["issue-to-prompt", "run-script"]),
            ("Verification", "Verify no behavior changes", "all_issues_in_qa", &["issue-to-prompt", "run-script"]),
            ("Done", "All refactoring verified", "all_issues_done", &[]),
        ],
        criteria: &["All refactoring issues done", "No behavior changes", "Code complexity reduced"],
        orchestrator: "Focus on incremental, safe refactoring. Tests must pass after every change.",
        member: "Refactor incrementally. Run tests after every change. Document what changed and why.",
    },
    TemplateSpec {
        id: "docs-sprint", name: "Documentation Sprint",
        description: "Comprehensive documentation: audit, write, review.",
        category: C::Ops,
        skills: &["issue-to-prompt", "triage-issues"],
        phases: &[
            ("Audit", "Identify documentation gaps", "doc_issues_created", &["triage-issues"]),
            ("Writing", "Create documentation", "all_issues_in_progress", &["issue-to-prompt"]),
            ("Review", "Review for accuracy", "all_issues_in_qa", &["issue-to-prompt"]),
            ("Done", "All docs reviewed", "all_issues_done", &[]),
        ],
        criteria: &["All doc gaps addressed", "README and API docs updated", "Architecture decisions documented"],
        orchestrator: "Identify gaps, assign writing, review for accuracy. Focus: README, API docs, ADRs.",
        member: "Research the codebase thoroughly before writing. Keep docs clear and accurate.",
    },
    TemplateSpec {
        id: "code-review", name: "Code Review Sweep",
        description: "Systematic code quality review.",
        category: C::Quality,
        skills: &["issue-to-prompt", "run-script", "triage-issues"],
        phases: &[
            ("Review", "Review code for quality issues", "review_issues_created", &["triage-issues"]),
            ("Fixing", "Fix found problems", "all_issues_in_progress", &["issue-to-prompt", "run-script"]),
            ("Verification", "Re-review fixes", "all_issues_in_qa", &["issue-to-prompt", "run-script"]),
            ("Done", "All findings addressed", "all_issues_done", &[]),
        ],
        criteria: &["All critical quality issues addressed", "Test coverage adequate", "No security vulnerabilities"],
        orchestrator: "QA reviews quality, security reviews vulnerabilities. Create issues for each finding.",
        member: "Review carefully for your specialty. Create issues for findings.",
    },
    TemplateSpec {
        id: "sprint-planning", name: "Sprint Planning",
        description: "Plan and prepare a sprint.",
        category: C::Planning,
        skills: &["kickoff-project", "plan-from-idea", "create-rich-plan", "plan-to-issues", "triage-issues"],
        phases: &[
            ("Discovery", "Research requirements", "research_complete", &["kickoff-project"]),
            ("Planning", "Create implementation plans", "plans_created", &["plan-from-idea", "create-rich-plan"]),
            ("Issue Creation", "Break plans into issues", "issues_created", &["plan-to-issues", "triage-issues"]),
            ("Prioritization", "Prioritize sprint backlog", "sprint_ready", &["triage-issues"]),
            ("Done", "Sprint backlog ready", "backlog_finalized", &[]),
        ],
        criteria: &["Sprint backlog created", "All issues have acceptance criteria", "Dependencies mapped"],
        orchestrator: "PO defines requirements, researcher gathers context, tech lead plans, scrum master prioritizes.",
        member: "Contribute your expertise to sprint planning.",
    },
    TemplateSpec {
        id: "bootstrap", name: "New Project Bootstrap",
        description: "Set up a new project from scratch.",
        category: C::Planning,
        skills: &["kickoff-project", "create-rich-plan", "plan-from-idea", "plan-to-issues", "setup-scripts"],
        phases: &[
            ("Discovery", "Define goals, tech stack, architecture", "goals_defined", &["kickoff-project"]),
            ("Planning", "Create detailed implementation plan", "plan_created", &["create-rich-plan", "plan-from-idea"]),
            ("Setup", "Create issues and configure scripts", "issues_created", &["plan-to-issues", "setup-scripts"]),
            ("Done", "Project structure ready", "project_ready", &[]),
        ],
        criteria: &["Goals and architecture documented", "Implementation plan created", "Build scripts configured", "Initial issues created"],
        orchestrator: "Start with /kickoff-project, then /create-rich-plan, then /plan-to-issues and /setup-scripts.",
        member: "Help bootstrap: PO defines requirements, researcher evaluates tech, tech lead designs architecture.",
    },
];

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// Built-in mission templates (`builtin-<name>` ids, `builtIn: true`).
pub fn builtin_templates() -> Vec<MissionTemplate> {
    TEMPLATES
        .iter()
        .map(|t| MissionTemplate {
            id: Id::builtin(t.id),
            name: t.name.to_string(),
            description: Some(t.description.to_string()),
            category: t.category,
            workflow_phases: t
                .phases
                .iter()
                .map(|(name, desc, gate, skills)| MissionWorkflowPhase {
                    name: name.to_string(),
                    description: Some(desc.to_string()),
                    gate: Some(gate.to_string()),
                    skills: strings(skills),
                })
                .collect(),
            skills_used: strings(t.skills),
            success_criteria: strings(t.criteria),
            orchestrator_prompt_extra: Some(t.orchestrator.to_string()),
            member_prompt_extra: Some(t.member.to_string()),
            built_in: true,
            created_at: 0,
            created_by: Actor::system(),
            updated_at: 0,
            ext: Default::default(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::missions::MissionAgentRole;

    #[test]
    fn builtins_are_well_formed() {
        let defs = builtin_agent_definitions();
        assert_eq!(defs.len(), 12);
        for d in &defs {
            assert!(d.id.is_builtin() && d.builtin && d.model.is_none());
            assert!(MissionAgentRole::parse(&d.role).is_some(), "{}", d.role);
        }
        let t = builtin_templates();
        assert_eq!(t.len(), 8);
        assert!(t.iter().all(|t| t.id.is_builtin() && t.built_in && !t.workflow_phases.is_empty()));
        assert_eq!(t[0].id.as_str(), "builtin-feature-build");
    }
}
