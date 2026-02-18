use anyhow::Result;
use reqwest::Client;
#[derive(serde::Serialize)]
pub struct BreachResult {
    pub found: bool,
    pub count: u64,
}

#[derive(serde::Serialize)]
pub struct IpResult {
    pub ip: String,
    pub is_warp: bool, // New field to signal if Warp is active
}

pub async fn check_pwned_by_prefix(prefix: &str, suffix: &str) -> Result<BreachResult> {
    // 1. Request only the prefix (First 5 chars)
    let url = format!("https://api.pwnedpasswords.com/range/{}", prefix);
    let client = Client::new();
    let response = client
        .get(&url)
        .header("User-Agent", "QRE-Privacy-Toolkit")
        .send()
        .await?
        .text()
        .await?;

    // 2. Parse Response locally to find the suffix
    for line in response.lines() {
        // Line format: SUFFIX:COUNT
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() == 2 {
            if parts[0] == suffix {
                let count = parts[1].parse::<u64>().unwrap_or(0);
                return Ok(BreachResult { found: true, count });
            }
        }
    }

    Ok(BreachResult {
        found: false,
        count: 0,
    })
}

/// Fetches IP and Warp status from Cloudflare trace
pub async fn get_public_ip() -> Result<IpResult> {
    let client = Client::new();

    // Cloudflare trace endpoint returns data like:
    // ip=1.2.3.4
    // warp=on
    let resp = client
        .get("https://www.cloudflare.com/cdn-cgi/trace")
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await?
        .text()
        .await?;

    let mut ip = "Unknown".to_string();
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

    Ok(IpResult { ip, is_warp })
}
