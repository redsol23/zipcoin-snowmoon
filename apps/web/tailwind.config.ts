import type { Config } from "tailwindcss";

// Veridia palette. Three colors carry meaning, like the pad on a restaurant table:
// pad green = private money moving, candle gold = coins burned to be heard, slate = civic (tax, polls).
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        snow: "#ECF0EC",
        drift: "#E1E7E2",
        pine: "#18241F",
        lichen: "#6E7A70",
        frost: "#C9D3CB",
        pad: "#22A866",
        candle: "#D6A01E",
        slate: "#496789",
      },
      fontFamily: {
        story: ["var(--font-newsreader)", "Georgia", "serif"],
        sans: ["var(--font-plex)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
export default config;
