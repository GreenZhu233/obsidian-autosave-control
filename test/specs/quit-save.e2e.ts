import * as fs from "node:fs/promises";
import * as path from "node:path";
import ObsidianApp from "../support/ObsidianApp";

const METADATA_PATH = path.resolve("test-output/quit-save-check.json");

describe("Quit save verification", () => {
  it("prepares pending changes for the real quit path", async () => {
    const notePath = "quit/real-quit-save.md";
    const expectedContent = "quit should flush this change";

    await ObsidianApp.reloadWithFreshVault();
    await ObsidianApp.setPluginSettings({
      disableAutoSave: false,
      saveDelaySeconds: 30,
    });
    await ObsidianApp.createAndOpenNote(notePath);
    await ObsidianApp.typeText(expectedContent);
    await ObsidianApp.waitForPendingStatus();

    const vaultBasePath = await ObsidianApp.getVaultBasePath();
    const rendererPid = await ObsidianApp.getRendererPid();
    const appPid = await ObsidianApp.getAppProcessPid();

    await fs.mkdir(path.dirname(METADATA_PATH), { recursive: true });
    await fs.writeFile(METADATA_PATH, JSON.stringify({
      notePath,
      expectedContent,
      vaultBasePath,
      rendererPid,
      appPid,
    }, null, 2));

    // Keep the WDIO session open while the external verifier sends a real Cmd+Q
    // through the operating system and then checks whether quit completed.
    await new Promise((resolve) => setTimeout(resolve, 60000));
  });
});
