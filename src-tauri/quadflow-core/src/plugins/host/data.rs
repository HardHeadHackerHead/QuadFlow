//! `data.*` (plugin-system.md §6.3): every domain service through core, with
//! `data:<domain>:read|write` (write implies read). Project-scoped methods take
//! an optional `projectRoot` param (default: the active project).
//!
//! Param names mirror the matching Tauri command (camelCase), so the TS
//! `DataApi` and the GUI's `commands.*` take the same shapes.

use super::{json, HostCall, HostEnv, MethodSpec, PermReq, Sink, SubscriptionGuard, TopicSpec};
use crate::domains::app::agent_definitions;
use crate::domains::{chat, discovery, environments, ideas, issues, missions, plans, project_config, scripts, ship};
use crate::error::{CoreError, Result};
use crate::events::{ChangeEvent, ChangeScope, Domain};
use crate::Id;
use serde_json::{json as j, Value};
use std::sync::Arc;

/// Project-store method: `|store, actor, call| expr` where `expr: Result<T>`.
macro_rules! ps {
    ($v:ident, $name:literal, $perm:literal, |$s:ident, $a:ident, $c:ident| $body:expr) => {
        $v.push(MethodSpec::new($name, PermReq::One($perm), |env: &HostEnv, $c: &HostCall| {
            let store = env.store($c)?;
            let $s = &*store;
            let actor = $c.actor();
            let $a = &actor;
            let _ = (&$s, &$a);
            json(($body)?)
        }));
    };
}

/// App-DB method: `|env, call| expr`.
macro_rules! app {
    ($v:ident, $name:literal, $perm:literal, |$e:ident, $c:ident| $body:expr) => {
        $v.push(MethodSpec::new($name, PermReq::One($perm), |$e: &HostEnv, $c: &HostCall| json(($body)?)));
    };
}

pub(super) fn methods() -> Vec<MethodSpec> {
    let mut v = Vec::new();

    // ---- ideas ----
    ps!(v, "data.ideas.list", "data:ideas:read", |s, _a, c| ideas::list(s, &c.arg_or_default("query")?));
    ps!(v, "data.ideas.get", "data:ideas:read", |s, _a, c| ideas::get(s, &c.arg::<Id>("id")?));
    ps!(v, "data.ideas.stats", "data:ideas:read", |s, _a, c| ideas::stats(s));
    ps!(v, "data.ideas.create", "data:ideas:write", |s, a, c| ideas::create(s, a, c.arg("idea")?));
    ps!(v, "data.ideas.update", "data:ideas:write", |s, a, c| ideas::update(s, a, &c.arg("id")?, c.arg("patch")?));
    ps!(v, "data.ideas.delete", "data:ideas:write", |s, a, c| ideas::delete(s, a, &c.arg("id")?));
    ps!(v, "data.ideas.merge", "data:ideas:write", |s, a, c| ideas::merge(s, a, &c.arg::<Vec<Id>>("ids")?, &c.arg("keep")?));
    ps!(v, "data.ideas.addTag", "data:ideas:write", |s, a, c| ideas::add_tag(s, a, &c.arg("id")?, &c.arg::<String>("tag")?));
    ps!(v, "data.ideas.removeTag", "data:ideas:write", |s, a, c| ideas::remove_tag(s, a, &c.arg("id")?, &c.arg::<String>("tag")?));
    ps!(v, "data.ideas.bulkTag", "data:ideas:write", |s, a, c| ideas::bulk_tag(
        s,
        a,
        &c.arg::<Vec<Id>>("ids")?,
        &c.arg::<String>("tag")?
    ));
    ps!(v, "data.ideas.addNote", "data:ideas:write", |s, a, c| ideas::add_note(s, a, &c.arg("id")?, &c.arg::<String>("body")?));
    ps!(v, "data.ideas.deleteNote", "data:ideas:write", |s, a, c| ideas::delete_note(s, a, &c.arg("id")?, &c.arg("noteId")?));
    ps!(v, "data.ideas.addSuggestion", "data:ideas:write", |s, a, c| ideas::add_suggestion(
        s,
        a,
        &c.arg("id")?,
        c.arg("kind")?,
        &c.arg::<String>("text")?
    ));
    ps!(v, "data.ideas.resolveSuggestion", "data:ideas:write", |s, a, c| ideas::resolve_suggestion(
        s,
        a,
        &c.arg("id")?,
        &c.arg("suggestionId")?,
        c.arg("accept")?
    ));
    ps!(v, "data.ideas.deleteSuggestion", "data:ideas:write", |s, a, c| ideas::delete_suggestion(
        s,
        a,
        &c.arg("id")?,
        &c.arg("suggestionId")?
    ));
    ps!(v, "data.ideas.revert", "data:ideas:write", |s, a, c| ideas::revert(s, a, &c.arg("id")?));

    // ---- issues / labels / epics ----
    ps!(v, "data.issues.list", "data:issues:read", |s, _a, c| issues::list(s, &c.arg_or_default("query")?));
    ps!(v, "data.issues.get", "data:issues:read", |s, _a, c| issues::get(s, &c.arg::<String>("issueRef")?));
    ps!(v, "data.issues.displayRef", "data:issues:read", |s, _a, c| {
        let issue = issues::get(s, &c.arg::<String>("issueRef")?)?;
        Ok::<_, CoreError>(issues::display_ref(&project_config::read(s)?, &issue))
    });
    ps!(v, "data.issues.create", "data:issues:write", |s, a, c| issues::create(s, a, c.arg("issue")?));
    ps!(v, "data.issues.update", "data:issues:write", |s, a, c| issues::update(
        s,
        a,
        &c.arg::<String>("issueRef")?,
        c.arg("patch")?
    ));
    ps!(v, "data.issues.setStatus", "data:issues:write", |s, a, c| issues::set_status(
        s,
        a,
        &c.arg::<String>("issueRef")?,
        c.arg("status")?
    ));
    ps!(v, "data.issues.close", "data:issues:write", |s, a, c| issues::close(s, a, &c.arg::<String>("issueRef")?));
    ps!(v, "data.issues.reopen", "data:issues:write", |s, a, c| issues::reopen(s, a, &c.arg::<String>("issueRef")?));
    ps!(v, "data.issues.delete", "data:issues:write", |s, a, c| issues::delete(s, a, &c.arg::<String>("issueRef")?));
    ps!(v, "data.issues.addComment", "data:issues:write", |s, a, c| issues::add_comment(
        s,
        a,
        &c.arg::<String>("issueRef")?,
        &c.arg::<String>("body")?
    ));
    ps!(v, "data.issues.deleteComment", "data:issues:write", |s, a, c| issues::delete_comment(
        s,
        a,
        &c.arg::<String>("issueRef")?,
        &c.arg("commentId")?
    ));
    ps!(v, "data.issues.toggleCriterion", "data:issues:write", |s, a, c| issues::toggle_criterion(
        s,
        a,
        &c.arg::<String>("issueRef")?,
        &c.arg("criterionId")?,
        c.opt("checked")?
    ));
    ps!(v, "data.issues.claim", "data:issues:write", |s, a, c| issues::claim(
        s,
        a,
        &c.arg::<String>("issueRef")?,
        c.arg("claim")?
    ));
    ps!(v, "data.issues.heartbeat", "data:issues:write", |s, a, c| issues::heartbeat(s, a, &c.arg::<String>("issueRef")?));
    ps!(v, "data.issues.release", "data:issues:write", |s, a, c| issues::release(s, a, &c.arg::<String>("issueRef")?));
    ps!(v, "data.issues.labels.list", "data:issues:read", |s, _a, c| issues::labels_list(s));
    ps!(v, "data.issues.labels.upsert", "data:issues:write", |s, a, c| issues::label_upsert(
        s,
        a,
        c.arg("label")?,
        c.opt("renameFrom")?
    ));
    ps!(v, "data.issues.labels.delete", "data:issues:write", |s, a, c| issues::label_delete(s, a, &c.arg::<String>("name")?));
    ps!(v, "data.issues.epics.list", "data:issues:read", |s, _a, c| issues::epics_list(s));
    ps!(v, "data.issues.epics.get", "data:issues:read", |s, _a, c| issues::epic_get(s, &c.arg("id")?));
    ps!(v, "data.issues.epics.create", "data:issues:write", |s, a, c| issues::epic_create(s, a, c.arg("epic")?));
    ps!(v, "data.issues.epics.update", "data:issues:write", |s, a, c| issues::epic_update(
        s,
        a,
        &c.arg("id")?,
        c.arg("patch")?
    ));
    ps!(v, "data.issues.epics.delete", "data:issues:write", |s, a, c| issues::epic_delete(s, a, &c.arg("id")?));

    // ---- plans ----
    ps!(v, "data.plans.list", "data:plans:read", |s, _a, c| plans::list(s, &c.arg_or_default("query")?));
    ps!(v, "data.plans.get", "data:plans:read", |s, _a, c| plans::get(s, &c.arg("planId")?));
    ps!(v, "data.plans.create", "data:plans:write", |s, a, c| plans::create(s, a, c.arg("plan")?));
    ps!(v, "data.plans.update", "data:plans:write", |s, a, c| plans::update(s, a, &c.arg("planId")?, c.arg("patch")?));
    ps!(v, "data.plans.delete", "data:plans:write", |s, a, c| plans::delete(s, a, &c.arg("planId")?));
    ps!(v, "data.plans.stepAdd", "data:plans:write", |s, a, c| plans::step_add(s, a, &c.arg("planId")?, c.arg("step")?));
    ps!(v, "data.plans.stepUpdate", "data:plans:write", |s, a, c| plans::step_update(
        s,
        a,
        &c.arg("planId")?,
        &c.arg("stepId")?,
        c.arg("patch")?
    ));
    ps!(v, "data.plans.stepDelete", "data:plans:write", |s, a, c| plans::step_delete(
        s,
        a,
        &c.arg("planId")?,
        &c.arg("stepId")?
    ));
    ps!(v, "data.plans.stepsReorder", "data:plans:write", |s, a, c| plans::steps_reorder(
        s,
        a,
        &c.arg("planId")?,
        &c.arg::<Vec<Id>>("stepIds")?
    ));
    ps!(v, "data.plans.commentAdd", "data:plans:write", |s, a, c| plans::comment_add(
        s,
        a,
        &c.arg("planId")?,
        &c.arg::<String>("body")?,
        c.arg("kind")?
    ));
    ps!(v, "data.plans.commentDelete", "data:plans:write", |s, a, c| plans::comment_delete(
        s,
        a,
        &c.arg("planId")?,
        &c.arg("commentId")?
    ));
    // Promotion creates issues: needs both.
    v.push(MethodSpec::new("data.plans.promoteStep", PermReq::Fn(plans_and_issues), |env: &HostEnv, c: &HostCall| {
        let s = env.store(c)?;
        json(plans::promote_step(&s, &c.actor(), &c.arg("planId")?, &c.arg("stepId")?)?)
    }));
    v.push(MethodSpec::new("data.plans.promoteAll", PermReq::Fn(plans_and_issues), |env: &HostEnv, c: &HostCall| {
        let s = env.store(c)?;
        json(plans::promote_all(&s, &c.actor(), &c.arg("planId")?)?)
    }));

    // ---- discovery ----
    ps!(v, "data.discovery.list", "data:discovery:read", |s, _a, c| discovery::list(s, &c.arg_or_default("query")?));
    ps!(v, "data.discovery.get", "data:discovery:read", |s, _a, c| discovery::get(s, &c.arg("id")?));
    ps!(v, "data.discovery.linked", "data:discovery:read", |s, _a, c| discovery::linked(s, &c.arg("id")?));
    ps!(v, "data.discovery.create", "data:discovery:write", |s, a, c| discovery::create(s, a, c.arg("project")?));
    ps!(v, "data.discovery.update", "data:discovery:write", |s, a, c| discovery::update(
        s,
        a,
        &c.arg("id")?,
        c.arg("patch")?
    ));
    ps!(v, "data.discovery.delete", "data:discovery:write", |s, a, c| discovery::delete(s, a, &c.arg("id")?));
    ps!(v, "data.discovery.itemAdd", "data:discovery:write", |s, a, c| discovery::item_add(
        s,
        a,
        &c.arg("id")?,
        c.arg("item")?
    ));
    ps!(v, "data.discovery.itemUpdate", "data:discovery:write", |s, a, c| discovery::item_update(
        s,
        a,
        &c.arg("id")?,
        &c.arg("itemId")?,
        c.arg("patch")?
    ));
    ps!(v, "data.discovery.itemDelete", "data:discovery:write", |s, a, c| discovery::item_delete(
        s,
        a,
        &c.arg("id")?,
        &c.arg("itemId")?
    ));
    ps!(v, "data.discovery.itemsReorder", "data:discovery:write", |s, a, c| discovery::items_reorder(
        s,
        a,
        &c.arg("id")?,
        &c.arg::<Vec<Id>>("itemIds")?
    ));

    // ---- scripts / groups / environments ----
    ps!(v, "data.scripts.list", "data:scripts:read", |s, _a, c| scripts::list(s, &c.arg_or_default("query")?));
    ps!(v, "data.scripts.get", "data:scripts:read", |s, _a, c| scripts::get(s, &c.arg("id")?));
    ps!(v, "data.scripts.create", "data:scripts:write", |s, a, c| scripts::create(s, a, c.arg("input")?));
    ps!(v, "data.scripts.update", "data:scripts:write", |s, a, c| scripts::update(s, a, &c.arg("id")?, c.arg("patch")?));
    ps!(v, "data.scripts.delete", "data:scripts:write", |s, a, c| scripts::delete(s, a, &c.arg("id")?));
    v.push(MethodSpec::new("data.scripts.resolveCommand", PermReq::One("data:scripts:read"), |env: &HostEnv, c: &HostCall| {
        let s = env.store(c)?;
        let db = env.core.app_db()?;
        json(scripts::resolve_command(&s, Some(&db), &c.arg("id")?, &c.arg_or_default("options")?)?)
    }));
    ps!(v, "data.scripts.groups.list", "data:scripts:read", |s, _a, c| scripts::groups_list(s));
    ps!(v, "data.scripts.groups.get", "data:scripts:read", |s, _a, c| scripts::group_get(s, &c.arg("id")?));
    ps!(v, "data.scripts.groups.create", "data:scripts:write", |s, a, c| scripts::group_create(s, a, c.arg("input")?));
    ps!(v, "data.scripts.groups.update", "data:scripts:write", |s, a, c| scripts::group_update(
        s,
        a,
        &c.arg("id")?,
        c.arg("patch")?
    ));
    ps!(v, "data.scripts.groups.delete", "data:scripts:write", |s, a, c| scripts::group_delete(s, a, &c.arg("id")?));
    ps!(v, "data.scripts.groups.addMember", "data:scripts:write", |s, a, c| scripts::group_add_member(
        s,
        a,
        &c.arg("groupId")?,
        c.arg("member")?
    ));
    ps!(v, "data.scripts.groups.removeMember", "data:scripts:write", |s, a, c| scripts::group_remove_member(
        s,
        a,
        &c.arg("groupId")?,
        &c.arg("scriptId")?
    ));
    app!(v, "data.scripts.environments.list", "data:scripts:read", |e, _c| environments::list(&*e.core.app_db()?));
    app!(v, "data.scripts.environments.detect", "data:scripts:write", |e, _c| environments::detect(&*e.core.app_db()?));

    // ---- ship ----
    ps!(v, "data.ship.configGet", "data:ship:read", |s, _a, c| ship::config_get(s));
    ps!(v, "data.ship.configSave", "data:ship:write", |s, a, c| ship::config_save(s, a, c.arg("config")?));
    ps!(v, "data.ship.validate", "data:ship:read", |s, _a, c| ship::validate(s));
    ps!(v, "data.ship.status", "data:ship:read", |s, _a, c| ship::status(s));
    ps!(v, "data.ship.readiness", "data:ship:read", |s, _a, c| ship::readiness(s));
    ps!(v, "data.ship.runs", "data:ship:read", |s, _a, c| ship::runs_list(s));
    ps!(v, "data.ship.runGet", "data:ship:read", |s, _a, c| ship::runs_get(s, &c.arg("id")?));
    ps!(v, "data.ship.abort", "data:ship:write", |s, a, c| ship::abort(s, a, c.opt::<Id>("runId")?.as_ref()));
    v.push(MethodSpec::new("data.ship.externalComplete", PermReq::One("data:ship:write"), |_env: &HostEnv, c: &HostCall| {
        json(ship::external_complete(&c.arg::<String>("requestId")?, c.arg("result")?)?)
    }));
    // API 1.4: setup, diagnostics and recovery (what the old Ship view had as shell commands).
    v.push(MethodSpec::new("data.ship.templates", PermReq::One("data:ship:read"), |_env: &HostEnv, _c: &HostCall| {
        json(ship::available_templates())
    }));
    ps!(v, "data.ship.init", "data:ship:write", |s, a, c| ship::init(s, a, c.arg("options")?));
    ps!(v, "data.ship.detect", "data:ship:read", |s, _a, c| Ok::<_, CoreError>(ship::detect_environment(&s.root().path)));
    ps!(v, "data.ship.diagnostics", "data:ship:read", |s, _a, c| ship::diagnostics(s));
    ps!(v, "data.ship.readinessOne", "data:ship:read", |s, _a, c| ship::readiness_one(s, &c.arg::<String>("checkId")?));
    ps!(v, "data.ship.configDelete", "data:ship:write", |s, a, c| ship::config_delete(s, a));
    ps!(v, "data.ship.restoreBackups", "data:ship:write", |s, _a, c| Ok::<_, CoreError>(ship::restore_backups(s)));

    // ---- chat (app DB; not project-scoped) ----
    app!(v, "data.chat.conversations", "data:chat:read", |e, c| chat::conversations_list(
        &*e.core.app_db()?,
        c.opt::<String>("projectRootKey")?.as_deref()
    ));
    app!(v, "data.chat.get", "data:chat:read", |e, c| chat::conversation_get(&*e.core.app_db()?, &c.arg("id")?));
    app!(v, "data.chat.messages", "data:chat:read", |e, c| chat::messages_list(&*e.core.app_db()?, &c.arg("id")?));
    app!(v, "data.chat.create", "data:chat:write", |e, c| chat::conversation_create(&*e.core.app_db()?, c.arg("input")?));
    app!(v, "data.chat.rename", "data:chat:write", |e, c| chat::conversation_rename(
        &*e.core.app_db()?,
        &c.arg("id")?,
        &c.arg::<String>("title")?
    ));
    app!(v, "data.chat.delete", "data:chat:write", |e, c| chat::conversation_delete(&*e.core.app_db()?, &c.arg("id")?));
    // API 1.4: endpoint settings (namespace `chat`; the key itself never crosses), models, one-off questions.
    app!(v, "data.chat.settingsGet", "data:chat:read", |e, _c| chat::settings_get(&*e.core.app_db()?, &e.secrets));
    app!(v, "data.chat.settingsUpdate", "data:chat:write", |e, c| chat::settings_update(
        &*e.core.app_db()?,
        &e.secrets,
        c.arg("patch")?
    ));
    app!(v, "data.chat.models", "data:chat:read", |e, c| chat::models(
        &*e.core.app_db()?,
        &e.secrets,
        u64::from(c.opt::<u32>("timeoutMs")?.unwrap_or(5000).clamp(100, 60_000))
    ));
    // Sends the question to the user's endpoint with their key: write-level, like `send`.
    app!(v, "data.chat.ask", "data:chat:write", |e, c| chat::ask(
        &*e.core.app_db()?,
        &e.secrets,
        &c.arg::<String>("question")?,
        c.opt::<String>("systemPrompt")?.as_deref(),
        c.opt::<String>("model")?.as_deref()
    ));

    // ---- missions ----
    ps!(v, "data.missions.list", "data:missions:read", |s, _a, c| missions::list(s, c.opt("status")?));
    ps!(v, "data.missions.get", "data:missions:read", |s, _a, c| missions::get(s, &c.arg("missionId")?));
    ps!(v, "data.missions.progress", "data:missions:read", |s, _a, c| missions::progress(s, &c.arg("missionId")?));
    v.push(MethodSpec::new("data.missions.issues", PermReq::Fn(missions_and_issues_read), |env: &HostEnv, c: &HostCall| {
        let s = env.store(c)?;
        json(missions::issues(&s, &c.arg("missionId")?)?)
    }));
    ps!(v, "data.missions.create", "data:missions:write", |s, a, c| missions::create(s, a, c.arg("mission")?));
    ps!(v, "data.missions.update", "data:missions:write", |s, a, c| missions::update(
        s,
        a,
        &c.arg("missionId")?,
        c.arg("patch")?
    ));
    ps!(v, "data.missions.delete", "data:missions:write", |s, a, c| missions::delete(s, a, &c.arg("missionId")?));
    v.push(MethodSpec::new("data.missions.memberAdd", PermReq::One("data:missions:write"), |env: &HostEnv, c: &HostCall| {
        let s = env.store(c)?;
        let db = env.core.app_db()?;
        json(missions::member_add_from_definition(&s, &db, &c.actor(), &c.arg("missionId")?, c.arg("input")?)?)
    }));
    ps!(v, "data.missions.memberUpdate", "data:missions:write", |s, a, c| missions::member_update(
        s,
        a,
        &c.arg("missionId")?,
        &c.arg::<String>("memberRef")?,
        c.arg("patch")?
    ));
    ps!(v, "data.missions.memberRemove", "data:missions:write", |s, a, c| missions::member_remove(
        s,
        a,
        &c.arg("missionId")?,
        &c.arg::<String>("memberRef")?
    ));
    ps!(v, "data.missions.messages", "data:missions:read", |s, _a, c| missions::messages(
        s,
        &c.arg("missionId")?,
        &c.arg_or_default("query")?
    ));
    ps!(v, "data.missions.send", "data:missions:write", |s, a, c| missions::send_message(
        s,
        a,
        &c.arg("missionId")?,
        c.arg("message")?
    ));
    ps!(v, "data.missions.activity", "data:missions:read", |s, _a, c| missions::activity(
        s,
        &c.arg("missionId")?,
        c.opt::<Id>("since")?.as_ref(),
        c.opt("limit")?
    ));
    v.push(MethodSpec::new("data.missions.assignIssues", PermReq::Fn(missions_and_issues_write), |env: &HostEnv, c: &HostCall| {
        let s = env.store(c)?;
        json(missions::assign_issues(&s, &c.actor(), &c.arg("missionId")?, &c.arg::<Vec<String>>("issueRefs")?)?)
    }));
    v.push(MethodSpec::new(
        "data.missions.claimNextIssue",
        PermReq::Fn(missions_and_issues_write),
        |env: &HostEnv, c: &HostCall| {
            let s = env.store(c)?;
            json(missions::claim_next_issue(&s, &c.actor(), &c.arg("missionId")?, &c.arg::<String>("memberRef")?)?)
        },
    ));
    // API 1.4: proposal decisions, merge-queue status, activity notes, read markers.
    ps!(v, "data.missions.proposalSetStatus", "data:missions:write", |s, a, c| missions::proposal_update_status(
        s,
        a,
        &c.arg("missionId")?,
        &c.arg("proposalId")?,
        c.arg("status")?
    ));
    ps!(v, "data.missions.mergeUpdate", "data:missions:write", |s, a, c| missions::merge_update(
        s,
        a,
        &c.arg("missionId")?,
        &c.arg("entryId")?,
        c.arg("patch")?
    ));
    ps!(v, "data.missions.logActivity", "data:missions:write", |s, a, c| missions::log_activity(
        s,
        a,
        &c.arg("missionId")?,
        c.arg("activity")?
    ));
    ps!(v, "data.missions.markRead", "data:missions:write", |s, a, c| missions::mark_read(
        s,
        a,
        &c.arg("missionId")?,
        &c.arg::<String>("reader")?,
        c.opt::<Id>("upTo")?.as_ref()
    ));
    ps!(v, "data.missions.templates.list", "data:missions:read", |s, _a, c| missions::templates_list(s));
    ps!(v, "data.missions.templates.upsert", "data:missions:write", |s, a, c| missions::template_upsert(
        s,
        a,
        c.arg("template")?
    ));
    ps!(v, "data.missions.templates.delete", "data:missions:write", |s, a, c| missions::template_delete(
        s,
        a,
        &c.arg("templateId")?
    ));
    app!(v, "data.missions.agentDefinitions.list", "data:missions:read", |e, _c| missions::agent_definitions_list(
        &*e.core.app_db()?
    ));
    app!(v, "data.missions.agentDefinitions.upsert", "data:missions:write", |e, c| {
        let def: agent_definitions::AgentDefinitionInput = c.arg("definition")?;
        if let Some(m) = def.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            missions::validate_model(m)?;
        }
        agent_definitions::upsert(&*e.core.app_db()?, def)
    });
    app!(v, "data.missions.agentDefinitions.delete", "data:missions:write", |e, c| agent_definitions::delete(
        &*e.core.app_db()?,
        &c.arg("id")?
    ));

    // ---- project config + watchers (no data permission) ----
    v.push(MethodSpec::new("data.projectConfig.get", PermReq::None, |env: &HostEnv, c: &HostCall| {
        json(project_config::read(&*env.store(c)?)?)
    }));
    v.push(MethodSpec::new("data.projectConfig.update", PermReq::One("project:config:write"), |env: &HostEnv, c: &HostCall| {
        json(project_config::update(&*env.store(c)?, &c.actor(), c.arg("patch")?)?)
    }));
    v.push(MethodSpec::new("data.watchProject", PermReq::None, |env: &HostEnv, c: &HostCall| {
        let root = env.project_root(c)?;
        env.core.watch_project(&root)?;
        Ok(Value::Null)
    }));

    v
}

fn plans_and_issues(_: &HostEnv, c: &HostCall) -> Result<Vec<String>> {
    // `PermReq::Fn` returns alternatives; both are required here, so check
    // issues inline and leave plans to the table.
    c.require("data:issues:write")?;
    Ok(vec!["data:plans:write".into()])
}

fn missions_and_issues_read(_: &HostEnv, c: &HostCall) -> Result<Vec<String>> {
    c.require("data:issues:read")?;
    Ok(vec!["data:missions:read".into()])
}

fn missions_and_issues_write(_: &HostEnv, c: &HostCall) -> Result<Vec<String>> {
    c.require("data:issues:write")?;
    Ok(vec!["data:missions:write".into()])
}

/// Permission domain of a change-event domain (`None` = not exposed to plugins,
/// `Some("")` = no permission needed).
fn event_permission(d: Domain) -> Option<&'static str> {
    Some(match d {
        Domain::ProjectConfig => "",
        Domain::Ideas => "data:ideas:read",
        Domain::Issues | Domain::Epics | Domain::Labels => "data:issues:read",
        Domain::Plans => "data:plans:read",
        Domain::Discovery => "data:discovery:read",
        Domain::Scripts | Domain::ScriptGroups | Domain::Environments => "data:scripts:read",
        Domain::Ship | Domain::ShipRuns => "data:ship:read",
        Domain::Missions | Domain::MissionMessages | Domain::MissionActivity | Domain::MissionTemplates
        | Domain::AgentDefinitions => "data:missions:read",
        // `settings`: only the `chat/*` keys (the endpoint config) — see [`visible_event`].
        Domain::Chat | Domain::Settings => "data:chat:read",
        _ => return None,
    })
}

/// The part of `e` a plugin subscriber sees: `settings` events are narrowed to
/// the `chat/<key>` ids (API 1.4; other namespaces are not plugin data). `None` = drop.
fn visible_event(e: &ChangeEvent) -> Option<std::borrow::Cow<'_, ChangeEvent>> {
    if e.domain != Domain::Settings || e.ids.is_empty() {
        return Some(std::borrow::Cow::Borrowed(e));
    }
    let ids: Vec<String> = e.ids.iter().filter(|i| i.starts_with("chat/")).cloned().collect();
    if ids.is_empty() {
        return None;
    }
    Some(std::borrow::Cow::Owned(ChangeEvent { ids, ..e.clone() }))
}

fn on_did_change_perm(_: &HostEnv, c: &HostCall) -> Result<Vec<String>> {
    let domains: Vec<Domain> = parse_domains(c)?;
    for d in &domains {
        match event_permission(*d) {
            None => {
                return Err(CoreError::invalid_input(format!("data.onDidChange: domain {:?} is not available to plugins", d.as_str())))
            }
            Some("") => {}
            Some(p) => c.require(p)?,
        }
    }
    Ok(vec![])
}

fn parse_domains(c: &HostCall) -> Result<Vec<Domain>> {
    let v = c.params.get("domain").cloned().unwrap_or(Value::Null);
    let list: Vec<Domain> = match v {
        Value::Array(_) => serde_json::from_value(v),
        Value::Null => return Err(CoreError::invalid_input("data.onDidChange: `domain` is required")),
        other => serde_json::from_value(other).map(|d| vec![d]),
    }
    .map_err(|e| CoreError::invalid_input(format!("data.onDidChange: domain: {e}")))?;
    if list.is_empty() {
        return Err(CoreError::invalid_input("data.onDidChange: `domain` is empty"));
    }
    Ok(list)
}

/// Drops the bus subscription when the guard is dropped.
struct BusSub(crate::events::EventBus, crate::events::SubscriptionId);
impl Drop for BusSub {
    fn drop(&mut self) {
        self.0.unsubscribe(self.1);
    }
}

pub(super) fn topics() -> Vec<TopicSpec> {
    let mut v = Vec::new();

    v.push(TopicSpec::new("data.onDidChange", PermReq::Fn(on_did_change_perm), |env: &HostEnv, c: &HostCall, sink: Sink| {
        let domains = parse_domains(c)?;
        let root_key: Option<String> = match c.opt::<String>("projectRoot")? {
            Some(r) if !r.trim().is_empty() => Some(crate::paths::root_key(std::path::Path::new(&r))),
            _ => None,
        };
        let bus = env.core.bus.clone();
        let id = bus.subscribe(move |e: &ChangeEvent| {
            if !domains.contains(&e.domain) {
                return;
            }
            if let Some(k) = &root_key {
                if !matches!(&e.scope, ChangeScope::Project { root_key, .. } if root_key == k) {
                    return;
                }
            }
            let Some(e) = visible_event(e) else { return };
            if let Ok(v) = serde_json::to_value(&*e) {
                sink(v);
            }
        });
        Ok(SubscriptionGuard::new(BusSub(env.core.bus.clone(), id)))
    }));

    // ship.run: stream `{event}` items, then `{done: ShipRun}` or `{error}`.
    v.push(TopicSpec::new("data.ship.run", PermReq::One("data:ship:write"), |env: &HostEnv, c: &HostCall, sink: Sink| {
        let store = env.store(c)?;
        let options: ship::ShipRunOptions = c.arg("options")?;
        let actor = c.actor();
        std::thread::spawn(move || {
            let s = PluginShipSink(sink.clone());
            let res = ship::run(&store, &actor, options, &s);
            finish(&sink, res);
        });
        Ok(SubscriptionGuard::none())
    }));

    // ship.runFix (API 1.4): the check's own fix command (never an arbitrary one);
    // stream `{event: ShipLineEvent}` items, then `{done: ShipReadinessCheck}` / `{error}`.
    v.push(TopicSpec::new("data.ship.runFix", PermReq::One("data:ship:write"), |env: &HostEnv, c: &HostCall, sink: Sink| {
        let store = env.store(c)?;
        let check_id: String = c.arg("checkId")?;
        std::thread::spawn(move || {
            let line = |l: ship::ShipLineEvent| {
                if let Ok(v) = serde_json::to_value(l) {
                    sink(j!({ "event": v }));
                }
            };
            let res = ship::run_fix(&store, &check_id, &line);
            finish(&sink, res);
        });
        Ok(SubscriptionGuard::none())
    }));

    // chat.send: stream `{event: ChatStreamEvent}` items, then `{done}` / `{error}`.
    v.push(TopicSpec::new("data.chat.send", PermReq::One("data:chat:write"), |env: &HostEnv, c: &HostCall, sink: Sink| {
        let core = Arc::clone(&env.core);
        let secrets = env.secrets.clone();
        let id: Id = c.arg("id")?;
        let content: String = c.arg("content")?;
        std::thread::spawn(move || {
            let res = core.app_db().and_then(|db| {
                let ev = |e: chat::ChatStreamEvent| {
                    if let Ok(v) = serde_json::to_value(e) {
                        sink(j!({ "event": v }));
                    }
                };
                chat::send(&db, &secrets, &id, &content, &ev)
            });
            finish(&sink, res);
        });
        Ok(SubscriptionGuard::none())
    }));

    v
}

fn finish<T: serde::Serialize>(sink: &Sink, res: Result<T>) {
    match res.and_then(json) {
        Ok(v) => sink(j!({ "done": v })),
        Err(e) => sink(j!({ "error": e })),
    }
}

struct PluginShipSink(Sink);

impl ship::ShipSink for PluginShipSink {
    fn phase(&self, event: ship::ShipPhaseEvent) {
        self.send(ship::ShipRunEvent::Phase { event });
    }
    fn line(&self, event: ship::ShipLineEvent) {
        self.send(ship::ShipRunEvent::Line { event });
    }
    fn external(&self, req: ship::ShipExternalRequest, cancel: &ship::ShipCancel) -> ship::ShipExternalOutcome {
        // The plugin answers with `data.ship.externalComplete(requestId, result)`.
        ship::external_roundtrip(req, cancel, |request| {
            self.send(ship::ShipRunEvent::ExternalRequest { request });
            Ok(())
        })
    }
    fn restored_backups(&self, files: &[String]) {
        self.send(ship::ShipRunEvent::RestoredBackups { files: files.to_vec() });
    }
}

impl PluginShipSink {
    fn send(&self, e: ship::ShipRunEvent) {
        if let Ok(v) = serde_json::to_value(e) {
            (self.0)(j!({ "event": v }));
        }
    }
}
