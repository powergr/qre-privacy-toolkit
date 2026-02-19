use anyhow::{anyhow, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
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

// --- NEW STRUCT FOR EMAIL BREACHES ---
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "PascalCase")] // HIBP returns PascalCase JSON
pub struct BreachInfo {
    pub name: String,
    pub title: String,
    pub domain: String,
    pub breach_date: String,
    pub description: String,
    pub pwn_count: u64,
    pub data_classes: Vec<String>,
    pub is_verified: bool,
}

// --- PASSWORD CHECK (k-Anonymity) ---
pub async fn check_pwned_by_prefix(prefix: &str, suffix: &str) -> Result<BreachResult> {
    let url = format!("https://api.pwnedpasswords.com/range/{}", prefix);
    let client = Client::new();

    let response = client
        .get(&url)
        .header("User-Agent", "QRE-Privacy-Toolkit")
        .timeout(Duration::from_secs(10))
        .send()
        .await?;

    if !response.status().is_success() {
        return Err(anyhow!("HIBP API Error: {}", response.status()));
    }

    let text = response.text().await?;

    for line in text.lines() {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() == 2 {
            if parts[0].to_uppercase() == suffix.to_uppercase() {
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

// --- NEW: EMAIL CHECK (Requires API Key) ---
pub async fn check_email(email: &str, api_key: &str) -> Result<Vec<BreachInfo>> {
    let url = format!(
        "https://haveibeenpwned.com/api/v3/breachedaccount/{}?truncateResponse=false",
        email
    );
    let client = Client::new();

    let response = client
        .get(&url)
        .header("User-Agent", "QRE-Privacy-Toolkit")
        .header("hibp-api-key", api_key)
        .timeout(Duration::from_secs(10))
        .send()
        .await?;

    // 404 means "Not Found" in HIBP terms (Good news!)
    if response.status() == 404 {
        return Ok(Vec::new());
    }

    if !response.status().is_success() {
        return Err(anyhow!("API Error: {} (Check API Key)", response.status()));
    }

    let breaches: Vec<BreachInfo> = response.json().await?;
    Ok(breaches)
}

// --- IP CHECK ---
pub async fn get_public_ip() -> Result<IpResult> {
    match get_ip_cloudflare().await {
        Ok(res) => return Ok(res),
        Err(e) => eprintln!("Cloudflare IP check failed: {}", e),
    }
    match get_ip_ipify().await {
        Ok(res) => return Ok(res),
        Err(e) => eprintln!("Ipify IP check failed: {}", e),
    }
    Err(anyhow!(
        "All IP services failed. Check internet connection."
    ))
}

async fn get_ip_cloudflare() -> Result<IpResult> {
    let client = Client::new();
    let resp = client
        .get("https://www.cloudflare.com/cdn-cgi/trace")
        .timeout(Duration::from_secs(5))
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

    if ip == "Unknown" {
        return Err(anyhow!("Could not parse Cloudflare response"));
    }
    Ok(IpResult {
        ip,
        is_warp,
        service_used: "Cloudflare".into(),
    })
}

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
        ip,
        is_warp: false,
        service_used: "ipify".into(),
    })
}
