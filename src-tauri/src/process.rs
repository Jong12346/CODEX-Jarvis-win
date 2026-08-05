use std::{ffi::OsString, path::PathBuf, process::Stdio, sync::Mutex as StdMutex};

use tokio::{
    io::{AsyncRead, AsyncWrite},
    process::{Child, Command},
};

#[doc(hidden)]
#[derive(Clone, Debug)]
pub struct ProcessSpec {
    pub binary: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    pub creation_flags: u32,
}

#[doc(hidden)]
pub trait ProcessSpawner: Send + Sync {
    fn spawn(&self, spec: ProcessSpec) -> Result<SpawnedCodexProcess, String>;
}

#[doc(hidden)]
pub struct SpawnedCodexProcess {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub stderr: Box<dyn AsyncRead + Send + Unpin>,
    pub control: Box<dyn ProcessControl>,
}

#[doc(hidden)]
pub trait ProcessControl: Send + Sync {
    fn pid(&self) -> Option<u32>;
    fn try_wait(&self) -> Result<Option<i32>, String>;
    fn start_kill(&self) -> Result<(), String>;
}

pub(crate) struct SystemProcessSpawner;

impl ProcessSpawner for SystemProcessSpawner {
    fn spawn(&self, spec: ProcessSpec) -> Result<SpawnedCodexProcess, String> {
        let mut command = Command::new(&spec.binary);
        command
            .args(spec.args)
            .envs(spec.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(target_os = "windows")]
        {
            command.creation_flags(spec.creation_flags);
            super::apply_windows_proxy(&mut command);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 codex app-server：{error}"))?;

        #[cfg(target_os = "windows")]
        let job = match WindowsJob::create_and_assign(&child) {
            Ok(job) => Some(job),
            Err(error) => {
                let _ = child.start_kill();
                return Err(error);
            }
        };

        let stdin = child.stdin.take().ok_or("无法连接 Codex stdin")?;
        let stdout = child.stdout.take().ok_or("无法连接 Codex stdout")?;
        let stderr = child.stderr.take().ok_or("无法连接 Codex stderr")?;
        let control = TokioProcessControl {
            pid: child.id(),
            child: StdMutex::new(child),
            #[cfg(target_os = "windows")]
            _job: job,
        };
        Ok(SpawnedCodexProcess {
            stdin: Box::new(stdin),
            stdout: Box::new(stdout),
            stderr: Box::new(stderr),
            control: Box::new(control),
        })
    }
}

struct TokioProcessControl {
    pid: Option<u32>,
    child: StdMutex<Child>,
    #[cfg(target_os = "windows")]
    _job: Option<WindowsJob>,
}

impl ProcessControl for TokioProcessControl {
    fn pid(&self) -> Option<u32> {
        self.pid
    }

    fn try_wait(&self) -> Result<Option<i32>, String> {
        self.child
            .lock()
            .map_err(|_| "Codex 进程控制锁已损坏".to_owned())?
            .try_wait()
            .map(|status| status.and_then(|value| value.code()))
            .map_err(|error| error.to_string())
    }

    fn start_kill(&self) -> Result<(), String> {
        self.child
            .lock()
            .map_err(|_| "Codex 进程控制锁已损坏".to_owned())?
            .start_kill()
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "windows")]
struct WindowsJob {
    handle: windows::Win32::Foundation::HANDLE,
}

#[cfg(target_os = "windows")]
unsafe impl Send for WindowsJob {}

#[cfg(target_os = "windows")]
unsafe impl Sync for WindowsJob {}

#[cfg(target_os = "windows")]
impl WindowsJob {
    fn create_and_assign(child: &Child) -> Result<Self, String> {
        use std::mem::size_of;
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::HANDLE,
                System::JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
            },
        };

        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
            .map_err(|error| format!("无法创建 Codex Job Object：{error}"))?;
        let job = Self { handle };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.handle,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|error| format!("无法配置 Codex Job Object：{error}"))?;
            let raw_handle = child
                .raw_handle()
                .ok_or_else(|| "Codex 在加入 Job Object 前已退出".to_owned())?;
            AssignProcessToJobObject(job.handle, HANDLE(raw_handle))
                .map_err(|error| format!("无法把 Codex 加入 Job Object：{error}"))?;
        }
        Ok(job)
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsJob {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}
