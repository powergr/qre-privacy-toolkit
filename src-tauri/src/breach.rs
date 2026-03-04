// --- START OF FILE breach.rs ---

use anyhow::{anyhow, Result};
use reqwest::Client; // Asynchronous HTTP client for external API calls
use serde::Serialize;
use std::time::Duration;

/// The structure returned to the frontend after a password breach check.
#[derive(Serialize, Debug)]
pub struct BreachResult {
    pub found: bool, // True if the password hash was found in a known data breach
    pub count: u64,  // The number of times this specific password was seen in breaches
}

/// The structure returned to the frontend after an IP address check.
#[derive(Serialize, Debug)]
pub struct IpResult {
    pub ip: String,           // The public IPv4 or IPv6 address
    pub is_warp: bool, // True if the user is currently routing traffic through Cloudflare WARP (VPN)
    pub service_used: String, // Which API successfully returned the data (for debugging/UI)
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD BREACH CHECK (k-Anonymity with HIBP)
// ─────────────────────────────────────────────────────────────────────────────

/// Checks if a password hash appears in the HaveIBeenPwned (HIBP) database using k-Anonymity.
///
/// SECURITY IMPLEMENTATION (Zero-Knowledge Proof Concept):
/// We NEVER send the user's password, or even the full hash of the password, over the internet.
/// Only the first 5 characters (the `prefix`) of the SHA-1 hash are sent to the HIBP API.
/// The API returns a massive list of ALL breached passwords whose hashes start with those 5 characters.
/// We then search that list locally for the remaining 35 characters (the `suffix`).
///
/// # Arguments
/// * `prefix` - First 5 characters of SHA-1 hash (uppercase hex)
/// * `suffix` - Remaining 35 characters of SHA-1 hash (uppercase hex)
///
/// # Returns
/// * `BreachResult` with `found` status and breach `count`
pub async fn check_pwned_by_prefix(prefix: &str, suffix: &str) -> Result<BreachResult> {
    // 1. Validate inputs (Defense-in-depth)
    // Even though the frontend generates the hash, the backend must independently verify
    // that the inputs are strictly valid SHA-1 hexadecimal parts to prevent injection or crashes.
    if prefix.len() != 5 || !prefix.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("Invalid prefix: must be 5 hex characters"));
    }
    if suffix.len() != 35 || !suffix.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("Invalid suffix: must be 35 hex characters"));
    }

    // Append the 5-character prefix to the k-Anonymity API endpoint
    let url = format!("https://api.pwnedpasswords.com/range/{}", prefix);
    let client = Client::new();

    // 2. Execute the HTTP Request
    let response = client
        .get(&url)
        // HIBP strictly requires a User-Agent header identifying the app consuming the API
        .header("User-Agent", "QRE-Privacy-Toolkit/1.0")
        // Enforce a strict timeout so the frontend doesn't hang indefinitely if the API is down
        .timeout(Duration::from_secs(10))
        .send()
        .await?;

    // 3. Handle specific API Errors
    // HTTP 429 means we are querying the API too quickly
    if response.status().as_u16() == 429 {
        return Err(anyhow!(
            "HIBP rate limit exceeded. Please wait a moment and try again."
        ));
    }

    // Catch-all for 500 Server Errors, 403 Forbidden, etc.
    if !response.status().is_success() {
        return Err(anyhow!("HIBP API error: {}", response.status()));
    }

    // 4. Parse the Response
    let text = response.text().await?;

    // The response is a newline-separated list formatted as `SUFFIX:COUNT`
    // Example: `0018A45C4D1DEF81644B54AB7F969B88D65:1`
    for line in text.lines() {
        let parts: Vec<&str> = line.split(':').collect();

        if parts.len() != 2 {
            // Malformed line - log warning to standard error and continue to the next line safely
            eprintln!("Warning: Malformed HIBP response line: {}", line);
            continue;
        }

        // 5. Local Suffix Matching
        // If the suffix from the API matches our local secret suffix, the password is breached.
        if parts[0].to_uppercase() == suffix.to_uppercase() {
            let count = parts[1]
                .parse::<u64>()
                .map_err(|_| anyhow!("Invalid count in HIBP response"))?;

            return Ok(BreachResult { found: true, count });
        }
    }

    // If we loop through the entire list and find no match, the password is safe.
    Ok(BreachResult {
        found: false,
        count: 0,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC IP ADDRESS CHECK (with VPN Detection)
// ─────────────────────────────────────────────────────────────────────────────

/// Gets the user's public IP address with an automatic fallback mechanism.
///
/// This is typically used by privacy tools to allow the user to verify that their VPN
/// is active and functioning correctly before proceeding with sensitive tasks.
/// It tries Cloudflare first (which provides extra VPN context), then falls back to ipify.
pub async fn get_public_ip() -> Result<IpResult> {
    // 1. Try Cloudflare first (Supports Cloudflare WARP VPN detection)
    match get_ip_cloudflare().await {
        Ok(res) => return Ok(res),
        Err(e) => {
            eprintln!("Cloudflare IP check failed: {}", e);
        }
    }

    // 2. Fallback to ipify (A standard, highly reliable IP API)
    match get_ip_ipify().await {
        Ok(res) => return Ok(res),
        Err(e) => {
            eprintln!("ipify IP check failed: {}", e);
        }
    }

    // 3. If both requests time out or fail, the user likely has no internet connection
    Err(anyhow!(
        "All IP check services failed. Please check your internet connection."
    ))
}

/// Fetches diagnostic trace data from Cloudflare.
/// Cloudflare's `cdn-cgi/trace` endpoint returns plain text key-value pairs about the connection.
async fn get_ip_cloudflare() -> Result<IpResult> {
    let client = Client::new();
    let resp = client
        .get("https://www.cloudflare.com/cdn-cgi/trace")
        .timeout(Duration::from_secs(5))
        .send()
        .await?
        .text()
        .await?;

    let mut ip = String::new();
    let mut is_warp = false;

    // Parse the trace data line by line
    for line in resp.lines() {
        // Extract the client IP
        if line.starts_with("ip=") {
            ip = line.replace("ip=", "");
        }
        // Extract the Cloudflare WARP status
        if line.starts_with("warp=") {
            let val = line.replace("warp=", "");
            // 'on' means standard WARP is active, 'plus' means WARP+ is active
            if val == "on" || val == "plus" {
                is_warp = true;
            }
        }
    }

    if ip.is_empty() {
        return Err(anyhow!("Could not parse Cloudflare response"));
    }

    Ok(IpResult {
        ip,
        is_warp,
        service_used: "Cloudflare".into(),
    })
}

/// Fetches the IP from ipify as a secondary fallback.
/// Ipify returns *only* the IP string, so it cannot detect specific VPN states.
async fn get_ip_ipify() -> Result<IpResult> {
    let client = Client::new();
    let ip = client
        .get("https://api.ipify.org")
        .timeout(Duration::from_secs(5)) // Fast timeout
        .send()
        .await?
        .text()
        .await?;

    Ok(IpResult {
        ip: ip.trim().to_string(),
        is_warp: false, // ipify does not provide VPN context data
        service_used: "ipify".into(),
    })
}

// ==========================================
// --- TESTS ---
// ==========================================

#[cfg(test)]
mod tests {
    use super::*;

    // --- Validation Tests (No Network Required) ---

    #[test]
    fn test_check_pwned_invalid_prefix_length() {
        tauri::async_runtime::block_on(async {
            let result = check_pwned_by_prefix("ABCD", "12345678901234567890123456789012345").await;
            assert!(result.is_err());
            assert!(result.unwrap_err().to_string().contains("Invalid prefix"));
        });
    }

    #[test]
    fn test_check_pwned_invalid_prefix_hex() {
        tauri::async_runtime::block_on(async {
            let result =
                check_pwned_by_prefix("1234Z", "12345678901234567890123456789012345").await;
            assert!(result.is_err());
            assert!(result.unwrap_err().to_string().contains("Invalid prefix"));
        });
    }

    #[test]
    fn test_check_pwned_invalid_suffix_length() {
        tauri::async_runtime::block_on(async {
            let result = check_pwned_by_prefix("ABCDE", "12345").await;
            assert!(result.is_err());
            assert!(result.unwrap_err().to_string().contains("Invalid suffix"));
        });
    }

    // --- Integration Tests (Requires Internet) ---

    #[test]
    fn test_hibp_breached_password() {
        tauri::async_runtime::block_on(async {
            // SHA-1 for "password"
            let result =
                check_pwned_by_prefix("5BAA6", "1E4C9B93F3F0682250B6CF8331B7EE68FD8").await;

            assert!(result.is_ok(), "HIBP request failed. Network issue?");
            let breach = result.unwrap();

            assert!(
                breach.found,
                "The password 'password' should definitely be breached!"
            );
            assert!(breach.count > 3000000, "The count should be massively high");
        });
    }

    #[test]
    fn test_hibp_safe_password() {
        tauri::async_runtime::block_on(async {
            // Hash of a very long, random string
            let result =
                check_pwned_by_prefix("785A8", "81E576B3C0E514B1F870E83D62D9BA1E915").await;

            assert!(result.is_ok(), "HIBP request failed. Network issue?");
            let breach = result.unwrap();

            assert!(
                !breach.found,
                "This specific random hash should not be in the breach database."
            );
            assert_eq!(breach.count, 0);
        });
    }

    #[test]
    fn test_get_public_ip() {
        tauri::async_runtime::block_on(async {
            let result = get_public_ip().await;
            assert!(result.is_ok(), "Failed to get public IP. Network issue?");

            let ip_data = result.unwrap();
            assert!(!ip_data.ip.is_empty(), "IP string should not be empty");

            assert!(
                ip_data.service_used == "Cloudflare" || ip_data.service_used == "ipify",
                "Unrecognized service used"
            );
        });
    }
}
// --- END OF FILE breach.rs ---
