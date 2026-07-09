import { useState, type ReactNode } from "react";
import {
  AppBar,
  Box,
  Button,
  IconButton,
  Stack,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import HomeRoundedIcon from "@mui/icons-material/HomeRounded";
import PeopleAltRoundedIcon from "@mui/icons-material/PeopleAltRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import NotesSidebar, { SIDEBAR_WIDTH } from "./NotesSidebar";
import DivitLogo from "./DivitLogo";
import { navigate, usePath } from "../utils/router";

// Persistent app chrome (sidebar + top bar) shared by every route (ADR-0024/0025).
// The routed page is passed as children. Primary nav (Ana Sayfa / Hastalar / Yeni
// muayene) is labeled + active-highlighted so pages are discoverable. Sidebar note
// actions navigate to /yeni with a query the workspace consumes.

interface AppShellProps {
  children: ReactNode;
  /** Highlight in the sidebar (a note/job id), when applicable. */
  activeId?: string | null;
  /** Bumped to force the sidebar to reload its lists. */
  refreshToken?: number;
}

export default function AppShell({ children, activeId = null, refreshToken = 0 }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const path = usePath();

  const navItems = [
    { label: "Ana Sayfa", icon: <HomeRoundedIcon fontSize="small" />, to: "/", active: path === "/" },
    { label: "Hastalar", icon: <PeopleAltRoundedIcon fontSize="small" />, to: "/patients", active: path === "/patients" || path.startsWith("/patients/") },
  ];

  return (
    <Box sx={{ display: "flex", minHeight: "100vh", bgcolor: "background.default" }}>
      {/* Persistent collapsible left sidebar */}
      <Box
        sx={{
          width: sidebarOpen ? SIDEBAR_WIDTH : 0,
          flexShrink: 0,
          overflow: "hidden",
          transition: "width .2s ease",
          borderRight: sidebarOpen ? "1px solid rgba(26,26,46,0.08)" : "none",
          position: "sticky",
          top: 0,
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          bgcolor: "background.paper",
        }}
      >
        {/* Primary navigation — labeled + active-highlighted (REQ-165). */}
        <Stack spacing={0.5} sx={{ p: 1.5, pb: 1 }}>
          <Button
            variant="contained"
            fullWidth
            startIcon={<AddRoundedIcon />}
            onClick={() => navigate("/yeni?new=1")}
            sx={{ justifyContent: "flex-start", mb: 0.5 }}
          >
            Yeni muayene
          </Button>
          {navItems.map((item) => (
            <Button
              key={item.to}
              fullWidth
              startIcon={item.icon}
              onClick={() => navigate(item.to)}
              sx={{
                justifyContent: "flex-start",
                color: item.active ? "primary.main" : "text.secondary",
                bgcolor: item.active ? "primary.light" : "transparent",
                fontWeight: item.active ? 700 : 500,
                "&:hover": { bgcolor: item.active ? "primary.light" : "action.hover" },
              }}
            >
              {item.label}
            </Button>
          ))}
        </Stack>

        {/* Note history / sessions list fills the rest. */}
        <Box sx={{ flexGrow: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <NotesSidebar
            activeId={activeId}
            onOpenNote={(id) => navigate(`/yeni?note=${encodeURIComponent(id)}`)}
            onOpenJob={(id) => navigate(`/yeni?job=${encodeURIComponent(id)}`)}
            onOpenActiveNote={(id) => navigate(`/yeni?activeNote=${encodeURIComponent(id)}`)}
            onNewNote={() => navigate("/yeni?new=1")}
            onCollapse={() => setSidebarOpen(false)}
            refreshToken={refreshToken}
          />
        </Box>
      </Box>

      {/* Main column */}
      <Box sx={{ flexGrow: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <AppBar
          position="sticky"
          color="inherit"
          elevation={0}
          sx={{ borderBottom: "1px solid rgba(26,26,46,0.08)" }}
        >
          <Toolbar>
            {!sidebarOpen && (
              <Tooltip title="Kenar çubuğunu göster">
                <IconButton
                  edge="start"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Kenar çubuğunu göster"
                  sx={{ mr: 1 }}
                >
                  <MenuRoundedIcon />
                </IconButton>
              </Tooltip>
            )}
            <Box
              sx={{ display: "flex", alignItems: "center", gap: 1.25, cursor: "pointer" }}
              onClick={() => navigate("/")}
            >
              <DivitLogo size={34} />
              <Typography variant="h6" sx={{ fontWeight: 800, letterSpacing: "-0.02em" }}>
                Divit
              </Typography>
            </Box>

            <Box sx={{ flexGrow: 1 }} />

            {/* Top-bar nav mirrors the sidebar for when it's collapsed. */}
            <Stack direction="row" spacing={0.5}>
              <Button
                startIcon={<HomeRoundedIcon />}
                onClick={() => navigate("/")}
                color="inherit"
                sx={{ color: path === "/" ? "primary.main" : "text.secondary", fontWeight: path === "/" ? 700 : 500 }}
              >
                Ana Sayfa
              </Button>
              <Button
                startIcon={<PeopleAltRoundedIcon />}
                onClick={() => navigate("/patients")}
                color="inherit"
                sx={{
                  color: path.startsWith("/patients") ? "primary.main" : "text.secondary",
                  fontWeight: path.startsWith("/patients") ? 700 : 500,
                }}
              >
                Hastalar
              </Button>
            </Stack>
          </Toolbar>
        </AppBar>

        {children}
      </Box>
    </Box>
  );
}
