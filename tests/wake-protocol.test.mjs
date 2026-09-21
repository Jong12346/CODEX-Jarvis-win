
// Behavior tests for the Windows wake sidecar's JSONL contract.
//
// These execute the real JarvisWakeListener.exe and assert on what it writes.
// They deliberately do not read the C# source: the contract is the bytes on the
// wire, because that is what the Rust supervisor parses.
//
// Contract: docs/WINDOWS_P0_CONTRACT.md §2.7

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(
  new URL("../src-tauri/wake-helper/JarvisWakeListener.exe", import.meta.url),
);

// The binary is gitignored and produced by `npm run wake:build`. `npm run check`
// always builds it first, so CI exercises these tests; a bare `npm test` on a
// fresh clone would not. Announce the gap loudly rather than passing silently.
const available = process.platform === "win32" && existsSync(helper);
if (!available) {
  console.warn(
    `\n[wake-protocol] SKIPPED — ${
      process.platform !== "win32"
        ? `platform is ${process.platform}, not win32`
        : "JarvisWakeListener.exe is missing; run `npm run wake:build`"
    }. The wake JSONL contract was NOT verified in this run.\n`,
  );
}
const windowsOnly = { skip: !available };

function runTestWake({ eventFile = null, seed = null } = {}) {
  const args = ["--test-wake"];
  if (eventFile) {
    if (seed !== null) writeFileSync(eventFile, seed);
    args.push("--event-file", eventFile);
  }
  const result = spawnSync(helper, args, { encoding: "buffer", timeout: 30_000 });
  return {
    status: result.status,
    stdout: result.stdout ?? Buffer.alloc(0),
    raw: eventFile && existsSync(eventFile) ? readFileSync(eventFile) : Buffer.alloc(0),
  };
}

function newEventFile() {
  return join(mkdtempSync(join(tmpdir(), "jarvis-wake-")), "events.jsonl");
}

/** Parse the JSONL exactly the way the Rust supervisor does: split on lines, skip unparsable. */
function parseEvents(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test("--test-wake writes the documented event sequence", windowsOnly, () => {
  const eventFile = newEventFile();
  const { status, raw } = runTestWake({ eventFile });

  assert.equal(status, 0, "--test-wake must exit 0");
  const events = parseEvents(raw.toString("utf8"));
  assert.deepEqual(
    events.map((event) => event.type),
    ["authorization", "ready", "wake"],
    "the supervisor relies on this exact ordering to reach the armed state",
  );
  assert.equal(events[0].status, "authorized");
  assert.equal(events[2].phrase, "test");
test("--test-release confirms microphone release before exit", windowsOnly, () => {
  // The Rust supervisor only emits voiceMayAcquireMicrophone after the sidecar
  // has exited AND written microphoneReleased. This mode exercises the exact
  // bytes of that handoff without touching an audio device.
  const eventFile = newEventFile();
  const controlFile = join(mkdtempSync(join(tmpdir(), "jarvis-wake-")), "control.txt");
  writeFileSync(controlFile, "release");
  const result = spawnSync(
    helper,
    ["--test-release", "--event-file", eventFile, "--control-file", controlFile],
    { encoding: "buffer", timeout: 30_000 },
  );
  assert.equal(result.status, 6, "--test-release must exit 6 after releasing");
  const events = parseEvents(readFileSync(eventFile).toString("utf8"));
  assert.deepEqual(
    events.map((event) => event.type),
    ["authorization", "ready", "stopping", "microphoneReleased"],
    "stopping must be reported before the microphone is released",
  );
  assert.equal(events[2].reason, "release");
});

test("--probe-recognizer exits 0 or 3 without touching audio", windowsOnly, () => {
  // The Rust diagnostics probe uses this to classify speech_pack_missing.
  // Exit 3 means no installed recognizer; 0 means one is present.
  const result = spawnSync(helper, ["--probe-recognizer"], {
    encoding: "buffer",
    timeout: 30_000,
  });
  assert.ok(
    result.status === 0 || result.status === 3,
    `expected 0 (present) or 3 (missing), got ${result.status}`,
  );
});

});

test("every event line carries a type discriminator", windowsOnly, () => {
  const { raw } = runTestWake({ eventFile: newEventFile() });
  for (const event of parseEvents(raw.toString("utf8"))) {
    assert.equal(typeof event.type, "string");
    assert.ok(event.type.length > 0);
  }
});

test("every field value is a JSON string", windowsOnly, () => {
  // The emitter builds JSON by concatenation with quoted values, so numbers and
  // booleans never appear. Rust-side deserialization may rely on this.
  const { raw } = runTestWake({ eventFile: newEventFile() });
  for (const event of parseEvents(raw.toString("utf8"))) {
    for (const [key, value] of Object.entries(event)) {
      assert.equal(typeof value, "string", `${event.type}.${key} must be a string`);
    }
  }
});

test("the event file is UTF-8 without a BOM", windowsOnly, () => {
  const { raw } = runTestWake({ eventFile: newEventFile() });
  assert.notEqual(
    raw.subarray(0, 3).toString("hex"),
    "efbbbf",
    "a BOM would land inside the first line and break serde_json",
  );
  assert.equal(raw.toString("utf8"), new TextDecoder("utf-8", { fatal: true }).decode(raw));
});

test("lines are CRLF terminated, and the last line is terminated too", windowsOnly, () => {
  // Pinned because consumers must not assume LF. Rust's str::lines() strips the
  // \r for free; a hand-rolled split('\n') would leave it attached and corrupt
  // the final JSON character.
  const { raw } = runTestWake({ eventFile: newEventFile() });
  const text = raw.toString("utf8");
  assert.ok(text.endsWith("\r\n"), "trailing terminator is required for append-safety");
  assert.equal(text.split("\r\n").length - 1, 3, "expected three CRLF-terminated records");
  assert.doesNotMatch(text.replace(/\r\n/g, ""), /[\r\n]/, "no bare LF or CR may remain");
});

test("--event-file appends and never truncates", windowsOnly, () => {
  // The supervisor pre-creates the file before spawning the helper. If the
  // helper truncated it, a same-tick pre-seeded state would be lost.
  const eventFile = newEventFile();
  const seed = '{"type":"seeded"}\r\n';
  const { raw } = runTestWake({ eventFile, seed });
  const events = parseEvents(raw.toString("utf8"));
  assert.equal(events[0].type, "seeded", "pre-existing content must survive");
  assert.deepEqual(events.map((event) => event.type), [
    "seeded",
    "authorization",
    "ready",
    "wake",
  ]);
});

test("without --event-file the events go to stdout", windowsOnly, () => {
  const { status, stdout } = runTestWake();
  assert.equal(status, 0);
  assert.deepEqual(parseEvents(stdout.toString("utf8")).map((event) => event.type), [
    "authorization",
    "ready",
    "wake",
  ]);
});

test("authorization is asserted before any microphone access is attempted", windowsOnly, () => {
  // Documents a protocol hazard rather than an intended feature: the helper
  // emits authorization=authorized unconditionally as its first action, before
  // SetInputToDefaultAudioDevice() has run. A later denial arrives as a SECOND
  // authorization event with status=denied.
  //
  // Therefore the supervisor must treat the first authorization event as
  // "not yet known to be denied", never as proof of access, and must accept
  // more than one authorization event per helper lifetime.
  const { raw } = runTestWake({ eventFile: newEventFile() });
  const events = parseEvents(raw.toString("utf8"));
  assert.equal(events[0].type, "authorization");
  assert.equal(
    events[0].status,
    "authorized",
    "--test-wake touches no audio device, yet still reports authorized",
  );
});
