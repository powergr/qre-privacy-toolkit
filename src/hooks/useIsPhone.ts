import { useEffect, useState } from "react";

/** The width at which the app switches to its phone layout. The style sheets use the same number. */
export const PHONE_QUERY = "(max-width: 600px)";

function read(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * True while the window is phone-sized, and follows it as the window changes. Where the
 * browser cannot say (older test environments), the answer is false: the desktop layout.
 */
export function useIsPhone(): boolean {
  const [isPhone, setIsPhone] = useState(read);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia(PHONE_QUERY);
    } catch {
      return;
    }
    const update = () => setIsPhone(query.matches);
    update();
    // Safari before 14 only has the old addListener pair.
    if (query.addEventListener) {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    query.addListener(update);
    return () => query.removeListener(update);
  }, []);

  return isPhone;
}
