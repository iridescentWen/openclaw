import { expect, it } from "vitest";
import {
  PICKED,
  WORKSPACE,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  installMockGateway,
  pollLocatorText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
suite.define(() => {
  it("drafts a session with a browsed folder and creates it on first message", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspaceGit: true,
      methodResponses: {
        "agents.list": {
          agents: [
            {
              id: "main",
              identity: { name: "Main" },
              name: "Main",
              workspace: WORKSPACE,
              workspaceGit: true,
            },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
        "fs.listDir": {
          cases: [
            {
              match: { path: WORKSPACE },
              response: {
                path: WORKSPACE,
                parent: "/home/peter",
                home: "/home/peter",
                entries: [
                  { name: "packages", path: PICKED },
                  { name: ".git", path: `${WORKSPACE}/.git`, hidden: true },
                ],
              },
            },
            {
              match: { path: PICKED },
              response: {
                path: PICKED,
                parent: WORKSPACE,
                home: "/home/peter",
                entries: [],
              },
            },
          ],
        },
        "sessions.create": { key: "agent:main:draft-e2e" },
      },
    });

    try {
      // Deep-link to /new: the page loads agents via agents.list (the sidebar
      // "+" navigates to the same route with ?agent=<id>).
      const response = await page.goto(`${suite.server.baseUrl}new`);
      expect(response?.status()).toBe(200);
      // The draft page shows the start-screen welcome hero for the agent.
      await page.getByRole("heading", { name: "Main" }).waitFor();
      await page.locator(".new-session-page__message").waitFor();

      // Unified layout: the trigger row (menus above the composer) sits
      // inside the start-screen welcome, below the hero.
      const heroBox = await page.locator(".agent-chat__welcome h2").boundingBox();
      const triggersBox = await page.locator(".new-session-page__triggers").boundingBox();
      const composerBox = await page.locator(".new-session-page__composer").boundingBox();
      const modelBox = await page.locator('[data-chat-model-select="true"]').boundingBox();
      const modelWrapperBox = await page
        .locator(".new-session-page__composer .chat-composer-model-control")
        .boundingBox();
      const footerBox = await page
        .locator(".new-session-page__composer .agent-chat__composer-footer")
        .boundingBox();
      expect(heroBox).not.toBeNull();
      expect(triggersBox).not.toBeNull();
      expect(composerBox).not.toBeNull();
      expect(modelBox).not.toBeNull();
      expect(modelWrapperBox).not.toBeNull();
      expect(footerBox).not.toBeNull();
      expect((heroBox?.y ?? 0) + (heroBox?.height ?? 0)).toBeLessThanOrEqual(
        (triggersBox?.y ?? 0) + 1,
      );
      expect((triggersBox?.y ?? 0) + (triggersBox?.height ?? 0)).toBeLessThanOrEqual(
        (composerBox?.y ?? 0) + 1,
      );
      expect(
        await page.locator(".new-session-page__composer .agent-chat__composer-footer").count(),
      ).toBe(1);
      expect(
        await page
          .locator('[data-chat-model-select="true"]')
          .evaluate((element) => element.closest(".agent-chat__composer-footer") != null),
      ).toBe(true);
      expect(modelWrapperBox?.x ?? 0).toBeGreaterThan(
        (footerBox?.x ?? 0) + (footerBox?.width ?? 0) / 2,
      );
      expect(
        (footerBox?.x ?? 0) +
          (footerBox?.width ?? 0) -
          ((modelWrapperBox?.x ?? 0) + (modelWrapperBox?.width ?? 0)),
      ).toBeLessThanOrEqual(12);
      expect(triggersBox?.x).toBeCloseTo(composerBox?.x ?? 0, 0);
      expect(triggersBox?.width).toBeCloseTo(composerBox?.width ?? 0, 0);
      expect(composerBox?.width).toBeCloseTo(48 * 16, 0);
      expect(await page.locator(".new-session-page__message").getAttribute("rows")).toBe("1");

      // The place trigger labels the workspace and opens the unified menu.
      const placeSelect = page.locator("wa-popover.new-session-page__place-popover");
      const placeTrigger = page.locator("#new-session-place-trigger");
      await pollLocatorText(placeTrigger.locator(".new-session-page__trigger-label")).toBe(
        "openclaw",
      );

      // Browse from the workspace, descend one level, then adopt the folder.
      await placeTrigger.click();
      await placeSelect.getByRole("button", { name: "Browse folders" }).click();
      await page.locator(".new-session-page__browser-entry", { hasText: "packages" }).click();
      await expect
        .poll(() => page.locator("input.new-session-page__browser-path").inputValue())
        .toBe(PICKED);
      await page.getByRole("button", { name: "Use this folder" }).click();

      // The adopted folder closes the menu and updates the trigger label.
      await expect.poll(() => placeSelect.getAttribute("open")).toBeNull();
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-place-trigger");
      await pollLocatorText(placeTrigger.locator(".new-session-page__trigger-label")).toBe(
        "packages",
      );

      // Git-backed custom folders stay direct until the user explicitly chooses isolation.
      await expect.poll(() => placeTrigger.getAttribute("data-worktree")).toBe("false");
      await placeTrigger.click();
      const worktreeItem = page.getByRole("button", { name: "Worktree" });
      await expect.poll(() => worktreeItem.getAttribute("aria-pressed")).toBe("false");
      expect(await worktreeItem.isEnabled()).toBe(true);
      await worktreeItem.click();
      await expect.poll(() => placeTrigger.getAttribute("data-worktree")).toBe("true");
      await page.keyboard.press("Escape");
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.id))
        .toBe("new-session-place-trigger");

      // Pointer light-dismiss still retires the unified popover after its
      // asynchronous hide animation completes.
      await placeTrigger.click();
      const afterPointerHide = placeSelect.evaluate(
        (element) =>
          new Promise<void>((resolve) => {
            element.addEventListener("wa-after-hide", () => resolve(), { once: true });
          }),
      );
      await page.locator(".agent-chat__welcome h2").click();
      await afterPointerHide;
      await expect.poll(() => placeSelect.getAttribute("open")).toBeNull();

      const message = page.locator(".new-session-page__message");
      await message.fill("fix the flaky test");
      await page.getByRole("button", { name: "Start session" }).click();

      const createRequest = await gateway.waitForRequest("sessions.create");
      expect(createRequest.params).toMatchObject({
        agentId: "main",
        message: "fix the flaky test",
        worktree: true,
        worktreeBaseRef: "main",
        cwd: PICKED,
      });

      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:draft-e2e"));
    } finally {
      await context.close();
    }
  });

  it("returns from the browse root to the place menu", async () => {
    const context = await suite.browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      workspace: WORKSPACE,
      workspaceGit: true,
      methodResponses: {
        "fs.listDir": {
          path: WORKSPACE,
          home: WORKSPACE,
          entries: [],
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const trigger = page.locator("#new-session-place-trigger");
      const place = page.locator("wa-popover.new-session-page__place-popover");
      await trigger.click();
      await place.getByRole("button", { name: "Browse folders" }).click();
      await gateway.waitForRequest("fs.listDir");
      await place.getByRole("button", { name: "Parent folder" }).click();
      await place.getByRole("button", { name: "Worktree" }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();

      await place.getByRole("button", { name: "Browse folders" }).click();
      await page.locator("input.new-session-page__browser-path").press("Escape");
      await place.getByRole("button", { name: "Worktree" }).waitFor();
      expect(await place.getAttribute("open")).not.toBeNull();
    } finally {
      await context.close();
    }
  });
});
