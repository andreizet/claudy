import { Box, Text, UnstyledButton } from "@mantine/core";
import { X as CloseIcon } from "lucide-react";

interface FileReferenceBadgeProps {
  file: string;
  onRemove?: () => void;
}

export default function FileReferenceBadge({ file, onRemove }: FileReferenceBadgeProps) {
  return (
    <Box
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        maxWidth: "100%",
        background: "#111115",
        border: "1px solid #30303a",
        borderRadius: 999,
        padding: "5px 10px",
      }}
    >
      <Text size="xs" c="#e4e4e7" style={{ lineHeight: 1.2 }}>
        {file}
      </Text>
      {onRemove ? (
        <UnstyledButton
          onClick={onRemove}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 14,
            height: 14,
            color: "#a1a1aa",
            flexShrink: 0,
          }}
        >
          <CloseIcon />
        </UnstyledButton>
      ) : null}
    </Box>
  );
}
