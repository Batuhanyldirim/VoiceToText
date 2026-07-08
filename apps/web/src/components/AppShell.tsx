import { useState, type ReactNode } from "react";
import {
  AppBar,
  Box,
  IconButton,
  Toolbar,
  Tooltip,
  Typography,
} from "@mui/material";
import GraphicEqRoundedIcon from "@mui/icons-material/GraphicEqRounded";
import MenuRoundedIcon from "@mui/icons-material/MenuRounded";
import PeopleAltRoundedIcon from "@mui/icons-material/PeopleAltRounded";
import NotesSidebar, { SIDEBAR_WIDTH } from "./NotesSidebar";
import { navigate } from "../utils/router";

// Persistent app chrome (sidebar + top bar) shared by every route (ADR-0024).
// The routed page is passed as children. Sidebar actions navigate: opening a note
// or job routes to the workspace ("/") with a query param it reads to open the
// right screen; "Yeni not" routes to a clean "/".

interface AppShellProps {
  children: ReactNode;
  /** Highlight in the sidebar (a note/job id), when applicable. */
  activeId?: string | null;
  /** Bumped to force the sidebar to reload its lists. */
  refreshToken?: number;
}

export default function AppShell({ children, activeId = null, refreshToken = 0 }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);

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
        }}
      >
        <NotesSidebar
          activeId={activeId}
          onOpenNote={(id) => navigate(`/?note=${encodeURIComponent(id)}`)}
          onOpenJob={(id) => navigate(`/?job=${encodeURIComponent(id)}`)}
          onOpenActiveNote={(id) => navigate(`/?activeNote=${encodeURIComponent(id)}`)}
          onNewNote={() => navigate("/?new=1")}
          onCollapse={() => setSidebarOpen(false)}
          refreshToken={refreshToken}
        />
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
              onClick={() => navigate("/?new=1")}
            >
              <Box
                sx={{
                  width: 36,
                  height: 36,
                  borderRadius: 2,
                  bgcolor: "primary.main",
                  color: "primary.contrastText",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <GraphicEqRoundedIcon fontSize="small" />
              </Box>
              <Typography variant="h6" sx={{ fontWeight: 800, letterSpacing: "-0.02em" }}>
                VoiceToText
              </Typography>
            </Box>

            <Box sx={{ flexGrow: 1 }} />

            <Tooltip title="Hastalar">
              <IconButton
                onClick={() => navigate("/patients")}
                aria-label="Hastalar"
                color="inherit"
                sx={{ color: "text.secondary" }}
              >
                <PeopleAltRoundedIcon />
              </IconButton>
            </Tooltip>
          </Toolbar>
        </AppBar>

        {children}
      </Box>
    </Box>
  );
}
