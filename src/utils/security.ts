// --- ENTROPY GENERATION (Paranoid Mode) ---

export function generateBrowserEntropy(paranoid: boolean): number[] {
  const array = new Uint8Array(32);
  window.crypto.getRandomValues(array);

  if (!paranoid) {
    return Array.from(array);
  }

  const time = performance.now();
  const timeBytes = new Uint8Array(new Float64Array([time]).buffer);

  for (let i = 0; i < array.length; i++) {
    array[i] = array[i] ^ timeBytes[i % 8];
  }

  return Array.from(array);
}

// --- LIGHTWEIGHT PASSWORD STRENGTH LOGIC ---

export const getPasswordStrength = (password: string) => {
  if (!password) return { score: 0, feedback: "Enter a password" };

  // 1. PASSPHRASE DETECTION (Fix for the "Yellow Bar" issue)
  // If it's very long (>20 chars) and uses separators (- or space), it's a strong passphrase.
  if (
    password.length > 20 &&
    (password.includes("-") || password.includes(" "))
  ) {
    return { score: 4, feedback: "Excellent Passphrase" };
  }

  // 2. STANDARD SCORING
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

  // Feedback Messages
  const messages = [
    "Very Weak (Too short)", // 0
    "Weak (Add numbers/symbols)", // 1
    "Okay (Reasonable)", // 2
    "Good (Hard to crack)", // 3
    "Strong (Excellent)", // 4
  ];

  return {
    score: score,
    feedback: messages[score],
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
