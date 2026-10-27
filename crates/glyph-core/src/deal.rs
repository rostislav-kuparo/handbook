//! Dealing out the written variants of a letter so the same one does not turn
//! up again and again.
//!
//! Drawing each letter at random repeats a lot: with three variants every
//! third «1» looks like the one before. Instead every key remembers the order
//! in which its variants were last used (in reading order, carried from one
//! paragraph to the next). The next letter takes a variant that fits its
//! place and was not used yet, and once all were, one of the least recently
//! used half (the longer ago, the likelier: about every other time the
//! oldest). So all of them turn up before any repeats, a variant comes back
//! only after about half of the others did, and never twice in a row while
//! there is another one.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::rng::Rng;

/// Per key, the indices of its samples in the order they were last used,
/// the most recent last. Serialized as `{ "м": [3, 0, 5], … }`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Deal(pub(crate) BTreeMap<String, Vec<usize>>);

impl Deal {
    /// One of `pool` (sample indices of `key`) for the next letter, remembered as used.
    pub fn pick(&mut self, key: &str, pool: &[usize], rng: &mut Rng) -> usize {
        if pool.is_empty() {
            return 0;
        }
        let recent = self.0.entry(key.to_string()).or_default();
        // Never used first (in random order), then from the longest ago.
        let mut order: Vec<(Option<usize>, u64, usize)> =
            pool.iter().map(|&i| (recent.iter().position(|&r| r == i), rng.next_u64(), i)).collect();
        order.sort_unstable();
        let fresh = order.iter().take_while(|o| o.0.is_none()).count();
        let pick = if fresh > 0 {
            order[rng.below(fresh)].2
        } else {
            // The least recently used half, each one half as likely as the one used before it.
            let h = pool.len().div_ceil(2);
            let mut r = rng.f64() * (2.0 - 0.5f64.powi(h as i32 - 1));
            let mut j = 0;
            while j + 1 < h && r >= 0.5f64.powi(j as i32) {
                r -= 0.5f64.powi(j as i32);
                j += 1;
            }
            order[j].2
        };
        recent.retain(|&r| r != pick);
        recent.push(pick);
        pick
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deal(pool: &[usize], n: usize, seed: u64) -> Vec<usize> {
        let mut d = Deal::default();
        let mut rng = Rng::new(seed);
        (0..n).map(|_| d.pick("м", pool, &mut rng)).collect()
    }

    #[test]
    fn never_the_same_twice_in_a_row() {
        for seed in 0..50 {
            for pool in [vec![0, 1], vec![4, 7, 9], (0..9).collect()] {
                let got = deal(&pool, 40, seed);
                assert!(got.windows(2).all(|w| w[0] != w[1]), "{pool:?}: {got:?}");
                assert!(got.iter().all(|i| pool.contains(i)));
            }
        }
    }

    #[test]
    fn every_variant_turns_up_and_none_comes_back_too_soon() {
        let pool: Vec<usize> = (0..9).collect();
        for seed in 0..50 {
            let got = deal(&pool, 30, seed);
            let first: std::collections::BTreeSet<usize> = got[..9].iter().copied().collect();
            assert_eq!(first.len(), 9, "the first nine letters show all nine variants: {got:?}");
            let counts: Vec<usize> = pool.iter().map(|v| got.iter().filter(|g| *g == v).count()).collect();
            assert!(counts.iter().all(|&c| (2..=5).contains(&c)), "evenly used: {counts:?}");
            // A variant waits at least ⌈9/2⌉ - 1 = 4 others before it may return.
            for (k, v) in got.iter().enumerate() {
                assert!(got[k + 1..(k + 5).min(got.len())].iter().all(|w| w != v), "{v} back too soon: {got:?}");
            }
        }
    }

    #[test]
    fn memory_is_shared_across_places_in_the_word() {
        // The middle of a word uses 0–2, a lone letter 0–5: the lone one avoids what the middle just used.
        let mut d = Deal::default();
        let mut rng = Rng::new(3);
        let mid: Vec<usize> = (0..3).map(|_| d.pick("м", &[0, 1, 2], &mut rng)).collect();
        let lone = d.pick("м", &[0, 1, 2, 3, 4, 5], &mut rng);
        assert!(!mid.contains(&lone), "{mid:?} then {lone}");
    }

    #[test]
    fn round_trips_as_json() {
        let mut d = Deal::default();
        let mut rng = Rng::new(1);
        d.pick("м", &[0, 1, 2], &mut rng);
        d.pick("ст", &[0], &mut rng);
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.starts_with('{') && json.contains("\"ст\""), "{json}");
        assert_eq!(serde_json::from_str::<Deal>(&json).unwrap(), d);
    }
}
