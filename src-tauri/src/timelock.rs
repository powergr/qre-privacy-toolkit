// --- START OF FILE src-tauri/src/timelock.rs ---
//
// Core time-lock utilities.
//
// With the V6 embedded design, cryptographic sidecar files are gone.
// All time-lock metadata lives inside the .qre file's StreamHeader.
// This module retains only the stateless helpers used by the command layer.

use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

// ==========================================
// --- PUBLIC API ---
// ==========================================

/// Returns the current Unix timestamp in seconds.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Minimum lock duration enforced server-side: 1 minute.
pub const MIN_LOCK_SECS: u64 = 60;

/// Maximum lock duration enforced server-side: 50 years.
pub const MAX_LOCK_SECS: u64 = 50 * 365 * 24 * 3600;

/// Validates that `unlock_at` is within the allowed bounds.
///
/// Called by the lock command before passing the timestamp to
/// `encrypt_file_stream`. The frontend check in `TimeLockModal.tsx`
/// is UX-only; this is the authoritative check.
pub fn validate_unlock_at(unlock_at: u64) -> Result<(), String> {
    if unlock_at == 0 {
        return Err("Invalid unlock timestamp: cannot be zero.".to_string());
    }
    let now = now_secs();
    let earliest = now.saturating_add(MIN_LOCK_SECS);
    let latest = now.saturating_add(MAX_LOCK_SECS);

    if unlock_at < earliest {
        return Err("Unlock time must be at least 1 minute in the future.".to_string());
    }
    if unlock_at > latest {
        return Err("Unlock time cannot exceed 50 years from now.".to_string());
    }
    Ok(())
}

/// Status returned to the frontend. Contains no secrets.
#[derive(Serialize, Debug)]
pub struct TimeLockStatus {
    /// True if the file has a time-lock that has not yet expired.
    pub is_locked: bool,
    /// Unix timestamp when the lock expires (0 if not time-locked).
    pub locked_until: u64,
    /// Human-readable remaining duration, e.g. "3 days, 2 hours".
    pub remaining_display: String,
}

/// Formats a duration in seconds to a human-readable string.
pub fn format_duration(seconds: u64) -> String {
    if seconds >= 86400 {
        let d = seconds / 86400;
        let h = (seconds % 86400) / 3600;
        if h > 0 {
            format!("{} {}, {} {}", d, plural(d, "day"), h, plural(h, "hour"))
        } else {
            format!("{} {}", d, plural(d, "day"))
        }
    } else if seconds >= 3600 {
        let h = seconds / 3600;
        let m = (seconds % 3600) / 60;
        if m > 0 {
            format!("{} {}, {} {}", h, plural(h, "hour"), m, plural(m, "minute"))
        } else {
            format!("{} {}", h, plural(h, "hour"))
        }
    } else if seconds >= 60 {
        let m = seconds / 60;
        format!("{} {}", m, plural(m, "minute"))
    } else {
        format!("{} {}", seconds, plural(seconds, "second"))
    }
}

fn plural(n: u64, unit: &str) -> String {
    if n == 1 {
        unit.to_string()
    } else {
        format!("{}s", unit)
    }
}

// ==========================================
// --- TESTS ---
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_reject_zero_timestamp() {
        assert!(validate_unlock_at(0).is_err());
    }

    #[test]
    fn test_reject_past_timestamp() {
        let past = now_secs() - 3600;
        assert!(validate_unlock_at(past).is_err());
    }

    #[test]
    fn test_reject_too_far_future() {
        let too_far = now_secs().saturating_add(MAX_LOCK_SECS + 86400);
        assert!(validate_unlock_at(too_far).is_err());
    }

    #[test]
    fn test_valid_timestamp() {
        let valid = now_secs() + 3600;
        assert!(validate_unlock_at(valid).is_ok());
    }

    #[test]
    fn test_format_duration_seconds() {
        assert_eq!(format_duration(30), "30 seconds");
        assert_eq!(format_duration(1), "1 second");
    }

    #[test]
    fn test_format_duration_minutes() {
        assert_eq!(format_duration(60), "1 minute");
        assert_eq!(format_duration(120), "2 minutes");
    }

    #[test]
    fn test_format_duration_hours() {
        assert_eq!(format_duration(3600), "1 hour");
        assert_eq!(format_duration(3600 + 60), "1 hour, 1 minute");
        assert_eq!(format_duration(7200 + 1800), "2 hours, 30 minutes");
    }

    #[test]
    fn test_format_duration_days() {
        assert_eq!(format_duration(86400), "1 day");
        assert_eq!(format_duration(86400 + 7200), "1 day, 2 hours");
        assert_eq!(format_duration(172800), "2 days");
    }
}

// --- END OF FILE src-tauri/src/timelock.rs ---
