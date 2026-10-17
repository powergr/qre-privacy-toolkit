import { useMediaQuery } from "./useMediaQuery";

/** The width at which the app switches to its phone layout. The style sheets use the same number. */
export const PHONE_QUERY = "(max-width: 600px)";

/**
 * True while the window is phone-sized, and follows it as the window changes. Where the
 * browser cannot say (older test environments), the answer is false: the desktop layout.
 */
export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
