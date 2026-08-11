/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { readDraftEnvironments } from "./discovery.ts";
import { resolvePlacePickerSections } from "./place-picker-sections.ts";
import { renderPlaceSelect } from "./place-picker.ts";

describe("Where picker", () => {
  it("uses node presence only until an authoritative environment catalog arrives", () => {
    const execNodes = [
      {
        nodeId: "usable",
        displayName: "Usable",
        connected: true,
        canExec: true,
        canBrowse: false,
      },
      {
        nodeId: "disconnected",
        displayName: "Disconnected",
        connected: false,
        canExec: true,
        canBrowse: false,
      },
      {
        nodeId: "no-exec",
        displayName: "No exec",
        connected: true,
        canExec: false,
        canBrowse: false,
      },
    ];

    expect(
      resolvePlacePickerSections({ environments: null, execNodes, cloudProfiles: [] }).deviceNodes,
    ).toEqual([execNodes[0]]);
    expect(
      resolvePlacePickerSections({ environments: [], execNodes, cloudProfiles: [] }).deviceNodes,
    ).toEqual([]);
  });

  it("groups usable places from environment types and the legacy node catalog", () => {
    const container = document.createElement("div");
    const connectedExecNodes = [
      "macbook",
      "worker",
      "local",
      "missing-environment",
      "future-type",
    ].map((nodeId) => ({
      nodeId,
      displayName: nodeId,
      connected: true,
      canExec: true,
      canBrowse: false,
    }));
    render(
      renderPlaceSelect({
        browseAvailable: true,
        isAdmin: true,
        canWrite: true,
        folder: "",
        workspace: "/workspace",
        workspaceRoots: ["/workspace"],
        projects: [],
        projectId: "",
        sessions: [],
        execNodes: [
          ...connectedExecNodes,
          {
            nodeId: "offline",
            displayName: "Offline Mac",
            connected: false,
            canExec: false,
            canBrowse: false,
          },
          {
            nodeId: "no-exec",
            displayName: "No exec",
            connected: true,
            canExec: false,
            canBrowse: false,
          },
        ],
        environments: readDraftEnvironments([
          { id: "gateway", type: "local" },
          { id: "node:macbook", type: "node" },
          { id: "node:worker", type: "worker" },
          { id: "node:local", type: "local" },
          { id: "node:offline", type: "node" },
          { id: "node:no-exec", type: "node" },
          { id: "node:future-type", type: "future" },
        ]),
        gatewayName: "Studio",
        cloudProfiles: [
          { id: "aws", providerId: "crabbox" },
          { id: "legacy", providerId: "static-ssh" },
        ],
        cloudProfileId: "",
        execNode: "",
        syncFolder: "/workspace",
        worktree: false,
        worktreeVisible: false,
        worktreeAvailable: true,
        branches: null,
        branchesLoading: false,
        baseRef: "",
        worktreeName: "",
        submitting: false,
        pendingCloud: false,
        showDestinations: true,
        popoverOpen: true,
        popoverHiding: false,
        browserTarget: null,
        browserListing: null,
        browserLoading: false,
        browserError: null,
        browserPathDraft: "",
        usableBrowserPath: null,
        registerProjectPath: null,
        registeringProject: false,
        onGuardTransition: vi.fn(),
        onPopoverShow: vi.fn(),
        onPopoverHide: vi.fn(),
        onPopoverAfterHide: vi.fn(),
        onSelectExecNode: vi.fn(),
        onSelectCloudProfile: vi.fn(),
        onSelectProject: vi.fn(),
        onApplyFolder: vi.fn(),
        onBrowse: vi.fn(),
        onBrowserPathDraftChange: vi.fn(),
        onBrowserNavigate: vi.fn(),
        onBrowserBack: vi.fn(),
        onRegisterProject: vi.fn(),
        onClose: vi.fn(),
        onToggleWorktree: vi.fn(),
        onBaseRefInput: vi.fn(),
        onWorktreeNameInput: vi.fn(),
      }),
      container,
    );

    const titles = [...container.querySelectorAll(".new-session-page__menu-title")].map((element) =>
      element.textContent?.trim(),
    );
    expect(titles).toEqual(["Folder", "This gateway", "Devices", "Cloud"]);
    expect(container.querySelector('[data-value="node:macbook"]')).not.toBeNull();
    for (const nodeId of [
      "worker",
      "local",
      "missing-environment",
      "future-type",
      "offline",
      "no-exec",
    ]) {
      expect(container.querySelector(`[data-value="node:${nodeId}"]`)).toBeNull();
    }
    expect(container.querySelector('[data-value="cloud:aws"]')).not.toBeNull();
    expect(container.querySelector('[data-value="cloud:legacy"]')).not.toBeNull();

    const gateway = container.querySelector('[data-value="gateway"]');
    expect(gateway?.lastElementChild?.classList.contains("session-menu__check")).toBe(true);
  });
});
