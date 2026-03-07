import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { DiscoveredWorkspace } from "./types";
import HomeView from "./views/HomeView";
import ChatView from "./views/ChatView";

type View =
  | { kind: "home" }
  | { kind: "chat"; workspace: DiscoveredWorkspace };

export default function App() {
  const [view, setView] = useState<View>({ kind: "home" });

  const { data: workspaces = [], isLoading } = useQuery({
    queryKey: ["existing-sessions"],
    queryFn: () => invoke<DiscoveredWorkspace[]>("scan_existing_sessions"),
  });

  if (view.kind === "chat") {
    return (
      <ChatView
        workspace={view.workspace}
        onBack={() => setView({ kind: "home" })}
      />
    );
  }

  return (
    <HomeView
      workspaces={workspaces}
      isLoading={isLoading}
      onOpenWorkspace={(workspace) => setView({ kind: "chat", workspace })}
    />
  );
}
