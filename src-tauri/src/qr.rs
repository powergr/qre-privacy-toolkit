use anyhow::{anyhow, Result};
use qrcodegen::{QrCode, QrCodeEcc};
use regex::Regex;
use std::sync::OnceLock;

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const MAX_INPUT_LENGTH: usize = 2048; // Maximum characters for QR content
const MAX_WIFI_SSID_LENGTH: usize = 32; // WiFi SSID max length (standard)
const MAX_WIFI_PASSWORD_LENGTH: usize = 63; // WPA2 max password length
const MIN_WIFI_PASSWORD_LENGTH: usize = 8; // WPA2 min password length

// Allowed QR error correction levels
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ErrorCorrectionLevel {
    Low,    // 7% recovery
    Medium, // 15% recovery
    Quartile, // 25% recovery
    High,   // 30% recovery
}

impl ErrorCorrectionLevel {
    fn to_qr_ecc(&self) -> QrCodeEcc {
        match self {
            ErrorCorrectionLevel::Low => QrCodeEcc::Low,
            ErrorCorrectionLevel::Medium => QrCodeEcc::Medium,
            ErrorCorrectionLevel::Quartile => QrCodeEcc::Quartile,
            ErrorCorrectionLevel::High => QrCodeEcc::High,
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// DATA STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════

#[derive(serde::Deserialize)]
pub struct QrOptions {
    pub text: String,
    pub fg_color: String,
    pub bg_color: String,
    #[serde(default = "default_ecc")]
    pub ecc: ErrorCorrectionLevel,
    #[serde(default = "default_border")]
    pub border: u32,
}

fn default_ecc() -> ErrorCorrectionLevel {
    ErrorCorrectionLevel::Medium
}

fn default_border() -> u32 {
    4
}

#[derive(serde::Deserialize)]
pub struct WifiQrOptions {
    pub ssid: String,
    pub password: String,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default = "default_security")]
    pub security: String, // WPA, WPA2, WEP, nopass
    pub fg_color: String,
    pub bg_color: String,
    #[serde(default = "default_ecc")]
    pub ecc: ErrorCorrectionLevel,
    #[serde(default = "default_border")]
    pub border: u32,
}

fn default_security() -> String {
    "WPA".to_string()
}

#[derive(serde::Serialize)]
pub struct QrResult {
    pub svg: String,
    pub size: i32,
    pub version: i32,
}

#[derive(serde::Serialize)]
pub struct QrValidation {
    pub valid: bool,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub estimated_size: Option<String>,
}

// ═══════════════════════════════════════════════════════════════════════════
// INPUT VALIDATION (CRITICAL SECURITY)
// ═══════════════════════════════════════════════════════════════════════════

/// Validates hex color format.
fn validate_color(color: &str) -> Result<String> {
    static HEX_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = HEX_REGEX.get_or_init(|| {
        Regex::new(r"^#[0-9A-Fa-f]{6}$").unwrap()
    });

    if !regex.is_match(color) {
        return Err(anyhow!("Invalid color format. Use #RRGGBB hex format"));
    }

    // Normalize to uppercase
    Ok(color.to_uppercase())
}

/// Validates input text length.
fn validate_text_length(text: &str) -> Result<()> {
    if text.is_empty() {
        return Err(anyhow!("Input text cannot be empty"));
    }

    if text.len() > MAX_INPUT_LENGTH {
        return Err(anyhow!(
            "Input text too long: {} characters (maximum: {})",
            text.len(),
            MAX_INPUT_LENGTH
        ));
    }

    Ok(())
}

/// Validates border size.
fn validate_border(border: u32) -> Result<u32> {
    if border > 20 {
        return Err(anyhow!("Border too large (maximum: 20)"));
    }
    Ok(border)
}

/// Validates WiFi SSID.
fn validate_wifi_ssid(ssid: &str) -> Result<()> {
    if ssid.is_empty() {
        return Err(anyhow!("WiFi SSID cannot be empty"));
    }

    if ssid.len() > MAX_WIFI_SSID_LENGTH {
        return Err(anyhow!(
            "WiFi SSID too long: {} characters (maximum: {})",
            ssid.len(),
            MAX_WIFI_SSID_LENGTH
        ));
    }

    // Check for invalid characters
    if ssid.contains('\0') {
        return Err(anyhow!("WiFi SSID contains null characters"));
    }

    Ok(())
}

/// Validates WiFi password.
fn validate_wifi_password(password: &str, security: &str) -> Result<()> {
    // Allow empty password for open networks
    if security == "nopass" {
        return Ok(());
    }

    if password.is_empty() {
        return Err(anyhow!("WiFi password cannot be empty for secured networks"));
    }

    if password.len() < MIN_WIFI_PASSWORD_LENGTH {
        return Err(anyhow!(
            "WiFi password too short: {} characters (minimum: {})",
            password.len(),
            MIN_WIFI_PASSWORD_LENGTH
        ));
    }

    if password.len() > MAX_WIFI_PASSWORD_LENGTH {
        return Err(anyhow!(
            "WiFi password too long: {} characters (maximum: {})",
            password.len(),
            MAX_WIFI_PASSWORD_LENGTH
        ));
    }

    Ok(())
}

/// Validates WiFi security type.
fn validate_wifi_security(security: &str) -> Result<String> {
    let valid = ["WPA", "WPA2", "WEP", "nopass"];
    let upper = security.to_uppercase();

    if !valid.contains(&upper.as_str()) {
        return Err(anyhow!(
            "Invalid security type '{}'. Valid options: WPA, WPA2, WEP, nopass",
            security
        ));
    }

    Ok(upper)
}

/// Escapes special characters in WiFi strings.
fn escape_wifi_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace(':', "\\:")
        .replace('"', "\\\"")
}

// ═══════════════════════════════════════════════════════════════════════════
// SANITIZATION
// ═══════════════════════════════════════════════════════════════════════════

/// Sanitizes color for safe SVG insertion.
fn sanitize_color(color: &str) -> String {
    // Remove any potential SVG injection attempts
    color.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '#')
        .collect()
}

/// Sanitizes SVG output to prevent XSS.
fn sanitize_svg(svg: &str) -> String {
    // Additional sanitization layer
    // Remove any script tags or event handlers
    svg.replace("<script", "&lt;script")
        .replace("</script>", "&lt;/script&gt;")
        .replace("javascript:", "")
        .replace("onerror=", "")
        .replace("onload=", "")
}

// ═══════════════════════════════════════════════════════════════════════════
// QR CODE GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/// Generates QR code from text with validation.
pub fn generate_qr(options: QrOptions) -> Result<QrResult> {
    // Validate inputs
    validate_text_length(&options.text)?;
    let fg_color = validate_color(&options.fg_color)?;
    let bg_color = validate_color(&options.bg_color)?;
    let border = validate_border(options.border)?;

    // Check color contrast (warn if too similar)
    if colors_too_similar(&fg_color, &bg_color) {
        return Err(anyhow!(
            "Foreground and background colors are too similar. QR code may not scan properly."
        ));
    }

    // Generate QR code
    let qr = QrCode::encode_text(&options.text, options.ecc.to_qr_ecc())
        .map_err(|e| anyhow!("Failed to encode QR: {}", e))?;

    let size = qr.size();
    let version = qr.version().value() as i32;

    // Generate SVG
    let svg = to_svg_string(&qr, border as i32, &fg_color, &bg_color);
    let sanitized_svg = sanitize_svg(&svg);

    Ok(QrResult {
        svg: sanitized_svg,
        size,
        version,
    })
}

/// Generates WiFi QR code with validation.
pub fn generate_wifi_qr(options: WifiQrOptions) -> Result<QrResult> {
    // Validate inputs
    validate_wifi_ssid(&options.ssid)?;
    let security = validate_wifi_security(&options.security)?;
    validate_wifi_password(&options.password, &security)?;
    let fg_color = validate_color(&options.fg_color)?;
    let bg_color = validate_color(&options.bg_color)?;
    let border = validate_border(options.border)?;

    // Check color contrast
    if colors_too_similar(&fg_color, &bg_color) {
        return Err(anyhow!(
            "Foreground and background colors are too similar. QR code may not scan properly."
        ));
    }

    // Escape special characters
    let safe_ssid = escape_wifi_string(&options.ssid);
    let safe_password = escape_wifi_string(&options.password);

    // Build WiFi string: WIFI:T:WPA;S:MyNetwork;P:password;H:false;;
    let wifi_string = format!(
        "WIFI:T:{};S:{};P:{};H:{};;",
        security,
        safe_ssid,
        safe_password,
        options.hidden
    );

    // Generate QR code
    let qr = QrCode::encode_text(&wifi_string, options.ecc.to_qr_ecc())
        .map_err(|e| anyhow!("Failed to encode WiFi QR: {}", e))?;

    let size = qr.size();
    let version = qr.version().value() as i32;

    // Generate SVG
    let svg = to_svg_string(&qr, border as i32, &fg_color, &bg_color);
    let sanitized_svg = sanitize_svg(&svg);

    Ok(QrResult {
        svg: sanitized_svg,
        size,
        version,
    })
}

/// Validates QR input without generating.
pub fn validate_qr_input(text: &str) -> QrValidation {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    // Check length
    if text.is_empty() {
        errors.push("Input text is empty".to_string());
    } else if text.len() > MAX_INPUT_LENGTH {
        errors.push(format!(
            "Input too long: {} characters (max: {})",
            text.len(),
            MAX_INPUT_LENGTH
        ));
    }

    // Estimate QR size
    let estimated_size = if !text.is_empty() && text.len() <= MAX_INPUT_LENGTH {
        match QrCode::encode_text(text, QrCodeEcc::Medium) {
            Ok(qr) => {
                let version = qr.version().value();
                let size = qr.size();

                if version > 20 {
                    warnings.push(format!(
                        "Large QR code (version {}). Consider shortening content for better scannability.",
                        version
                    ));
                }

                Some(format!("Version {} ({}x{} modules)", version, size, size))
            }
            Err(e) => {
                errors.push(format!("Cannot generate QR: {}", e));
                None
            }
        }
    } else {
        None
    };

    // Check for URLs
    if text.starts_with("http://") && !text.starts_with("https://") {
        warnings.push("Using HTTP instead of HTTPS is not secure".to_string());
    }

    QrValidation {
        valid: errors.is_empty(),
        errors,
        warnings,
        estimated_size,
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SVG GENERATION
// ═══════════════════════════════════════════════════════════════════════════

fn to_svg_string(qr: &QrCode, border: i32, fg: &str, bg: &str) -> String {
    let size = qr.size();
    let dimension = size + border * 2;
    let mut sb = String::with_capacity(1024); // Pre-allocate

    // Sanitize colors one more time
    let fg_safe = sanitize_color(fg);
    let bg_safe = sanitize_color(bg);

    // XML Header
    sb.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    
    // SVG Root
    sb.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 {} {}\" stroke=\"none\">",
        dimension, dimension
    ));

    // Background Rectangle
    sb.push_str(&format!(
        "<rect width=\"100%\" height=\"100%\" fill=\"{}\"/>",
        bg_safe
    ));

    // Foreground Path
    sb.push_str(&format!("<path fill=\"{}\" d=\"", fg_safe));

    // Draw QR modules
    for y in 0..size {
        for x in 0..size {
            if qr.get_module(x, y) {
                sb.push_str(&format!("M{},{}h1v1h-1z ", x + border, y + border));
            }
        }
    }

    sb.push_str("\"/>");
    sb.push_str("</svg>");

    sb
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/// Checks if two colors are too similar (poor contrast).
fn colors_too_similar(color1: &str, color2: &str) -> bool {
    let rgb1 = hex_to_rgb(color1);
    let rgb2 = hex_to_rgb(color2);

    if rgb1.is_none() || rgb2.is_none() {
        return false;
    }

    let (r1, g1, b1) = rgb1.unwrap();
    let (r2, g2, b2) = rgb2.unwrap();

    // Calculate luminance
    let lum1 = 0.299 * r1 + 0.587 * g1 + 0.114 * b1;
    let lum2 = 0.299 * r2 + 0.587 * g2 + 0.114 * b2;

    // Check contrast ratio
    let contrast = if lum1 > lum2 {
        (lum1 + 0.05) / (lum2 + 0.05)
    } else {
        (lum2 + 0.05) / (lum1 + 0.05)
    };

    // QR codes need at least 3:1 contrast ratio
    contrast < 3.0
}

fn hex_to_rgb(hex: &str) -> Option<(f64, f64, f64)> {
    if hex.len() != 7 || !hex.starts_with('#') {
        return None;
    }

    let r = u8::from_str_radix(&hex[1..3], 16).ok()? as f64 / 255.0;
    let g = u8::from_str_radix(&hex[3..5], 16).ok()? as f64 / 255.0;
    let b = u8::from_str_radix(&hex[5..7], 16).ok()? as f64 / 255.0;

    Some((r, g, b))
}
