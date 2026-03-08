import { MantineProvider } from "@mantine/core";
import { render, RenderOptions } from "@testing-library/react";
import { ReactElement } from "react";

export function renderWithMantine(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return render(ui, {
    wrapper: ({ children }) => <MantineProvider>{children}</MantineProvider>,
    ...options,
  });
}
