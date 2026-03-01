// --- START OF FILE qr.rs ---

use anyhow::{anyhow, Result};
use qrcodegen::{QrCode, QrCodeEcc};
use regex::Regex;
use std::sync::OnceLock;

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

// SECURITY: Hard limits prevent memory exhaustion if a user tries to generate
// a QR code containing an entire book.
const MAX_INPUT_LENGTH: usize = 2048; // Maximum characters for standard QR content
const MAX_WIFI_SSID_LENGTH: usize = 32; // Standard maximum length for a WiFi network name
const MAX_WIFI_PASSWORD_LENGTH: usize = 63; // Standard maximum length for WPA2 passwords
const MIN_WIFI_PASSWORD_LENGTH: usize = 8; // Standard minimum length for WPA2 passwords

/// Maps frontend string selections to the underlying QR library's Error Correction types.
/// Higher error correction means the QR code can sustain more damage (smudges, tears)
/// and still be scanned, but makes the QR pattern denser and harder for cheap cameras to read.
#[derive(serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ErrorCorrectionLevel {
    Low,      // 7% recovery
    Medium,   // 15% recovery (Standard default)
    Quartile, // 25% recovery
    High,     // 30% recovery
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

/// Payload received from the frontend to generate a standard text/URL QR code.
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
    4 // 4 "modules" (squares) of white space around the QR code is the standard quiet zone requirement
}

/// Payload received from the frontend to generate a WiFi connection QR code.
#[derive(serde::Deserialize)]
pub struct WifiQrOptions {
    pub ssid: String,
    pub password: String,
    #[serde(default)]
    pub hidden: bool, // True if the WiFi network does not broadcast its SSID
    #[serde(default = "default_security")]
    pub security: String, // "WPA", "WPA2", "WEP", or "nopass"
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

/// The response sent back to the React frontend containing the raw SVG markup.
#[derive(serde::Serialize)]
pub struct QrResult {
    pub svg: String,  // The generated raw SVG XML string
    pub size: i32,    // The calculated dimension of the QR code matrix
    pub version: i32, // The QR protocol version (1-40) determining density
}

/// Feedback sent to the frontend while the user is typing to validate their input live.
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
// We generate SVGs manually by concatenating strings later in this file.
// If we don't strictly validate inputs (like colors), an attacker could pass
// `"><script>alert(1)</script>` as a color, resulting in an XSS payload
// executing in the Tauri WebView.

/// Enforces strict `#RRGGBB` format for colors.
fn validate_color(color: &str) -> Result<String> {
    // OnceLock compiles the regex exactly once during the application's lifecycle,
    // making subsequent calls incredibly fast.
    static HEX_REGEX: OnceLock<Regex> = OnceLock::new();
    let regex = HEX_REGEX.get_or_init(|| Regex::new(r"^#[0-9A-Fa-f]{6}$").unwrap());

    if !regex.is_match(color) {
        return Err(anyhow!("Invalid color format. Use #RRGGBB hex format"));
    }

    Ok(color.to_uppercase())
}

/// Rejects inputs that are empty or maliciously large.
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

fn validate_border(border: u32) -> Result<u32> {
    // Prevent rendering massive padding that crashes the UI
    if border > 20 {
        return Err(anyhow!("Border too large (maximum: 20)"));
    }
    Ok(border)
}

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

    if ssid.contains('\0') {
        return Err(anyhow!("WiFi SSID contains null characters"));
    }

    Ok(())
}

fn validate_wifi_password(password: &str, security: &str) -> Result<()> {
    // Open networks don't need a password
    if security == "nopass" {
        return Ok(());
    }

    if password.is_empty() {
        return Err(anyhow!(
            "WiFi password cannot be empty for secured networks"
        ));
    }

    // WPA/WPA2 specification enforcement
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

/// The WiFi QR Code specification dictates that special characters used in the syntax
/// (like colons or semicolons) must be escaped with a backslash if they appear in the password/SSID.
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

/// Strips any non-alphanumeric characters from the color string (except `#`).
/// This acts as a secondary defense-in-depth layer against XSS in the SVG generator.
fn sanitize_color(color: &str) -> String {
    color
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '#')
        .collect()
}

/// Sanitizes the final SVG string.
/// Even though we build the SVG safely, this final pass guarantees no script nodes sneaked in.
fn sanitize_svg(svg: &str) -> String {
    svg.replace("<script", "&lt;script")
        .replace("</script>", "&lt;/script&gt;")
        .replace("javascript:", "")
        .replace("onerror=", "")
        .replace("onload=", "")
}

// ═══════════════════════════════════════════════════════════════════════════
// QR CODE GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/// Primary endpoint for generating standard QR codes.
pub fn generate_qr(options: QrOptions) -> Result<QrResult> {
    // 1. Validate all inputs strictly
    validate_text_length(&options.text)?;
    let fg_color = validate_color(&options.fg_color)?;
    let bg_color = validate_color(&options.bg_color)?;
    let border = validate_border(options.border)?;

    // 2. Usability check: Prevent user from generating invisible/unscannable QR codes
    if colors_too_similar(&fg_color, &bg_color) {
        return Err(anyhow!(
            "Foreground and background colors are too similar. QR code may not scan properly."
        ));
    }

    // 3. Compute the QR matrix
    let qr = QrCode::encode_text(&options.text, options.ecc.to_qr_ecc())
        .map_err(|e| anyhow!("Failed to encode QR: {}", e))?;

    let size = qr.size();
    let version = qr.version().value() as i32;

    // 4. Build and sanitize the SVG XML
    let svg = to_svg_string(&qr, border as i32, &fg_color, &bg_color);
    let sanitized_svg = sanitize_svg(&svg);

    Ok(QrResult {
        svg: sanitized_svg,
        size,
        version,
    })
}

/// Primary endpoint for generating WiFi-specific QR codes.
pub fn generate_wifi_qr(options: WifiQrOptions) -> Result<QrResult> {
    validate_wifi_ssid(&options.ssid)?;
    let security = validate_wifi_security(&options.security)?;
    validate_wifi_password(&options.password, &security)?;
    let fg_color = validate_color(&options.fg_color)?;
    let bg_color = validate_color(&options.bg_color)?;
    let border = validate_border(options.border)?;

    if colors_too_similar(&fg_color, &bg_color) {
        return Err(anyhow!(
            "Foreground and background colors are too similar. QR code may not scan properly."
        ));
    }

    let safe_ssid = escape_wifi_string(&options.ssid);
    let safe_password = escape_wifi_string(&options.password);

    // Construct the standardized MECARD format string that phones recognize as a WiFi network.
    // Example: WIFI:T:WPA;S:MyHomeNetwork;P:SuperSecretPassword;H:false;;
    let wifi_string = format!(
        "WIFI:T:{};S:{};P:{};H:{};;",
        security, safe_ssid, safe_password, options.hidden
    );

    let qr = QrCode::encode_text(&wifi_string, options.ecc.to_qr_ecc())
        .map_err(|e| anyhow!("Failed to encode WiFi QR: {}", e))?;

    let size = qr.size();
    let version = qr.version().value() as i32;

    let svg = to_svg_string(&qr, border as i32, &fg_color, &bg_color);
    let sanitized_svg = sanitize_svg(&svg);

    Ok(QrResult {
        svg: sanitized_svg,
        size,
        version,
    })
}

/// Endpoint called continuously by the frontend as the user types to provide live feedback.
pub fn validate_qr_input(text: &str) -> QrValidation {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if text.is_empty() {
        errors.push("Input text is empty".to_string());
    } else if text.len() > MAX_INPUT_LENGTH {
        errors.push(format!(
            "Input too long: {} characters (max: {})",
            text.len(),
            MAX_INPUT_LENGTH
        ));
    }

    // Attempt to generate a dry-run QR code to determine how dense the matrix will be
    let estimated_size = if !text.is_empty() && text.len() <= MAX_INPUT_LENGTH {
        match QrCode::encode_text(text, QrCodeEcc::Medium) {
            Ok(qr) => {
                let version = qr.version().value();
                let size = qr.size();

                // High versions create tiny, dense pixels that are difficult for cheap phones to scan
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

    // General best-practice warnings
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

/// Builds the actual SVG XML string.
/// This is highly optimized. Instead of rendering thousands of individual `<rect>` tags
/// for the black squares, it constructs a single massive `<path>` using `M` (Move To)
/// and `h1v1h-1z` (Draw 1x1 square) commands. This shrinks the DOM size dramatically,
/// making rendering in React instantaneous.
fn to_svg_string(qr: &QrCode, border: i32, fg: &str, bg: &str) -> String {
    let size = qr.size();
    let dimension = size + border * 2;
    let mut sb = String::with_capacity(1024); // Pre-allocate memory to avoid reallocation overhead

    let fg_safe = sanitize_color(fg);
    let bg_safe = sanitize_color(bg);

    sb.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");

    sb.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 {} {}\" stroke=\"none\">",
        dimension, dimension
    ));

    // Draw the background square
    sb.push_str(&format!(
        "<rect width=\"100%\" height=\"100%\" fill=\"{}\"/>",
        bg_safe
    ));

    // Start drawing the foreground data path
    sb.push_str(&format!("<path fill=\"{}\" d=\"", fg_safe));

    for y in 0..size {
        for x in 0..size {
            // If the module is dark (true), draw a 1x1 square path at that coordinate
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

/// Calculates the contrast ratio between two hex colors to ensure the QR code is legible
/// according to WCAG contrast algorithms.
fn colors_too_similar(color1: &str, color2: &str) -> bool {
    let rgb1 = hex_to_rgb(color1);
    let rgb2 = hex_to_rgb(color2);

    if rgb1.is_none() || rgb2.is_none() {
        return false;
    }

    let (r1, g1, b1) = rgb1.unwrap();
    let (r2, g2, b2) = rgb2.unwrap();

    // Calculate relative luminance
    let lum1 = 0.299 * r1 + 0.587 * g1 + 0.114 * b1;
    let lum2 = 0.299 * r2 + 0.587 * g2 + 0.114 * b2;

    // Check contrast ratio
    let contrast = if lum1 > lum2 {
        (lum1 + 0.05) / (lum2 + 0.05)
    } else {
        (lum2 + 0.05) / (lum1 + 0.05)
    };

    // QR codes generally need at least a 3:1 contrast ratio for scanners to distinguish the dots
    contrast < 3.0
}

/// Converts a standard #RRGGBB string into a tuple of 0.0-1.0 floats.
fn hex_to_rgb(hex: &str) -> Option<(f64, f64, f64)> {
    if hex.len() != 7 || !hex.starts_with('#') {
        return None;
    }

    let r = u8::from_str_radix(&hex[1..3], 16).ok()? as f64 / 255.0;
    let g = u8::from_str_radix(&hex[3..5], 16).ok()? as f64 / 255.0;
    let b = u8::from_str_radix(&hex[5..7], 16).ok()? as f64 / 255.0;

    Some((r, g, b))
}

// --- END OF FILE qr.rs ---
