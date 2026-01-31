use anyhow::Result;
use qrcodegen::{QrCode, QrCodeEcc};

pub fn generate_qr(text: &str, fg_hex: &str, bg_hex: &str) -> Result<String> {
    // Encode text with Medium Error Correction
    let qr = QrCode::encode_text(text, QrCodeEcc::Medium).map_err(|e| anyhow::anyhow!(e))?;

    // Convert to SVG String with custom colors
    Ok(to_svg_string(&qr, 4, fg_hex, bg_hex))
}

// Helper to convert QR object to SVG string
fn to_svg_string(qr: &QrCode, border: i32, fg: &str, bg: &str) -> String {
    let size = qr.size();
    let dimension = size + border * 2;
    let mut sb = String::new();

    // Header
    sb.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
    sb.push_str(&format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" version=\"1.1\" viewBox=\"0 0 {0} {0}\" stroke=\"none\">", 
        dimension
    ));

    // Background Rectangle
    sb.push_str(&format!(
        "<rect width=\"100%\" height=\"100%\" fill=\"{}\"/>",
        bg
    ));

    // Path Start (Foreground Color)
    sb.push_str(&format!("<path fill=\"{}\" d=\"", fg));

    // Draw Modules
    for y in 0..size {
        for x in 0..size {
            if qr.get_module(x, y) {
                // Draw 1x1 rectangle at coordinate
                sb.push_str(&format!("M{},{}h1v1h-1z ", x + border, y + border));
            }
        }
    }

    // Path End & Footer
    sb.push_str("\"/></svg>");

    sb
}
