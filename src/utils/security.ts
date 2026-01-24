import { zxcvbn, zxcvbnOptions } from "@zxcvbn-ts/core";
import { dictionary, adjacencyGraphs } from "@zxcvbn-ts/language-common";
import { translations } from "@zxcvbn-ts/language-en"; // <--- Import official translations

// --- CONFIGURATION ---
const options = {
  translations, // Use the official package
  graphs: adjacencyGraphs,
  dictionary: {
    ...dictionary,
  },
};

zxcvbnOptions.setOptions(options);

// --- ENTROPY GENERATION (Paranoid Mode) ---

export function generateBrowserEntropy(paranoid: boolean): number[] {
  // 1. Get Crypto Random Values (OS provided)
  const array = new Uint8Array(32);
  window.crypto.getRandomValues(array);

  if (!paranoid) {
    return Array.from(array);
  }

  // 2. Paranoid: Mix in high-res timestamp
  const time = performance.now();
  const timeBytes = new Uint8Array(new Float64Array([time]).buffer);

  for (let i = 0; i < array.length; i++) {
    array[i] = array[i] ^ timeBytes[i % 8];
  }

  return Array.from(array);
}

// --- PASSWORD STRENGTH LOGIC ---

export const getPasswordStrength = (password: string) => {
  if (!password) return { score: 0, feedback: "Enter a password" };

  const result = zxcvbn(password);

  // Custom user-friendly feedback based on score (0-4)
  const messages = [
    "Very Weak (Instant hack)", // 0
    "Weak (Seconds to crack)", // 1
    "Okay (Minutes to crack)", // 2
    "Good (Hours/Days to crack)", // 3
    "Strong (Years to crack)", // 4
  ];

  // If zxcvbn provides a specific warning, use it. Otherwise use our generic message.
  const feedbackText = result.feedback.warning || messages[result.score];

  return {
    score: result.score, // 0 to 4
    feedback: feedbackText,
  };
};

export const getStrengthColor = (score: number) => {
  switch (score) {
    case 0:
      return "#dc2626"; // Red (Very Weak)
    case 1:
      return "#ea580c"; // Orange (Weak)
    case 2:
      return "#eab308"; // Yellow (Okay)
    case 3:
      return "#84cc16"; // Light Green (Good)
    case 4:
      return "#15803d"; // Dark Green (Strong)
    default:
      return "#454545"; // Grey
  }
};

// Legacy compatibility wrapper
export const getPasswordScore = (password: string): number => {
  return zxcvbn(password).score;
};
