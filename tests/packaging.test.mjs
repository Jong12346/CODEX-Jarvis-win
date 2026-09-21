// Windows packaging consistency tests.
//
// These replace the packaging-related assertions from the deleted
// tests/wav.test.mjs. The difference: these parse the real config files and
// check that independent files agree with each other, rather than grepping
// source text for substrings. A silent disagreement between the bundle config
// and the build script ships an installer with no wake listener in it.
//
// Contract: docs/WINDOWS_P0_CONTRACT.md §6

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tauriRoot = resolve(repoRoot, "src-tauri");

const readJson = (relative) =>
  JSON.parse(readFileSync(resolve(repoRoot, relative), "utf8"));

const windowsConfig = readJson("src-tauri/tauri.windows.conf.json");
const baseConfig = readJson("src-tauri/tauri.conf.json");
const packageJson = readJson("package.json");

test("the Windows bundle targets NSIS only", () => {
  assert.deepEqual(windowsConfig.bundle.targets, ["nsis"]);
});

test("every bundled resource path actually exists relative to src-tauri", () => {
  // The real failure mode: someone renames the helper and the installer still
  // builds, just without the wake listener inside it.
  const resources = windowsConfig.bundle.resources;
  assert.ok(Array.isArray(resources) && resources.length > 0, "expected bundle resources");
  for (const relative of resources) {
    const absolute = resolve(tauriRoot, relative);
    assert.ok(
      existsSync(absolute),
      `bundle resource ${relative} does not exist at ${absolute}. ` +
        "If it is a build artifact, run `npm run wake:build` first.",
    );
  }
});

test("the wake build script writes exactly where the bundle config reads", () => {
  // Cross-file agreement. The build script and the bundle config are edited by
  // different people at different times; this is the seam that silently breaks.
  const buildScript = readFileSync(resolve(repoRoot, "scripts/build-wake-helper.mjs"), "utf8");
  const outputMatch = buildScript.match(
    /new URL\(\s*"(\.\.\/src-tauri\/wake-helper\/[^"]+\.exe)"\s*,\s*import\.meta\.url\s*\)/,
  );
  assert.ok(outputMatch, "could not determine the build script's output path");

  const producedAbsolute = resolve(dirname(resolve(repoRoot, "scripts/x")), outputMatch[1]);
  const bundledAbsolute = windowsConfig.bundle.resources
    .map((relative) => resolve(tauriRoot, relative))
    .find((candidate) => candidate.toLowerCase() === producedAbsolute.toLowerCase());

  assert.ok(
    bundledAbsolute,
    `the build script produces ${producedAbsolute}, which is not listed in ` +
      `tauri.windows.conf.json bundle.resources (${windowsConfig.bundle.resources.join(", ")})`,
  );
});

test("the WebView2 install mode is a recognised value", () => {
  // Recorded rather than judged: downloadBootstrapper means Evergreen ONLINE
  // install. Whether that is acceptable for a clean offline machine is manual
  // acceptance item M-5 in docs/WINDOWS_P0_CONTRACT.md §3. This test exists so
  // that a change away from the audited value is deliberate and visible.
  const installMode = windowsConfig.bundle.windows.webviewInstallMode.type;
  assert.ok(
    ["downloadBootstrapper", "embedBootstrapper", "offlineInstaller", "fixedRuntime", "skip"].includes(
      installMode,
    ),
    `unrecognised webviewInstallMode ${installMode}`,
  );
  assert.equal(
    installMode,
    "downloadBootstrapper",
    "audited value is downloadBootstrapper (Evergreen, online). " +
      "If this changed deliberately, update M-5 in docs/WINDOWS_P0_CONTRACT.md §3.",
  );
});

test("the wake helper binary is not committed to the repository", () => {
  // A committed build artifact would ship stale bytes that no longer match
  // JarvisWakeListener.cs, and the JSONL protocol tests would pass against the
  // wrong binary.
  const gitignore = readFileSync(resolve(repoRoot, ".gitignore"), "utf8");
  assert.match(
    gitignore,
    /^src-tauri\/wake-helper\/JarvisWakeListener\.exe$/m,
    "the built wake helper must stay gitignored",
  );
});

test("the bundle identifier and product name are set", () => {
  assert.match(baseConfig.identifier, /^[a-z0-9.-]+$/, "identifier must be reverse-DNS safe");
  assert.ok(baseConfig.productName.length > 0);
  assert.equal(
    baseConfig.version,
    packageJson.version,
    "package.json and tauri.conf.json versions must agree, or the installer is mislabelled",
  );
});

test("release builds are linked as a GUI subsystem binary", () => {
  // The one remaining source-level assertion in this file, kept deliberately.
  // This attribute is a compiler directive with no runtime API to query, and
  // losing it makes a console window flash behind the transparent Jarvis
  // window on every launch. Asserting the built PE subsystem instead would
  // require a full release build inside the test suite.
  const rustMain = readFileSync(resolve(repoRoot, "src-tauri/src/main.rs"), "utf8");
  assert.match(
    rustMain,
    /#!\[cfg_attr\(\s*not\(debug_assertions\)\s*,\s*windows_subsystem\s*=\s*"windows"\s*\)\]/,
    "src-tauri/src/main.rs must keep the release-only windows_subsystem attribute",
  );
});
