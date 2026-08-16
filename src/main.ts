import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./style.css";

type Mode = "booting" | "ready" | "voice-starting" | "listening" | "working" | "speaking" | "degraded" | "stopped";
type Message = { id?: number | string; method?: string; params?: any };
type Session = { threadId: string; cwd: string };
type WorkspaceInfo = {
  id: string;
  display: string;
  threadKey: string;
  sourceThreadKey: string;
  legacyThreadKeys: string[];
};
type DirectVoice = {
  codexConnected: boolean;
  voiceActive: boolean;
  phase: string;
  protocol: string;
  threadId?: string;
  realtimeSessionId?: string;
};
type RuntimeStateInfo = {
  state: "absent" | "starting" | "ready" | "degraded" | "dead" | "restarting" | "failed";
  runtimeId?: string;
  restartAttempts: number;
  lastExitCode?: number;
  lastErrorCode?: string;
  lastError?: string;
};
type VoiceStateName = "booting" | "wakeArming" | "wakeReady" | "wakeDetected" | "wakeReleasingMicrophone" | "voiceAcquiringMicrophone" | "voiceConnecting" | "voiceListening" | "voiceSpeaking" | "working" | "voiceStopping" | "wakeRearming" | "degraded" | "stopping";
type VoiceStateInfo = {
  state: VoiceStateName;
  micOwner: "none" | "wake" | "voice";
  reconnectAttempts: number;
  degraded?: {
    errorKind: string;
    recoverable: boolean;
    suggestedAction: string;
    owner: "none" | "wake" | "voice";
  };
};
type DiagnosticItem = {
  key: string;
  verdict: {
    level: "green" | "yellow" | "red";
    code: string;
    messageZh: string;
    suggestedActionZh: string;
  };
};
type SettingsDto = {
  present: boolean;
  workspace?: string;
  threadId?: string;
  permissionMode: string;
  speechStyle: string;
  codexBinary?: string;
  autostart: boolean;
  hotkey?: string;
  wizardCompleted: boolean;
};
type WizardReport = {
  completed: boolean;
  canProceed: boolean;
  steps: { id: string; level: "green" | "yellow" | "red"; blocking: boolean }[];
};
type WakeStatus = {
  enabled: boolean;
  ready: boolean;
  authorization: string;
};
type WakeEvent = {
  ok: boolean;
  error?: string;
  cold?: boolean;
};
type PermissionMode = "safe" | "auto" | "full";
type PermissionResolution = {
  mode: PermissionMode;
  changed: boolean;
  reason?: "workspace_is_home" | "workspace_is_home_ancestor" | "requires_confirmation";
};
type SpeechStyle = "mandarin" | "shaanxi";

const state = {
  voice: null as VoiceStateInfo | null,
  settings: null as SettingsDto | null,
  mode: "booting" as Mode,
  session: null as Session | null,
  directVoice: null as DirectVoice | null,
  wake: null as WakeStatus | null,
  level: 0,
  manualStop: false,
  agentWorking: false,
};

const WORKSPACE_KEY = "jarvis.workspace";
const THREAD_MIGRATION_BACKUP_PREFIX = "jarvis.threadMigrationBackup.v1:";
const THREAD_MIGRATION_MARKER_PREFIX = "jarvis.threadMigration.v1:";
const PERMISSION_KEY = "jarvis.permissionMode";
const CODEX_BINARY_KEY = "jarvis.codexBinary";
const SPEECH_STYLE_KEY = "jarvis.speechStyle";
const permissionLabels: Record<PermissionMode, string> = {
  safe: "安全模式 · 需要时确认",
  auto: "自动办公 · 仅限所选工作区",
  full: "完全访问 · 高风险",
};
const speechStyleLabels: Record<SpeechStyle, string> = {
  mandarin: "普通话 · 清晰自然",
  shaanxi: "陕西话 · 方言风格",
};
function storedPermissionMode(): PermissionMode {
  const value = localStorage.getItem(PERMISSION_KEY);
  return value === "auto" || value === "full" ? value : "safe";
}
function storedSpeechStyle(): SpeechStyle {
  return localStorage.getItem(SPEECH_STYLE_KEY) === "shaanxi" ? "shaanxi" : "mandarin";
}
let workspace: WorkspaceInfo = {
  id: "",
  display: "",
  threadKey: "",
  sourceThreadKey: "",
  legacyThreadKeys: [],
};
function permissionLabel(mode: PermissionMode): string {
  if (mode === "safe") return `Safe · prompts outside ${workspace.display}`;
  if (mode === "auto") return `Auto · autonomous only inside ${workspace.display}`;
  return permissionLabels.full;
}
let permissionMode = storedPermissionMode();
let speechStyle = storedSpeechStyle();
let codexBinary = localStorage.getItem(CODEX_BINARY_KEY) ?? "";
const savedThreadId = () =>
  state.settings?.threadId
  ?? (workspace.threadKey ? localStorage.getItem(workspace.threadKey) : null);

function migrateWorkspaceThreadKeys(info: WorkspaceInfo): string | null {
  const markerKey = `${THREAD_MIGRATION_MARKER_PREFIX}${info.id}`;
  if (localStorage.getItem(markerKey) === "1") return null;

  const candidateKeys = Array.from(new Set([
    info.sourceThreadKey,
    info.threadKey,
    ...info.legacyThreadKeys,
  ].filter(Boolean)));
  const entries = candidateKeys.flatMap((key) => {
    const threadId = localStorage.getItem(key);
    return threadId ? [{ key, threadId }] : [];
  });
  if (entries.length > 0) {
    const backupKey = `${THREAD_MIGRATION_BACKUP_PREFIX}${info.id}`;
    localStorage.setItem(backupKey, JSON.stringify({ schemaVersion: 1, entries }));
    const preferred = entries.find(({ key }) => key === info.sourceThreadKey)
      ?? entries.find(({ key }) => key === info.threadKey)
      ?? entries[0];
    localStorage.setItem(info.threadKey, preferred.threadId);
  }
  localStorage.setItem(markerKey, "1");

  const distinctThreadIds = new Set(entries.map(({ threadId }) => threadId));
  return distinctThreadIds.size > 1
    ? "检测到这个工作目录存在多个历史线程。当前线程已续接，其他 thread id 已备份且旧记录未删除。"
    : null;
}
let peer: RTCPeerConnection | null = null;
let microphoneStream: MediaStream | null = null;
let remoteStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let microphoneAnalyser: AnalyserNode | null = null;
let remoteAnalyser: AnalyserNode | null = null;
let userTranscriptBuffer = "";
let assistantTranscriptBuffer = "";
let agentMessageBuffer = "";
let allTracksEnded = false;
const voiceAudio = new Audio();
voiceAudio.autoplay = true;
const previewParams = new URLSearchParams(window.location.search);
const tauriInternals = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
const currentWindow = typeof tauriInternals?.invoke === "function" ? getCurrentWindow() : null;
const previewModeValue = previewParams.get("preview");
const previewActionValue = previewParams.get("action");
const visualPreviewMode: Mode = ["booting", "ready", "voice-starting", "listening", "working", "speaking", "degraded", "stopped"].includes(previewModeValue ?? "")
  ? previewModeValue as Mode
  : "ready";
if (!currentWindow) {
  document.documentElement.classList.add("visual-preview");
  if (previewParams.get("grid") === "1") document.documentElement.classList.add("transparency-grid");
}
if (currentWindow) {
  void currentWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    await currentWindow.hide();
  });
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<main class="shell" data-mode="booting">
  <canvas id="particle-field" width="1440" height="900" aria-hidden="true"></canvas>
  <header class="topbar hud-panel">
    <div class="brand"><i></i><strong>JARVIS</strong><span></span><em>CODEX VOICE SYSTEM</em></div>
    <div class="status"><i></i><b id="mode-label">INITIALIZING</b></div>
    <button id="settings" class="icon-button" aria-label="设置">⌘</button>
  </header>
  <section class="stage">
    <div class="avatar-window">
      <div class="character-aura"></div>
      <div class="character-rig">
        <div class="assembly-orbits" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="armor-shards" aria-hidden="true"></div>
        <img id="jarvis-character" class="helmet-character" src="/assets/jarvis-character-v2.png" alt="Jarvis holographic helmet">
        <div class="helmet-scan"></div>
        <div class="assembly-flash" aria-hidden="true"></div>
      </div>
      <canvas id="wave" width="900" height="120"></canvas>
    </div>
    <div class="identity"><span>JARVIS CORE</span><b id="identity-state">SYSTEM BOOT</b></div>
  </section>
  <aside class="workers">
    <article class="worker active" data-role="orchestrator"><span>›_</span><div><b>Codex</b><small>Connecting</small></div><i></i></article>
    <article class="worker" data-role="developer"><span>⌬</span><div><b>Developer</b><small>Standby</small></div><i></i></article>
    <article class="worker" data-role="researcher"><span>⌕</span><div><b>Researcher</b><small>Standby</small></div><i></i></article>
    <article class="worker" data-role="reviewer"><span>✓</span><div><b>Reviewer</b><small>Standby</small></div><i></i></article>
  </aside>
  <section class="dialogue hud-panel">
    <b>YOU</b><p id="user-transcript">“嗨，Jarvis”</p>
    <b class="jarvis">JARVIS</b><p id="assistant-transcript">正在连接 Codex 原生任务线程…</p>
  </section>
  <footer class="controls">
    <button id="mic" class="control mic"><span aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="8.25" y="3" width="7.5" height="11.5" rx="3.75"></rect><path d="M5.5 11.25v.75a6.5 6.5 0 0 0 13 0v-.75M12 18.5V22M8.75 22h6.5"></path></svg></span><b>CODEX VOICE</b><small>V3 WEBRTC · DIRECT</small></button>
    <form id="command-form" class="command"><input id="command-input" aria-label="文字指令" placeholder="Voice 不可用时，发送本地 Codex 文字任务…" autocomplete="off"><button>EXECUTE</button></form>
    <button id="stop" class="control stop"><span aria-hidden="true"><svg viewBox="0 0 24 24"><rect class="stop-mark" x="6.5" y="6.5" width="11" height="11" rx="1.8"></rect></svg></span><b>STOP</b><small>INTERRUPT ALL</small></button>
  </footer>
  <div id="degraded-banner" class="degraded-banner" hidden><b>JARVIS NEEDS PERMISSION</b><span id="degraded-copy">首次使用请允许麦克风和语音识别。</span></div>
  <dialog id="approval"><h2>高风险操作确认</h2><p id="approval-copy">Codex 请求执行需要确认的动作。</p><div><button id="deny">拒绝</button><button id="approve">允许一次</button></div></dialog>
  <dialog id="settings-dialog"><h2>JARVIS SYSTEM</h2><dl><dt>Wake phrase</dt><dd>嗨 Jarvis / Hey Jarvis</dd><dt>Wake listener</dt><dd id="wake-auth">检测中</dd><dt>Codex thread</dt><dd id="thread-id">—</dd><dt>Workspace</dt><dd id="workspace">—</dd><dt>Permission</dt><dd id="permission-mode-label">—</dd><dt>Voice style</dt><dd id="speech-style-label">—</dd><dt>Voice kernel</dt><dd id="voice-auth">检测中</dd></dl><label class="workspace-setting">工作目录<input id="workspace-setting" autocomplete="off" spellcheck="false"></label><label class="workspace-setting">全局快捷键（如 Alt+Shift+J，留空禁用）<input id="hotkey-setting" autocomplete="off" spellcheck="false" placeholder="Alt+Shift+J"></label><label class="workspace-setting">Codex 可执行文件（可选）<input id="codex-binary-setting" autocomplete="off" spellcheck="false" placeholder="自动查找，或填写 codex.exe 的完整路径"></label><fieldset class="permission-setting"><legend>Codex 操作权限</legend><label><input type="radio" name="permission-mode" value="safe"><span><b>安全模式</b><small>工作区外或高风险操作时询问</small></span></label><label><input type="radio" name="permission-mode" value="auto"><span><b>自动办公</b><small>仅在所选绝对工作区内自主执行，越界操作直接阻止</small></span></label><label class="danger"><input type="radio" name="permission-mode" value="full"><span><b>完全访问</b><small>不限制目录且不询问，请谨慎使用</small></span></label></fieldset><fieldset class="permission-setting speech-style-setting"><legend>语音风格</legend><label><input type="radio" name="speech-style" value="mandarin"><span><b>普通话</b><small>清晰、中性，默认风格</small></span></label><label><input type="radio" name="speech-style" value="shaanxi"><span><b>陕西话</b><small>使用自然的陕西方言措辞和口音，实际效果可能有差异</small></span></label></fieldset><p>权限、工作目录、Codex 路径或语音风格切换会停止当前任务并重建运行时。</p><p>正在通话时切换语音风格，保存后会自动重连 Voice；语音风格只影响表达方式，不改变任务权限。</p><p>工作目录保存后立即生效；每个目录会续接自己的 Codex thread。</p><p>“新开线程”会结束当前任务并创建一个全新的 Codex thread；原线程仍保留在 Codex 历史记录中。</p><p>唤醒词在本机识别；Jarvis 页面通过 Codex app-server V3 WebRTC 进入官方 Voice 线程。认证复用本机 Codex 登录，不读取凭据、不模拟点击，也不建立第二套 GPT-Live。</p><div class="diagnostics-section" style="margin-top:10px;border-top:1px solid rgba(148,163,184,.25);padding-top:10px"><b style="color:#e2e8f0">一键诊断</b><div style="margin-top:6px"><button id="run-diagnostics" type="button" style="margin-right:8px">一键检查</button><button id="copy-diagnostics" type="button">复制诊断</button></div><div id="diagnostics-result" style="margin-top:6px;font-size:12px;color:#cbd5e1;white-space:pre-wrap"></div></div><div class="settings-actions"><button id="new-thread" class="new-thread">＋ 新开线程</button><span></span><button id="save-settings">保存</button><button id="close-settings">关闭</button></div></dialog>
<dialog id="wizard-dialog"><h2>首次启动检查</h2><div id="wizard-steps" style="margin:8px 0;font-size:12px"></div><div class="settings-actions"><button id="wizard-continue">继续</button></div></dialog>
</main>`;

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const shell = $<HTMLElement>(".shell");
const transcript = $("#user-transcript");
const response = $("#assistant-transcript");
const banner = $("#degraded-banner") as HTMLDivElement;
const mic = $("#mic") as HTMLButtonElement;
const approval = $("#approval") as HTMLDialogElement;
const settings = $("#settings-dialog") as HTMLDialogElement;
const wizard = $("#wizard-dialog") as HTMLDialogElement;
const characterRig = $<HTMLElement>(".character-rig");
const hoverControls = $<HTMLElement>(".controls");
const settingsButton = $<HTMLButtonElement>("#settings");
let controlsHideTimer: number | undefined;
let characterActionTimer: number | undefined;

function revealControls() {
  if (controlsHideTimer !== undefined) window.clearTimeout(controlsHideTimer);
  shell.classList.add("controls-visible");
}

function scheduleControlsHide() {
  if (controlsHideTimer !== undefined) window.clearTimeout(controlsHideTimer);
  controlsHideTimer = window.setTimeout(() => shell.classList.remove("controls-visible"), 1500);
}

type CharacterAction = "acknowledge" | "approval" | "complete" | "error";

function triggerCharacterAction(action: CharacterAction, duration = 1100) {
  if (characterActionTimer !== undefined) window.clearTimeout(characterActionTimer);
  for (const name of ["acknowledge", "approval", "complete", "error"] as const) {
    shell.classList.remove(`action-${name}`);
  }
  void shell.clientWidth;
  shell.classList.add(`action-${action}`);
  characterActionTimer = window.setTimeout(() => shell.classList.remove(`action-${action}`), duration);
}

for (const area of [characterRig, hoverControls, settingsButton]) {
  area.addEventListener("pointerenter", revealControls);
  area.addEventListener("pointerleave", scheduleControlsHide);
}
shell.addEventListener("focusin", (event) => {
  if (event.target instanceof Element && (hoverControls.contains(event.target) || settingsButton.contains(event.target))) revealControls();
});
shell.addEventListener("focusout", scheduleControlsHide);

let approvalId: number | string | undefined;
const copy: Record<Mode, [string, string]> = {
  booting: ["INITIALIZING", "SYSTEM BOOT"], ready: ["READY", "CODEX VOICE STANDBY"],
  "voice-starting": ["VOICE LINKING", "OPENING CODEX VOICE"], listening: ["LISTENING", "OFFICIAL VOICE ONLINE"],
  working: ["CODEX WORKING", "TASK EXECUTION"], speaking: ["JARVIS SPEAKING", "VOICE OUTPUT"],
  degraded: ["PERMISSION NEEDED", "WAKE SYSTEM OFFLINE"], stopped: ["INTERRUPTED", "ALL SYSTEMS HALTED"],
};

function setMode(mode: Mode) {
  state.mode = mode; shell.setAttribute("data-mode", mode);
  $("#mode-label").textContent = copy[mode][0]; $("#identity-state").textContent = copy[mode][1];
  if (mode === "voice-starting") {
    shell.classList.remove("is-forming");
    void shell.clientWidth;
    shell.classList.add("is-forming");
    startParticleFormation();
  }
}
function setWorker(role: string, label: string, active = true) {
  const card = document.querySelector<HTMLElement>(`.worker[data-role="${role}"]`);
  if (!card) return;
  card.classList.toggle("active", active); card.querySelector("small")!.textContent = label;
}
function roleOf(params: any) {
  const text = JSON.stringify(params ?? {}).toLowerCase();
  return text.includes("research") ? "researcher" : text.includes("review") ? "reviewer" :
    text.includes("developer") || text.includes("commandexecution") || text.includes("filechange") ? "developer" : "orchestrator";
}
function drawWave() {
  const canvas = $("#wave") as HTMLCanvasElement, context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const time = performance.now() / 370, amplitude = 5 + state.level * 42 + (state.mode === "speaking" ? 22 : 0);
  context.beginPath();
  for (let x = 0; x <= canvas.width; x += 3) {
    const y = canvas.height / 2 + (Math.sin(x * .085 + time * 2.2) + Math.sin(x * .031 - time) * .55) * amplitude * Math.sin(x / canvas.width * Math.PI) * .48;
    x ? context.lineTo(x, y) : context.moveTo(x, y);
  }
  context.strokeStyle = state.mode === "working" ? "#ff9d2e" : state.mode === "stopped" ? "#ff3d33" : "#22c7ff";
  context.shadowColor = context.strokeStyle; context.shadowBlur = 15; context.lineWidth = 2; context.stroke();
  state.level *= .9; requestAnimationFrame(drawWave);
}
drawWave();

type VisualParticle = {
  fromX: number;
  fromY: number;
  targetX: number;
  targetY: number;
  size: number;
  phase: number;
  delay: number;
  curve: number;
  amber: boolean;
};

const particleCanvas = $("#particle-field") as HTMLCanvasElement;
const particleContext = particleCanvas.getContext("2d")!;
const characterImage = $("#jarvis-character") as HTMLImageElement;
const armorShardLayer = $<HTMLElement>(".armor-shards");
const armorShardSpecs = [
  ["polygon(35% 4%,65% 4%,63% 23%,37% 23%)", 0, -390, -8, 80],
  ["polygon(17% 9%,37% 4%,38% 31%,22% 35%)", -430, -280, -24, 0],
  ["polygon(63% 4%,83% 9%,78% 35%,62% 31%)", 430, -280, 24, 20],
  ["polygon(37% 22%,63% 22%,61% 45%,39% 45%)", 30, -320, 10, 170],
  ["polygon(20% 31%,39% 27%,43% 48%,19% 49%)", -470, -120, -32, 100],
  ["polygon(61% 27%,80% 31%,81% 49%,57% 48%)", 470, -120, 32, 120],
  ["polygon(16% 45%,43% 44%,46% 57%,20% 59%)", -520, -20, -18, 220],
  ["polygon(57% 44%,84% 45%,80% 59%,54% 57%)", 520, -20, 18, 240],
  ["polygon(42% 43%,58% 43%,59% 70%,41% 70%)", 0, 390, -10, 300],
  ["polygon(19% 56%,42% 54%,41% 73%,24% 78%)", -480, 180, -28, 280],
  ["polygon(58% 54%,81% 56%,76% 78%,59% 73%)", 480, 180, 28, 300],
  ["polygon(24% 73%,42% 68%,45% 84%,31% 88%)", -340, 330, 22, 390],
  ["polygon(58% 68%,76% 73%,69% 88%,55% 84%)", 340, 330, -22, 410],
  ["polygon(41% 68%,59% 68%,56% 88%,44% 88%)", 40, 430, 14, 470],
  ["polygon(31% 85%,45% 82%,44% 96%,36% 94%)", -250, 460, -30, 500],
  ["polygon(55% 82%,69% 85%,64% 94%,56% 96%)", 250, 460, 30, 520],
  ["polygon(43% 86%,57% 86%,56% 98%,44% 98%)", 0, 520, -12, 560],
  ["polygon(12% 25%,24% 19%,22% 45%,14% 52%)", -560, -210, -38, 180],
  ["polygon(76% 19%,88% 25%,86% 52%,78% 45%)", 560, -210, 38, 200],
] as const;

for (const [clip, translateX, translateY, rotation, delay] of armorShardSpecs) {
  const shard = document.createElement("i");
  shard.className = "armor-shard";
  shard.style.setProperty("--shard-clip", clip);
  shard.style.setProperty("--shard-x", `${translateX}px`);
  shard.style.setProperty("--shard-y", `${translateY}px`);
  shard.style.setProperty("--shard-rotation", `${rotation}deg`);
  shard.style.setProperty("--shard-delay", `${delay}ms`);
  if (Math.abs(rotation) >= 28 || delay % 3 === 0) shard.classList.add("amber-edge");
  armorShardLayer.append(shard);
}

let visualParticles: VisualParticle[] = [];
let formationStartedAt = -10_000;
let particleTargetBounds = { left: 0, top: 0, width: 1, height: 1 };
const FORMATION_DURATION = 3200;

function scatterParticleFromWindowEdge(particle: VisualParticle) {
  const edge = Math.floor(Math.random() * 4);
  const inset = Math.random() * 24;
  if (edge === 0) {
    particle.fromX = inset;
    particle.fromY = Math.random() * particleCanvas.height;
  } else if (edge === 1) {
    particle.fromX = particleCanvas.width - inset;
    particle.fromY = Math.random() * particleCanvas.height;
  } else {
    particle.fromX = Math.random() * particleCanvas.width;
    particle.fromY = edge === 2 ? inset : particleCanvas.height - inset;
  }
}

function syncParticleCanvasSize() {
  const bounds = shell.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  if (particleCanvas.width !== width) particleCanvas.width = width;
  if (particleCanvas.height !== height) particleCanvas.height = height;
}

function prepareVisualParticles() {
  if (!characterImage.naturalWidth) return;
  syncParticleCanvasSize();
  const sample = document.createElement("canvas");
  sample.width = particleCanvas.width;
  sample.height = particleCanvas.height;
  const context = sample.getContext("2d", { willReadFrequently: true })!;
  const shellBounds = shell.getBoundingClientRect();
  const characterBounds = characterImage.getBoundingClientRect();
  const left = characterBounds.left - shellBounds.left;
  const top = characterBounds.top - shellBounds.top;
  particleTargetBounds = { left, top, width: characterBounds.width, height: characterBounds.height };
  context.drawImage(characterImage, left, top, characterBounds.width, characterBounds.height);
  const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
  visualParticles = [];
  for (let y = 0; y < sample.height; y += 7) {
    for (let x = 0; x < sample.width; x += 7) {
      const alpha = pixels[(y * sample.width + x) * 4 + 3];
      if (alpha < 46 || Math.random() > .82) continue;
      const particle: VisualParticle = {
        fromX: 0,
        fromY: 0,
        targetX: x + (Math.random() - .5) * 5,
        targetY: y + (Math.random() - .5) * 5,
        size: Math.random() > .965 ? 2.6 + Math.random() * 1.8 : .45 + Math.random() * 1.65,
        phase: Math.random() * Math.PI * 2,
        delay: Math.random() * .3,
        curve: (Math.random() - .5) * (90 + Math.random() * 190),
        amber: Math.random() < .16,
      };
      scatterParticleFromWindowEdge(particle);
      visualParticles.push(particle);
    }
  }
}

function startParticleFormation() {
  if (!visualParticles.length) prepareVisualParticles();
  formationStartedAt = performance.now();
  for (const particle of visualParticles) scatterParticleFromWindowEdge(particle);
}

function easeFormation(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function particlePosition(particle: VisualParticle, progress: number) {
  const eased = easeFormation(progress);
  const deltaX = particle.targetX - particle.fromX;
  const deltaY = particle.targetY - particle.fromY;
  const distance = Math.max(1, Math.hypot(deltaX, deltaY));
  const bend = Math.sin(eased * Math.PI) * particle.curve;
  return {
    x: particle.fromX + deltaX * eased - deltaY / distance * bend,
    y: particle.fromY + deltaY * eased + deltaX / distance * bend,
  };
}

function drawFormationEnergy(now: number, rawProgress: number) {
  if (rawProgress < 0 || rawProgress > 1.12) return;
  const progress = Math.max(0, Math.min(1, rawProgress));
  const centerX = particleTargetBounds.left + particleTargetBounds.width / 2;
  const centerY = particleTargetBounds.top + particleTargetBounds.height / 2;
  const intensity = Math.sin(progress * Math.PI);
  const outerRadius = Math.max(particleCanvas.width, particleCanvas.height) * .56;
  const targetRadius = Math.max(particleTargetBounds.width, particleTargetBounds.height) * .48;
  const radius = outerRadius + (targetRadius - outerRadius) * easeFormation(progress);

  particleContext.save();
  particleContext.globalCompositeOperation = "lighter";
  particleContext.translate(centerX, centerY);
  particleContext.scale(1, .72);
  for (let index = 0; index < 4; index += 1) {
    const ringRadius = radius + index * 34;
    particleContext.beginPath();
    particleContext.setLineDash([16 + index * 5, 34 + index * 7]);
    particleContext.lineDashOffset = (index % 2 ? 1 : -1) * now / (12 + index * 3);
    particleContext.arc(0, 0, ringRadius, 0, Math.PI * 2);
    particleContext.lineWidth = index === 0 ? 1.8 : .75;
    particleContext.strokeStyle = index === 2
      ? `rgba(255,155,47,${intensity * .48})`
      : `rgba(34,199,255,${intensity * (.56 - index * .08)})`;
    particleContext.stroke();
  }
  particleContext.restore();

  const shock = Math.max(0, Math.min(1, (progress - .68) / .25));
  if (shock > 0 && shock < 1) {
    particleContext.save();
    particleContext.globalCompositeOperation = "lighter";
    particleContext.beginPath();
    particleContext.ellipse(
      centerX,
      centerY,
      targetRadius * (.65 + shock * 1.35),
      targetRadius * (.48 + shock * .95),
      0,
      0,
      Math.PI * 2,
    );
    particleContext.strokeStyle = `rgba(134,229,255,${(1 - shock) * .85})`;
    particleContext.shadowColor = "#22c7ff";
    particleContext.shadowBlur = 28;
    particleContext.lineWidth = 2.4;
    particleContext.stroke();
    particleContext.restore();
  }
}

function drawParticleField(now: number) {
  particleContext.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
  if (visualParticles.length) {
    const rawProgress = (now - formationStartedAt) / FORMATION_DURATION;
    const forming = rawProgress >= 0 && rawProgress < 1.08;
    const idleStrength = state.mode === "speaking" ? .18 + state.level * .48 : state.mode === "working" ? .12 : .045;
    particleContext.globalCompositeOperation = "lighter";
    for (const particle of visualParticles) {
      const localRaw = forming ? (rawProgress - particle.delay) / (1 - particle.delay) : 1;
      const progress = Math.max(0, Math.min(1, localRaw));
      const point = particlePosition(particle, progress);
      const previous = particlePosition(particle, Math.max(0, progress - (.035 + particle.size * .008)));
      const drift = forming ? 0 : Math.sin(now / 760 + particle.phase) * (1.1 + state.level * 3.2);
      const x = point.x + drift;
      const y = point.y + Math.cos(now / 830 + particle.phase) * (forming ? 0 : 1.4);
      const alpha = forming
        ? localRaw < 0
          ? .12 + Math.sin(now / 180 + particle.phase) * .08
          : .34 + Math.sin(progress * Math.PI) * .66
        : idleStrength;
      const color = state.mode === "working"
        ? "255,155,47"
        : state.mode === "stopped"
          ? "255,73,62"
          : particle.amber
            ? "255,155,47"
            : "34,199,255";
      if (forming) {
        particleContext.beginPath();
        particleContext.moveTo(previous.x, previous.y);
        particleContext.lineTo(x, y);
        particleContext.strokeStyle = `rgba(${color},${alpha * (particle.size > 2.5 ? .62 : .28)})`;
        particleContext.lineWidth = particle.size > 2.5 ? 1.5 : .65;
        particleContext.stroke();
      }
      particleContext.beginPath();
      particleContext.arc(x, y, particle.size * (forming ? 1.3 : 1), 0, Math.PI * 2);
      particleContext.fillStyle = `rgba(${color},${alpha})`;
      particleContext.fill();
    }
    if (forming) drawFormationEnergy(now, rawProgress);
    particleContext.globalCompositeOperation = "source-over";
  }
  requestAnimationFrame(drawParticleField);
}

if (characterImage.complete && characterImage.naturalWidth) prepareVisualParticles();
else characterImage.addEventListener("load", prepareVisualParticles, { once: true });
new ResizeObserver(() => prepareVisualParticles()).observe(shell);
requestAnimationFrame(drawParticleField);

function analyserLevel(analyser: AnalyserNode | null) {
  if (!analyser) return 0;
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let energy = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    energy += normalized * normalized;
  }
  return Math.min(1, Math.sqrt(energy / samples.length) * 5);
}

function updateAudioMeters() {
  if (!currentWindow) {
    const time = performance.now();
    state.level = state.mode === "speaking"
      ? .52 + Math.sin(time / 125) * .16
      : state.mode === "working"
        ? .2 + Math.sin(time / 310) * .08
        : state.mode === "listening"
          ? .08 + Math.sin(time / 430) * .035
          : 0;
    shell.style.setProperty("--voice-pulse", String(1 + state.level * .026));
    shell.style.setProperty("--voice-glow", String(.45 + state.level * .55));
    requestAnimationFrame(updateAudioMeters);
    return;
  }
  const micLevel = analyserLevel(microphoneAnalyser);
  const speakerLevel = analyserLevel(remoteAnalyser);
  state.level = Math.max(state.level, micLevel, speakerLevel);
  shell.style.setProperty("--voice-pulse", String(1 + state.level * .026));
  shell.style.setProperty("--voice-glow", String(.45 + state.level * .55));
  if (state.directVoice?.voiceActive && !state.agentWorking) {
    if (speakerLevel > 0.08 && state.mode !== "speaking") setMode("speaking");
    if (speakerLevel < 0.025 && state.mode === "speaking") setMode("listening");
  }
  requestAnimationFrame(updateAudioMeters);
}
updateAudioMeters();

function updateVoiceInfo(info: DirectVoice) {
  state.directVoice = info;
  // 麦克风持有由 jarvis-voice-state 驱动，这里不再推断连接状态。
  if (info.threadId) {
    state.session = { threadId: info.threadId, cwd: workspace.id };
    if (state.settings) state.settings.threadId = info.threadId;
    $("#thread-id").textContent = info.threadId;
    localStorage.setItem(workspace.threadKey, info.threadId);
  }
}

﻿async function handle(message: Message) {
  if (message.id !== undefined && message.method) {
    triggerCharacterAction("approval", 1800);
    approvalId = message.id; $("#approval-copy").textContent = `Codex 请求：${message.method}`; approval.showModal(); return;
  }
  const method = message.method, params = message.params;
  if (method === "thread/realtime/sdp") {
    if (!peer || !params?.sdp) return;
    try {
      await peer.setRemoteDescription({ type: "answer", sdp: params.sdp });
    } catch (error) {
      triggerCharacterAction("error");
      setMode("degraded");
      response.textContent = `Codex Voice SDP 连接失败：${String(error)}`;
    }
  } else if (method === "thread/realtime/started") {
    updateVoiceInfo({
      codexConnected: true,
      voiceActive: true,
      phase: "connected",
      protocol: "Codex app-server V3 · WebRTC",
      threadId: params?.threadId,
      realtimeSessionId: params?.realtimeSessionId,
    });
    banner.hidden = true;
    setMode("listening");
    triggerCharacterAction("acknowledge");
    setWorker("orchestrator", "Official Voice online");
    response.textContent = "Codex 官方 Voice 已上线。你现在可以直接和 Jarvis 对话。";
  } else if (method === "thread/realtime/transcript/delta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    if (params?.role === "assistant") {
      assistantTranscriptBuffer += delta;
      response.textContent = assistantTranscriptBuffer;
      if (!state.agentWorking) setMode("speaking");
    } else {
      userTranscriptBuffer += delta;
      transcript.textContent = userTranscriptBuffer;
      if (!state.agentWorking) setMode("listening");
    }
  } else if (method === "thread/realtime/transcript/done") {
    const text = typeof params?.text === "string" ? params.text.trim() : "";
    if (params?.role === "assistant") {
      if (text) response.textContent = text;
      assistantTranscriptBuffer = "";
      if (!state.agentWorking) setMode("listening");
    } else {
      if (text) transcript.textContent = text;
      userTranscriptBuffer = "";
      if (text) triggerCharacterAction("acknowledge");
    }
  } else if (method === "thread/realtime/itemAdded") {
    const itemType = String(params?.item?.type ?? "");
    if (itemType.includes("handoff") || itemType.includes("delegation")) {
      setMode("working");
      setWorker("orchestrator", "Delegating to Codex");
    }
  } else if (method === "thread/realtime/error") {
    const detail = String(params?.message ?? "Codex Voice realtime error");
    triggerCharacterAction("error");
    // 重连或进入 Degraded 由后端状态机驱动，前端只展示错误细节。
    $("#degraded-copy").textContent = detail;
    response.textContent = detail;
  } else if (method === "thread/realtime/closed") {
    cleanupPeer();
    stopLocalTracks();
    updateVoiceInfo({
      codexConnected: true,
      voiceActive: false,
      phase: "closed",
      protocol: "Codex app-server V3 · WebRTC",
      threadId: params?.threadId ?? state.session?.threadId,
    });
    // 状态推进（VoiceStopped -> WakeRearming -> WakeReady）由 jarvis-voice-state 驱动。
  } else if (method === "turn/started") {
    if (state.manualStop) return;
    agentMessageBuffer = "";
    state.agentWorking = true;
    setMode("working"); setWorker("orchestrator", "Codex working");
  } else if (method === "item/agentMessage/delta") {
    const delta = typeof params?.delta === "string" ? params.delta : "";
    agentMessageBuffer += delta;
    if (agentMessageBuffer) response.textContent = agentMessageBuffer;
  } else if (method === "turn/completed") {
    state.agentWorking = false;
    if (!state.manualStop) triggerCharacterAction("complete", 1400);
    setMode(state.manualStop ? "stopped" : state.directVoice?.voiceActive ? "listening" : "ready");
    setWorker("orchestrator", state.manualStop ? "Interrupted" : "Ready", !state.manualStop);
    for (const role of ["developer", "researcher", "reviewer"]) {
      setWorker(role, state.manualStop ? "Interrupted" : "Standby", false);
    }
  } else if (method === "item/started") {
    if (!state.manualStop) setWorker(roleOf(params), "Working");
  } else if (method === "item/completed") {
    setWorker(roleOf(params), "Complete", false);
    if (params?.item?.type === "agentMessage") {
      const text = typeof params.item.text === "string" ? params.item.text : agentMessageBuffer;
      if (text) response.textContent = text;
    }
  }
}

async function waitForIceGathering(connection: RTCPeerConnection) {
  if (connection.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      connection.removeEventListener("icegatheringstatechange", changed);
      reject(new Error("WebRTC ICE gathering timed out"));
    }, 12_000);
    const changed = () => {
      if (connection.iceGatheringState !== "complete") return;
      window.clearTimeout(timer);
      connection.removeEventListener("icegatheringstatechange", changed);
      resolve();
    };
    connection.addEventListener("icegatheringstatechange", changed);
  });
}

function attachAnalyser(stream: MediaStream, target: "microphone" | "remote") {
  audioContext ??= new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  if (target === "microphone") microphoneAnalyser = analyser;
  else remoteAnalyser = analyser;
}

function cleanupPeer() {
  peer?.close();
  peer = null;
  remoteStream?.getTracks().forEach((track) => track.stop());
  remoteStream = null;
  voiceAudio.pause();
  voiceAudio.srcObject = null;
  microphoneAnalyser = null;
  remoteAnalyser = null;
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

function reportVoiceEvent(event: string): Promise<VoiceStateInfo> {
  return invoke<VoiceStateInfo>("report_voice_event", { event }).then(applyVoiceState);
}

function voiceCopy(stateName: VoiceStateName): { mode: Mode; title: string } {
  switch (stateName) {
    case "booting":
    case "wakeArming":
      return { mode: "ready", title: "正在启动唤醒监听…" };
    case "wakeReady":
      return { mode: "ready", title: "我在。直接说“嗨 Jarvis”。" };
    case "wakeDetected":
    case "wakeReleasingMicrophone":
    case "voiceAcquiringMicrophone":
    case "voiceConnecting":
      return { mode: "voice-starting", title: "正在交接麦克风并建立 Codex Voice…" };
    case "voiceListening":
    case "voiceSpeaking":
      return { mode: "listening", title: "Codex 官方 Voice 已上线。你现在可以直接和 Jarvis 对话。" };
    case "working":
      return { mode: "working", title: "" };
    case "voiceStopping":
    case "wakeRearming":
      return { mode: "ready", title: "正在停止 Voice 并重新布防…" };
    case "degraded":
      return { mode: "degraded", title: "" };
    case "stopping":
      return { mode: "stopped", title: "已停止。" };
  }
}

function applyVoiceState(info: VoiceStateInfo): VoiceStateInfo {
  state.voice = info;
  mic.classList.toggle("active", info.micOwner === "voice");
  $("#voice-auth").textContent = `Codex app-server V3 · ${
    info.micOwner === "voice" || info.state === "voiceAcquiringMicrophone" || info.state === "voiceConnecting"
      ? "connecting"
      : info.state === "wakeReady" ? "standby" : info.state
  }`;
  const copy = voiceCopy(info.state);
  if (state.manualStop && (info.state === "wakeReady" || info.state === "wakeArming")) {
    setMode("stopped");
    response.textContent = "已停止。说“嗨 Jarvis”或点麦克风重新开始。";
  } else {
    setMode(copy.mode);
    if (copy.title) response.textContent = copy.title;
  }
  if (info.state === "degraded" && info.degraded) {
    banner.hidden = false;
    const detail = info.degraded.suggestedAction;
    $("#degraded-copy").textContent = detail;
    response.textContent = detail;
  } else if (info.state !== "degraded") {
    banner.hidden = true;
  }
  if (info.state === "voiceAcquiringMicrophone") {
    void acquireVoiceMicrophone();
  } else if (info.state === "voiceConnecting" && info.reconnectAttempts > 0 && !peer) {
    void reconnectVoice();
  }
  maybeReportAllTracksEnded();
  return info;
}

async function acquireVoiceMicrophone() {
  if (peer || state.voice?.micOwner === "voice") return;
  allTracksEnded = false;
  try {
    const authorization = await invoke<string>("request_microphone_permission");
    if (authorization !== "authorized") {
      throw new Error("请在系统设置 → 隐私与安全性 → 麦克风中允许 Jarvis Codex。");
    }
    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    watchTrackEnded(microphoneStream);
    attachAnalyser(microphoneStream, "microphone");
  } catch (error) {
    // Mic acquisition failed: report the acquire stage and release any stream.
    cleanupPeer();
    stopLocalTracks();
    const detail = String(error);
    try { await reportVoiceEvent("microphoneAcquireTimeout"); } catch { /* already degraded */ }
    banner.hidden = false;
    $("#degraded-copy").textContent = detail;
    response.textContent = detail;
    return;
  }
  try {
    await reportVoiceEvent("voiceMicrophoneAcquired");
    await connectVoiceSession();
  } catch (error) {
    // The microphone was handed over; failure here is a voice-session or
    // runtime problem (for example Codex not logged in), not a mic-acquire
    // timeout. Stop local tracks so the mic is not left held after Degraded.
    cleanupPeer();
    stopLocalTracks();
    const detail = String(error);
    try { await reportVoiceEvent("voiceConnectTimeout"); } catch { /* already degraded */ }
    banner.hidden = false;
    $("#degraded-copy").textContent = detail;
    response.textContent = detail;
  }
}

async function connectVoiceSession() {
  if (!microphoneStream) throw new Error("缺少麦克风音轨");
  const connection = new RTCPeerConnection();
  peer = connection;
  const track = microphoneStream.getAudioTracks()[0];
  if (!track) throw new Error("未找到麦克风音轨");
  connection.addTrack(track, microphoneStream);
  connection.createDataChannel("oai-events");
  connection.ontrack = (event) => {
    remoteStream = event.streams[0] ?? new MediaStream([event.track]);
    voiceAudio.srcObject = remoteStream;
    attachAnalyser(remoteStream, "remote");
    void audioContext?.resume();
    void voiceAudio.play();
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "failed") {
      setMode("degraded");
      response.textContent = "Codex Voice WebRTC 连接失败。";
    }
  };
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await waitForIceGathering(connection);
  const sdp = connection.localDescription?.sdp;
  if (!sdp) throw new Error("WebRTC 未生成 SDP offer");
  const info = await invoke<DirectVoice>("start_codex_voice", {
    request: {
      cwd: workspace.id,
      threadId: savedThreadId(),
      permissionMode,
      speechStyle,
      codexPath: codexBinary || null,
      sdp,
      voice: "cove",
    },
  });
  updateVoiceInfo(info);
}

async function reconnectVoice() {
  if (!microphoneStream || peer) return;
  try {
    await connectVoiceSession();
  } catch (error) {
    cleanupPeer();
    const detail = String(error);
    try { await reportVoiceEvent("voiceConnectTimeout"); } catch { /* already degraded */ }
    banner.hidden = false;
    $("#degraded-copy").textContent = detail;
    response.textContent = detail;
  }
}

function watchTrackEnded(stream: MediaStream) {
  const tracks = stream.getAudioTracks();
  const check = () => {
    if (allTracksEnded) return;
    if (tracks.length > 0 && tracks.every((track) => track.readyState === "ended")) {
      allTracksEnded = true;
      maybeReportAllTracksEnded();
    }
  };
  for (const track of tracks) track.addEventListener("ended", check);
}

function maybeReportAllTracksEnded() {
  if (!allTracksEnded || state.voice?.state !== "wakeRearming") return;
  allTracksEnded = false;
  void reportVoiceEvent("allTracksEnded").catch(() => {});
}

function stopLocalTracks() {
  if (microphoneStream) {
    for (const track of microphoneStream.getTracks()) track.stop();
  }
}

const wizardLabels: Record<string, string> = {
  windows: "系统版本",
  webview2: "WebView2 Runtime",
  microphone: "麦克风权限",
  speech_pack: "语音识别语言包",
  codex: "Codex 可执行文件",
  workspace: "工作目录",
  network: "网络连接",
};
async function showWizardIfNeeded() {
  try {
    const report = await invoke<WizardReport>("wizard_status");
    if (report.completed) return;
    const container = $("#wizard-steps");
    container.innerHTML = report.steps.map((step) => {
      const color = step.level === "green" ? "#22c55e" : step.level === "yellow" ? "#f59e0b" : "#ef4444";
      return '<div style="margin:2px 0;color:#dbeafe"><span style="color:' + color + '">●</span> ' + (wizardLabels[step.id] ?? step.id) + (step.blocking ? '（阻塞）' : '') + '</div>';
    }).join("");
    ($("#wizard-continue") as HTMLButtonElement).disabled = !report.canProceed;
    wizard.showModal();
  } catch { /* 向导失败不阻塞启动 */ }
}
$("#wizard-continue").addEventListener("click", async () => {
  try {
    await invoke<SettingsDto>("save_settings", {
      request: {
        workspace: workspace.id,
        threadId: savedThreadId() ?? undefined,
        permissionMode,
        speechStyle,
        codexPath: codexBinary || null,
        wizardCompleted: true,
      },
    });
    wizard.close();
  } catch (error) {
    $("#wizard-steps").textContent = `保存失败：${String(error)}`;
  }
});
async function loadBackendSettings(): Promise<SettingsDto | null> {
  try {
    let settings = await invoke<SettingsDto>("get_settings");
    if (!settings.present) {
      const snapshot: Record<string, string> = {};
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key?.startsWith("jarvis.threadId:")) {
          snapshot[key] = localStorage.getItem(key) ?? "";
        }
      }
      snapshot["jarvis.workspace"] = localStorage.getItem(WORKSPACE_KEY) ?? "";
      snapshot["jarvis.permissionMode"] = localStorage.getItem(PERMISSION_KEY) ?? "";
      snapshot["jarvis.speechStyle"] = localStorage.getItem(SPEECH_STYLE_KEY) ?? "";
      snapshot["jarvis.codexBinary"] = localStorage.getItem(CODEX_BINARY_KEY) ?? "";
      await invoke<SettingsDto>("import_legacy_settings", { snapshot });
      settings = await invoke<SettingsDto>("get_settings");
    }
    state.settings = settings;
    return settings;
  } catch {
    return null;
  }
}

if (currentWindow) {
  await listen<Message>("codex-event", ({ payload }) => void handle(payload));
  await listen<VoiceStateInfo>("jarvis-voice-state", ({ payload }) => applyVoiceState(payload));
  await listen("jarvis-voice-may-acquire-microphone", () => { /* 状态机已切到 voiceAcquiringMicrophone，由 applyVoiceState 驱动 */ });
  await listen<{ id: string }>("jarvis-tray-action", ({ payload }) => {
    if (payload.id === "textMode") ($("#command-input") as HTMLInputElement).focus();
    if (payload.id === "diagnostics") {
      settings.showModal();
      void ($("#run-diagnostics") as HTMLButtonElement).click();
    }
  });
  await listen<{ error: string }>("jarvis-hotkey-error", ({ payload }) => {
    response.textContent = `快捷键：${payload.error}`;
  });
  await listen<RuntimeStateInfo>("jarvis-runtime-state", ({ payload }) => {
    if (payload.state === "ready") {
      banner.hidden = true;
      if (!state.manualStop && !state.directVoice?.voiceActive) setMode("ready");
      void invoke<DirectVoice>("direct_voice_status").then(updateVoiceInfo);
      return;
    }
    const voiceActive = state.voice != null && (
      state.voice.micOwner === "voice" ||
      state.voice.state === "voiceAcquiringMicrophone" ||
      state.voice.state === "voiceConnecting" ||
      state.voice.state === "voiceListening" ||
      state.voice.state === "voiceSpeaking" ||
      state.voice.state === "working" ||
      state.voice.state === "voiceStopping" ||
      state.voice.state === "wakeRearming"
    );
    // While a voice session is in progress, the voice state machine owns the
    // microphone and the error surface. Do not tear down the peer, degrade the
    // UI, or re-arm the wake sidecar here: that would grab the mic mid-voice.
    if (voiceActive) return;
    cleanupPeer();
    state.directVoice = null;
    state.agentWorking = false;
    if (payload.state === "absent" && state.manualStop) {
      setMode("stopped");
      return;
    }
    setMode("degraded");
    banner.hidden = false;
    const detail = payload.lastError ?? ({
      starting: "Codex runtime is starting…",
      degraded: "Codex runtime initialization failed.",
      dead: "Codex runtime exited unexpectedly.",
      restarting: `Codex runtime is restarting (attempt ${payload.restartAttempts}/3)…`,
      failed: "Codex runtime could not be recovered automatically.",
      absent: "Codex runtime is not running.",
    } as const)[payload.state];
    $("#degraded-copy").textContent = detail;
    response.textContent = detail;
    void armWakeListener();
  });
  await listen<WakeStatus>("jarvis-wake-status", ({ payload }) => {
    state.wake = payload;
    $("#wake-auth").textContent = payload.ready
      ? "Local listener ready"
      : payload.authorization === "authorized"
        ? "Waiting to re-arm"
        : payload.authorization;
    if (payload.ready) {
      if (state.mode === "ready") {
        response.textContent = "我在。直接说“嗨 Jarvis”。";
        setWorker("orchestrator", "Wake word armed");
      }
    }
  });
  await listen<WakeEvent>("jarvis-wake", ({ payload }) => {
    transcript.textContent = "“嗨，Jarvis”";
    state.manualStop = false;
    if (!payload.ok) {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = payload.error ?? "无法打开官方 Codex Voice。";
      response.textContent = payload.error ?? "无法打开官方 Codex Voice。";
      return;
    }
    banner.hidden = true;
    // 麦克风交接由后端状态机驱动（voiceAcquiringMicrophone -> voiceMayAcquire）。
  });
}
$("#command-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const input = $("#command-input") as HTMLInputElement, text = input.value.trim();
  if (!text) return;
  state.manualStop = false;
  transcript.textContent = text;
  input.value = "";
  if (!currentWindow) {
    response.textContent = "视觉预览：文字任务已切换为 Codex 工作态。";
    setMode("working");
    return;
  }
  if (state.directVoice?.voiceActive) {
    response.textContent = "已将文字作为用户话语注入当前 Codex Voice 会话。";
    await invoke("append_codex_voice_text", { text });
    return;
  }
  if (!state.session) {
    state.session = await invoke<Session>("start_jarvis", {
      cwd: workspace.id,
      threadId: savedThreadId(),
      permissionMode,
      speechStyle,
      codexPath: codexBinary || null,
    });
    localStorage.setItem(workspace.threadKey, state.session.threadId);
    $("#thread-id").textContent = state.session.threadId;
    $("#workspace").textContent = state.session.cwd;
  }
  setMode("working");
  await invoke("send_text", { text });
});
mic.addEventListener("click", () => {
  state.manualStop = false;
  if (state.voice?.state === "degraded") {
    void reportVoiceEvent("retryRequested");
  } else if (state.voice?.micOwner === "voice" || peer) {
    void reportVoiceEvent("stopRequested");
  } else {
    void reportVoiceEvent("wakeDetected");
  }
});
$("#stop").addEventListener("click", async () => {
  triggerCharacterAction("error", 700);
  state.manualStop = true; setMode("stopped");
  state.agentWorking = false;
  for (const role of ["orchestrator", "developer", "researcher", "reviewer"]) setWorker(role, "Interrupted", false);
  if (!currentWindow) return;
  try { await reportVoiceEvent("stopRequested"); } catch { /* no runtime to stop */ }
  stopLocalTracks();
});
function syncPermissionControls() {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="permission-mode"][value="${permissionMode}"]`,
  );
  if (input) input.checked = true;
  $("#permission-mode-label").textContent = permissionLabel(permissionMode);
  const safeCopy = document.querySelector<HTMLElement>('input[value="safe"] + span small');
  const autoCopy = document.querySelector<HTMLElement>('input[value="auto"] + span small');
  if (safeCopy) safeCopy.textContent = `Prompts for risky actions or access outside ${workspace.display}`;
  if (autoCopy) autoCopy.textContent = `Acts autonomously only inside ${workspace.display}; blocks boundary crossings`;
}
function syncSpeechStyleControls() {
  const input = document.querySelector<HTMLInputElement>(
    `input[name="speech-style"][value="${speechStyle}"]`,
  );
  if (input) input.checked = true;
  $("#speech-style-label").textContent = speechStyleLabels[speechStyle];
}

$("#settings").addEventListener("click", () => {
  ($("#codex-binary-setting") as HTMLInputElement).value = codexBinary;
  ($("#hotkey-setting") as HTMLInputElement).value = state.settings?.hotkey ?? "";
  syncPermissionControls();
  syncSpeechStyleControls();
  settings.showModal();
});
$("#close-settings").addEventListener("click", () => settings.close());
$("#run-diagnostics").addEventListener("click", async () => {
  const result = $("#diagnostics-result");
  try {
    const items = await invoke<DiagnosticItem[]>("run_diagnostics");
    result.innerHTML = items.map((item) => {
      const color = item.verdict.level === "green" ? "#22c55e" : item.verdict.level === "yellow" ? "#f59e0b" : "#ef4444";
      return `<div style="margin:2px 0"><span style="color:${color}">●</span> ${item.verdict.messageZh} — ${item.verdict.suggestedActionZh}</div>`;
    }).join("");
  } catch (error) {
    result.textContent = `检查失败：${String(error)}`;
  }
});
$("#copy-diagnostics").addEventListener("click", async () => {
  const result = $("#diagnostics-result");
  try {
    const text = await invoke<string>("copy_diagnostics");
    await navigator.clipboard.writeText(text);
    result.textContent = "诊断文本已复制（已脱敏）。";
  } catch (error) {
    result.textContent = `复制失败：${String(error)}`;
  }
});
$("#new-thread").addEventListener("click", async () => {
  const button = $("#new-thread") as HTMLButtonElement;
  button.disabled = true;
  state.manualStop = true;
  settings.close();
  response.textContent = "正在结束当前任务并创建新的 Codex thread…";
  try {
    try { await reportVoiceEvent("workspaceSwitchRequested"); } catch { /* no voice */ }
    stopLocalTracks();
    try { await invoke("stop_all"); } catch { /* no active runtime */ }
    await invoke("shutdown");
    const freshSession = await invoke<Session>("start_jarvis", {
      cwd: workspace.id,
      threadId: null,
      permissionMode,
      speechStyle,
      codexPath: codexBinary || null,
    });
    state.session = freshSession;
    state.directVoice = null;
    try {
      state.settings = await invoke<SettingsDto>("save_settings", {
        request: {
          workspace: workspace.id,
          threadId: freshSession.threadId,
          permissionMode,
          speechStyle,
          codexPath: codexBinary || null,
        },
      });
    } catch { /* localStorage 仍作缓存 */ }
    localStorage.setItem(workspace.threadKey, freshSession.threadId);
    $("#thread-id").textContent = freshSession.threadId;
    $("#workspace").textContent = freshSession.cwd;
    userTranscriptBuffer = "";
    assistantTranscriptBuffer = "";
    agentMessageBuffer = "";
    transcript.textContent = "“新开线程”";
    response.textContent = "新的 Codex thread 已创建。下一次唤醒和文字任务都会进入这个线程。";
    setMode("ready");
    setWorker("orchestrator", "Fresh thread ready");
  } catch (error) {
    try { await invoke("shutdown"); } catch { /* already stopped */ }
    state.session = null;
    state.directVoice = null;
    setMode("degraded");
    response.textContent = `新建线程失败，原线程仍可续接：${String(error)}`;
  } finally {
    button.disabled = false;
    await armWakeListener();
  }
});
$("#save-settings").addEventListener("click", async () => {
  const requestedWorkspace = ($("#workspace-setting") as HTMLInputElement).value.trim();
  if (!requestedWorkspace) return;
  let nextWorkspace: WorkspaceInfo;
  try {
    nextWorkspace = await invoke<WorkspaceInfo>("validate_workspace", { cwd: requestedWorkspace });
  } catch (error) {
    response.textContent = `工作目录无效：${String(error)}`;
    return;
  }
  const selectedPermission = document.querySelector<HTMLInputElement>(
    'input[name="permission-mode"]:checked',
  )?.value as PermissionMode | undefined;
  let nextPermission = selectedPermission ?? permissionMode;
  if (nextPermission === "full" && !window.confirm(
    `Grant Codex full filesystem and network access for ${nextWorkspace.display}? This choice will reset to Safe after restart.`,
  )) return;
  try {
    const resolution = await invoke<PermissionResolution>("resolve_permission_mode", {
      cwd: nextWorkspace.id,
      mode: nextPermission,
      source: "user-selection",
    });
    nextPermission = resolution.mode;
  } catch (error) {
    response.textContent = `${String(error)} (${nextWorkspace.display})`;
    return;
  }
  const selectedSpeechStyle = document.querySelector<HTMLInputElement>(
    'input[name="speech-style"]:checked',
  )?.value as SpeechStyle | undefined;
  const nextSpeechStyle = selectedSpeechStyle ?? speechStyle;
  const nextCodexBinary = ($("#codex-binary-setting") as HTMLInputElement).value.trim();
  const workspaceChanged = nextWorkspace.id !== workspace.id;
  const speechStyleChanged = nextSpeechStyle !== speechStyle;
  const resumeVoiceAfterSave = speechStyleChanged && Boolean(state.directVoice?.voiceActive || peer);
  const runtimeChanged = workspaceChanged
    || nextPermission !== permissionMode
    || speechStyleChanged
    || nextCodexBinary !== codexBinary;
  let workspaceMigrationNotice: string | null = null;
  if (workspaceChanged) {
    workspaceMigrationNotice = migrateWorkspaceThreadKeys(nextWorkspace);
    localStorage.setItem(WORKSPACE_KEY, nextWorkspace.id);
    workspace = nextWorkspace;
    $("#workspace").textContent = workspace.display;
    ($("#workspace-setting") as HTMLInputElement).value = workspace.display;
    $("#thread-id").textContent = savedThreadId() ?? "Not started";
  }
  if (runtimeChanged) {
    state.manualStop = true;
    try { await reportVoiceEvent("workspaceSwitchRequested"); } catch { /* no voice */ }
    stopLocalTracks();
    try { await invoke("stop_all"); } catch { /* no active runtime */ }
    await invoke("shutdown");
    permissionMode = nextPermission;
    localStorage.setItem(PERMISSION_KEY, permissionMode);
    speechStyle = nextSpeechStyle;
    localStorage.setItem(SPEECH_STYLE_KEY, speechStyle);
    codexBinary = nextCodexBinary;
    if (codexBinary) localStorage.setItem(CODEX_BINARY_KEY, codexBinary);
    else localStorage.removeItem(CODEX_BINARY_KEY);
    try {
      state.settings = await invoke<SettingsDto>("save_settings", {
        request: {
          workspace: nextWorkspace.id,
          threadId: savedThreadId() ?? undefined,
          permissionMode: nextPermission,
          speechStyle: nextSpeechStyle,
          codexPath: nextCodexBinary || null,
          hotkey: ($("#hotkey-setting") as HTMLInputElement).value.trim() || null,
        },
      });
    } catch { /* localStorage 仍作缓存 */ }
    state.session = null;
    state.directVoice = null;
    syncPermissionControls();
    syncSpeechStyleControls();
    setMode("ready");
    response.textContent = `Runtime settings saved (${permissionLabel(permissionMode)} · ${speechStyleLabels[speechStyle]}).`;
    if (workspaceMigrationNotice) response.textContent += ` ${workspaceMigrationNotice}`;
    if (resumeVoiceAfterSave) {
      response.textContent += " 正在使用新的语音风格重连 Voice…";
      await sleep(250);
      await reportVoiceEvent("wakeDetected");
    } else {
      response.textContent += " 下一次任务将在所选目录续接 Codex thread。";
      await armWakeListener();
    }
  } else {
    try {
      state.settings = await invoke<SettingsDto>("save_settings", {
        request: {
          workspace: nextWorkspace.id,
          threadId: savedThreadId() ?? undefined,
          permissionMode: nextPermission,
          speechStyle: nextSpeechStyle,
          codexPath: nextCodexBinary || null,
          hotkey: ($("#hotkey-setting") as HTMLInputElement).value.trim() || null,
        },
      });
      response.textContent = `Runtime settings saved (${permissionLabel(permissionMode)} · ${speechStyleLabels[speechStyle]}).`;
    } catch (error) {
      response.textContent = `保存失败：${String(error)}`;
    }
  }
  settings.close();
});
for (const [selector, approved] of [["#approve", true], ["#deny", false]] as const) {
  $(selector).addEventListener("click", async () => { await invoke("resolve_server_request", { requestId: approvalId, approved }); approval.close(); });
}

if (currentWindow) {
  try {
    const storedWorkspace = localStorage.getItem(WORKSPACE_KEY);
    const backendSettings = await loadBackendSettings();
    workspace = backendSettings?.workspace
      ? await invoke<WorkspaceInfo>("validate_workspace", { cwd: backendSettings.workspace })
      : storedWorkspace
        ? await invoke<WorkspaceInfo>("validate_workspace", { cwd: storedWorkspace })
        : await invoke<WorkspaceInfo>("default_workspace");
    if (backendSettings) {
      if (backendSettings.permissionMode === "safe" || backendSettings.permissionMode === "auto" || backendSettings.permissionMode === "full") {
        permissionMode = backendSettings.permissionMode;
      }
      if (backendSettings.speechStyle === "mandarin" || backendSettings.speechStyle === "shaanxi") {
        speechStyle = backendSettings.speechStyle;
      }
      if (backendSettings.codexBinary) codexBinary = backendSettings.codexBinary;
    }
    const permissionResolution = await invoke<PermissionResolution>("resolve_permission_mode", {
      cwd: workspace.id,
      mode: permissionMode,
      source: "stored-config",
    });
    permissionMode = permissionResolution.mode;
    localStorage.setItem(PERMISSION_KEY, permissionMode);
    const permissionMigrationNotice = permissionResolution.changed
      ? `For safety, the stored permission was reset to Safe for ${workspace.display}.`
      : null;
    const migrationNotice = migrateWorkspaceThreadKeys(workspace);
    localStorage.setItem(WORKSPACE_KEY, workspace.id);
    $("#thread-id").textContent = savedThreadId() ?? "Not started";
    $("#workspace").textContent = workspace.display;
    ($("#workspace-setting") as HTMLInputElement).value = workspace.display;
    ($("#codex-binary-setting") as HTMLInputElement).value = codexBinary;
    syncPermissionControls();
    syncSpeechStyleControls();
    if (permissionMigrationNotice || migrationNotice) {
      response.textContent = [permissionMigrationNotice, migrationNotice].filter(Boolean).join(" ");
    }
    setWorker("orchestrator", "Wake word starting");
    setMode("ready");
    const backgroundStart = await invoke<boolean>("startup_is_background");
    if (!backgroundStart) {
      const microphoneAuthorization = await invoke<string>("request_microphone_permission");
      if (microphoneAuthorization !== "authorized") {
        setMode("degraded");
        banner.hidden = false;
        $("#degraded-copy").textContent =
          "请在系统设置 → 隐私与安全性 → 麦克风中允许 Jarvis Codex。";
      }
    }
    await armWakeListener();
    updateVoiceInfo(await invoke<DirectVoice>("direct_voice_status"));
    applyVoiceState(await invoke<VoiceStateInfo>("voice_state"));
    await showWizardIfNeeded();
    if (await invoke<boolean>("consume_cold_wake")) {
      transcript.textContent = "“嗨，Jarvis”";
    }
  } catch (error) { setMode("stopped"); response.textContent = `启动失败：${String(error)}`; }
} else {
  workspace = {
    id: "Visual preview · native systems disconnected",
    display: "Visual preview · native systems disconnected",
    threadKey: "",
    sourceThreadKey: "",
    legacyThreadKeys: [],
  };
  $("#thread-id").textContent = "Preview only";
  $("#workspace").textContent = workspace.display;
  ($("#workspace-setting") as HTMLInputElement).value = workspace.display;
  ($("#codex-binary-setting") as HTMLInputElement).value = codexBinary;
  $("#wake-auth").textContent = "Preview · not connected";
  $("#voice-auth").textContent = "Preview · not connected";
  transcript.textContent = visualPreviewMode === "stopped" ? "“停下”" : "“嗨，Jarvis”";
  response.textContent = visualPreviewMode === "voice-starting"
    ? "正在从粒子中重构 Jarvis 核心…"
    : visualPreviewMode === "working"
      ? "Codex 正在执行任务，装甲能量切换为工作态。"
      : visualPreviewMode === "speaking"
        ? "语音输出正在驱动角色光效与声波。"
        : visualPreviewMode === "stopped"
          ? "所有任务已中断，等待下一次唤醒。"
          : "Jarvis 视觉系统预览就绪。";
  setMode(visualPreviewMode);
  if (["acknowledge", "approval", "complete", "error"].includes(previewActionValue ?? "")) {
    window.setTimeout(() => triggerCharacterAction(previewActionValue as CharacterAction, 1800), 180);
  }
  setWorker("orchestrator", visualPreviewMode === "working" ? "Codex working" : "Visual preview");
  if (visualPreviewMode === "working") {
    setWorker("developer", "Working");
  }
}

async function armWakeListener() {
  try {
    state.wake = await invoke<WakeStatus>("arm_wake_listener");
    $("#wake-auth").textContent = state.wake.ready ? "Local listener ready" : state.wake.authorization;
    if (["denied", "restricted"].includes(state.wake.authorization)) {
      setMode("degraded");
      banner.hidden = false;
      $("#degraded-copy").textContent = "请在系统设置 → 隐私与安全性中允许麦克风和语音识别。";
    }
  } catch (error) {
    $("#wake-auth").textContent = String(error);
  }
}
