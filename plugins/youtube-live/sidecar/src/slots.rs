//! Slot machine rules: weighted reels (with lucky hour), pay table, free spins,
//! progressive jackpot. Shared by chat `!pull` commands and the demo pull.

use crate::db::YouTubeLiveDatabase;
use crate::models::SlotPull;
use crate::settings::YouTubeSettings;
use crate::util::{chrono_now_iso, gen_id};
use rand::Rng;

const FALLBACK_SLOT_SYMBOLS: &[&str] = &["cherry", "lemon", "orange", "plum", "bell", "bar", "seven"];

fn uniform_fallback(rng: &mut impl Rng) -> Vec<String> {
    (0..3).map(|_| FALLBACK_SLOT_SYMBOLS[rng.gen_range(0..FALLBACK_SLOT_SYMBOLS.len())].to_string()).collect()
}

fn in_lucky_hour(s: &YouTubeSettings, now_hhmm: &str) -> bool {
    if !s.slot_lucky_hour_enabled {
        return false;
    }
    let (start, end) = (s.slot_lucky_hour_start.as_str(), s.slot_lucky_hour_end.as_str());
    if start <= end {
        now_hhmm >= start && now_hhmm < end
    } else {
        // Wraps midnight (e.g., 23:00 - 01:00)
        now_hhmm >= start || now_hhmm < end
    }
}

/// Weighted pick of `(name, weight)` reels. Non-positive weights never win; if no
/// symbol has a positive weight the pick is uniform (the old code called
/// `gen_range(0..0)` and panicked when all weights summed to 0).
pub fn pick_weighted(rng: &mut impl Rng, symbols: &[(String, i64)]) -> Option<String> {
    if symbols.is_empty() {
        return None;
    }
    let total: i64 = symbols.iter().map(|(_, w)| (*w).max(0)).sum();
    if total <= 0 {
        return Some(symbols[rng.gen_range(0..symbols.len())].0.clone());
    }
    let mut roll = rng.gen_range(0..total);
    for (name, w) in symbols {
        roll -= (*w).max(0);
        if roll < 0 {
            return Some(name.clone());
        }
    }
    symbols.last().map(|(n, _)| n.clone())
}

/// Three reels from the DB's enabled symbols (weights boosted for rare symbols
/// during lucky hour). Returns `(symbols, is_jackpot)`.
pub fn generate_slot_result(db: &YouTubeLiveDatabase) -> (Vec<String>, bool) {
    let mut rng = rand::thread_rng();
    let db_symbols = db.list_slot_symbols().unwrap_or_default();
    let settings = db.get_settings().ok();
    let now = chrono::Local::now().format("%H:%M").to_string();
    let lucky = settings.as_ref().is_some_and(|s| in_lucky_hour(s, &now));

    let mut weighted: Vec<(String, i64)> = db_symbols.iter().map(|s| (s.name.clone(), s.weight)).collect();
    if lucky && !weighted.is_empty() {
        let boost_pct = settings.as_ref().map_or(50, |s| s.slot_lucky_hour_boost);
        let mut sorted: Vec<i64> = weighted.iter().map(|(_, w)| *w).collect();
        sorted.sort();
        let median = sorted[sorted.len() / 2];
        // Boost symbols at or below the median weight (the rare ones).
        for (_, w) in weighted.iter_mut() {
            if *w <= median {
                *w += *w * boost_pct / 100;
            }
        }
    }

    let symbols: Vec<String> = if weighted.is_empty() {
        uniform_fallback(&mut rng)
    } else {
        (0..3).filter_map(|_| pick_weighted(&mut rng, &weighted)).collect()
    };
    let is_jackpot = symbols.len() == 3 && symbols[0] == symbols[1] && symbols[1] == symbols[2];
    (symbols, is_jackpot)
}

/// What to do when the player cannot pay for the pull.
pub enum OnBroke {
    /// Skip the pull (live chat).
    Skip,
    /// Top up with `starting_points` and retry (demo pulls).
    TopUp,
}

/// Run one pull for `author` end to end (cost, reels, pay table, free spins,
/// progressive pool, stats) and persist it. `None` when skipped (no points).
pub fn run_pull(
    db: &YouTubeLiveDatabase,
    s: &YouTubeSettings,
    author_name: &str,
    author_channel_id: &str,
    video_id: &str,
    on_broke: OnBroke,
) -> std::result::Result<Option<SlotPull>, String> {
    let is_free_spin = db.get_free_spins(author_channel_id) > 0;
    let mut points_change: Option<i64> = None;
    let mut new_balance: Option<i64> = None;

    if is_free_spin {
        let _ = db.use_free_spin(author_channel_id);
    } else if s.slot_pull_cost > 0 {
        match db.deduct_pull_cost(author_channel_id, s.slot_pull_cost, None) {
            Ok(stats) => {
                points_change = Some(-s.slot_pull_cost);
                new_balance = Some(stats.points);
            }
            Err(_) => match on_broke {
                OnBroke::Skip => return Ok(None),
                OnBroke::TopUp => {
                    let _ = db.award_points(author_channel_id, s.starting_points, "starting_bonus", None);
                    let stats = db
                        .deduct_pull_cost(author_channel_id, s.slot_pull_cost, None)
                        .map_err(|e| format!("Failed to deduct pull cost: {}", e))?;
                    points_change = Some(-s.slot_pull_cost);
                    new_balance = Some(stats.points);
                }
            },
        }
    }

    // Progressive jackpot: contribute a percentage of the pull cost.
    if s.progressive_jackpot_enabled && !is_free_spin && s.slot_pull_cost > 0 {
        let contribution = s.slot_pull_cost * s.progressive_contribution_pct / 100;
        if contribution > 0 {
            let _ = db.contribute_to_progressive(contribution);
        }
    }

    let (symbols, is_jackpot) = generate_slot_result(db);
    let pull_id = gen_id();
    let mut prize_log_id: Option<String> = None;
    let mut prize_name: Option<String> = None;
    let mut free_spins_won: i64 = 0;
    let add_points = |pts: i64, reason: &str, reference: Option<&str>, change: &mut Option<i64>, bal: &mut Option<i64>| {
        if let Ok(stats) = db.award_points(author_channel_id, pts, reason, reference) {
            *change = Some(change.unwrap_or(0) + pts);
            *bal = Some(stats.points);
        }
    };

    let match_type = if let Ok(Some(entry)) = db.evaluate_paytable(&symbols) {
        prize_name = entry.prize_name.clone();
        // Payouts are multiples of the pull cost (points_amount is the multiplier).
        let mut pts = entry.points_amount * s.slot_pull_cost.max(1);
        if s.slot_symbol_of_day_enabled {
            if let Ok(Some((sotd, mult))) = db.get_symbol_of_day() {
                if is_jackpot && symbols.iter().any(|x| x == &sotd) {
                    pts *= mult;
                }
            }
        }
        if pts > 0 {
            add_points(pts, "slot_prize", Some(&pull_id), &mut points_change, &mut new_balance);
        }
        if entry.prize_type == "real" {
            if let Ok(log_entry) = db.create_prize_log(
                &pull_id,
                &entry.id,
                author_channel_id,
                author_name,
                &entry.prize_type,
                pts,
                entry.prize_name.as_deref(),
                entry.prize_description.as_deref(),
            ) {
                prize_log_id = Some(log_entry.id);
            }
        }
        if entry.free_spins_awarded > 0 {
            free_spins_won = entry.free_spins_awarded;
            let _ = db.add_free_spins(author_channel_id, free_spins_won);
        }
        Some(entry.match_type.clone())
    } else if is_jackpot && s.slot_jackpot_bonus > 0 {
        // Fallback: legacy jackpot bonus (also a multiplier of the pull cost).
        let bonus = s.slot_jackpot_bonus * s.slot_pull_cost.max(1);
        add_points(bonus, "slot_jackpot", None, &mut points_change, &mut new_balance);
        Some("triple_any".to_string())
    } else {
        Some("none".to_string())
    };

    // Progressive jackpot: a jackpot wins the pool.
    let mut progressive_won: Option<i64> = None;
    if s.progressive_jackpot_enabled && is_jackpot {
        if let Ok(pool) = db.award_progressive_jackpot(author_name, s.progressive_seed_amount) {
            progressive_won = Some(pool);
            add_points(pool, "progressive_jackpot", Some(&pull_id), &mut points_change, &mut new_balance);
        }
    }
    let current_pool = if s.progressive_jackpot_enabled { db.get_progressive_pool().ok() } else { None };

    let _ = db.record_pull(author_channel_id, is_jackpot);
    let free_spins_remaining = db.get_free_spins(author_channel_id);

    let pull = SlotPull {
        id: pull_id,
        video_id: video_id.to_string(),
        author_name: author_name.to_string(),
        author_channel_id: author_channel_id.to_string(),
        symbols,
        is_jackpot,
        created_at: chrono_now_iso(),
        points_change,
        new_balance,
        match_type,
        prize_log_id,
        prize_name,
        is_free_spin: Some(is_free_spin),
        free_spins_remaining: Some(free_spins_remaining),
        free_spins_won: if free_spins_won > 0 { Some(free_spins_won) } else { None },
        progressive_pool: progressive_won.or(current_pool),
    };
    db.save_slot_pull(&pull).map_err(|e| format!("Failed to save slot pull: {e}"))?;
    Ok(Some(pull))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weighted_pick_never_panics_on_zero_weights() {
        let mut rng = rand::thread_rng();
        let zero = vec![("a".to_string(), 0), ("b".to_string(), 0)];
        for _ in 0..50 {
            assert!(pick_weighted(&mut rng, &zero).is_some());
        }
        let neg = vec![("a".to_string(), -5), ("b".to_string(), 3)];
        for _ in 0..50 {
            assert_eq!(pick_weighted(&mut rng, &neg).as_deref(), Some("b"));
        }
        assert_eq!(pick_weighted(&mut rng, &[]), None);
    }

    #[test]
    fn all_zero_weight_symbols_still_spin() {
        let db = crate::db::test_db();
        for s in db.list_all_slot_symbols().unwrap() {
            db.update_slot_symbol(&s.id, None, None, Some(0), None, None).unwrap();
        }
        let (symbols, _) = generate_slot_result(&db);
        assert_eq!(symbols.len(), 3);
    }

    #[test]
    fn demo_pull_charges_and_persists() {
        let db = crate::db::test_db();
        let s = db.get_settings().unwrap();
        db.get_or_create_user_stats("c1", "Ada", s.starting_points).unwrap();
        let pull = run_pull(&db, &s, "Ada", "c1", "test-video", OnBroke::TopUp).unwrap().unwrap();
        assert_eq!(pull.symbols.len(), 3);
        assert!(pull.points_change.is_some());
        assert_eq!(db.list_slot_pulls(None, 10).unwrap().len(), 1);
    }

    #[test]
    fn live_pull_without_points_is_skipped() {
        let db = crate::db::test_db();
        let s = db.update_settings(&serde_json::json!({ "starting_points": 0, "slot_pull_cost": 10 })).unwrap();
        db.get_or_create_user_stats("c2", "Bob", 0).unwrap();
        assert!(run_pull(&db, &s, "Bob", "c2", "v", OnBroke::Skip).unwrap().is_none());
    }

    #[test]
    fn lucky_hour_window_wraps_midnight() {
        let s = YouTubeSettings {
            slot_lucky_hour_enabled: true,
            slot_lucky_hour_start: "23:00".into(),
            slot_lucky_hour_end: "01:00".into(),
            ..Default::default()
        };
        assert!(in_lucky_hour(&s, "23:30"));
        assert!(in_lucky_hour(&s, "00:30"));
        assert!(!in_lucky_hour(&s, "12:00"));
    }
}
