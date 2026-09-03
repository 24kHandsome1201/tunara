import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { KnownHostsPanel } from "@/modules/ssh/KnownHostsPanel";

const snapshot = {
  revision: "revision-1",
  entries: [
    {
      entryId: "host-1",
      line: 1,
      marker: null,
      patternDisplay: "server.example",
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:example",
      manageable: true,
    },
  ],
};

test("known hosts are expanded by default and can be collapsed for the current mount", async () => {
  mockIPC((command) => command === "ssh_known_hosts_list_v1" ? snapshot : undefined);
  const view = render(<KnownHostsPanel />);

  const collapse = await screen.findByRole("button", { name: "Collapse known hosts" });
  expect(collapse.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Known hosts · 1")).toBeTruthy();
  expect(screen.getByText("server.example")).toBeTruthy();

  fireEvent.click(collapse);
  const expand = screen.getByRole("button", { name: "Expand known hosts" });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByText("server.example")).toBeNull();

  view.unmount();
  render(<KnownHostsPanel />);
  expect(await screen.findByRole("button", { name: "Collapse known hosts" })).toBeTruthy();
});
