// run with npx jest src/utils/security.test.ts
// Or simply: npm test

import {
  getPasswordStrength,
  generateBrowserEntropy,
  getStrengthColor,
  getPasswordScore,
} from "./security";

// Mock the browser crypto API which doesn't exist natively in Node.js/Jest
beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    value: {
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) {
          arr[i] = Math.floor(Math.random() * 256);
        }
        return arr;
      },
    },
    writable: true, // Allows redefining if other tests also mock it
  });
});

describe("security.ts", () => {
  // ---------------------------------------------------------------------------
  // getPasswordStrength & getPasswordScore
  // ---------------------------------------------------------------------------
  describe("getPasswordStrength & getPasswordScore", () => {
    test("returns 0 (Very Weak) for empty or too short passwords", () => {
      expect(getPasswordStrength("").score).toBe(0);
      expect(getPasswordStrength("12345").score).toBe(0); // < 8 chars
      expect(getPasswordScore("Short!")).toBe(0); // < 8 chars, even with symbol
    });

    test("returns 1 (Weak) for >8 chars but low complexity", () => {
      // Only lowercase and numbers
      expect(getPasswordStrength("password123").score).toBe(1);
      // Only uppercase and lowercase
      expect(getPasswordStrength("PasswordOnly").score).toBe(1);
    });

    test("returns 2 (Medium) for >8 chars and moderate complexity", () => {
      // Upper, lower, digit (3 types)
      expect(getPasswordStrength("Password123").score).toBe(2);
    });

    test("returns 3 (Strong) for >8 chars and high complexity", () => {
      // Upper, lower, digit, special (4 types)
      expect(getPasswordStrength("P@ssw0rd123!").score).toBe(3);
    });

    test("returns 4 (Excellent) for long passphrases", () => {
      // >20 chars with separators
      const result = getPasswordStrength("correct-horse-battery-staple");
      expect(result.score).toBe(4);
      expect(result.feedback).toBe("Excellent Passphrase");

      // Spaced passphrase
      expect(getPasswordScore("my super long and very secure phrase")).toBe(4);
    });

    test("enforces max score cap", () => {
      // Even a ridiculously long and complex password shouldn't exceed score 4
      const result = getPasswordStrength("A1!b".repeat(10));
      expect(result.score).toBe(4);
    });
  });

  // ---------------------------------------------------------------------------
  // getStrengthColor
  // ---------------------------------------------------------------------------
  describe("getStrengthColor", () => {
    test("returns correct hex color for each score level", () => {
      expect(getStrengthColor(0)).toBe("#dc2626"); // Red
      expect(getStrengthColor(1)).toBe("#ea580c"); // Orange
      expect(getStrengthColor(2)).toBe("#eab308"); // Yellow
      expect(getStrengthColor(3)).toBe("#84cc16"); // Light Green
      expect(getStrengthColor(4)).toBe("#15803d"); // Dark Green

      // Fallback for invalid score
      expect(getStrengthColor(-1)).toBe("#454545");
      expect(getStrengthColor(5)).toBe("#454545");
    });
  });

  // ---------------------------------------------------------------------------
  // generateBrowserEntropy
  // ---------------------------------------------------------------------------
  describe("generateBrowserEntropy", () => {
    test("generates exactly 32 bytes of entropy", () => {
      // Passing true or false shouldn't matter anymore since we removed the parameter,
      // but we test the output length regardless.
      const entropy = generateBrowserEntropy();
      expect(entropy.length).toBe(32);
    });

    test("values are within byte bounds (0-255)", () => {
      const entropy = generateBrowserEntropy();
      entropy.forEach((byte) => {
        expect(byte).toBeGreaterThanOrEqual(0);
        expect(byte).toBeLessThanOrEqual(255);
        expect(Number.isInteger(byte)).toBe(true);
      });
    });
  });
});
