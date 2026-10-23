use super::YouTubeLiveDatabase;
use crate::error::{Result, YouTubeLiveError};
use crate::models::*;
use crate::util::*;

impl YouTubeLiveDatabase {
    // ---- Slot Pulls ----

    pub fn save_slot_pull(&self, pull: &SlotPull) -> Result<()> {
        let symbols_json = serde_json::to_string(&pull.symbols)
            .map_err(|e| YouTubeLiveError::Json(e.to_string()))?;
        self.conn.execute(
            "INSERT INTO youtube_slot_pulls (id, video_id, author_name, author_channel_id, symbols, is_jackpot, created_at, prize_log_id, match_type, is_free_spin, free_spins_remaining, free_spins_won, progressive_pool)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                pull.id, pull.video_id, pull.author_name, pull.author_channel_id,
                symbols_json, pull.is_jackpot as i64, pull.created_at,
                pull.prize_log_id, pull.match_type,
                pull.is_free_spin.map(|v| v as i64).unwrap_or(0),
                pull.free_spins_remaining.unwrap_or(0),
                pull.free_spins_won.unwrap_or(0),
                pull.progressive_pool
            ],
        )?;
        Ok(())
    }

    pub fn list_slot_pulls(&self, video_id: Option<&str>, limit: i64) -> Result<Vec<SlotPull>> {
        let (sql, params): (String, Vec<Box<dyn rusqlite::types::ToSql>>) = match video_id {
            Some(vid) => (
                "SELECT id, video_id, author_name, author_channel_id, symbols, is_jackpot, created_at, prize_log_id, match_type, is_free_spin, free_spins_remaining, free_spins_won, progressive_pool
                 FROM youtube_slot_pulls WHERE video_id = ?1
                 ORDER BY created_at DESC LIMIT ?2".to_string(),
                vec![Box::new(vid.to_string()) as Box<dyn rusqlite::types::ToSql>,
                     Box::new(limit)],
            ),
            None => (
                "SELECT id, video_id, author_name, author_channel_id, symbols, is_jackpot, created_at, prize_log_id, match_type, is_free_spin, free_spins_remaining, free_spins_won, progressive_pool
                 FROM youtube_slot_pulls
                 ORDER BY created_at DESC LIMIT ?1".to_string(),
                vec![Box::new(limit) as Box<dyn rusqlite::types::ToSql>],
            ),
        };

        let mut stmt = self.conn.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let pulls = stmt.query_map(param_refs.as_slice(), |row| {
            let symbols_str: String = row.get(4)?;
            let symbols: Vec<String> = serde_json::from_str(&symbols_str).unwrap_or_default();
            let is_jackpot_int: i64 = row.get(5)?;
            let is_free_spin_int: i64 = row.get::<_, i64>(9).unwrap_or(0);
            Ok(SlotPull {
                id: row.get(0)?,
                video_id: row.get(1)?,
                author_name: row.get(2)?,
                author_channel_id: row.get(3)?,
                symbols,
                is_jackpot: is_jackpot_int != 0,
                created_at: row.get(6)?,
                points_change: None,
                new_balance: None,
                prize_log_id: row.get(7)?,
                match_type: row.get(8)?,
                prize_name: None,
                is_free_spin: Some(is_free_spin_int != 0),
                free_spins_remaining: row.get(10).ok(),
                free_spins_won: row.get(11).ok(),
                progressive_pool: row.get(12).ok(),
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(pulls)
    }

    // ---- Slot Symbols ----

    pub(super) fn seed_default_symbols(&self) {
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM youtube_slot_symbols", [], |row| row.get(0)
        ).unwrap_or(0);
        if count > 0 { return; }

        // (name, emoji, weight, sort_order) — lower weight = rarer
        let defaults = vec![
            ("seven", "7\u{FE0F}\u{20E3}", 1, 0),
            ("bar", "\u{1F32D}", 2, 1),
            ("bell", "\u{1F514}", 3, 2),
            ("plum", "\u{1FAD0}", 5, 3),
            ("orange", "\u{1F34A}", 8, 4),
            ("lemon", "\u{1F34B}", 12, 5),
            ("cherry", "\u{1F352}", 15, 6),
        ];

        for (name, emoji, weight, sort_order) in defaults {
            let _ = self.conn.execute(
                "INSERT INTO youtube_slot_symbols (id, name, emoji, weight, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![gen_id(), name, emoji, weight, sort_order],
            );
        }
    }

    pub fn list_slot_symbols(&self) -> Result<Vec<SlotSymbol>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, emoji, weight, enabled, is_wild, sort_order, created_at, updated_at
             FROM youtube_slot_symbols WHERE enabled = 1 ORDER BY weight ASC"
        )?;
        let symbols = stmt.query_map([], |row| {
            let enabled_int: i64 = row.get(4)?;
            let is_wild_int: i64 = row.get(5)?;
            Ok(SlotSymbol {
                id: row.get(0)?,
                name: row.get(1)?,
                emoji: row.get(2)?,
                weight: row.get(3)?,
                enabled: enabled_int != 0,
                is_wild: is_wild_int != 0,
                sort_order: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(symbols)
    }

    pub fn list_all_slot_symbols(&self) -> Result<Vec<SlotSymbol>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, emoji, weight, enabled, is_wild, sort_order, created_at, updated_at
             FROM youtube_slot_symbols ORDER BY weight ASC"
        )?;
        let symbols = stmt.query_map([], |row| {
            let enabled_int: i64 = row.get(4)?;
            let is_wild_int: i64 = row.get(5)?;
            Ok(SlotSymbol {
                id: row.get(0)?,
                name: row.get(1)?,
                emoji: row.get(2)?,
                weight: row.get(3)?,
                enabled: enabled_int != 0,
                is_wild: is_wild_int != 0,
                sort_order: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(symbols)
    }

    pub fn create_slot_symbol(&self, name: &str, emoji: &str, weight: i64, is_wild: bool) -> Result<SlotSymbol> {
        let id = gen_id();
        let now = chrono_now_iso();
        let max_order: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM youtube_slot_symbols", [], |row| row.get(0)
        ).unwrap_or(0);
        self.conn.execute(
            "INSERT INTO youtube_slot_symbols (id, name, emoji, weight, is_wild, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![id, name, emoji, weight, is_wild as i64, max_order, now, now],
        )?;
        Ok(SlotSymbol {
            id,
            name: name.to_string(),
            emoji: emoji.to_string(),
            weight,
            enabled: true,
            is_wild,
            sort_order: max_order,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn update_slot_symbol(
        &self,
        id: &str,
        name: Option<&str>,
        emoji: Option<&str>,
        weight: Option<i64>,
        enabled: Option<bool>,
        is_wild: Option<bool>,
    ) -> Result<SlotSymbol> {
        let now = chrono_now_iso();
        if let Some(v) = name {
            self.conn.execute("UPDATE youtube_slot_symbols SET name = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        if let Some(v) = emoji {
            self.conn.execute("UPDATE youtube_slot_symbols SET emoji = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        if let Some(v) = weight {
            self.conn.execute("UPDATE youtube_slot_symbols SET weight = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        if let Some(v) = enabled {
            self.conn.execute("UPDATE youtube_slot_symbols SET enabled = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v as i64, now, id])?;
        }
        if let Some(v) = is_wild {
            self.conn.execute("UPDATE youtube_slot_symbols SET is_wild = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v as i64, now, id])?;
        }
        let mut stmt = self.conn.prepare(
            "SELECT id, name, emoji, weight, enabled, is_wild, sort_order, created_at, updated_at
             FROM youtube_slot_symbols WHERE id = ?1"
        )?;
        let symbol = stmt.query_row([id], |row| {
            let enabled_int: i64 = row.get(4)?;
            let is_wild_int: i64 = row.get(5)?;
            Ok(SlotSymbol {
                id: row.get(0)?,
                name: row.get(1)?,
                emoji: row.get(2)?,
                weight: row.get(3)?,
                enabled: enabled_int != 0,
                is_wild: is_wild_int != 0,
                sort_order: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;
        Ok(symbol)
    }

    pub fn delete_slot_symbol(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM youtube_slot_symbols WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---- Pay Table ----

    pub(super) fn seed_default_paytable(&self) {
        // Only seed if the table is empty
        let count: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM youtube_slot_paytable", [], |row| row.get(0)
        ).unwrap_or(0);
        if count > 0 { return; }

        // points_amount is a multiplier of the pull cost (e.g., 77 = 77x pull cost)
        let defaults = vec![
            (10, "triple_specific", Some("seven"), "points", 77, Some("Triple Sevens"), Some("The ultimate jackpot!")),
            (20, "triple_specific", Some("bar"), "points", 20, Some("Triple Bars"), Some("Bar combo!")),
            (30, "triple_specific", Some("bell"), "points", 15, Some("Triple Bells"), Some("Ring the bells!")),
            (40, "triple_specific", Some("plum"), "points", 10, Some("Triple Plums"), None),
            (50, "triple_specific", Some("orange"), "points", 8, Some("Triple Oranges"), None),
            (60, "triple_specific", Some("lemon"), "points", 5, Some("Triple Lemons"), None),
            (70, "triple_specific", Some("cherry"), "points", 5, Some("Triple Cherries"), None),
            (100, "triple_any", None, "points", 50, Some("Any Triple"), Some("Three of a kind!")),
            (200, "partial", None, "points", 1, Some("Partial Match"), Some("Two matching symbols")),
        ];

        for (priority, match_type, symbol, prize_type, points, name, desc) in defaults {
            let _ = self.conn.execute(
                "INSERT INTO youtube_slot_paytable (id, priority, match_type, symbol, prize_type, points_amount, prize_name, prize_description)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    gen_id(), priority, match_type, symbol, prize_type, points, name, desc
                ],
            );
        }
    }

    pub fn list_paytable_entries(&self) -> Result<Vec<PayTableEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, priority, match_type, symbol, prize_type, points_amount, prize_name, prize_description, enabled, created_at, updated_at, free_spins_awarded
             FROM youtube_slot_paytable ORDER BY priority ASC"
        )?;
        let entries = stmt.query_map([], |row| {
            let enabled_int: i64 = row.get(8)?;
            Ok(PayTableEntry {
                id: row.get(0)?,
                priority: row.get(1)?,
                match_type: row.get(2)?,
                symbol: row.get(3)?,
                prize_type: row.get(4)?,
                points_amount: row.get(5)?,
                prize_name: row.get(6)?,
                prize_description: row.get(7)?,
                enabled: enabled_int != 0,
                free_spins_awarded: row.get::<_, i64>(11).unwrap_or(0),
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    pub fn create_paytable_entry(
        &self,
        priority: i64,
        match_type: &str,
        symbol: Option<&str>,
        prize_type: &str,
        points_amount: i64,
        prize_name: Option<&str>,
        prize_description: Option<&str>,
        free_spins_awarded: Option<i64>,
    ) -> Result<PayTableEntry> {
        let id = gen_id();
        let now = chrono_now_iso();
        let spins = free_spins_awarded.unwrap_or(0);
        self.conn.execute(
            "INSERT INTO youtube_slot_paytable (id, priority, match_type, symbol, prize_type, points_amount, prize_name, prize_description, free_spins_awarded, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![id, priority, match_type, symbol, prize_type, points_amount, prize_name, prize_description, spins, now, now],
        )?;
        Ok(PayTableEntry {
            id,
            priority,
            match_type: match_type.to_string(),
            symbol: symbol.map(String::from),
            prize_type: prize_type.to_string(),
            points_amount,
            prize_name: prize_name.map(String::from),
            prize_description: prize_description.map(String::from),
            enabled: true,
            free_spins_awarded: spins,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn update_paytable_entry(
        &self,
        id: &str,
        priority: Option<i64>,
        match_type: Option<&str>,
        symbol: Option<Option<&str>>,
        prize_type: Option<&str>,
        points_amount: Option<i64>,
        prize_name: Option<Option<&str>>,
        prize_description: Option<Option<&str>>,
        enabled: Option<bool>,
        free_spins_awarded: Option<i64>,
    ) -> Result<PayTableEntry> {
        let now = chrono_now_iso();
        if let Some(v) = priority {
            self.conn.execute("UPDATE youtube_slot_paytable SET priority = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        if let Some(v) = match_type {
            self.conn.execute("UPDATE youtube_slot_paytable SET match_type = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        if let Some(v) = symbol {
            self.conn.execute("UPDATE youtube_slot_paytable SET symbol = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        if let Some(v) = prize_type {
            self.conn.execute("UPDATE youtube_slot_paytable SET prize_type = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        if let Some(v) = points_amount {
            self.conn.execute("UPDATE youtube_slot_paytable SET points_amount = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        if let Some(v) = prize_name {
            self.conn.execute("UPDATE youtube_slot_paytable SET prize_name = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        if let Some(v) = prize_description {
            self.conn.execute("UPDATE youtube_slot_paytable SET prize_description = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        if let Some(v) = enabled {
            self.conn.execute("UPDATE youtube_slot_paytable SET enabled = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v as i64, now, id])?;
        }
        if let Some(v) = free_spins_awarded {
            self.conn.execute("UPDATE youtube_slot_paytable SET free_spins_awarded = ?1, updated_at = ?2 WHERE id = ?3", rusqlite::params![v, now, id])?;
        }
        // Fetch and return updated entry
        let mut stmt = self.conn.prepare(
            "SELECT id, priority, match_type, symbol, prize_type, points_amount, prize_name, prize_description, enabled, created_at, updated_at, free_spins_awarded
             FROM youtube_slot_paytable WHERE id = ?1"
        )?;
        let entry = stmt.query_row([id], |row| {
            let enabled_int: i64 = row.get(8)?;
            Ok(PayTableEntry {
                id: row.get(0)?,
                priority: row.get(1)?,
                match_type: row.get(2)?,
                symbol: row.get(3)?,
                prize_type: row.get(4)?,
                points_amount: row.get(5)?,
                prize_name: row.get(6)?,
                prize_description: row.get(7)?,
                enabled: enabled_int != 0,
                free_spins_awarded: row.get::<_, i64>(11).unwrap_or(0),
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })?;
        Ok(entry)
    }

    pub fn delete_paytable_entry(&self, id: &str) -> Result<()> {
        self.conn.execute("DELETE FROM youtube_slot_paytable WHERE id = ?1", [id])?;
        Ok(())
    }

    // ---- Progressive Jackpot Pool ----

    pub fn get_progressive_pool(&self) -> Result<i64> {
        let pool: i64 = self.conn.query_row(
            "SELECT current_pool FROM youtube_slot_progressive WHERE id = 1", [], |row| row.get(0)
        ).unwrap_or(100);
        Ok(pool)
    }

    pub fn contribute_to_progressive(&self, amount: i64) -> Result<i64> {
        self.conn.execute(
            "UPDATE youtube_slot_progressive SET current_pool = current_pool + ?1, total_contributed = total_contributed + ?1 WHERE id = 1",
            [amount],
        )?;
        self.get_progressive_pool()
    }

    pub fn award_progressive_jackpot(&self, winner_name: &str, seed_amount: i64) -> Result<i64> {
        let pool = self.get_progressive_pool()?;
        self.conn.execute(
            "UPDATE youtube_slot_progressive SET current_pool = ?1, total_paid_out = total_paid_out + ?2, last_winner_name = ?3, last_winner_at = ?4, times_won = times_won + 1 WHERE id = 1",
            rusqlite::params![seed_amount, pool, winner_name, chrono_now_iso()],
        )?;
        Ok(pool)
    }

    // ---- Free Spins ----

    pub fn get_free_spins(&self, author_channel_id: &str) -> i64 {
        self.conn.query_row(
            "SELECT free_spins_remaining FROM youtube_user_stats WHERE author_channel_id = ?1",
            [author_channel_id],
            |row| row.get::<_, i64>(0),
        ).unwrap_or(0)
    }

    pub fn add_free_spins(&self, author_channel_id: &str, count: i64) -> Result<i64> {
        self.conn.execute(
            "UPDATE youtube_user_stats SET free_spins_remaining = free_spins_remaining + ?1 WHERE author_channel_id = ?2",
            rusqlite::params![count, author_channel_id],
        )?;
        Ok(self.get_free_spins(author_channel_id))
    }

    pub fn use_free_spin(&self, author_channel_id: &str) -> Result<i64> {
        self.conn.execute(
            "UPDATE youtube_user_stats SET free_spins_remaining = MAX(0, free_spins_remaining - 1) WHERE author_channel_id = ?1",
            [author_channel_id],
        )?;
        Ok(self.get_free_spins(author_channel_id))
    }

    // ---- Symbol of the Day ----

    pub fn get_symbol_of_day(&self) -> Result<Option<(String, i64)>> {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        match self.conn.query_row(
            "SELECT symbol_name, multiplier FROM youtube_slot_daily WHERE date = ?1",
            [&today],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        ) {
            Ok(result) => Ok(Some(result)),
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                // Pick a random enabled symbol
                let symbols = self.list_slot_symbols()?;
                if symbols.is_empty() { return Ok(None); }
                use rand::Rng;
                let idx = rand::thread_rng().gen_range(0..symbols.len());
                let sym = &symbols[idx];
                let settings = self.get_settings()?;
                let multiplier = settings.slot_symbol_of_day_multiplier;
                self.conn.execute(
                    "INSERT OR IGNORE INTO youtube_slot_daily (date, symbol_name, multiplier) VALUES (?1, ?2, ?3)",
                    rusqlite::params![today, sym.name, multiplier],
                )?;
                Ok(Some((sym.name.clone(), multiplier)))
            }
            Err(e) => Err(e.into()),
        }
    }

    pub fn evaluate_paytable(&self, symbols: &[String]) -> Result<Option<PayTableEntry>> {
        let entries = self.list_paytable_entries()?;

        // Get wild symbol names
        let wild_names: Vec<String> = self.list_slot_symbols()
            .unwrap_or_default()
            .into_iter()
            .filter(|s| s.is_wild)
            .map(|s| s.name)
            .collect();

        let is_wild = |s: &str| wild_names.iter().any(|w| w == s);

        // For matching purposes, resolve wilds: find the "effective" symbol each position represents
        // A wild matches anything, so we resolve to the first non-wild symbol
        let s = &symbols;
        if s.len() != 3 { return Ok(None); }

        // Check if all three match (considering wilds)
        let matches = |a: &str, b: &str| -> bool {
            a == b || is_wild(a) || is_wild(b)
        };
        let is_triple = matches(&s[0], &s[1]) && matches(&s[1], &s[2]) && matches(&s[0], &s[2]);

        // For triple_specific, find the non-wild symbol that everything matches to
        let effective_symbol = if is_triple {
            s.iter().find(|sym| !is_wild(sym)).map(|sym| sym.as_str())
        } else {
            None
        };

        let has_partial = !is_triple && (
            matches(&s[0], &s[1]) || matches(&s[1], &s[2]) || matches(&s[0], &s[2])
        );

        for entry in entries {
            if !entry.enabled { continue; }
            match entry.match_type.as_str() {
                "triple_specific" => {
                    if is_triple {
                        if let Some(ref sym) = entry.symbol {
                            if let Some(eff) = effective_symbol {
                                if eff == sym.as_str() {
                                    return Ok(Some(entry));
                                }
                            } else {
                                // All wilds — match the first triple_specific entry
                                return Ok(Some(entry));
                            }
                        }
                    }
                }
                "triple_any" => {
                    if is_triple {
                        return Ok(Some(entry));
                    }
                }
                "partial" => {
                    if has_partial {
                        return Ok(Some(entry));
                    }
                }
                _ => {}
            }
        }
        Ok(None)
    }

    // ---- Prize Log ----

    pub fn create_prize_log(
        &self,
        pull_id: &str,
        paytable_entry_id: &str,
        author_channel_id: &str,
        author_name: &str,
        prize_type: &str,
        points_awarded: i64,
        prize_name: Option<&str>,
        prize_description: Option<&str>,
    ) -> Result<PrizeLogEntry> {
        let id = gen_id();
        let now = chrono_now_iso();
        self.conn.execute(
            "INSERT INTO youtube_prize_log (id, pull_id, paytable_entry_id, author_channel_id, author_name, prize_type, points_awarded, prize_name, prize_description, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![id, pull_id, paytable_entry_id, author_channel_id, author_name, prize_type, points_awarded, prize_name, prize_description, now],
        )?;
        Ok(PrizeLogEntry {
            id,
            pull_id: Some(pull_id.to_string()),
            paytable_entry_id: Some(paytable_entry_id.to_string()),
            author_channel_id: author_channel_id.to_string(),
            author_name: author_name.to_string(),
            prize_type: prize_type.to_string(),
            points_awarded,
            prize_name: prize_name.map(String::from),
            prize_description: prize_description.map(String::from),
            redeemed: false,
            redeemed_at: None,
            redeemed_note: None,
            created_at: now,
        })
    }

    pub fn list_prize_log(&self, limit: i64, offset: i64, unredeemed_only: bool) -> Result<Vec<PrizeLogEntry>> {
        let sql = if unredeemed_only {
            "SELECT id, pull_id, paytable_entry_id, author_channel_id, author_name, prize_type, points_awarded, prize_name, prize_description, redeemed, redeemed_at, redeemed_note, created_at
             FROM youtube_prize_log WHERE redeemed = 0 ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
        } else {
            "SELECT id, pull_id, paytable_entry_id, author_channel_id, author_name, prize_type, points_awarded, prize_name, prize_description, redeemed, redeemed_at, redeemed_note, created_at
             FROM youtube_prize_log ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
        };
        let mut stmt = self.conn.prepare(sql)?;
        let entries = stmt.query_map(rusqlite::params![limit, offset], |row| {
            let redeemed_int: i64 = row.get(9)?;
            Ok(PrizeLogEntry {
                id: row.get(0)?,
                pull_id: row.get(1)?,
                paytable_entry_id: row.get(2)?,
                author_channel_id: row.get(3)?,
                author_name: row.get(4)?,
                prize_type: row.get(5)?,
                points_awarded: row.get(6)?,
                prize_name: row.get(7)?,
                prize_description: row.get(8)?,
                redeemed: redeemed_int != 0,
                redeemed_at: row.get(10)?,
                redeemed_note: row.get(11)?,
                created_at: row.get(12)?,
            })
        })?.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(entries)
    }

    pub fn mark_prize_redeemed(&self, id: &str, note: Option<&str>) -> Result<PrizeLogEntry> {
        let now = chrono_now_iso();
        self.conn.execute(
            "UPDATE youtube_prize_log SET redeemed = 1, redeemed_at = ?1, redeemed_note = ?2 WHERE id = ?3",
            rusqlite::params![now, note, id],
        )?;
        let mut stmt = self.conn.prepare(
            "SELECT id, pull_id, paytable_entry_id, author_channel_id, author_name, prize_type, points_awarded, prize_name, prize_description, redeemed, redeemed_at, redeemed_note, created_at
             FROM youtube_prize_log WHERE id = ?1"
        )?;
        let entry = stmt.query_row([id], |row| {
            let redeemed_int: i64 = row.get(9)?;
            Ok(PrizeLogEntry {
                id: row.get(0)?,
                pull_id: row.get(1)?,
                paytable_entry_id: row.get(2)?,
                author_channel_id: row.get(3)?,
                author_name: row.get(4)?,
                prize_type: row.get(5)?,
                points_awarded: row.get(6)?,
                prize_name: row.get(7)?,
                prize_description: row.get(8)?,
                redeemed: redeemed_int != 0,
                redeemed_at: row.get(10)?,
                redeemed_note: row.get(11)?,
                created_at: row.get(12)?,
            })
        })?;
        Ok(entry)
    }

    pub fn count_unredeemed_prizes(&self) -> Result<i64> {
        let count = self.conn.query_row(
            "SELECT COUNT(*) FROM youtube_prize_log WHERE redeemed = 0", [], |row| row.get(0)
        )?;
        Ok(count)
    }


    // ---- Dashboards ----

    /// Progressive pool with its history (`youtube_get_progressive_pool`).
    pub fn progressive_pool_info(&self) -> Result<serde_json::Value> {
        let pool = self.get_progressive_pool()?;
        Ok(self
            .conn
            .query_row(
                "SELECT current_pool, total_contributed, total_paid_out, last_winner_name, last_winner_at, times_won FROM youtube_slot_progressive WHERE id = 1",
                [],
                |row| {
                    Ok(serde_json::json!({
                        "current_pool": row.get::<_, i64>(0)?,
                        "total_contributed": row.get::<_, i64>(1)?,
                        "total_paid_out": row.get::<_, i64>(2)?,
                        "last_winner_name": row.get::<_, Option<String>>(3)?,
                        "last_winner_at": row.get::<_, Option<String>>(4)?,
                        "times_won": row.get::<_, i64>(5)?,
                    }))
                },
            )
            .unwrap_or(serde_json::json!({ "current_pool": pool })))
    }

    /// Slot statistics for the stats panel. (The old command read the
    /// non-existent `youtube_slot_prize_log`, so biggest win was always 0.)
    pub fn slot_stats(&self) -> Result<serde_json::Value> {
        let total_pulls: i64 = self.conn.query_row("SELECT COUNT(*) FROM youtube_slot_pulls", [], |row| row.get(0)).unwrap_or(0);
        let total_jackpots: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM youtube_slot_pulls WHERE is_jackpot = 1", [], |row| row.get(0))
            .unwrap_or(0);
        let (biggest_win, biggest_winner): (i64, Option<String>) = self
            .conn
            .query_row(
                "SELECT amount, author_name FROM (
                     SELECT h.amount AS amount, u.author_name AS author_name
                     FROM youtube_points_history h LEFT JOIN youtube_user_stats u ON u.author_channel_id = h.author_channel_id
                     WHERE h.reason IN ('slot_prize', 'slot_jackpot', 'progressive_jackpot')
                     ORDER BY h.amount DESC LIMIT 1)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((0, None));
        let luckiest_user = self
            .conn
            .query_row(
                "SELECT author_name, COUNT(*) as wins FROM youtube_slot_pulls WHERE is_jackpot = 1 GROUP BY author_channel_id ORDER BY wins DESC LIMIT 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .ok();
        Ok(serde_json::json!({
            "total_pulls": total_pulls,
            "total_jackpots": total_jackpots,
            "jackpot_rate": if total_pulls > 0 { format!("{:.1}%", (total_jackpots as f64 / total_pulls as f64) * 100.0) } else { "0%".to_string() },
            "biggest_win": biggest_win,
            "biggest_winner": biggest_winner,
            "luckiest_user": luckiest_user.as_ref().map(|(name, _)| name.clone()),
            "luckiest_user_wins": luckiest_user.as_ref().map(|(_, wins)| *wins).unwrap_or(0),
        }))
    }
}
