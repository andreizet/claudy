import { createTheme, MantineColorsTuple } from "@mantine/core";

// True zinc dark — no saturated hue in the grays
const dark: MantineColorsTuple = [
  "#f4f4f5", // [0] primary text
  "#d4d4d8", // [1] secondary text
  "#a1a1aa", // [2] muted text
  "#71717a", // [3] very muted
  "#3f3f46", // [4] subtle border
  "#27272a", // [5] border
  "#18181b", // [6] hover / card
  "#131316", // [7] sidebar
  "#0c0c0f", // [8] main bg
  "#080809", // [9] deepest
];

// Muted slate-blue — used sparingly (focus rings, active states)
const accent: MantineColorsTuple = [
  "#f0f4ff",
  "#dce6ff",
  "#b3c6ff",
  "#7a9ef5",
  "#4f78e8",
  "#3b63d6",
  "#2f52b8",
  "#243f90",
  "#1a2e68",
  "#0f1c42",
];

export const theme = createTheme({
  primaryColor: "accent",
  colors: { dark, accent },
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif',
  fontFamilyMonospace:
    '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, monospace',
  defaultRadius: "md",
  cursorType: "pointer",
});
