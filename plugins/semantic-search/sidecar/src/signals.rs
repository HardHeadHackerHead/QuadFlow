//! Signal detection for semantic search quality improvements
//! Detects success/failure signals, extracts file paths, and identifies task types

use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

/// Metadata extracted from a conversation for search quality improvement
#[derive(Debug, Clone, Default)]
pub struct ConversationSignals {
    /// Whether the conversation contains success indicators
    pub has_success_signal: bool,
    /// Whether the conversation contains failure indicators
    pub has_failure_signal: bool,
    /// File paths mentioned in the conversation
    pub files_mentioned: Vec<String>,
    /// Detected task type (debug, feature, refactor, etc.)
    pub task_type: Option<String>,
}

/// Success indicator phrases (case-insensitive)
const SUCCESS_PHRASES: &[&str] = &[
    "that worked",
    "that works",
    "it worked",
    "it works",
    "working now",
    "works now",
    "thanks",
    "thank you",
    "perfect",
    "awesome",
    "great",
    "excellent",
    "fixed",
    "solved",
    "that did it",
    "that's it",
    "exactly what i needed",
    "looks good",
    "lgtm",
    "ship it",
    "all good",
    "nice work",
    "well done",
];

/// Failure indicator phrases (case-insensitive)
const FAILURE_PHRASES: &[&str] = &[
    "doesn't work",
    "does not work",
    "didn't work",
    "did not work",
    "not working",
    "still broken",
    "still failing",
    "same error",
    "same issue",
    "still getting",
    "that didn't help",
    "that doesn't help",
    "no luck",
    "still stuck",
    "nevermind",
    "never mind",
    "forget it",
    "let's try something else",
    "different approach",
    "wrong",
    "incorrect",
    "that's not right",
    "not what i wanted",
];

/// Task type indicators
const DEBUG_INDICATORS: &[&str] = &[
    "bug", "error", "fix", "debug", "crash", "broken", "issue", "problem",
    "exception", "stack trace", "failing", "doesn't work", "not working",
];

const FEATURE_INDICATORS: &[&str] = &[
    "add", "create", "implement", "build", "new feature", "feature",
    "want to", "need to", "should be able to",
];

const REFACTOR_INDICATORS: &[&str] = &[
    "refactor", "clean up", "reorganize", "restructure", "improve",
    "optimize", "performance", "simplify", "extract",
];

const RESEARCH_INDICATORS: &[&str] = &[
    "how does", "what is", "explain", "understand", "learn",
    "documentation", "example", "tutorial",
];

/// Extract signals from conversation content
pub fn extract_signals(content: &str) -> ConversationSignals {
    let content_lower = content.to_lowercase();

    ConversationSignals {
        has_success_signal: detect_success(&content_lower),
        has_failure_signal: detect_failure(&content_lower),
        files_mentioned: extract_file_paths(content),
        task_type: detect_task_type(&content_lower),
    }
}

/// Detect success signals in content
fn detect_success(content: &str) -> bool {
    SUCCESS_PHRASES.iter().any(|phrase| content.contains(phrase))
}

/// Detect failure signals in content
fn detect_failure(content: &str) -> bool {
    FAILURE_PHRASES.iter().any(|phrase| content.contains(phrase))
}

/// Extract file paths from content
pub fn extract_file_paths(content: &str) -> Vec<String> {
    static FILE_PATH_REGEX: OnceLock<Regex> = OnceLock::new();
    let file_path_regex = FILE_PATH_REGEX.get_or_init(|| Regex::new(
            r#"(?x)
            # Match paths with extensions
            (?:^|[\s\(\[\{'"`:])  # Start of line or common delimiters
            (
                # Absolute or relative paths
                (?:[a-zA-Z]:)?  # Optional drive letter (Windows)
                (?:[/\\])?  # Optional leading slash
                (?:[\w.-]+[/\\])*  # Directory components
                [\w.-]+  # Filename
                \.  # Dot before extension
                (?:ts|tsx|js|jsx|rs|py|go|java|cpp|c|h|hpp|css|scss|html|json|yaml|yml|toml|md|txt|sql|sh|bash|ps1|vue|svelte)  # Common extensions
            )
            (?:$|[\s\)\]\}'"`:,])  # End of line or common delimiters
            "#
        ).unwrap());

    let mut paths: HashSet<String> = HashSet::new();

    for cap in file_path_regex.captures_iter(content) {
        if let Some(path) = cap.get(1) {
            let path_str = path.as_str().to_string();
            // Normalize path separators
            let normalized = path_str.replace('\\', "/");
            // Skip very short paths that are likely false positives
            if normalized.len() > 4 && !normalized.starts_with("http") {
                paths.insert(normalized);
            }
        }
    }

    // Also look for paths in backticks (common in markdown)
    static BACKTICK_PATH_REGEX: OnceLock<Regex> = OnceLock::new();
    let backtick_regex = BACKTICK_PATH_REGEX.get_or_init(|| {
        Regex::new(r#"`([^`\s]+\.(?:ts|tsx|js|jsx|rs|py|go|java|cpp|c|h|hpp|css|scss|html|json|yaml|yml|toml|md|sql))`"#).unwrap()
    });

    for cap in backtick_regex.captures_iter(content) {
        if let Some(path) = cap.get(1) {
            let path_str = path.as_str().to_string();
            let normalized = path_str.replace('\\', "/");
            if normalized.len() > 4 {
                paths.insert(normalized);
            }
        }
    }

    paths.into_iter().collect()
}

/// Detect task type from content
fn detect_task_type(content: &str) -> Option<String> {
    // Count indicators for each type
    let debug_count = DEBUG_INDICATORS.iter().filter(|&ind| content.contains(ind)).count();
    let feature_count = FEATURE_INDICATORS.iter().filter(|&ind| content.contains(ind)).count();
    let refactor_count = REFACTOR_INDICATORS.iter().filter(|&ind| content.contains(ind)).count();
    let research_count = RESEARCH_INDICATORS.iter().filter(|&ind| content.contains(ind)).count();

    // Return the type with most indicators, if any
    let max_count = debug_count.max(feature_count).max(refactor_count).max(research_count);

    if max_count < 2 {
        return None; // Not enough signal
    }

    if debug_count == max_count {
        Some("debug".to_string())
    } else if feature_count == max_count {
        Some("feature".to_string())
    } else if refactor_count == max_count {
        Some("refactor".to_string())
    } else if research_count == max_count {
        Some("research".to_string())
    } else {
        None
    }
}

/// Check if a set of files overlaps with mentioned files
pub fn files_overlap(current_files: &[String], mentioned_files: &[String]) -> bool {
    if current_files.is_empty() || mentioned_files.is_empty() {
        return false;
    }

    // Normalize paths for comparison
    let normalize = |p: &str| -> String {
        p.replace('\\', "/")
            .trim_start_matches("./")
            .trim_start_matches("/")
            .to_lowercase()
    };

    let current_set: HashSet<String> = current_files.iter().map(|p| normalize(p)).collect();

    for mentioned in mentioned_files {
        let normalized = normalize(mentioned);
        // Check exact match
        if current_set.contains(&normalized) {
            return true;
        }
        // Check if mentioned file ends with any current file (partial path match)
        for current in &current_set {
            if normalized.ends_with(current) || current.ends_with(&normalized) {
                return true;
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_success_detection() {
        assert!(detect_success("that worked perfectly, thanks!"));
        assert!(detect_success("it works now"));
        assert!(!detect_success("let me try this"));
    }

    #[test]
    fn test_failure_detection() {
        assert!(detect_failure("that doesn't work"));
        assert!(detect_failure("still getting the same error"));
        assert!(!detect_failure("let me try this"));
    }

    #[test]
    fn test_file_path_extraction() {
        let content = "Check the file at src/auth/login.ts and also utils/helpers.rs";
        let paths = extract_file_paths(content);
        assert!(paths.contains(&"src/auth/login.ts".to_string()));
        assert!(paths.contains(&"utils/helpers.rs".to_string()));
    }

    #[test]
    fn test_task_type_detection() {
        assert_eq!(detect_task_type("fix this bug in the error handling"), Some("debug".to_string()));
        assert_eq!(detect_task_type("add a new feature for user auth"), Some("feature".to_string()));
    }

    #[test]
    fn test_files_overlap() {
        let current = vec!["src/auth/login.ts".to_string()];
        let mentioned = vec!["login.ts".to_string()];
        assert!(files_overlap(&current, &mentioned));

        let no_match = vec!["other/file.rs".to_string()];
        assert!(!files_overlap(&current, &no_match));
    }
}
