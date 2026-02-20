use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::Serialize;
use std::time::Duration;

#[derive(Serialize)]
pub struct BreachResult {
    pub found: bool,
    pub count: u64,
}

#[derive(Serialize)]
pub struct IpResult {
    pub ip: String,
    pub is_warp: bool,
    pub service_used: String,
}

// ─────────────────────────────────────────────────────────────────────────────
// PASSWORD BREACH CHECK (k-Anonymity with HIBP)
// ─────────────────────────────────────────────────────────────────────────────

/// Checks if a password hash appears in the HIBP database using k-Anonymity.
///
/// SECURITY: Only the first 5 characters of the SHA-1 hash are sent to HIBP.
/// The remaining 35 characters are matched locally, ensuring zero-knowledge.
///
/// # Arguments
/// * `prefix` - First 5 characters of SHA-1 hash (uppercase hex)
/// * `suffix` - Remaining 35 characters of SHA-1 hash (uppercase hex)
///
/// # Returns
/// * `BreachResult` with `found` status and breach `count`
pub async fn check_pwned_by_prefix(prefix: &str, suffix: &str) -> Result<BreachResult> {
    // Validate inputs (defense in depth - frontend also validates)
    if prefix.len() != 5 || !prefix.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("Invalid prefix: must be 5 hex characters"));
    }
    if suffix.len() != 35 || !suffix.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("Invalid suffix: must be 35 hex characters"));
    }

    let url = format!("https://api.pwnedpasswords.com/range/{}", prefix);
    let client = Client::new();

    let response = client
        .get(&url)
        .header("User-Agent", "QRE-Privacy-Toolkit/1.0")
        .timeout(Duration::from_secs(10))
        .send()
        .await?;

    // Check for rate limiting
    if response.status().as_u16() == 429 {
        return Err(anyhow!(
            "HIBP rate limit exceeded. Please wait a moment and try again."
        ));
    }

    // Check for other HTTP errors
    if !response.status().is_success() {
        return Err(anyhow!("HIBP API error: {}", response.status()));
    }

    let text = response.text().await?;

    // Parse response and find suffix match
    for line in text.lines() {
        let parts: Vec<&str> = line.split(':').collect();

        if parts.len() != 2 {
            // Malformed line - log warning and continue
            eprintln!("Warning: Malformed HIBP response line: {}", line);
            continue;
        }

        if parts[0].to_uppercase() == suffix.to_uppercase() {
            let count = parts[1]
                .parse::<u64>()
                .map_err(|_| anyhow!("Invalid count in HIBP response"))?;
            return Ok(BreachResult { found: true, count });
        }
    }

    // Not found in any breaches
    Ok(BreachResult {
        found: false,
        count: 0,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC IP ADDRESS CHECK (with VPN Detection)
// ─────────────────────────────────────────────────────────────────────────────

/// Gets the user's public IP address with automatic fallback.
///
/// Tries Cloudflare first (can detect Warp), then falls back to ipify.
/// Both services are privacy-respecting and use HTTPS.
pub async fn get_public_ip() -> Result<IpResult> {
    // Try Cloudflare first (supports Warp detection)
    match get_ip_cloudflare().await {
        Ok(res) => return Ok(res),
        Err(e) => {
            eprintln!("Cloudflare IP check failed: {}", e);
        }
    }

    // Fallback to ipify
    match get_ip_ipify().await {
        Ok(res) => return Ok(res),
        Err(e) => {
            eprintln!("ipify IP check failed: {}", e);
        }
    }

    // All services failed
    Err(anyhow!(
        "All IP check services failed. Please check your internet connection."
    ))
}

/// Gets IP from Cloudflare's trace endpoint (supports Warp detection)
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

    for line in resp.lines() {
        if line.starts_with("ip=") {
            ip = line.replace("ip=", "");
        }
        if line.starts_with("warp=") {
            let val = line.replace("warp=", "");
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

/// Gets IP from ipify (fallback service)
async fn get_ip_ipify() -> Result<IpResult> {
    let client = Client::new();
    let ip = client
        .get("https://api.ipify.org")
        .timeout(Duration::from_secs(5))
        .send()
        .await?
        .text()
        .await?;

    Ok(IpResult {
        ip: ip.trim().to_string(),
        is_warp: false, // ipify cannot detect Warp
        service_used: "ipify".into(),
    })
}
