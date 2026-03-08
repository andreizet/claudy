import { useMemo, useState } from "react";
import { Alert, Box, Group, ScrollArea, Skeleton, Stack, Table, Text, UnstyledButton } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { UsageDashboard } from "../types";
import {
  compareProjectRows,
  compareSessionRows,
  ProjectSortKey,
  SessionSortKey,
  SortState,
  toggleSort,
} from "../shared/usageDashboard";

type UsageInterval = "7d" | "30d" | "90d" | "all";

const INTERVALS: Array<{ value: UsageInterval; label: string }> = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

export default function UsageDashboardView() {
  const [interval, setInterval] = useState<UsageInterval>("30d");
  const [projectSort, setProjectSort] = useState<SortState<ProjectSortKey>>({
    key: "tokens",
    direction: "desc",
  });
  const [sessionSort, setSessionSort] = useState<SortState<SessionSortKey>>({
    key: "started",
    direction: "desc",
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ["usage-dashboard", interval],
    queryFn: () => invoke<UsageDashboard>("get_usage_dashboard", { interval }),
    staleTime: 60_000,
  });

  const maxDailyTokens = useMemo(
    () => Math.max(...(data?.daily.map((point) => point.total_tokens) ?? [0]), 1),
    [data?.daily]
  );
  const sortedProjects = useMemo(() => {
    const items = [...(data?.projects ?? [])];
    items.sort((a, b) => compareProjectRows(a, b, projectSort));
    return items;
  }, [data?.projects, projectSort]);
  const sortedSessions = useMemo(() => {
    const items = [...(data?.sessions ?? [])];
    items.sort((a, b) => compareSessionRows(a, b, sessionSort));
    return items;
  }, [data?.sessions, sessionSort]);

  if (isLoading) {
    return (
      <Stack gap={16} p={20}>
        <Skeleton height={34} width={340} radius="md" />
        <Group grow>
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} height={92} radius="lg" />
          ))}
        </Group>
        <Skeleton height={220} radius="lg" />
        <Skeleton height={320} radius="lg" />
      </Stack>
    );
  }

  if (error || !data) {
    return (
      <Box p={20}>
        <Alert color="red" variant="light" title="Usage dashboard unavailable">
          Could not load usage data from `~/.claude`.
        </Alert>
      </Box>
    );
  }

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Stack gap={20} p={20}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Box>
            <Text size="xl" fw={700} c="#f4f4f5">Usage Dashboard</Text>
          </Box>
          <Group gap={8}>
            {INTERVALS.map((item) => (
              <IntervalButton
                key={item.value}
                active={interval === item.value}
                onClick={() => setInterval(item.value)}
              >
                {item.label}
              </IntervalButton>
            ))}
          </Group>
        </Group>

        <Group grow align="stretch">
          <MetricCard label="Sessions" value={formatInt(data.summary.total_sessions)} />
          <MetricCard label="Total Tokens" value={formatInt(data.summary.total_tokens)} />
          <MetricCard label="Cost" value={formatUsd(data.summary.total_cost_usd)} />
          <MetricCard label="Messages" value={formatInt(data.summary.total_messages)} />
          <MetricCard label="Tool Calls" value={formatInt(data.summary.total_tool_calls)} />
          <MetricCard label="Files Modified" value={formatInt(data.summary.total_files_modified)} />
        </Group>

        <Group grow align="stretch">
          <MetricCard label="Input Tokens" value={formatInt(data.summary.total_input_tokens)} subtle />
          <MetricCard label="Output Tokens" value={formatInt(data.summary.total_output_tokens)} subtle />
          <MetricCard label="Lines Added" value={formatInt(data.summary.total_lines_added)} subtle />
          <MetricCard label="Lines Removed" value={formatInt(data.summary.total_lines_removed)} subtle />
          <MetricCard label="Active Days" value={formatInt(data.summary.active_days)} subtle />
          <MetricCard label="Msgs / Session" value={data.summary.avg_messages_per_session.toFixed(1)} subtle />
        </Group>

        <Panel title="Daily Usage Trend" subtitle="Sessions, tokens, and cost by day">
          {data.daily.length === 0 ? (
            <EmptyPanel message="No usage data in the selected interval." />
          ) : (
            <Stack gap={10}>
              {data.daily.map((point) => (
                <Box key={point.date}>
                  <Group justify="space-between" mb={4}>
                    <Text size="xs" c="#e4e4e7">{point.date}</Text>
                    <Group gap={10}>
                      <Text size="xs" c="#71717a">{formatInt(point.sessions)} sessions</Text>
                      <Text size="xs" c="#71717a">{formatInt(point.total_tokens)} tokens</Text>
                      <Text size="xs" c="#71717a">{formatUsd(point.cost_usd)}</Text>
                    </Group>
                  </Group>
                  <Box
                    style={{
                      height: 8,
                      borderRadius: 999,
                      background: "#202028",
                      overflow: "hidden",
                    }}
                  >
                    <Box
                      style={{
                        width: `${(point.total_tokens / maxDailyTokens) * 100}%`,
                        minWidth: point.total_tokens > 0 ? 6 : 0,
                        height: "100%",
                        borderRadius: 999,
                        background: "linear-gradient(90deg, #FFE100 0%, #ffb300 100%)",
                      }}
                    />
                  </Box>
                </Box>
              ))}
            </Stack>
          )}
        </Panel>

        <Group grow align="stretch">
          <Panel title="Model Breakdown" subtitle="Usage by Claude model">
            {data.models.length === 0 ? (
              <EmptyPanel message="No model data available." />
            ) : (
              <DataTable
                headers={["Model", "Tokens", "Input", "Output", "Cost", "Sessions"]}
                rows={data.models.slice(0, 12).map((item) => [
                  item.model,
                  formatInt(item.total_tokens),
                  formatInt(item.input_tokens),
                  formatInt(item.output_tokens),
                  formatUsd(item.cost_usd),
                  formatInt(item.sessions),
                ])}
              />
            )}
          </Panel>

          <Panel title="Project Breakdown" subtitle="Where usage is concentrated">
            {sortedProjects.length === 0 ? (
              <EmptyPanel message="No project data available." />
            ) : (
              <SortableTable
                columns={[
                  { key: "project", label: "Project" },
                  { key: "sessions", label: "Sessions", align: "right" },
                  { key: "tokens", label: "Tokens", align: "right" },
                  { key: "cost", label: "Cost", align: "right" },
                  { key: "messages", label: "Messages", align: "right" },
                  { key: "last_active", label: "Last Active", align: "right" },
                ]}
                sort={projectSort}
                onSortChange={(key) => setProjectSort((current) => toggleSort(current, key))}
                rows={sortedProjects.slice(0, 12).map((item) => ({
                  key: item.project_path,
                  cells: [
                    item.display_name,
                    formatInt(item.sessions),
                    formatInt(item.total_tokens),
                    formatUsd(item.cost_usd),
                    formatInt(item.messages),
                    formatDateTime(item.last_active),
                  ],
                }))}
              />
            )}
          </Panel>
        </Group>

        <Panel title="Session Breakdown" subtitle="Most recent sessions in the selected interval">
          {sortedSessions.length === 0 ? (
            <EmptyPanel message="No sessions in the selected interval." />
          ) : (
            <SortableTable
              columns={[
                { key: "session", label: "Session" },
                { key: "project", label: "Project" },
                { key: "started", label: "Started", align: "right" },
                { key: "duration", label: "Duration", align: "right" },
                { key: "tokens", label: "Tokens", align: "right" },
                { key: "cost", label: "Cost", align: "right" },
                { key: "prompt", label: "Prompt" },
              ]}
              sort={sessionSort}
              onSortChange={(key) => setSessionSort((current) => toggleSort(current, key))}
              rows={sortedSessions.slice(0, 20).map((item) => ({
                key: item.session_id,
                cells: [
                  item.session_id.slice(0, 8),
                  item.display_name,
                  formatDateTime(item.start_time),
                  `${formatInt(item.duration_minutes)} min`,
                  formatInt(item.total_tokens),
                  formatUsd(item.cost_usd),
                  truncate(item.first_prompt, 88),
                ],
              }))}
            />
          )}
        </Panel>
      </Stack>
    </ScrollArea>
  );
}

function MetricCard({ label, value, subtle = false }: { label: string; value: string; subtle?: boolean }) {
  return (
    <Box
      style={{
        padding: "14px 16px",
        borderRadius: 14,
        border: "1px solid #23232a",
        background: subtle ? "#111116" : "#15151b",
        minWidth: 0,
      }}
    >
      <Text size="10px" tt="uppercase" fw={700} c="#71717a">{label}</Text>
      <Text mt={8} size="xl" fw={700} c="#f4f4f5">{value}</Text>
    </Box>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <Box
      style={{
        borderRadius: 16,
        border: "1px solid #23232a",
        background: "#121217",
        padding: 16,
        minWidth: 0,
      }}
    >
      <Text size="sm" fw={700} c="#f4f4f5">{title}</Text>
      <Text size="xs" c="#71717a" mb={14}>{subtitle}</Text>
      {children}
    </Box>
  );
}

function DataTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <ScrollArea>
      <Table
        withTableBorder={false}
        withColumnBorders={false}
        highlightOnHover={false}
        styles={{
          tr: { borderBottom: "1px solid #23232a" },
          th: { color: "#71717a", fontSize: 11, fontWeight: 700, textTransform: "uppercase", padding: "8px 10px" },
          td: { color: "#e4e4e7", fontSize: 12, padding: "10px" },
        }}
      >
        <Table.Thead>
          <Table.Tr>
            {headers.map((header) => (
              <Table.Th key={header}>{header}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row, index) => (
            <Table.Tr key={index}>
              {row.map((cell, cellIndex) => (
                <Table.Td key={`${index}-${cellIndex}`}>{cell}</Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function SortableTable<TSortKey extends string>({
  columns,
  rows,
  sort,
  onSortChange,
}: {
  columns: Array<{ key: TSortKey; label: string; align?: "left" | "right" }>;
  rows: Array<{ key: string; cells: string[] }>;
  sort: SortState<TSortKey>;
  onSortChange: (key: TSortKey) => void;
}) {
  return (
    <ScrollArea>
      <Table
        withTableBorder={false}
        withColumnBorders={false}
        highlightOnHover={false}
        styles={{
          tr: { borderBottom: "1px solid #23232a" },
          th: { color: "#71717a", fontSize: 11, fontWeight: 700, textTransform: "uppercase", padding: "8px 10px" },
          td: { color: "#e4e4e7", fontSize: 12, padding: "10px" },
        }}
      >
        <Table.Thead>
          <Table.Tr>
            {columns.map((column) => (
              <Table.Th key={column.key} style={{ textAlign: column.align === "right" ? "right" : "left" }}>
                <UnstyledButton
                  onClick={() => onSortChange(column.key)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    color: sort.key === column.key ? "#e4e4e7" : "#71717a",
                  }}
                >
                  <Text size="11px" fw={700} tt="uppercase" inherit>
                    {column.label}
                  </Text>
                  <Text size="10px" c={sort.key === column.key ? "#FFE100" : "#52525b"} lh={1}>
                    {sort.key === column.key ? (sort.direction === "asc" ? "↑" : "↓") : "↕"}
                  </Text>
                </UnstyledButton>
              </Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((row) => (
            <Table.Tr key={row.key}>
              {row.cells.map((cell, index) => (
                <Table.Td
                  key={`${row.key}-${index}`}
                  style={{ textAlign: columns[index]?.align === "right" ? "right" : "left" }}
                >
                  {cell}
                </Table.Td>
              ))}
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}

function EmptyPanel({ message }: { message: string }) {
  return <Text size="sm" c="#71717a">{message}</Text>;
}

function IntervalButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <UnstyledButton
      onClick={onClick}
      style={{
        padding: "7px 10px",
        borderRadius: 8,
        border: active ? "1px solid #383844" : "1px solid #23232a",
        background: active ? "#1d1d24" : "#121217",
        color: active ? "#f4f4f5" : "#a1a1aa",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {children}
    </UnstyledButton>
  );
}

function formatUsd(value: number) {
  return value > 0 ? `$${value.toFixed(2)}` : "$0.00";
}

function formatInt(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
