import zxcvbn from "zxcvbn";

export const getStrengthColor = (score: number) => {
  switch (score) {
    case 0: return "#f7768e";
    case 1: return "#ff9e64";
    case 2: return "#e0af68";
    case 3: return "#9ece6a";
    case 4: return "#73daca";
    default: return "transparent";
  }
};

export function getPasswordScore(pass: string) {
    return pass ? zxcvbn(pass).score : -1;
}

export function generateBrowserEntropy(isParanoid: boolean): number[] | null {
  if (!isParanoid) return null;
  const array = new Uint8Array(32);
  window.crypto.getRandomValues(array);
  return Array.from(array);
}