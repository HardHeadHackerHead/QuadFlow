use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
    pub commit: String,
    pub is_bare: bool,
    pub is_main: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeStatus {
    pub path: String,
    pub branch: String,
    pub is_dirty: bool,
    pub staged_files: Vec<String>,
    pub unstaged_files: Vec<String>,
    pub untracked_files: Vec<String>,
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MergeResult {
    pub success: bool,
    pub conflict_files: Vec<String>,
    pub message: String,
}

fn git(args: &[&str], cwd: &str) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(stderr)
    }
}

fn git_allow_fail(args: &[&str], cwd: &str) -> Result<(bool, String, String), String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok((output.status.success(), stdout, stderr))
}

/// Validate that a path is a git repository
fn ensure_git_repo(project_dir: &str) -> Result<(), String> {
    git(&["rev-parse", "--git-dir"], project_dir)
        .map(|_| ())
        .map_err(|_| format!("'{}' is not a git repository", project_dir))
}

/// Create a new git worktree for an agent branch
#[tauri::command]
pub async fn create_worktree(
    project_dir: String,
    branch_name: String,
    worktree_path: String,
) -> Result<WorktreeInfo, String> {
    // Filesystem / process work: blocking pool, never the main thread.
    tauri::async_runtime::spawn_blocking(move || create_worktree_blocking(project_dir, branch_name, worktree_path))
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

fn create_worktree_blocking(
    project_dir: String,
    branch_name: String,
    worktree_path: String,
) -> Result<WorktreeInfo, String> {
    ensure_git_repo(&project_dir)?;

    // Normalize paths for git (forward slashes)
    let wt_path = worktree_path.replace('\\', "/");

    // Check if branch already exists
    let branch_exists = git(
        &["rev-parse", "--verify", &format!("refs/heads/{}", branch_name)],
        &project_dir,
    )
    .is_ok();

    if branch_exists {
        // Add worktree for existing branch
        git(
            &["worktree", "add", &wt_path, &branch_name],
            &project_dir,
        )
        .map_err(|e| format!("Failed to create worktree for existing branch: {}", e))?;
    } else {
        // Create new branch + worktree in one command
        git(
            &["worktree", "add", "-b", &branch_name, &wt_path],
            &project_dir,
        )
        .map_err(|e| format!("Failed to create worktree with new branch: {}", e))?;
    }

    // Get the HEAD commit of the new worktree
    let commit = git(&["rev-parse", "HEAD"], &worktree_path).unwrap_or_default();

    Ok(WorktreeInfo {
        path: worktree_path,
        branch: branch_name,
        commit,
        is_bare: false,
        is_main: false,
    })
}

/// List all worktrees for a project
#[tauri::command]
pub async fn list_worktrees(project_dir: String) -> Result<Vec<WorktreeInfo>, String> {
    // Filesystem / process work: blocking pool, never the main thread.
    tauri::async_runtime::spawn_blocking(move || list_worktrees_blocking(project_dir))
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

fn list_worktrees_blocking(project_dir: String) -> Result<Vec<WorktreeInfo>, String> {
    ensure_git_repo(&project_dir)?;

    let output = git(&["worktree", "list", "--porcelain"], &project_dir)?;

    let mut worktrees = Vec::new();
    let mut current_path = String::new();
    let mut current_branch = String::new();
    let mut current_commit = String::new();
    let mut is_bare = false;
    let mut first = true;

    for line in output.lines() {
        if line.is_empty() {
            if !current_path.is_empty() {
                worktrees.push(WorktreeInfo {
                    path: current_path.clone(),
                    branch: current_branch.clone(),
                    commit: current_commit.clone(),
                    is_bare,
                    is_main: first,
                });
                first = false;
            }
            current_path = String::new();
            current_branch = String::new();
            current_commit = String::new();
            is_bare = false;
        } else if let Some(p) = line.strip_prefix("worktree ") {
            current_path = p.to_string();
        } else if let Some(b) = line.strip_prefix("branch refs/heads/") {
            current_branch = b.to_string();
        } else if let Some(c) = line.strip_prefix("HEAD ") {
            current_commit = c.to_string();
        } else if line == "bare" {
            is_bare = true;
        } else if line == "detached" {
            current_branch = "(detached)".to_string();
        }
    }

    // Flush last entry
    if !current_path.is_empty() {
        worktrees.push(WorktreeInfo {
            path: current_path,
            branch: current_branch,
            commit: current_commit,
            is_bare,
            is_main: first,
        });
    }

    Ok(worktrees)
}

/// Delete a worktree and optionally its branch
#[tauri::command]
pub async fn delete_worktree(
    project_dir: String,
    worktree_path: String,
    force: bool,
    delete_branch: bool,
) -> Result<(), String> {
    // Filesystem / process work: blocking pool, never the main thread.
    tauri::async_runtime::spawn_blocking(move || delete_worktree_blocking(project_dir, worktree_path, force, delete_branch))
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

fn delete_worktree_blocking(
    project_dir: String,
    worktree_path: String,
    force: bool,
    delete_branch: bool,
) -> Result<(), String> {
    ensure_git_repo(&project_dir)?;

    // Get branch name before deleting worktree
    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"], &worktree_path).ok();

    let wt_path = worktree_path.replace('\\', "/");

    if force {
        git(&["worktree", "remove", "--force", &wt_path], &project_dir)
            .map_err(|e| format!("Failed to force-remove worktree: {}", e))?;
    } else {
        git(&["worktree", "remove", &wt_path], &project_dir)
            .map_err(|e| format!("Failed to remove worktree (use force=true if dirty): {}", e))?;
    }

    // Optionally delete the branch
    if delete_branch {
        if let Some(b) = branch {
            if b != "main" && b != "master" && b != "HEAD" && !b.is_empty() {
                let _ = git(&["branch", "-D", &b], &project_dir);
            }
        }
    }

    // Prune stale worktree references
    let _ = git(&["worktree", "prune"], &project_dir);

    Ok(())
}

/// Get status of a worktree — dirty/clean, changed files
#[tauri::command]
pub async fn get_worktree_status(worktree_path: String) -> Result<WorktreeStatus, String> {
    // Filesystem / process work: blocking pool, never the main thread.
    tauri::async_runtime::spawn_blocking(move || get_worktree_status_blocking(worktree_path))
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

fn get_worktree_status_blocking(worktree_path: String) -> Result<WorktreeStatus, String> {
    if !Path::new(&worktree_path).exists() {
        return Err(format!("Worktree path does not exist: {}", worktree_path));
    }

    let branch = git(&["rev-parse", "--abbrev-ref", "HEAD"], &worktree_path)
        .unwrap_or_else(|_| "(unknown)".to_string());

    // git status --porcelain gives machine-readable output
    let status_output = git(&["status", "--porcelain"], &worktree_path).unwrap_or_default();

    let mut staged_files = Vec::new();
    let mut unstaged_files = Vec::new();
    let mut untracked_files = Vec::new();

    for line in status_output.lines() {
        if line.len() < 3 {
            continue;
        }
        let xy = &line[..2];
        let file = line[3..].to_string();

        let x = xy.chars().next().unwrap_or(' ');
        let y = xy.chars().nth(1).unwrap_or(' ');

        if x != ' ' && x != '?' {
            staged_files.push(file.clone());
        }
        if y != ' ' && y != '?' {
            unstaged_files.push(file.clone());
        }
        if xy == "??" {
            untracked_files.push(file);
        }
    }

    let is_dirty = !staged_files.is_empty() || !unstaged_files.is_empty();

    // Get ahead/behind relative to origin (best effort)
    let (ahead, behind) = get_ahead_behind(&worktree_path, &branch);

    Ok(WorktreeStatus {
        path: worktree_path,
        branch,
        is_dirty,
        staged_files,
        unstaged_files,
        untracked_files,
        ahead,
        behind,
    })
}

fn get_ahead_behind(worktree_path: &str, branch: &str) -> (u32, u32) {
    let remote_branch = format!("origin/{}", branch);
    let result = git(
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("{}...{}", branch, remote_branch),
        ],
        worktree_path,
    );

    if let Ok(counts) = result {
        let parts: Vec<&str> = counts.split_whitespace().collect();
        if parts.len() == 2 {
            let ahead = parts[0].parse().unwrap_or(0);
            let behind = parts[1].parse().unwrap_or(0);
            return (ahead, behind);
        }
    }
    (0, 0)
}

/// Merge a source branch into target branch with conflict detection.
/// Returns success=true if clean merge, or success=false with conflict_files list.
#[tauri::command]
pub async fn merge_worktree_branch(
    project_dir: String,
    source_branch: String,
    target_branch: String,
    commit_message: Option<String>,
) -> Result<MergeResult, String> {
    // Filesystem / process work: blocking pool, never the main thread.
    tauri::async_runtime::spawn_blocking(move || merge_worktree_branch_blocking(project_dir, source_branch, target_branch, commit_message))
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

fn merge_worktree_branch_blocking(
    project_dir: String,
    source_branch: String,
    target_branch: String,
    commit_message: Option<String>,
) -> Result<MergeResult, String> {
    ensure_git_repo(&project_dir)?;

    // Switch to target branch
    git(&["checkout", &target_branch], &project_dir)
        .map_err(|e| format!("Failed to checkout target branch '{}': {}", target_branch, e))?;

    let msg = commit_message.unwrap_or_else(|| {
        format!("Merge agent branch '{}'", source_branch)
    });

    // Attempt merge with no-ff to keep history clear
    let (success, _stdout, stderr) = git_allow_fail(
        &["merge", "--no-ff", "-m", &msg, &source_branch],
        &project_dir,
    )?;

    if success {
        return Ok(MergeResult {
            success: true,
            conflict_files: vec![],
            message: format!("Successfully merged '{}' into '{}'", source_branch, target_branch),
        });
    }

    // Merge failed — check if it's conflicts
    if stderr.contains("CONFLICT") || stderr.contains("conflict") {
        // Get list of conflicting files
        let conflict_output = git(&["diff", "--name-only", "--diff-filter=U"], &project_dir)
            .unwrap_or_default();

        let conflict_files: Vec<String> = conflict_output
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| l.to_string())
            .collect();

        // Abort the merge so the repo is clean
        let _ = git(&["merge", "--abort"], &project_dir);

        return Ok(MergeResult {
            success: false,
            conflict_files,
            message: format!(
                "Merge conflict detected between '{}' and '{}'. Merge aborted.",
                source_branch, target_branch
            ),
        });
    }

    // Some other error
    Err(format!("Merge failed: {}", stderr))
}

/// Prune stale worktree references (cleanup after delete)
#[tauri::command]
pub async fn prune_worktrees(project_dir: String) -> Result<(), String> {
    // Filesystem / process work: blocking pool, never the main thread.
    tauri::async_runtime::spawn_blocking(move || prune_worktrees_blocking(project_dir))
        .await
        .map_err(|e| format!("task failed: {e}"))?
}

fn prune_worktrees_blocking(project_dir: String) -> Result<(), String> {
    ensure_git_repo(&project_dir)?;
    git(&["worktree", "prune"], &project_dir).map(|_| ())
}
