// --- ENTROPY GENERATION (Paranoid Mode Fallback) ---

export function generateBrowserEntropy(): number[] {
  // Always use the browser's Cryptographically Secure Pseudo-Random Number Generator (CSPRNG)
  const array = new Uint8Array(32);
  window.crypto.getRandomValues(array);
  return Array.from(array);
}

// --- LIGHTWEIGHT PASSWORD STRENGTH LOGIC ---

export const getPasswordStrength = (password: string) => {
  if (!password) {
    return {
      score: 0,
      feedback: "Enter a password",
      label: "Empty",
      color: "#454545",
    };
  }

  // 1. PASSPHRASE DETECTION
  // If it's very long (>20 chars) and uses separators (- or space), it's a strong passphrase.
  if (
    password.length > 20 &&
    (password.includes("-") || password.includes(" "))
  ) {
    return {
      score: 4,
      feedback: "Excellent Passphrase",
      label: "Excellent",
      color: "#15803d",
    };
  }

  // 2. IMMEDIATE REJECTION FOR SHORT PASSWORDS
  // A password under 8 characters is mathematically weak against modern cracking,
  // regardless of how many symbols it contains.
  if (password.length < 8) {
    return {
      score: 0,
      feedback: "Very Weak (Too short)",
      label: "Very Weak",
      color: "#dc2626",
    };
  }

  // 3. STANDARD SCORING
  let score = 0;

  // Length Bonus
  if (password.length > 8) score += 1;
  if (password.length > 12) score += 1;

  // Complexity Bonus
  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSpecial = /[^a-zA-Z0-9]/.test(password);

  const varietyCount = [hasLower, hasUpper, hasNumber, hasSpecial].filter(
    Boolean,
  ).length;

  if (varietyCount >= 3) score += 1;
  if (varietyCount >= 4) score += 1;

  // Cap score at 4
  if (score > 4) score = 4;

  // Feedback Messages mapping
  const messages = [
    { feedback: "Very Weak (Too short)", label: "Very Weak", color: "#dc2626" }, // 0
    { feedback: "Weak (Add numbers/symbols)", label: "Weak", color: "#ea580c" }, // 1
    { feedback: "Okay (Reasonable)", label: "Okay", color: "#eab308" }, // 2
    { feedback: "Good (Hard to crack)", label: "Good", color: "#84cc16" }, // 3
    { feedback: "Strong (Excellent)", label: "Strong", color: "#15803d" }, // 4
  ];

  return {
    score: score,
    feedback: messages[score].feedback,
    label: messages[score].label,
    color: messages[score].color,
  };
};

export const getStrengthColor = (score: number) => {
  switch (score) {
    case 0:
      return "#dc2626"; // Red
    case 1:
      return "#ea580c"; // Orange
    case 2:
      return "#eab308"; // Yellow
    case 3:
      return "#84cc16"; // Light Green
    case 4:
      return "#15803d"; // Dark Green
    default:
      return "#454545"; // Grey
  }
};

export const getPasswordScore = (password: string): number => {
  return getPasswordStrength(password).score;
};
