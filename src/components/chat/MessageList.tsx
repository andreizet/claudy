import { ComponentPropsWithoutRef, MouseEvent, ReactNode, forwardRef, memo, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import {
  ChevronDown,
  ChevronUp,
  FilePenLine,
  FileText,
  Brain,
  Terminal,
  Wrench,
  Copy,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as Diff from "diff";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
// language imports (prism-light requires explicit registration)
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import java from "react-syntax-highlighter/dist/esm/languages/prism/java";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import { JsonlRecord, ContentBlock, ContentBlockToolUse, ContentBlockToolResult } from "../../types";
import FileReferenceBadge from "./FileReferenceBadge";


SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("java", java);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("yaml", yaml);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("toml", toml);
SyntaxHighlighter.registerLanguage("markdown", markdown);

interface Props {
  messages: JsonlRecord[];
  streamMessages?: JsonlRecord[];
  streamBlocks?: ContentBlock[];
  showGenerating?: boolean;
  pendingUserText?: string;
  sessionId?: string | null;
  userAvatarUrl?: string;
}

type MessageListItem =
  | { key: string; kind: "message"; record: JsonlRecord }
  | { key: string; kind: "stream-message"; record: JsonlRecord }
  | { key: string; kind: "pending-user"; text: string }
  | { key: string; kind: "stream"; blocks: ContentBlock[] };

const VirtuosoScroller = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(function VirtuosoScroller(
  props,
  ref,
) {
  return <div {...props} ref={ref} data-testid="viewport" className="message-list-scroller" />;
});

const VirtuosoList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(function VirtuosoList(
  props,
  ref,
) {
  return (
    <div
      {...props}
      ref={ref}
      style={{
        ...(props.style ?? {}),
        maxWidth: 820,
        margin: "0 auto",
        width: "100%",
      }}
    />
  );
});

function MessageList({ messages, streamMessages, streamBlocks, showGenerating, pendingUserText, sessionId, userAvatarUrl }: Props) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const scrollRef = useRef<HTMLElement | null>(null);
  const atBottomRef = useRef(true);
  const initialScrollSessionRef = useRef<string | null>(null);
  const pendingInitialScrollSessionRef = useRef<string | null>(null);
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const items = useMemo(() => [
    ...messages.flatMap((record, index) => (
      shouldRenderRecord(record)
        ? [{
          key: `${sessionId ?? "session"}-message-${index}`,
          kind: "message" as const,
          record,
        }]
        : []
    )),
    ...(pendingUserText ? [{ key: `${sessionId ?? "session"}-pending-user`, kind: "pending-user" as const, text: pendingUserText }] : []),
    ...((streamMessages ?? []).flatMap((record, index) => (
      shouldRenderRecord(record)
        ? [{
          key: `${sessionId ?? "session"}-stream-message-${index}`,
          kind: "stream-message" as const,
          record,
        }]
        : []
    ))),
    ...(((streamBlocks && streamBlocks.length > 0) || showGenerating)
      ? [{ key: `${sessionId ?? "session"}-stream`, kind: "stream" as const, blocks: streamBlocks ?? [] }]
      : []),
  ], [messages, streamMessages, streamBlocks, showGenerating, pendingUserText, sessionId]);

  const scrollToBottom = (behavior: "auto" | "smooth") => {
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior });
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  };

  useEffect(() => {
    if (!sessionId || items.length === 0) return;
    if (initialScrollSessionRef.current === sessionId) return;
    pendingInitialScrollSessionRef.current = sessionId;
  }, [sessionId, items.length]);

  useEffect(() => {
    if (!sessionId || items.length === 0) return;
    if (pendingInitialScrollSessionRef.current !== sessionId) return;

    const timeoutId = window.setTimeout(() => {
      requestAnimationFrame(() => {
        if (pendingInitialScrollSessionRef.current !== sessionId) return;
        scrollToBottom("auto");
      });
    }, 300);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [sessionId, items.length]);

  useEffect(() => {
    if (initialScrollSessionRef.current !== sessionId) return;
    if (items.length === 0) {
      initialScrollSessionRef.current = null;
    }
  }, [sessionId, items.length]);

  // Keep the growing streaming response pinned when already at bottom.
  useEffect(() => {
    if (atBottomRef.current) {
      virtuosoRef.current?.autoscrollToBottom();
    }
  }, [streamBlocks, showGenerating]);

  // Keyboard nav
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const el = scrollRef.current;
      if (!el) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;

      if (event.key === "PageUp") {
        event.preventDefault();
        el.scrollBy({ top: -Math.max(120, el.clientHeight * 0.85), behavior: "auto" });
      } else if (event.key === "PageDown") {
        event.preventDefault();
        el.scrollBy({ top: Math.max(120, el.clientHeight * 0.85), behavior: "auto" });
      } else if (event.key === "Home") {
        event.preventDefault();
        el.scrollTo({ top: 0, behavior: "auto" });
      } else if (event.key === "End") {
        event.preventDefault();
        el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const toolResults = useMemo(() => {
    const map = new Map<string, { content: string; isError: boolean }>();
    for (const record of messages) {
      if (!record.message || record.message.role !== "user") continue;
      const content = record.message.content;
      if (typeof content === "string") continue;
      for (const block of content) {
        if (block.type === "tool_result") {
          const b = block as ContentBlockToolResult;
          const text = typeof b.content === "string"
            ? b.content
            : (b.content as ContentBlock[]).filter(x => x.type === "text").map(x => (x as { type: "text"; text: string }).text).join("\n");
          map.set(b.tool_use_id, { content: text, isError: !!b.is_error });
        }
      }
    }
    return map;
  }, [messages]);

  if (messages.length === 0 && (streamMessages?.length ?? 0) === 0 && (!streamBlocks || streamBlocks.length === 0) && !showGenerating && !pendingUserText) {
    return (
      <Box style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <Text size="sm" c="#3f3f46">No messages in this session</Text>
      </Box>
    );
  }

  return (
    <Box style={{ flex: 1, minHeight: 0, position: "relative" }}>
      <Virtuoso<MessageListItem>
        ref={virtuosoRef}
        data={items}
        style={{ height: "100%" }}
        alignToBottom
        followOutput="smooth"
        atTopThreshold={1}
        atBottomThreshold={1}
        atTopStateChange={setAtTop}
        atBottomStateChange={(nextAtBottom) => {
          atBottomRef.current = nextAtBottom;
          setAtBottom(nextAtBottom);
        }}
        totalListHeightChanged={() => {
          if (!sessionId || items.length === 0) return;
          if (pendingInitialScrollSessionRef.current !== sessionId) return;

          requestAnimationFrame(() => {
            if (pendingInitialScrollSessionRef.current !== sessionId) return;
            scrollToBottom("auto");
            initialScrollSessionRef.current = sessionId;
            pendingInitialScrollSessionRef.current = null;
          });
        }}
        computeItemKey={(_, item) => item.key}
        scrollerRef={(el) => {
          scrollRef.current = el instanceof HTMLElement ? el : null;
        }}
        components={{
          Scroller: VirtuosoScroller,
          List: VirtuosoList,
          Header: () => <div style={{ height: 24 }} />,
          Footer: () => <div style={{ height: 140 }} />,
        }}
        itemContent={(_, item) => {
          if (item.kind === "message" || item.kind === "stream-message") {
            return <MessageItem record={item.record} toolResults={toolResults} userAvatarUrl={userAvatarUrl} />;
          }
          if (item.kind === "pending-user") {
            return <UserBubble text={item.text} avatarUrl={userAvatarUrl} />;
          }
          return <StreamingItem blocks={item.blocks} />;
        }}
      />

      <ScrollNav
        onTop={() => scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
        onBottom={() => scrollToBottom("smooth")}
        disableTop={atTop}
        disableBottom={atBottom}
      />
    </Box>
  );
}

export default memo(MessageList);

function shouldRenderRecord(record: JsonlRecord): boolean {
  if (record.type === "summary") return true;
  if (record.type === "local-command-caveat") return false;
  if (!record.message) return false;

  if (record.message.role === "user") {
    const text = typeof record.message.content === "string" ? record.message.content : extractUserText(record.message.content);
    return shouldRenderUserText(text);
  }

  const blocks = typeof record.message.content === "string"
    ? [{ type: "text" as const, text: record.message.content }]
    : record.message.content;

  return blocks.some((block) => block.type === "text" || block.type === "tool_use");
}

function shouldRenderUserText(text: string): boolean {
  if (!text.trim()) return false;
  if (extractTag(text, "local-command-caveat") !== null) return false;
  if (isExpandedSkillPrompt(text)) return false;

  const stdout = extractTag(text, "local-command-stdout") ?? extractTag(text, "local-command-stderr");
  if (stdout !== null) return stdout.trim().length > 0;

  return true;
}

function StreamingItem({ blocks }: { blocks: ContentBlock[] }) {
  const record: JsonlRecord = {
    type: "assistant",
    message: {
      role: "assistant",
      content: blocks,
    },
    timestamp: new Date(0).toISOString(),
  };
  return (
    <Box style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 16 }}>
      {blocks.map((block, index) => (
        <AssistantBlock
          key={`${block.type}-${index}`}
          block={block}
          record={record}
          isLast={index === blocks.length - 1}
          toolResults={new Map()}
          showThinking
        />
      ))}
      <GeneratingIndicator />
    </Box>
  );
}

function GeneratingIndicator() {
  return (
    <Box
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        width: "fit-content",
        padding: "8px 10px",
        borderRadius: 999,
        background: "#141418",
        border: "1px solid #23232a",
      }}
    >
      <Text c="#71717a" style={{ fontSize: 14 }}>Generating</Text>
      <Box style={{ display: "flex", alignItems: "center", gap: 4 }}>
        {[0, 1, 2].map((index) => (
          <Box
            key={index}
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "#71717a",
              animation: `claudyTyping 1.2s ${index * 0.16}s infinite ease-in-out`,
            }}
          />
        ))}
      </Box>
      <style>{`
        @keyframes claudyTyping {
          0%, 80%, 100% {
            transform: translateY(0);
            opacity: 0.35;
          }
          40% {
            transform: translateY(-3px);
            opacity: 1;
          }
        }
      `}</style>
    </Box>
  );
}

// ── Individual message ────────────────────────────────────────────────────────

function MessageItem({
  record,
  toolResults,
  userAvatarUrl,
}: {
  record: JsonlRecord;
  toolResults: Map<string, { content: string; isError: boolean }>;
  userAvatarUrl?: string;
}) {
  if (record.type === "summary") {
    return <SummaryDivider />;
  }

  if (!record.message) return null;

  if (record.type === "local-command-caveat") return null;

  const isUser = record.message.role === "user";
  const content = record.message.content;

  if (isUser) {
    const text = typeof content === "string" ? content : extractUserText(content);
    if (!text.trim()) return null;
    return <UserBubble text={text} avatarUrl={userAvatarUrl} />;
  }

  // Assistant message — render each content block
  const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;

  return (
    <Box style={{ display: "flex", flexDirection: "column", gap: 8, paddingBottom: 16 }}>
      {blocks.map((block, i) => (
        <AssistantBlock key={i} block={block} record={record} isLast={i === blocks.length - 1} toolResults={toolResults} />
      ))}
    </Box>
  );
}

// ── User bubble ───────────────────────────────────────────────────────────────

function extractTag(text: string, tag: string): string | null {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? m[1].trim() : null;
}

function UserBubble({ text, avatarUrl }: { text: string; avatarUrl?: string }) {
  // hide caveat messages
  if (extractTag(text, "local-command-caveat") !== null) return null;
  if (isExpandedSkillPrompt(text)) return null;

  // command-name / command-message / command-args block
  const cmdName = extractTag(text, "command-name");
  if (cmdName) {
    const cmdMsg = extractTag(text, "command-message");
    const cmdArgs = extractTag(text, "command-args");
    const display = [cmdName, cmdArgs].filter(Boolean).join(" ").trim();
    return (
      <Box style={{ display: "flex", justifyContent: "flex-end", paddingBottom: 8 }}>
        <Box style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", borderRadius: 8, background: "#18181b", border: "1px solid #27272a" }}>
          <Terminal size={12} strokeWidth={2} style={{ color: "#52525b", flexShrink: 0 }} />
          <Text size="sm" ff="monospace" c="#d4d4d8">{display || cmdMsg || cmdName}</Text>
        </Box>
      </Box>
    );
  }

  // local-command-stdout / local-command-stderr
  const stdout = extractTag(text, "local-command-stdout") ?? extractTag(text, "local-command-stderr");
  if (stdout !== null) {
    if (!stdout.trim()) return null;
    return (
      <Box style={{ paddingBottom: 8, maxWidth: "88%" }}>
        <Box
          component="pre"
          style={{
            margin: 0,
            padding: "8px 12px",
            background: "#18181b",
            border: "1px solid #27272a",
            borderRadius: 8,
            fontSize: 12,
            fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
            color: "#a1a1aa",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 160,
            overflowY: "auto",
          }}
        >
          {stdout}
        </Box>
      </Box>
    );
  }

  const { fileRefs, body } = extractUserBubbleContent(text);

  return (
    <Box style={{ display: "flex", justifyContent: "flex-end", alignItems: "flex-end", gap: 8, paddingBottom: 16 }}>
      <Box
        style={{
          maxWidth: "72%",
          background: "#1e1e24",
          border: "1px solid #2a2a32",
          borderRadius: "14px 14px 4px 14px",
          padding: "10px 14px",
          color: "#e4e4e7",
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        {fileRefs.length > 0 ? (
          <Box style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: body ? 10 : 0 }}>
            {fileRefs.map((file) => (
              <FileReferenceBadge key={file} file={file} />
            ))}
          </Box>
        ) : null}
        {body ? (
          <Box
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {body}
          </Box>
        ) : null}
      </Box>
      <Box style={{ width: 28, height: 28, borderRadius: "50%", background: "#27272a", border: "1px solid #3f3f46", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Box
          component="img"
          src={avatarUrl || "https://www.gravatar.com/avatar/?s=80&d=mp"}
          alt="User avatar"
          style={{ width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover" }}
        />
      </Box>
    </Box>
  );
}

function isExpandedSkillPrompt(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;

  return (
    normalized.startsWith("Base directory for this skill")
    || (
      normalized.includes("Base directory for this skill")
      && normalized.includes("When referencing files in this skill")
    )
  );
}

// ── Assistant content block ───────────────────────────────────────────────────

function AssistantBlock({
  block,
  record,
  isLast,
  toolResults,
  showThinking = false,
}: {
  block: ContentBlock;
  record: JsonlRecord;
  isLast: boolean;
  toolResults: Map<string, { content: string; isError: boolean }>;
  showThinking?: boolean;
}) {
  if (block.type === "text") {
    if (!block.text.trim()) return null;
    return (
      <Box>
        <AssistantText text={block.text} />
        {isLast && record.durationMs && (
          <WorkedFor ms={record.durationMs} cost={record.costUSD} />
        )}
      </Box>
    );
  }

  if (block.type === "tool_use") {
    const result = toolResults.get(block.id);
    return <ToolCard block={block} result={result} />;
  }

  if (block.type === "thinking") {
    if (!showThinking || !block.thinking.trim()) return null;
    return <ThinkingCard thinking={block.thinking} />;
  }

  return null;
}

function ThinkingCard({ thinking }: { thinking: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Box
      style={{
        borderRadius: 8,
        background: "#15161a",
        border: "1px solid #27272a",
        maxWidth: "88%",
        overflow: "hidden",
      }}
    >
      <Box
        onClick={() => setExpanded((current) => !current)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "7px 12px",
          cursor: "pointer",
        }}
      >
        <Brain size={14} strokeWidth={2} style={{ color: "#71717a", flexShrink: 0 }} />
        <Text fw={500} c="#d4d4d8" style={{ fontSize: 14, flex: 1 }}>
          Thinking
        </Text>
        {expanded ? (
          <ChevronUp size={12} strokeWidth={2} style={{ color: "#52525b", flexShrink: 0 }} />
        ) : (
          <ChevronDown size={12} strokeWidth={2} style={{ color: "#52525b", flexShrink: 0 }} />
        )}
      </Box>
      {expanded && (
        <Box style={{ borderTop: "1px solid #27272a", padding: "10px 12px" }}>
          <Text size="sm" c="#a1a1aa" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6 }}>
            {thinking}
          </Text>
        </Box>
      )}
    </Box>
  );
}

// ── Assistant text (markdown) ─────────────────────────────────────────────────

function AssistantText({ text }: { text: string }) {
  return (
    <Box style={{ position: "relative", maxWidth: "88%" }}>
      <CopyButton content={text} label="Copy assistant message" successMessage="Assistant message copied" />
      <Box className="md-body" style={{ color: "#d4d4d8", fontSize: 14, lineHeight: 1.75, wordBreak: "break-word", display: "flow-root" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => (
            <p style={{ margin: "0 0 10px", whiteSpace: "pre-wrap" }}>{children}</p>
          ),
          pre: ({ children }) => (
            <Box
              component="pre"
              style={{
                background: "#18181b",
                border: "1px solid #27272a",
                borderRadius: 8,
                padding: "12px 14px",
                margin: "10px 0",
                fontSize: 13,
                fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
                color: "#a1a1aa",
                overflowX: "auto",
                whiteSpace: "pre",
              }}
            >
              {children}
            </Box>
          ),
          code: ({ children, className }) => {
            const isInline = !String(children).includes("\n") && !className;
            if (isInline) {
              return (
                <code style={{
                  background: "#27272a",
                  borderRadius: 4,
                  padding: "1px 5px",
                  fontSize: 13,
                  fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
                  color: "#a1a1aa",
                }}>
                  {children}
                </code>
              );
            }
            return <code style={{ fontFamily: "inherit", background: "none" }}>{children}</code>;
          },
          h1: ({ children }) => <h1 style={{ color: "#f4f4f5", fontSize: 18, fontWeight: 600, margin: "16px 0 8px" }}>{children}</h1>,
          h2: ({ children }) => <h2 style={{ color: "#f4f4f5", fontSize: 16, fontWeight: 600, margin: "14px 0 6px" }}>{children}</h2>,
          h3: ({ children }) => <h3 style={{ color: "#e4e4e7", fontSize: 15, fontWeight: 600, margin: "12px 0 4px" }}>{children}</h3>,
          ul: ({ children }) => <ul style={{ margin: "6px 0 10px", paddingLeft: 20 }}>{children}</ul>,
          ol: ({ children }) => <ol style={{ margin: "6px 0 10px", paddingLeft: 20 }}>{children}</ol>,
          li: ({ children }) => <li style={{ marginBottom: 3 }}>{children}</li>,
          blockquote: ({ children }) => (
            <blockquote style={{ borderLeft: "3px solid #3f3f46", margin: "8px 0", paddingLeft: 12, color: "#71717a" }}>
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a href={href} style={{ color: "#6b9fdb", textDecoration: "none" }}>{children}</a>
          ),
          strong: ({ children }) => <strong style={{ color: "#f4f4f5", fontWeight: 600 }}>{children}</strong>,
          hr: () => <hr style={{ border: "none", borderTop: "1px solid #27272a", margin: "12px 0" }} />,
          table: ({ children }) => (
            <table style={{ borderCollapse: "collapse", width: "100%", margin: "8px 0", fontSize: 13 }}>{children}</table>
          ),
          th: ({ children }) => (
            <th style={{ border: "1px solid #27272a", padding: "4px 8px", background: "#18181b", textAlign: "left", color: "#a1a1aa" }}>{children}</th>
          ),
          td: ({ children }) => (
            <td style={{ border: "1px solid #27272a", padding: "4px 8px" }}>{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      </Box>
    </Box>
  );
}

// ── Tool call card ────────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  Write: "Write file",
  Read: "Read file",
  Edit: "Edit file",
  MultiEdit: "Edit file",
  Bash: "Run command",
  TodoWrite: "Update todos",
  TodoRead: "Read todos",
  WebFetch: "Fetch URL",
  Task: "Spawn agent",
  ToolSearch: "Search tools",
  Glob: "Glob files",
  Grep: "Search content",
  NotebookEdit: "Edit notebook",
  WebSearch: "Web search",
};

function ToolCard({ block, result }: { block: ContentBlockToolUse; result?: { content: string; isError: boolean } }) {
  const [expanded, setExpanded] = useState(false);
  const label = TOOL_LABELS[block.name] ?? block.name;
  const detail = extractToolDetail(block);
  const isEdit = block.name === "Edit" || block.name === "MultiEdit";
  const fullCommand = typeof block.input?.command === "string" ? block.input.command as string : null;

  // For Edit: single {old_string, new_string}; for MultiEdit: edits array
  const edits: Array<{ old_string: string; new_string: string }> = isEdit
    ? block.name === "MultiEdit" && Array.isArray(block.input?.edits)
      ? (block.input.edits as Array<{ old_string: string; new_string: string }>)
      : typeof block.input?.old_string === "string"
        ? [{ old_string: block.input.old_string as string, new_string: (block.input.new_string as string) ?? "" }]
        : []
    : [];

  const isBash = block.name === "Bash";
  const hasParams = block.input && Object.keys(block.input).length > 0 && !isEdit && !isBash;
  const canExpand = isEdit ? edits.length > 0 : isBash ? (!!result?.content || !!fullCommand) : (hasParams || !!result?.content);

  return (
    <Box
      className="tool-card"
      style={{
        borderRadius: 8,
        background: "#18181b",
        border: `1px solid ${result?.isError ? "#4d1f1f" : "#27272a"}`,
        maxWidth: "88%",
        overflow: "hidden",
        transition: "border-color 180ms ease, background 180ms ease",
      }}
    >
      {/* Header row */}
      <Box
        onClick={() => canExpand && setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "7px 12px",
          cursor: canExpand ? "pointer" : "default",
          transition: "background 180ms ease, color 180ms ease",
        }}
      >
        <ToolIcon name={block.name} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text fw={500} c={result?.isError ? "#f87171" : "#d4d4d8"} style={{ fontSize: 14 }}>{label}</Text>
          {detail && (
            <Text c="#a1a1aa" truncate ff="monospace" mt={1} style={{ fontSize: 14 }}>
              {detail}
            </Text>
          )}
        </Box>
        {canExpand && (
          <ChevronDown
            size={12}
            strokeWidth={2}
            style={{ flexShrink: 0, color: "#3f3f46", transform: expanded ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 150ms" }}
          />
        )}
      </Box>

      {/* Expanded body */}
      {canExpand && (
        <Box className={`tool-card__content ${expanded ? "is-expanded" : ""}`}>
          <Box className="tool-card__content-inner" style={{ borderTop: "1px solid #27272a" }}>
          {isEdit ? (
            edits.map((edit, i) => (
              <Box key={i}>
                {edits.length > 1 && (
                  <Text c="#71717a" style={{ padding: "4px 14px", borderBottom: "1px solid #1f1f23", fontFamily: "monospace", fontSize: 14 }}>
                    edit {i + 1} of {edits.length}
                  </Text>
                )}
                <ContentSection
                  copyContent={buildEditCopyContent(edit)}
                  copyLabel={`Copy ${label} edit ${i + 1}`}
                  copySuccessMessage={`${label} edit copied`}
                >
                  <DiffView oldStr={edit.old_string} newStr={edit.new_string} />
                </ContentSection>
              </Box>
            ))
          ) : isBash ? (
            <>
              {fullCommand && (
                <ContentSection
                  copyContent={fullCommand}
                  copyLabel={`Copy ${label} command`}
                  copySuccessMessage={`${label} command copied`}
                  borderBottom={!!result?.content}
                >
                  <Box
                    component="pre"
                    style={{
                      margin: 0,
                      padding: "10px 14px",
                      fontSize: 12,
                      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
                      color: "#a1a1aa",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      background: "#141417",
                    }}
                  >
                    <span style={{ color: "#3f3f46", userSelect: "none" }}>$ </span>{fullCommand}
                  </Box>
                </ContentSection>
              )}
              {result?.content && (
                <ContentSection
                  copyContent={result.content}
                  copyLabel={`Copy ${label} output`}
                  copySuccessMessage={`${label} output copied`}
                >
                  <Box
                    component="pre"
                    style={{
                      margin: 0,
                      padding: "10px 14px",
                      fontSize: 12,
                      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
                      color: result.isError ? "#f87171" : "#71717a",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: 320,
                      overflowY: "auto",
                      background: "#0f0f12",
                    }}
                  >
                    {result.content}
                  </Box>
                </ContentSection>
              )}
            </>
          ) : (
            <>
              {hasParams && (
                <ContentSection
                  copyContent={JSON.stringify(block.input, null, 2)}
                  copyLabel={`Copy ${label} input`}
                  copySuccessMessage={`${label} input copied`}
                  borderBottom={!!result?.content}
                >
                  <Box
                    component="pre"
                    style={{
                      margin: 0,
                      padding: "10px 14px",
                      fontSize: 12,
                      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
                      color: "#a1a1aa",
                      whiteSpace: "pre",
                      overflowX: "auto",
                      background: "#141417",
                    }}
                  >
                    {JSON.stringify(block.input, null, 2)}
                  </Box>
                </ContentSection>
              )}
              {result?.content && (
                result.isError ? (
                  <ContentSection
                    copyContent={result.content}
                    copyLabel={`Copy ${label} output`}
                    copySuccessMessage={`${label} output copied`}
                  >
                    <Box component="pre" style={{ margin: 0, padding: "10px 14px", fontSize: 12, fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace', color: "#f87171", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 320, overflowY: "auto", background: "#0f0f12" }}>
                      {result.content}
                    </Box>
                  </ContentSection>
                ) : (
                  <ContentSection
                    copyContent={result.content}
                    copyLabel={`Copy ${label} output`}
                    copySuccessMessage={`${label} output copied`}
                  >
                    <ReadOutput
                      content={result.content}
                      filePath={typeof block.input?.file_path === "string" ? block.input.file_path as string : typeof block.input?.path === "string" ? block.input.path as string : undefined}
                    />
                  </ContentSection>
                )
              )}
            </>
          )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

// ── Diff view ─────────────────────────────────────────────────────────────────

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const hunks = Diff.diffLines(oldStr, newStr);
  return (
    <Box
      component="pre"
      style={{
        margin: 0,
        padding: "10px 0",
        fontSize: 12,
        fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
        whiteSpace: "pre",
        overflowX: "auto",
        maxHeight: 400,
        overflowY: "auto",
        background: "#0f0f12",
      }}
    >
      {hunks.map((part, i) => {
        const lines = part.value.replace(/\n$/, "").split("\n");
        const color = part.added ? "#4ade80" : part.removed ? "#f87171" : "#52525b";
        const bg = part.added ? "rgba(74,222,128,0.07)" : part.removed ? "rgba(248,113,113,0.07)" : "transparent";
        const prefix = part.added ? "+" : part.removed ? "-" : " ";
        return lines.map((line, j) => (
          <Box
            key={`${i}-${j}`}
            style={{
              display: "flex",
              background: bg,
              paddingLeft: 14,
              paddingRight: 14,
            }}
          >
            <span style={{ color: part.added ? "#22c55e" : part.removed ? "#ef4444" : "#2d2d33", userSelect: "none", marginRight: 10, flexShrink: 0 }}>
              {prefix}
            </span>
            <span style={{ color }}>{line}</span>
          </Box>
        ));
      })}
    </Box>
  );
}

function extractToolDetail(block: ContentBlockToolUse): string | null {
  const input = block.input;
  if (!input) return null;
  if (typeof input.path === "string") return shortenPath(input.path);
  if (typeof input.file_path === "string") return shortenPath(input.file_path);
  if (typeof input.command === "string") return (input.command as string).slice(0, 80);
  if (typeof input.url === "string") return input.url as string;
  return null;
}

function shortenPath(p: string): string {
  const home = p.match(/^\/(?:Users|home)\/[^/]+/)?.[0];
  if (home) return "~" + p.slice(home.length);
  const windowsHome = p.match(/^[A-Za-z]:\\Users\\[^\\]+/i)?.[0];
  if (windowsHome) return "~" + p.slice(windowsHome.length).replace(/\\/g, "/");
  return p;
}

function ToolIcon({ name }: { name: string }) {
  const color = "#71717a";
  if (name === "Bash") {
    return <Terminal size={13} strokeWidth={2} style={{ flexShrink: 0, color }} />;
  }
  if (name === "Write" || name === "Edit" || name === "MultiEdit") {
    return <FilePenLine size={13} strokeWidth={2} style={{ flexShrink: 0, color }} />;
  }
  if (name === "Read") {
    return <FileText size={13} strokeWidth={2} style={{ flexShrink: 0, color }} />;
  }
  return <Wrench size={13} strokeWidth={2} style={{ flexShrink: 0, color }} />;
}

function ContentSection({
  children,
  copyContent,
  copyLabel,
  copySuccessMessage,
  borderBottom = false,
}: {
  children: ReactNode;
  copyContent: string;
  copyLabel: string;
  copySuccessMessage: string;
  borderBottom?: boolean;
}) {
  return (
    <Box style={{ position: "relative", borderBottom: borderBottom ? "1px solid #27272a" : undefined }}>
      <CopyButton
        content={copyContent}
        label={copyLabel}
        successMessage={copySuccessMessage}
        compact
      />
      <Box style={{ paddingTop: 34 }}>
        {children}
      </Box>
    </Box>
  );
}

function CopyButton({
  content,
  label,
  successMessage,
  compact = false,
}: {
  content: string;
  label: string;
  successMessage: string;
  compact?: boolean;
}) {
  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(content);
      notifications.show({
        color: "green",
        title: "Copied to clipboard",
        message: successMessage,
      });
    } catch {
      notifications.show({
        color: "red",
        title: "Copy failed",
        message: "Clipboard access is not available.",
      });
    }
  };

  return (
    <Box
      component="button"
      type="button"
      aria-label={label}
      title={label}
      onClick={handleCopy}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: compact ? 24 : 28,
        height: compact ? 24 : 28,
        borderRadius: 7,
        border: "1px solid #2f2f36",
        background: compact ? "#141417" : "rgba(20,20,24,0.92)",
        color: "#8b8b97",
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
        marginLeft: compact ? undefined : "auto",
        marginBottom: compact ? undefined : 8,
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 1,
      }}
    >
      <Copy size={13} strokeWidth={2} />
    </Box>
  );
}

function buildEditCopyContent(edit: { old_string: string; new_string: string }): string {
  return [
    "old_string:",
    edit.old_string,
    "",
    "new_string:",
    edit.new_string,
  ].join("\n");
}

// ── Timing indicator ──────────────────────────────────────────────────────────

function WorkedFor({ ms, cost }: { ms: number; cost?: number }) {
  const secs = (ms / 1000).toFixed(1);
  return (
    <Box
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        margin: "10px 0 4px",
        color: "#3f3f46",
        fontSize: 11,
      }}
    >
      <Box style={{ flex: 1, height: 1, background: "#1f1f23" }} />
      <Text size="xs" c="#3f3f46" style={{ whiteSpace: "nowrap" }}>
        Worked for {secs}s{cost ? ` · $${cost.toFixed(4)}` : ""}
      </Text>
      <Box style={{ flex: 1, height: 1, background: "#1f1f23" }} />
    </Box>
  );
}

// ── Summary divider ───────────────────────────────────────────────────────────

function SummaryDivider() {
  return (
    <Box style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 0" }}>
      <Box style={{ flex: 1, height: 1, background: "#1f1f23" }} />
      <Text size="xs" c="#3f3f46">Conversation summary</Text>
      <Box style={{ flex: 1, height: 1, background: "#1f1f23" }} />
    </Box>
  );
}

// ── Scroll nav buttons ────────────────────────────────────────────────────────

function ScrollNav({
  onTop,
  onBottom,
  disableTop,
  disableBottom,
}: {
  onTop: () => void;
  onBottom: () => void;
  disableTop: boolean;
  disableBottom: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Box
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "absolute",
        bottom: 16,
        right: 20,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        opacity: hovered ? 1 : 0.55,
        transition: "opacity 150ms",
        zIndex: 10,
      }}
    >
      {[
        { label: "Top", onClick: onTop, icon: <ChevronUp size={13} strokeWidth={2} />, disabled: disableTop },
        { label: "Bottom", onClick: onBottom, icon: <ChevronDown size={13} strokeWidth={2} />, disabled: disableBottom },
      ].map(({ label, onClick, icon, disabled }) => (
        <Box
          key={label}
          component="button"
          onClick={onClick}
          disabled={disabled}
          title={`Scroll to ${label}`}
          style={{
            width: 32,
            height: 32,
            borderRadius: 7,
            background: "rgba(24,24,27,0.92)",
            backdropFilter: "blur(8px)",
            border: "1px solid #3f3f46",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: disabled ? "not-allowed" : "pointer",
            color: disabled ? "#52525b" : "#a1a1aa",
            opacity: disabled ? 0.45 : 1,
            padding: 0,
          }}
        >
          {icon}
        </Box>
      ))}
    </Box>
  );
}

// ── Language detection ────────────────────────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rs: "rust", go: "go", java: "java",
  css: "css", scss: "css", json: "json",
  yaml: "yaml", yml: "yaml", toml: "toml",
  sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql", md: "markdown", markdown: "markdown",
  html: "html", xml: "html", c: "c", cpp: "cpp", cc: "cpp",
};

function langFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return EXT_LANG[ext] ?? null;
}

// ── Read file output (strips N→ line prefixes) ────────────────────────────────

const LINE_NUM_RE = /^ *(\d+)\u2192/;

function parseReadOutput(raw: string): { lines: Array<{ num: number | null; text: string }> ; hasNumbers: boolean } {
  const rows = raw.split("\n");
  // Check if the majority of non-empty lines have the N→ prefix
  const nonEmpty = rows.filter(l => l.trim());
  const matching = nonEmpty.filter(l => LINE_NUM_RE.test(l));
  const hasNumbers = nonEmpty.length > 0 && matching.length / nonEmpty.length >= 0.5;

  return {
    hasNumbers,
    lines: rows.map(l => {
      const m = l.match(LINE_NUM_RE);
      if (m) return { num: parseInt(m[1], 10), text: l.slice(m[0].length) };
      return { num: null, text: l };
    }),
  };
}

function ReadOutput({ content, filePath }: { content: string; filePath?: string }) {
  const { lines, hasNumbers } = parseReadOutput(content);
  const lang = langFromPath(filePath);
  const plainText = lines.map(l => l.text).join("\n");

  if (lang) {
    return (
      <SyntaxHighlighter
        language={lang}
        style={vscDarkPlus}
        showLineNumbers={hasNumbers}
        startingLineNumber={lines.find(l => l.num !== null)?.num ?? 1}
        customStyle={{
          margin: 0,
          padding: "10px 14px",
          background: "#0f0f12",
          fontSize: 12,
          lineHeight: 1.6,
          borderRadius: 0,
        }}
        lineNumberStyle={{ color: "#2d2d33", minWidth: "2.5em" }}
        wrapLongLines
      >
        {plainText}
      </SyntaxHighlighter>
    );
  }

  return (
    <Box
      style={{
        fontSize: 12,
        fontFamily: '"JetBrains Mono", "Fira Code", Menlo, monospace',
        background: "#0f0f12",
        display: "flex",
        lineHeight: 1.6,
      }}
    >
      {hasNumbers && (
        <Box
          style={{
            padding: "10px 10px 10px 14px",
            textAlign: "right",
            color: "#2d2d33",
            userSelect: "none",
            flexShrink: 0,
            borderRight: "1px solid #1a1a1f",
          }}
        >
          {lines.map((l, i) => (
            <div key={i}>{l.num ?? ""}</div>
          ))}
        </Box>
      )}
      <Box
        component="pre"
        style={{
          margin: 0,
          padding: "10px 14px",
          color: "#71717a",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          flex: 1,
        }}
      >
        {plainText}
      </Box>
    </Box>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractUserText(content: ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

function extractUserBubbleContent(text: string): { fileRefs: string[]; body: string } {
  const lines = text.split("\n");
  const fileRefs: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.startsWith("@")) break;
    const file = line.slice(1).trim();
    if (!file) break;
    fileRefs.push(file);
    index += 1;
  }

  while (index < lines.length && lines[index].trim() === "") {
    index += 1;
  }

  return {
    fileRefs,
    body: lines.slice(index).join("\n"),
  };
}
