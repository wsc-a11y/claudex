import { useEffect, useState } from "react";

// useVisualViewport — mobile keyboard / safe-area aware viewport read.
//
// Returns the visual viewport's inner height plus `offsetBottom` =
// `window.innerHeight - visualViewport.height - visualViewport.offsetTop`,
// i.e. how many CSS pixels of the layout viewport are currently hidden under
// the software keyboard (or, on iOS, the URL bar + keyboard combined).
//
// Useful for lifting a fixed composer above the keyboard: set
// `transform: translateY(-offsetBottom)` or `paddingBottom: offsetBottom`
// on the composer wrapper so it stays visible while the user types.
//
// SSR safe: returns `{height: 0, offsetBottom: 0}` on the server, and
// degrades to `{height: window.innerHeight, offsetBottom: 0}` in browsers
// without a `visualViewport` (everything modern has it; this is defensive).
export function useVisualViewport(): { height: number; offsetBottom: number } {
  const [state, setState] = useState<{ height: number; offsetBottom: number }>(() => {
    if (typeof window === "undefined") return { height: 0, offsetBottom: 0 };
    const vv = window.visualViewport;
    if (!vv) return { height: window.innerHeight, offsetBottom: 0 };
    return {
      height: vv.height,
      offsetBottom: Math.max(0, window.innerHeight - vv.height - vv.offsetTop),
    };
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      setState({
        height: vv.height,
        offsetBottom: Math.max(0, window.innerHeight - vv.height - vv.offsetTop),
      });
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return state;
}
