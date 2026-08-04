import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const frontend = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const rustMain = await readFile(new URL("../src-tauri/src/main.rs", import.meta.url), "utf8");
const wakeHelper = await readFile(
  new URL("../src-tauri/wake-helper/JarvisWakeListener.swift", import.meta.url),
  "utf8",
);
const windowsWakeHelper = await readFile(
  new URL("../src-tauri/wake-helper/JarvisWakeListener.cs", import.meta.url),
  "utf8",
);
const wakeBuild = await readFile(
  new URL("../scripts/build-wake-helper.mjs", import.meta.url),
  "utf8",
);
const windowsTauriConfig = await readFile(
  new URL("../src-tauri/tauri.windows.conf.json", import.meta.url),
  "utf8",
);
const entitlements = await readFile(
  new URL("../src-tauri/Entitlements.plist", import.meta.url),
  "utf8",
);
const helperEntitlements = await readFile(
  new URL("../src-tauri/wake-helper/Entitlements.plist", import.meta.url),
  "utf8",
);

test("Voice uses Codex app-server V3 WebRTC directly", () => {
  assert.match(backend, /"version":\s*"v3"/);
  assert.match(backend, /"transport":\s*\{"type":\s*"webrtc"/);
  assert.match(backend, /"app-server",\s*"--enable",\s*"realtime_conversation",\s*"--stdio"/);
  assert.doesNotMatch(frontend, /OPENAI_API_KEY|ChatGPT.*button|hotkey/i);
});

test("wake phrase opens the same direct Voice path", () => {
  assert.match(frontend, /listen<WakeEvent>\("jarvis-wake"/);
  assert.match(frontend, /void startDirectVoice\(\{ coldStart: payload\.cold === true \}\)/);
  assert.match(frontend, /const attempts = coldStart \? 6 : 1/);
  assert.match(frontend, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(frontend, /recoverableColdStartError/);
  assert.match(backend, /"--host-app"/);
  assert.match(wakeHelper, /NSWorkspace\.shared\.openApplication/);
  assert.match(wakeHelper, /configuration\.arguments\s*=\s*\["--jarvis-wake"\]/);
  assert.match(frontend, /consume_cold_wake/);
  assert.match(backend, /AVAudioEngine releases the input device asynchronously/);
  assert.match(backend, /matches!\(authorization, "denied" \| "restricted"\)/);
  assert.match(backend, /requestAccessForMediaType_completionHandler/);
  assert.match(frontend, /request_microphone_permission/);
  assert.match(frontend, /startup_is_background/);
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(helperEntitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(backend, /tauri_plugin_autostart/);
  assert.match(frontend, /onCloseRequested/);
  assert.match(wakeHelper, /"--test-wake"/);
});

test("STOP suppresses transcript-tail handoffs and interrupts late turns", () => {
  assert.match(backend, /"flushTranscriptTailOnSessionEnd":\s*false/);
  assert.match(backend, /for _ in 0\.\.6/);
  assert.match(backend, /"turn\/interrupt"/);
});

test("text input can join the active Voice conversation", () => {
  assert.match(frontend, /append_codex_voice_text/);
  assert.match(backend, /"thread\/realtime\/appendText"/);
});

test("production configuration persists workspace and resumes threads", () => {
  assert.match(frontend, /jarvis\.workspace/);
  assert.match(frontend, /jarvis\.threadId:/);
  assert.match(frontend, /invoke<string>\("validate_workspace"/);
  assert.match(frontend, /workspace = nextWorkspace/);
  assert.match(backend, /"thread\/resume"/);
  assert.match(backend, /validated_workspace/);
  assert.match(backend, /fn validate_workspace\(cwd: String\)/);
  assert.match(wakeHelper, /requiresOnDeviceRecognition = true/);
});

test("user can create a fresh Codex thread without deleting history", () => {
  assert.match(frontend, /id="new-thread"/);
  assert.match(frontend, /threadId:\s*null/);
  assert.match(frontend, /invoke<Session>\("start_jarvis"/);
  assert.match(frontend, /freshSession\.threadId/);
  assert.match(frontend, /原线程仍保留在 Codex 历史记录中/);
});

test("permission profiles are persisted and mapped by the trusted backend", () => {
  assert.match(frontend, /jarvis\.permissionMode/);
  assert.match(frontend, /type PermissionMode = "safe" \| "auto" \| "full"/);
  assert.match(frontend, /permissionMode,/);
  assert.match(backend, /enum PermissionMode/);
  assert.match(backend, /approval_policy: "on-request"/);
  assert.match(backend, /approval_policy: "never"/);
  assert.match(backend, /sandbox: "workspace-write"/);
  assert.match(backend, /sandbox: "danger-full-access"/);
  assert.match(backend, /existing\.permission_mode == permission_mode/);
});

test("Mandarin and Shaanxi speech styles persist and rebuild the Voice runtime", () => {
  assert.match(frontend, /type SpeechStyle = "mandarin" \| "shaanxi"/);
  assert.match(frontend, /jarvis\.speechStyle/);
  assert.match(frontend, /name="speech-style"/);
  assert.match(frontend, /speechStyle,/);
  assert.match(frontend, /speechStyleChanged/);
  assert.match(frontend, /resumeVoiceAfterSave/);
  assert.match(frontend, /await startDirectVoice\(\)/);
  assert.match(backend, /enum SpeechStyle/);
  assert.match(backend, /Self::Shaanxi/);
  assert.match(backend, /Shaanxi dialect style/);
  assert.match(backend, /existing\.speech_style == speech_style/);
  assert.match(backend, /speech_style\.instructions\(\)/);
});

test("wake activates the macOS app before focusing the Jarvis window", () => {
  assert.match(backend, /fn raise_jarvis_window/);
  assert.match(backend, /activateIgnoringOtherApps\(true\)/);
  assert.match(backend, /set_always_on_top\(true\)/);
  assert.match(backend, /set_always_on_top\(false\)/);
  assert.match(backend, /raise_jarvis_window\(&app\)/);
});

test("Windows builds a local wake listener and packages it with NSIS", () => {
  assert.match(wakeBuild, /process\.platform === "win32"/);
  assert.match(wakeBuild, /Framework64.*csc\.exe/);
  assert.match(wakeBuild, /System\.Speech\.dll/);
  assert.match(wakeBuild, /\/target:winexe/);
  assert.match(windowsWakeHelper, /System\.Speech\.Recognition/);
  assert.match(windowsWakeHelper, /SpeechRecognitionEngine/);
  assert.match(windowsWakeHelper, /--test-wake/);
  assert.match(windowsWakeHelper, /嗨 jarvis/);
  assert.match(windowsWakeHelper, /贾维斯/);
  assert.match(backend, /Some\("error"\)[\s\S]*wake_enabled\.store\(false/);
  assert.match(windowsTauriConfig, /"targets":\s*\["nsis"\]/);
  assert.match(windowsTauriConfig, /JarvisWakeListener\.exe/);
  assert.match(windowsTauriConfig, /"type":\s*"downloadBootstrapper"/);
});

test("Windows can discover or explicitly select codex.exe", () => {
  assert.match(frontend, /jarvis\.codexBinary/);
  assert.match(frontend, /id="codex-binary-setting"/);
  assert.match(frontend, /codexPath:\s*codexBinary \|\| null/);
  assert.match(backend, /JARVIS_CODEX_BIN/);
  assert.match(backend, /std::env::var_os\("PATH"\)/);
  assert.match(backend, /std::env::var\("LOCALAPPDATA"\)/);
  assert.match(backend, /join\("WindowsApps"\)/);
  assert.match(backend, /codex-win32-x64/);
  assert.match(backend, /x86_64-pc-windows-msvc/);
  assert.match(backend, /fs::File::open\(path\)/);
  assert.match(backend, /CREATE_NO_WINDOW/);
  assert.match(backend, /arg\("--version"\)/);
  assert.match(backend, /ProxyEnable/);
  assert.match(backend, /ProxyServer/);
  assert.match(backend, /command\.env\("HTTPS_PROXY"/);
  assert.match(backend, /join\("codex\.exe"\)/);
  assert.match(backend, /Select the native codex\.exe file/);
});

test("Windows wake shutdown targets only the owned child process", () => {
  assert.match(backend, /exact helper process owned by this/);
  assert.match(backend, /child\.kill\(\)\.await/);
  assert.doesNotMatch(backend, /taskkill|Stop-Process/);
});

test("a second desktop launch raises the existing Jarvis runtime", () => {
  assert.match(backend, /tauri_plugin_single_instance::init/);
  assert.match(backend, /raise_jarvis_window\(app\)/);
  assert.match(backend, /argument == "--jarvis-wake"/);
  assert.match(backend, /app\.emit\("jarvis-wake"/);
});

test("Windows release runs as a GUI application without a console window", () => {
  assert.match(rustMain, /windows_subsystem = "windows"/);
  assert.match(backend, /Windows Terminal opens behind the transparent Jarvis window/);
  assert.match(backend, /command\.creation_flags\(CREATE_NO_WINDOW\)/);
});

test("transient realtime network resets use bounded automatic reconnect", () => {
  assert.match(frontend, /MAX_REALTIME_RECONNECTS = 3/);
  assert.match(frontend, /function isRecoverableRealtimeError/);
  assert.match(frontend, /without closing handshake/);
  assert.match(frontend, /function scheduleRealtimeReconnect/);
  assert.match(frontend, /startDirectVoice\(\{ reconnect: true \}\)/);
  assert.match(frontend, /if \(!reconnect\) cancelRealtimeReconnect\(\)/);
});
