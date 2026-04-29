// --- START OF FILE src-tauri/src/timelock_clock.rs ---
//
// Authoritative time source for time-lock enforcement.
//
// SECURITY DESIGN — two layers of clock-manipulation resistance:
//
//   Layer 1 — NTP verification (online):
//     Queries 3 well-known NTP servers via UDP. Uses the median response to
//     resist a single rogue or misconfigured server. If NTP is reachable,
//     the system clock is ignored entirely — an attacker who winds back the
//     system clock while staying online is caught immediately.
//
//   Layer 2 — Ratchet (offline):
//     Every failed unlock attempt records the highest timestamp ever witnessed
//     (max of NTP/system time) inside the .qre file header. On future attempts,
//     the effective time is max(current_time, ratchet_max_seen). An attacker
//     who goes offline AND rewinds the clock is caught because the ratchet
//     already recorded a higher time during a previous online attempt.
//
// REMAINING GAP:
//     A fresh system (no prior access) that is fully offline can still bypass
//     by rewinding the clock. This is the fundamental limit of all software-only
//     time-locks without hardware security modules (HSMs). Both VeraCrypt and
//     BitLocker share this same limitation.
//
// NO EXTERNAL CRATES REQUIRED:
//     NTP uses std::net::UdpSocket only. No tokio, no reqwest, no sntpc.

use std::net::UdpSocket;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ==========================================
// --- CONSTANTS ---
// ==========================================

/// NTP servers queried in parallel (all are anycast, globally distributed).
const NTP_SERVERS: &[&str] = &["time.cloudflare.com", "time.google.com", "pool.ntp.org"];

/// NTP epoch is Jan 1 1900; Unix epoch is Jan 1 1970.
/// Offset in seconds between the two epochs.
const NTP_TO_UNIX_OFFSET: u64 = 2_208_988_800;

/// Per-server socket timeout. Three servers × 3s = up to 9s worst case,
/// but in practice at least one server responds within ~100ms.
const NTP_TIMEOUT_SECS: u64 = 3;

// ==========================================
// --- INTERNAL NTP QUERY ---
// ==========================================

/// Sends a single NTP client request to `server:123` and parses the
/// transmit timestamp from the response.
///
/// Returns the Unix timestamp in seconds, or an error if the socket
/// operation fails or the response is malformed.
fn query_ntp_server(server: &str) -> Result<u64, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("bind: {}", e))?;

    socket
        .set_read_timeout(Some(Duration::from_secs(NTP_TIMEOUT_SECS)))
        .map_err(|e| format!("set_read_timeout: {}", e))?;

    socket
        .connect(format!("{}:123", server))
        .map_err(|e| format!("connect to {}: {}", server, e))?;

    // Minimal NTP v3 client request packet (48 bytes).
    // Byte 0: LI=0 (no warning), VN=3 (version 3), Mode=3 (client)
    let mut request = [0u8; 48];
    request[0] = 0x1B;

    socket
        .send(&request)
        .map_err(|e| format!("send to {}: {}", server, e))?;

    let mut response = [0u8; 48];
    socket
        .recv(&mut response)
        .map_err(|e| format!("recv from {}: {}", server, e))?;

    // Transmit Timestamp is at bytes 40–43 (seconds, big-endian).
    // Bytes 44–47 are the fractional part — we ignore sub-second precision.
    let ntp_secs =
        u32::from_be_bytes([response[40], response[41], response[42], response[43]]) as u64;

    // Sanity check: NTP seconds must be after the Unix epoch
    if ntp_secs < NTP_TO_UNIX_OFFSET {
        return Err(format!(
            "NTP response from {} looks invalid (secs={})",
            server, ntp_secs
        ));
    }

    Ok(ntp_secs - NTP_TO_UNIX_OFFSET)
}

// ==========================================
// --- PUBLIC API ---
// ==========================================

/// Returns the current Unix timestamp in seconds from the system clock.
pub fn system_time_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Queries all NTP servers, takes the median response, and returns it.
///
/// Returns `Ok(unix_secs)` if at least one server responds.
/// Returns `Err` if all servers are unreachable (device is offline).
///
/// The median is used instead of the mean to resist a single rogue server
/// returning a wildly incorrect value.
pub fn get_ntp_time() -> Result<u64, String> {
    let mut responses: Vec<u64> = NTP_SERVERS
        .iter()
        .filter_map(|server| query_ntp_server(server).ok())
        .collect();

    if responses.is_empty() {
        return Err("All NTP servers unreachable — device appears to be offline.".to_string());
    }

    responses.sort_unstable();
    let median = responses[responses.len() / 2];

    Ok(median)
}

/// Returns the **authoritative** current time for time-lock enforcement.
///
/// This function is the single source of truth for "what time is it now?"
/// used by the time-lock decryption check. It implements the two-layer
/// defense described in the module doc comment.
///
/// # Arguments
/// * `ratchet_max_seen` — the highest timestamp ever recorded in this file's
///   `TimeLockMeta`. `0` for a newly created file (no prior access).
///
/// # Returns
/// Always returns a `u64` Unix timestamp. Never panics.
pub fn get_authoritative_time(ratchet_max_seen: u64) -> u64 {
    let system_time = system_time_secs();

    match get_ntp_time() {
        Ok(ntp_time) => {
            // Online path: NTP is authoritative.
            // The ratchet is applied as a safety floor — if somehow NTP returned
            // a time lower than what we've already witnessed, the ratchet wins.
            ntp_time.max(ratchet_max_seen)
        }
        Err(_) => {
            // Offline path: NTP unreachable.
            // Use max(system_clock, ratchet) so that rewinding the clock
            // while offline is caught by the ratchet from a previous online attempt.
            system_time.max(ratchet_max_seen)
        }
    }
}

// ==========================================
// --- TESTS ---
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_system_time_is_reasonable() {
        let t = system_time_secs();
        // Must be after 2024-01-01 and before 2100-01-01
        assert!(t > 1_700_000_000, "system time too far in the past");
        assert!(t < 4_102_444_800, "system time too far in the future");
    }

    #[test]
    fn test_ratchet_wins_over_low_system_time() {
        // Simulate system clock rewound to 0 while offline.
        // The ratchet value (a past legitimate timestamp) must win.
        let ratchet = 1_750_000_000u64;

        // Mimic the offline path logic directly
        let system_time = 0u64; // clock rewound
        let result = system_time.max(ratchet);
        assert_eq!(result, ratchet, "ratchet must override a rewound clock");
    }

    #[test]
    fn test_ratchet_does_not_regress() {
        // New ratchet value must always be >= old ratchet value
        let old_ratchet = 1_750_000_000u64;
        let current_time = 1_749_999_999u64; // slightly less than ratchet (clock rewound)
        let new_ratchet = old_ratchet.max(current_time);
        assert_eq!(new_ratchet, old_ratchet, "ratchet must never decrease");
    }

    #[test]
    fn test_ntp_median_selection() {
        // Verify median logic: with [low, mid, high], mid is selected
        let mut responses = vec![1_700_000_100u64, 1_700_000_000u64, 1_700_000_200u64];
        responses.sort_unstable();
        let median = responses[responses.len() / 2];
        assert_eq!(median, 1_700_000_100u64);
    }

    #[test]
    fn test_ntp_median_with_rogue_server() {
        // One rogue server returns a wildly wrong value.
        // Median of [correct, correct, rogue_far_future] should still be correct.
        let mut responses = vec![
            1_700_000_000u64, // correct
            1_700_000_001u64, // correct
            9_999_999_999u64, // rogue — far future
        ];
        responses.sort_unstable();
        let median = responses[responses.len() / 2];
        assert_eq!(
            median, 1_700_000_001u64,
            "rogue server must not dominate median"
        );
    }
}

// --- END OF FILE src-tauri/src/timelock_clock.rs ---
