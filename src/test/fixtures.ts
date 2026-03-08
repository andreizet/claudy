import { DiscoveredSession, DiscoveredWorkspace } from "../types";

export const mockSessions: DiscoveredSession[] = [
  {
    id: "session-alpha",
    file_path: "/tmp/claudy/session-alpha.jsonl",
    modified_at: `${Math.floor(Date.now() / 1000) - 3600}`,
    first_message: "Implement the login flow",
  },
  {
    id: "session-beta",
    file_path: "/tmp/claudy/session-beta.jsonl",
    modified_at: `${Math.floor(Date.now() / 1000) - 7200}`,
    first_message: "Fix the dashboard charts",
  },
];

export const mockWorkspace: DiscoveredWorkspace = {
  encoded_name: "-Users-andrei-_work-claudy-claudy",
  decoded_path: "/Users/andrei/_work/claudy/claudy",
  display_name: "claudy",
  path_exists: true,
  sessions: mockSessions,
};

export const missingWorkspace: DiscoveredWorkspace = {
  ...mockWorkspace,
  encoded_name: "-missing-project",
  decoded_path: "/Users/andrei/_work/missing-project",
  display_name: "missing-project",
  path_exists: false,
  sessions: [],
};
