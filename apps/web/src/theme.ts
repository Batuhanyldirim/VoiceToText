import { createTheme } from "@mui/material/styles";

// A clean, intentional light theme with a modern indigo/violet primary,
// rounded surfaces and generous spacing.
const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#5b5bd6",
      light: "#7c7cf0",
      dark: "#3f3fae",
      contrastText: "#ffffff",
    },
    secondary: {
      main: "#0ea5a4",
    },
    background: {
      default: "#f6f7fb",
      paper: "#ffffff",
    },
    text: {
      primary: "#1a1a2e",
      secondary: "#5a5a72",
    },
  },
  shape: {
    borderRadius: 14,
  },
  typography: {
    fontFamily:
      '"Inter", system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    h4: { fontWeight: 700, letterSpacing: "-0.02em" },
    h5: { fontWeight: 700, letterSpacing: "-0.01em" },
    h6: { fontWeight: 700 },
    button: { textTransform: "none", fontWeight: 600 },
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
    MuiCard: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: {
          border: "1px solid rgba(26, 26, 46, 0.08)",
          borderRadius: 18,
        },
      },
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 12 },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
  },
});

export default theme;
