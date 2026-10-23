//! Public URLs of the open-source project. `REPO` is the single place the
//! GitHub `owner/name` is spelled (agent-providers.md §6.1, plugin-system.md §12.1).

/// GitHub repository (`owner/name`) of the QuadFlow repo. While the repo is
/// private, raw fetches fail and callers fall back to bundled data.
pub const REPO: &str = "HardHeadHackerHead/QuadFlow";

/// `false` while [`REPO`] still carries the `OWNER/` placeholder.
pub fn repo_configured() -> bool {
    !REPO.starts_with("OWNER/")
}

/// Raw URL of a file on the repo's default branch.
pub fn raw_default_branch(path: &str) -> String {
    format!("https://raw.githubusercontent.com/{REPO}/HEAD/{}", path.trim_start_matches('/'))
}

#[cfg(test)]
mod tests {
    #[test]
    fn raw_url_shape() {
        assert_eq!(
            super::raw_default_branch("/catalog/models.json"),
            format!("https://raw.githubusercontent.com/{}/HEAD/catalog/models.json", super::REPO)
        );
    }
}
