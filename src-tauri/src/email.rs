use serde::{Deserialize, Serialize};
use reqwest::Client;
use anyhow::Result;

// --- DATA STRUCTURES ---

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EmailMessage {
    pub id: u64,
    pub from: String,
    pub subject: String,
    pub date: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EmailContent {
    pub id: u64,
    pub from: String,
    pub subject: String,
    pub date: String,
    pub body: String, // Plain text body
    pub htmlBody: String, // HTML body
}

// --- LOGIC ---

// 1. Generate a random address
pub async fn generate_email() -> Result<String> {
    let url = "https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1";
    let client = Client::builder().user_agent("QRE-Toolkit").build()?;
    
    let response: Vec<String> = client.get(url).send().await?.json().await?;
    
    if let Some(email) = response.first() {
        Ok(email.clone())
    } else {
        Err(anyhow::anyhow!("Failed to generate email"))
    }
}

// 2. Check Inbox
pub async fn check_inbox(address: &str) -> Result<Vec<EmailMessage>> {
    let parts: Vec<&str> = address.split('@').collect();
    if parts.len() != 2 { return Ok(vec![]); }
    
    let login = parts[0];
    let domain = parts[1];

    let url = format!(
        "https://www.1secmail.com/api/v1/?action=getMessages&login={}&domain={}",
        login, domain
    );
    
    let client = Client::builder().user_agent("QRE-Toolkit").build()?;
    let messages: Vec<EmailMessage> = client.get(&url).send().await?.json().await?;
    
    Ok(messages)
}

// 3. Read specific message
pub async fn read_message(address: &str, id: u64) -> Result<EmailContent> {
    let parts: Vec<&str> = address.split('@').collect();
    let login = parts[0];
    let domain = parts[1];

    let url = format!(
        "https://www.1secmail.com/api/v1/?action=readMessage&login={}&domain={}&id={}",
        login, domain, id
    );

    let client = Client::builder().user_agent("QRE-Toolkit").build()?;
    let content: EmailContent = client.get(&url).send().await?.json().await?;
    
    Ok(content)
}