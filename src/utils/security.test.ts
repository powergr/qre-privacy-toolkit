// run with npx jest src/utils/security.test.ts

import { getPasswordStrength, generateBrowserEntropy } from "./security";

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
  describe("getPasswordStrength", () => {
    test("returns 0 for empty or very weak passwords", () => {
      expect(getPasswordStrength("").score).toBe(0);
      expect(getPasswordStrength("12345").score).toBe(0); // Too short
    });

    test("returns 1 for weak passwords", () => {
      expect(getPasswordStrength("password123").score).toBe(1);
    });

    test("returns 3 for strong complex passwords", () => {
      expect(getPasswordStrength("P@ssw0rd123!").score).toBe(3);
    });

    test("returns 4 for long passphrases", () => {
      expect(getPasswordStrength("correct-horse-battery-staple").score).toBe(4);
    });
  });

  describe("generateBrowserEntropy", () => {
    test("generates exactly 32 bytes of entropy", () => {
      const entropy = generateBrowserEntropy();
      expect(entropy.length).toBe(32);
    });

    test("values are within byte bounds (0-255)", () => {
      const entropy = generateBrowserEntropy();
      entropy.forEach((byte) => {
        expect(byte).toBeGreaterThanOrEqual(0);
        expect(byte).toBeLessThanOrEqual(255);
      });
    });
  });
});
