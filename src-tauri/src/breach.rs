use sha1::{Digest, Sha1};
use reqwest::Client;
use anyhow::{Result};

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

pub async fn check_pwned(password: &str) -> Result<BreachResult> {
    let mut hasher = Sha1::new();
    hasher.update(password.as_bytes());
    let hash = format!("{:X}", hasher.finalize());

    let prefix = &hash[0..5];
    let suffix = &hash[5..];

    let url = format!("https://api.pwnedpasswords.com/range/{}", prefix);
    let client = Client::new();
    let response = client.get(&url)
        .header("User-Agent", "QRE-Privacy-Toolkit")
        .send()
        .await?
        .text()
        .await?;

    for line in response.lines() {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() == 2 {
            if parts[0] == suffix {
                let count = parts[1].parse::<u64>().unwrap_or(0);
                return Ok(BreachResult { found: true, count });
            }
        }
    }

    Ok(BreachResult { found: false, count: 0 })
}

/// Fetches IP and Warp status from Cloudflare trace
pub async fn get_public_ip() -> Result<IpResult> {
    let client = Client::new();
    
    // Cloudflare trace endpoint returns data like:
    // ip=1.2.3.4
    // warp=on
    let resp = client.get("https://www.cloudflare.com/cdn-cgi/trace")
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