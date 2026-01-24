use sha1::{Digest, Sha1};
use reqwest::Client;
use anyhow::{Result};

#[derive(serde::Serialize)]
pub struct BreachResult {
    pub found: bool,
    pub count: u64,
}

pub async fn check_pwned(password: &str) -> Result<BreachResult> {
    // 1. Hash the password (SHA-1)
    let mut hasher = Sha1::new();
    hasher.update(password.as_bytes());
    let hash = format!("{:X}", hasher.finalize()); // Uppercase required by API

    // 2. Split (k-Anonymity)
    // We send only the first 5 chars. We keep the rest to verify locally.
    let prefix = &hash[0..5];
    let suffix = &hash[5..];

    // 3. Request
    let url = format!("https://api.pwnedpasswords.com/range/{}", prefix);
    let client = Client::new();
    let response = client.get(&url)
        // Add a User-Agent (Good practice)
        .header("User-Agent", "QRE-Privacy-Toolkit")
        .send()
        .await?
        .text()
        .await?;

    // 4. Parse Response locally
    // Response format: SUFFIX:COUNT \n SUFFIX:COUNT ...
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