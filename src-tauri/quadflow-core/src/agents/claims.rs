//! Race-free session discovery (agent-providers.md §8.3): one registry of
//! claimed sessions and FIFO queues of pending launches per `(provider, cwd)`.
//! Under one mutex the oldest unclaimed candidate is assigned to the oldest
//! pending launch, so a session can never be claimed twice.

use super::sessions::AgentSessionInfo;
use crate::model::Timestamp;
use crate::paths::root_key;
use parking_lot::Mutex;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Candidates may be created up to this long before the launch was recorded.
pub const CLOCK_SLACK_MS: Timestamp = 2000;
/// A pending launch older than this becomes `unlinked`.
pub const PENDING_TIMEOUT_MS: Timestamp = 180_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionLink {
    pub terminal_id: String,
    pub provider_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug)]
struct Pending {
    terminal_id: String,
    launched_at_ms: Timestamp,
}

#[derive(Clone, Debug)]
struct Group {
    cwd: PathBuf,
    queue: VecDeque<Pending>,
}

#[derive(Default)]
struct State {
    /// (provider, session) → terminal
    claimed: HashMap<(String, String), String>,
    /// (provider, cwdKey) → FIFO by launchedAt
    pending: BTreeMap<(String, String), Group>,
}

/// One per GUI process.
#[derive(Default)]
pub struct SessionClaims {
    state: Mutex<State>,
}

/// A `(provider, cwd)` with pending launches, as a discovery worker sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct PendingGroup {
    pub provider_id: String,
    pub cwd_key: String,
    pub cwd: PathBuf,
    pub oldest_launched_at_ms: Timestamp,
}

impl SessionClaims {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a launch awaiting its session. Returns `true` when this created a
    /// new group (the caller then starts a worker for it).
    pub fn register_pending(&self, provider_id: &str, cwd: &Path, terminal_id: &str, launched_at_ms: Timestamp) -> bool {
        let mut st = self.state.lock();
        // A terminal waits for at most one session.
        for g in st.pending.values_mut() {
            g.queue.retain(|p| p.terminal_id != terminal_id);
        }
        st.pending.retain(|_, g| !g.queue.is_empty());
        let key = (provider_id.to_string(), root_key(cwd));
        let is_new = !st.pending.contains_key(&key);
        let g = st.pending.entry(key).or_insert_with(|| Group { cwd: cwd.to_path_buf(), queue: VecDeque::new() });
        let pos = g.queue.iter().position(|p| p.launched_at_ms > launched_at_ms).unwrap_or(g.queue.len());
        g.queue.insert(pos, Pending { terminal_id: terminal_id.to_string(), launched_at_ms });
        is_new
    }

    /// Seed a known binding (restore) or a manual link. Fails if another
    /// terminal already holds the session.
    pub fn claim(&self, provider_id: &str, session_id: &str, terminal_id: &str) -> Result<(), String> {
        let mut st = self.state.lock();
        let key = (provider_id.to_string(), session_id.to_string());
        match st.claimed.get(&key) {
            Some(t) if t != terminal_id => Err(t.clone()),
            _ => {
                st.claimed.retain(|(p, _), t| !(p == provider_id && t == terminal_id));
                st.claimed.insert(key, terminal_id.to_string());
                for g in st.pending.values_mut() {
                    g.queue.retain(|p| p.terminal_id != terminal_id);
                }
                st.pending.retain(|_, g| !g.queue.is_empty());
                Ok(())
            }
        }
    }

    /// Closing a terminal: drop its pending entry and release its claims.
    pub fn release_terminal(&self, terminal_id: &str) {
        let mut st = self.state.lock();
        st.claimed.retain(|_, t| t != terminal_id);
        for g in st.pending.values_mut() {
            g.queue.retain(|p| p.terminal_id != terminal_id);
        }
        st.pending.retain(|_, g| !g.queue.is_empty());
    }

    pub fn is_claimed(&self, provider_id: &str, session_id: &str) -> Option<String> {
        self.state.lock().claimed.get(&(provider_id.to_string(), session_id.to_string())).cloned()
    }

    pub fn group(&self, provider_id: &str, cwd_key: &str) -> Option<PendingGroup> {
        let st = self.state.lock();
        st.pending.get(&(provider_id.to_string(), cwd_key.to_string())).and_then(|g| {
            g.queue.front().map(|p| PendingGroup {
                provider_id: provider_id.into(),
                cwd_key: cwd_key.into(),
                cwd: g.cwd.clone(),
                oldest_launched_at_ms: p.launched_at_ms,
            })
        })
    }

    pub fn pending_terminals(&self) -> Vec<String> {
        self.state.lock().pending.values().flat_map(|g| g.queue.iter().map(|p| p.terminal_id.clone())).collect()
    }

    /// Assign unclaimed `candidates` (any order) to pending launches of the
    /// group, oldest-to-oldest. A candidate is only eligible for a launch it was
    /// created after (minus [`CLOCK_SLACK_MS`]).
    pub fn assign(&self, provider_id: &str, cwd_key: &str, candidates: &[AgentSessionInfo]) -> Vec<SessionLink> {
        let mut st = self.state.lock();
        let key = (provider_id.to_string(), cwd_key.to_string());
        let mut cands: Vec<&AgentSessionInfo> = candidates
            .iter()
            .filter(|s| s.provider_id == provider_id && !st.claimed.contains_key(&(provider_id.to_string(), s.id.clone())))
            .collect();
        cands.sort_by(|a, b| a.created_at.cmp(&b.created_at).then(a.id.cmp(&b.id)));
        cands.dedup_by(|a, b| a.id == b.id);
        let mut links = Vec::new();
        let Some(group) = st.pending.get_mut(&key) else { return links };
        for c in cands {
            let Some(front) = group.queue.front() else { break };
            if c.created_at < front.launched_at_ms - CLOCK_SLACK_MS {
                continue; // predates the oldest pending launch
            }
            let p = group.queue.pop_front().expect("front exists");
            links.push(SessionLink { terminal_id: p.terminal_id, provider_id: provider_id.into(), session_id: c.id.clone() });
        }
        if group.queue.is_empty() {
            st.pending.remove(&key);
        }
        for l in &links {
            st.claimed.insert((l.provider_id.clone(), l.session_id.clone()), l.terminal_id.clone());
        }
        links
    }

    /// Remove pending launches older than [`PENDING_TIMEOUT_MS`]; returns their terminals.
    pub fn expire(&self, provider_id: &str, cwd_key: &str, now_ms: Timestamp) -> Vec<String> {
        let mut st = self.state.lock();
        let key = (provider_id.to_string(), cwd_key.to_string());
        let mut gone = Vec::new();
        if let Some(g) = st.pending.get_mut(&key) {
            g.queue.retain(|p| {
                let keep = now_ms - p.launched_at_ms < PENDING_TIMEOUT_MS;
                if !keep {
                    gone.push(p.terminal_id.clone());
                }
                keep
            });
            if g.queue.is_empty() {
                st.pending.remove(&key);
            }
        }
        gone
    }
}

/// Poll interval after `elapsed` since the oldest pending launch (§8.3).
pub fn poll_interval(elapsed_ms: Timestamp) -> Duration {
    match elapsed_ms {
        e if e < 10_000 => Duration::from_millis(500),
        e if e < 60_000 => Duration::from_secs(1),
        _ => Duration::from_secs(2),
    }
}

/// What a discovery worker reports.
#[derive(Clone, Debug, PartialEq)]
pub enum DiscoveryEvent {
    Linked(SessionLink),
    Unlinked { terminal_id: String, provider_id: String },
}

/// One discovery pass for a group: scan, assign, expire. `scan(cwd, since)`
/// lists the provider's sessions. Returns `false` when the group is done.
pub fn discovery_tick(
    claims: &SessionClaims,
    provider_id: &str,
    cwd_key: &str,
    now_ms: Timestamp,
    scan: &dyn Fn(&Path, Timestamp) -> Vec<AgentSessionInfo>,
    emit: &dyn Fn(DiscoveryEvent),
) -> bool {
    let Some(g) = claims.group(provider_id, cwd_key) else { return false };
    let since = g.oldest_launched_at_ms - CLOCK_SLACK_MS;
    let cands = scan(&g.cwd, since);
    for l in claims.assign(provider_id, cwd_key, &cands) {
        emit(DiscoveryEvent::Linked(l));
    }
    for t in claims.expire(provider_id, cwd_key, now_ms) {
        emit(DiscoveryEvent::Unlinked { terminal_id: t, provider_id: provider_id.into() });
    }
    claims.group(provider_id, cwd_key).is_some()
}

/// Run a worker for one group on the current thread until no launch is pending.
pub fn run_discovery(
    claims: &SessionClaims,
    provider_id: &str,
    cwd_key: &str,
    scan: &dyn Fn(&Path, Timestamp) -> Vec<AgentSessionInfo>,
    emit: &dyn Fn(DiscoveryEvent),
) {
    loop {
        let now = crate::time::now_ms();
        if !discovery_tick(claims, provider_id, cwd_key, now, scan, emit) {
            break;
        }
        let Some(g) = claims.group(provider_id, cwd_key) else { break };
        std::thread::sleep(poll_interval(now - g.oldest_launched_at_ms));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::detect::ProcessEnv;
    use crate::agents::sessions::test_util::write_rollout;
    use crate::agents::sessions::SessionScanner;
    use crate::agents::spec::{fixtures, parse_spec};
    use crate::time::now_ms;
    use std::sync::{Arc, Mutex as StdMutex};

    fn sess(id: &str, created: Timestamp) -> AgentSessionInfo {
        AgentSessionInfo {
            provider_id: "beta".into(),
            id: id.into(),
            path: format!("/x/{id}"),
            cwd: Some("/p".into()),
            created_at: created,
            modified_at: created,
            size_bytes: 1,
            title: None,
        }
    }

    #[test]
    fn fifo_assignment_never_double_claims() {
        let c = SessionClaims::new();
        let cwd = Path::new("/p");
        let key = root_key(cwd);
        assert!(c.register_pending("beta", cwd, "t1", 1_000_000));
        assert!(!c.register_pending("beta", cwd, "t2", 1_000_500));
        // Both pollers would have seen the same first session — only one gets it.
        let links = c.assign("beta", &key, &[sess("s1", 1_001_000)]);
        assert_eq!(links, vec![SessionLink { terminal_id: "t1".into(), provider_id: "beta".into(), session_id: "s1".into() }]);
        assert!(c.assign("beta", &key, &[sess("s1", 1_001_000)]).is_empty(), "s1 already claimed");
        let links = c.assign("beta", &key, &[sess("s1", 1_001_000), sess("s2", 1_002_000)]);
        assert_eq!(links.len(), 1);
        assert_eq!((links[0].terminal_id.as_str(), links[0].session_id.as_str()), ("t2", "s2"));
        assert!(c.group("beta", &key).is_none());
    }

    #[test]
    fn old_sessions_ignored_and_expiry() {
        let c = SessionClaims::new();
        let cwd = Path::new("/p");
        let key = root_key(cwd);
        c.register_pending("beta", cwd, "t1", 1_000_000);
        assert!(c.assign("beta", &key, &[sess("old", 990_000)]).is_empty());
        assert!(c.expire("beta", &key, 1_000_000 + 10_000).is_empty());
        assert_eq!(c.expire("beta", &key, 1_000_000 + PENDING_TIMEOUT_MS), vec!["t1".to_string()]);
        assert!(c.group("beta", &key).is_none());
    }

    #[test]
    fn seeded_claims_and_release() {
        let c = SessionClaims::new();
        c.claim("beta", "s1", "t1").unwrap();
        assert_eq!(c.claim("beta", "s1", "t2"), Err("t1".to_string()));
        let cwd = Path::new("/p");
        c.register_pending("beta", cwd, "t2", 0);
        assert!(c.assign("beta", &root_key(cwd), &[sess("s1", 5)]).is_empty(), "restored claim respected");
        c.release_terminal("t1");
        assert_eq!(c.is_claimed("beta", "s1"), None);
        c.release_terminal("t2");
        assert!(c.pending_terminals().is_empty());
    }

    /// Acceptance (README AP-1): two concurrent launches in one cwd get distinct
    /// sessions, with a fake session dir and the real scanner + worker.
    #[test]
    fn two_concurrent_discover_launches_get_distinct_sessions() {
        let home = tempfile::tempdir().unwrap();
        let proj = tempfile::tempdir().unwrap();
        let spec = parse_spec(&fixtures::discover()).unwrap();
        let env = ProcessEnv { home: Some(home.path().into()), ..Default::default() };
        let sdir = home.path().join(".beta/sessions");
        // A session from before the launches must not be claimed.
        write_rollout(&sdir, "00000000-0000-4000-8000-000000000000", proj.path());
        std::thread::sleep(Duration::from_millis(2100 + 50));

        let claims = Arc::new(SessionClaims::new());
        let t0 = now_ms();
        let key = root_key(proj.path());
        assert!(claims.register_pending("beta", proj.path(), "term-a", t0));
        assert!(!claims.register_pending("beta", proj.path(), "term-b", t0 + 1));

        let events = Arc::new(StdMutex::new(Vec::new()));
        let scanner = Arc::new(SessionScanner::new());
        let worker = {
            let (claims, events, scanner, spec, env, key) =
                (claims.clone(), events.clone(), scanner.clone(), spec.clone(), env.clone(), key.clone());
            std::thread::spawn(move || {
                let scan = |cwd: &Path, since: Timestamp| scanner.list(&spec, cwd, Some(since), &env).unwrap();
                let emit = |e: DiscoveryEvent| events.lock().unwrap().push(e);
                run_discovery(&claims, "beta", &key, &scan, &emit);
            })
        };
        // Both agents write their session files "simultaneously".
        std::thread::sleep(Duration::from_millis(300));
        let a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        write_rollout(&sdir, a, proj.path());
        write_rollout(&sdir, b, proj.path());
        worker.join().unwrap();

        let ev = events.lock().unwrap().clone();
        let linked: Vec<_> = ev
            .iter()
            .filter_map(|e| match e {
                DiscoveryEvent::Linked(l) => Some((l.terminal_id.clone(), l.session_id.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(linked.len(), 2, "{ev:?}");
        assert_ne!(linked[0].1, linked[1].1, "distinct sessions");
        assert_ne!(linked[0].0, linked[1].0, "distinct terminals");
        assert!(linked.iter().all(|(_, s)| s == a || s == b), "pre-existing session never claimed");
        assert_eq!(claims.is_claimed("beta", a).is_some() as u8 + claims.is_claimed("beta", b).is_some() as u8, 2);
    }

    #[test]
    fn intervals() {
        assert_eq!(poll_interval(0), Duration::from_millis(500));
        assert_eq!(poll_interval(30_000), Duration::from_secs(1));
        assert_eq!(poll_interval(120_000), Duration::from_secs(2));
    }
}
