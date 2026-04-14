import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const metadataPath = path.resolve("test-output/quit-save-check.json");

await fs.rm(metadataPath, { force: true });

const runProcess = spawn(
  "npx",
  ["wdio", "run", "./wdio.conf.mts", "--spec", "./test/specs/quit-save.e2e.ts"],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendRealQuitShortcut(appPid) {
  const script = [
    'tell application id "md.obsidian" to activate',
    'delay 1',
    'tell application "System Events"',
    `  set frontmost of first application process whose unix id is ${Number(appPid)} to true`,
    '  delay 0.5',
    '  key code 12 using command down',
    'end tell',
  ].join("\n");

  const result = spawnSync("osascript", ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`Failed to send real Cmd+Q to Obsidian PID ${appPid}: ${result.stderr || result.stdout || "unknown osascript error"}`);
  }
}

async function waitForFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      await wait(250);
    }
  }

  throw new Error(`Timed out waiting for file ${filePath}`);
}

async function waitForProcessExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await isMatchingProcessStillRunning(pid))) {
      return false;
    }

    await wait(250);
  }

  return true;
}

async function isMatchingProcessStillRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  if (result.status !== 0) {
    return false;
  }

  const command = result.stdout.trim();
  if (!command) {
    return false;
  }

  return command.includes("/Obsidian") || command.includes("Obsidian Helper");
}

async function terminatePid(pid) {
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  await wait(1000);

  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(null);
    }, timeoutMs);

    child.once("exit", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      resolve(code);
    });
  });
}

const metadataRaw = await waitForFile(metadataPath, 30000);
const metadata = JSON.parse(metadataRaw);
const noteAbsolutePath = path.join(metadata.vaultBasePath, metadata.notePath);

await wait(1000);
sendRealQuitShortcut(metadata.appPid);

let savedContent = null;
let fileExists = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    savedContent = await fs.readFile(noteAbsolutePath, "utf8");
    fileExists = true;
    if (savedContent === metadata.expectedContent) {
      break;
    }
  } catch {
    // keep polling briefly for the final quit flush
  }

  await wait(250);
}

const appStillRunning = await waitForProcessExit(metadata.appPid, 15000);
const rendererStillRunning = await waitForProcessExit(metadata.rendererPid, 5000);

const failures = [];

if (!fileExists) {
  failures.push(`note file was not found at ${noteAbsolutePath}`);
}

if (savedContent !== metadata.expectedContent) {
  failures.push(`expected '${metadata.expectedContent}' but found '${savedContent ?? "<missing>"}'`);
}

if (appStillRunning) {
  failures.push(`Obsidian app PID ${metadata.appPid} is still running after Cmd+Q`);
}

if (rendererStillRunning) {
  failures.push(`Obsidian renderer PID ${metadata.rendererPid} is still running after Cmd+Q`);
}

if (failures.length > 0) {
  await terminatePid(metadata.rendererPid);
  await terminatePid(metadata.appPid);
  try {
    runProcess.kill("SIGTERM");
  } catch {
    // already gone
  }

  const exitCode = await waitForChildExit(runProcess, 5000);
  throw new Error(`Quit-save verification failed: ${failures.join("; ")}${typeof exitCode === "number" ? `; WDIO exited with code ${exitCode}` : ""}`);
}

const exitCode = await waitForChildExit(runProcess, 20000);

console.log(`Verified quit-save flush for ${metadata.notePath}`);
console.log(`Obsidian app PID ${metadata.appPid} exited`);
console.log(`Obsidian renderer PID ${metadata.rendererPid} exited`);

if (typeof exitCode === "number") {
  console.log(`WDIO process exited with code ${exitCode}`);
}
