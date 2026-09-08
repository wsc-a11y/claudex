import { useEffect } from "react";
import { Navigate, Routes, Route, useLocation, useParams } from "react-router-dom";
import { useAuth } from "@/state/auth";
import { LoginScreen } from "@/screens/Login";
import { HomeScreen } from "@/screens/Home";
import { ChatScreen } from "@/screens/Chat";
import { DiffReviewScreen } from "@/screens/DiffReview";
import { SessionDiffScreen } from "@/screens/SessionDiff";
import { SubagentRunScreen } from "@/screens/SubagentRun";
import { SettingsScreen } from "@/screens/Settings";
import { AboutScreen } from "@/screens/About";
import { RoutinesScreen } from "@/screens/Routines";
import { QueueScreen } from "@/screens/Queue";
import { AlertsScreen } from "@/screens/Alerts";
import { FilesScreen } from "@/screens/Files";
import { UsagePage } from "@/screens/UsagePage";
import { ClientErrorsScreen } from "@/screens/ClientErrors";
import { KeyboardHelp } from "@/components/KeyboardHelp";

// Force a full remount of <ChatScreen /> whenever the route :id changes.
// Without this, React reuses the component instance across
// `/session/:idA` → `/session/:idB` and every piece of local state
// (revealedSeq, editingSeq, ToolCallBlock expansion, forking, etc.)
// leaks into the next session. Keying on `id` guarantees a clean slate.
function ChatScreenWithKey() {
  const { id } = useParams();
  return <ChatScreen key={id} />;
}

function Guard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-ui text-ink-muted mono">
        loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: loc }} />;
  return <>{children}</>;
}

export default function App() {
  const { checkSession } = useAuth();
  useEffect(() => {
    checkSession();
  }, [checkSession]);
  return (
    <>
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/" element={<Navigate to="/sessions" replace />} />
      <Route
        path="/sessions"
        element={
          <Guard>
            <HomeScreen />
          </Guard>
        }
      />
      <Route
        path="/routines"
        element={
          <Guard>
            <RoutinesScreen />
          </Guard>
        }
      />
      <Route
        path="/queue"
        element={
          <Guard>
            <QueueScreen />
          </Guard>
        }
      />
      <Route
        path="/alerts"
        element={
          <Guard>
            <AlertsScreen />
          </Guard>
        }
      />
      <Route
        path="/files"
        element={
          <Guard>
            <FilesScreen />
          </Guard>
        }
      />
      <Route
        path="/usage"
        element={
          <Guard>
            <UsagePage />
          </Guard>
        }
      />
      <Route
        path="/errors"
        element={
          <Guard>
            <ClientErrorsScreen />
          </Guard>
        }
      />
      <Route
        path="/session/:id"
        element={
          <Guard>
            <ChatScreenWithKey />
          </Guard>
        }
      />
      <Route
        path="/session/:id/diff"
        element={
          <Guard>
            <DiffReviewScreen />
          </Guard>
        }
      />
      <Route
        path="/session/:id/session-diff"
        element={
          <Guard>
            <SessionDiffScreen />
          </Guard>
        }
      />
      <Route
        path="/session/:id/subagent/:taskId"
        element={
          <Guard>
            <SubagentRunScreen />
          </Guard>
        }
      />
      <Route
        path="/settings"
        element={
          <Guard>
            <SettingsScreen />
          </Guard>
        }
      />
      <Route
        path="/about"
        element={
          <Guard>
            <AboutScreen />
          </Guard>
        }
      />
      <Route path="*" element={<Navigate to="/sessions" replace />} />
    </Routes>
    <KeyboardHelp />
    </>
  );
}
