//! P0-1 可执行规格：工作区标识规范化与 thread key 唯一入口。
//!
//! 激活前提（`#[doc(hidden)] pub`，见 `tests/contract/README.md`）：
//!
//! ```ignore
//! pub enum Platform { Windows, Unix }
//! pub struct WorkspaceId(..);          impl WorkspaceId { pub fn as_str(&self) -> &str }
//! pub enum WorkspaceError { Empty, NotFound, NotADirectory, Unreadable }
//! pub trait PathProbe {
//!     fn is_dir(&self, path: &str) -> bool;
//!     fn real_path(&self, path: &str) -> Result<String, WorkspaceError>;
//! }
//! pub struct ResolvedWorkspace { pub id: WorkspaceId, pub native_path: String }
//! pub fn normalize_workspace_path(real_path: &str, platform: Platform) -> String;
//! pub fn canonicalize_workspace(input: &str, platform: Platform, probe: &dyn PathProbe)
//!     -> Result<ResolvedWorkspace, WorkspaceError>;
//! pub fn workspace_thread_key(id: &WorkspaceId) -> String;
//! ```
//!
//! 向量来自 `tests/fixtures/workspace-path-vectors.json`。该文件中的 Windows
//! 映射是 2026-08-04 在审查主机上对 `std::fs::canonicalize` 的实测结果，不是假设。

use std::collections::{HashMap, HashSet};

use jarvis_codex_lib::{
    canonicalize_workspace, normalize_workspace_path, workspace_thread_key, PathProbe, Platform,
    WorkspaceError,
};
use serde_json::Value;

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../tests/fixtures/workspace-path-vectors.json"
    );
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("cannot read {path}: {error}"));
    serde_json::from_str(&raw).expect("fixture is not valid JSON")
}

/// 由 fixture 数据驱动的假探测器。使纯逻辑可在任一平台运行，无需真实文件系统。
struct FixtureProbe {
    dirs: HashMap<String, String>,
    files: HashSet<String>,
    platform: Platform,
}

impl FixtureProbe {
    fn new(section: &Value, platform: Platform) -> Self {
        let probe = &section["probe"];
        Self {
            dirs: probe["dirs"]
                .as_object()
                .expect("probe.dirs")
                .iter()
                .map(|(key, value)| (key.clone(), value.as_str().expect("real path").to_owned()))
                .collect(),
            files: probe["files"]
                .as_array()
                .expect("probe.files")
                .iter()
                .map(|value| value.as_str().expect("file path").to_owned())
                .collect(),
            platform,
        }
    }
}

impl PathProbe for FixtureProbe {
    fn is_dir(&self, path: &str) -> bool {
        // real_path 已把输入解析为规范形式，因此这里同时接受原始输入和解析结果。
        self.dirs.contains_key(path) || self.dirs.values().any(|real| real == path)
    }

    fn real_path(&self, path: &str) -> Result<String, WorkspaceError> {
        if let Some(real) = self.dirs.get(path) {
            return Ok(real.clone());
        }
        if self.files.contains(path) {
            // 文件确实存在，解析得到真实路径；是否为目录由 is_dir 判定。
            return Ok(match self.platform {
                Platform::Windows => format!(r"\\?\{path}"),
                Platform::Unix => path.to_owned(),
            });
        }
        Err(WorkspaceError::NotFound)
    }
}

fn sections() -> [(&'static str, Platform); 2] {
    [("windows", Platform::Windows), ("unix", Platform::Unix)]
}

#[test]
fn pure_layer_normalizes_every_measured_vector() {
    let data = fixture();
    for (key, platform) in sections() {
        for vector in data[key]["normalize"].as_array().expect("normalize") {
            let real = vector["realPath"].as_str().expect("realPath");
            let expected = vector["expected"].as_str().expect("expected");
            let name = vector["name"].as_str().unwrap_or("<unnamed>");
            assert_eq!(
                normalize_workspace_path(real, platform),
                expected,
                "[{key}] {name}: normalize({real:?})"
            );
        }
    }
}

#[test]
fn pure_layer_is_idempotent() {
    let data = fixture();
    for (key, platform) in sections() {
        for vector in data[key]["normalize"].as_array().expect("normalize") {
            let real = vector["realPath"].as_str().expect("realPath");
            let once = normalize_workspace_path(real, platform);
            let twice = normalize_workspace_path(&once, platform);
            assert_eq!(twice, once, "[{key}] f(f(x)) != f(x) for {real:?}");
        }
    }
}

#[test]
fn every_spelling_in_an_equivalence_class_yields_one_id() {
    let data = fixture();
    for (key, platform) in sections() {
        let probe = FixtureProbe::new(&data[key], platform);
        for class in data[key]["equivalence"].as_array().expect("equivalence") {
            let expected = class["expectedId"].as_str().expect("expectedId");
            let name = class["name"].as_str().unwrap_or("<unnamed>");
            for input in class["inputs"].as_array().expect("inputs") {
                let input = input.as_str().expect("input");
                let resolved = canonicalize_workspace(input, platform, &probe)
                    .unwrap_or_else(|error| panic!("[{key}] {name}: {input:?} -> {error:?}"));
                assert_eq!(
                    resolved.id.as_str(),
                    expected,
                    "[{key}] {name}: canonicalize({input:?})"
                );
            }
        }
    }
}

#[test]
fn entry_layer_is_idempotent_through_its_own_output() {
    // 关键回归：P0-1 的成因正是"规范化结果再次进入入口时不等价"。
    let data = fixture();
    for (key, platform) in sections() {
        let probe = FixtureProbe::new(&data[key], platform);
        for class in data[key]["equivalence"].as_array().expect("equivalence") {
            for input in class["inputs"].as_array().expect("inputs") {
                let input = input.as_str().expect("input");
                let once = canonicalize_workspace(input, platform, &probe).expect("first pass");
                let twice = canonicalize_workspace(once.id.as_str(), platform, &probe)
                    .expect("feeding the id back in must succeed");
                assert_eq!(
                    twice.id.as_str(),
                    once.id.as_str(),
                    "[{key}] canonicalize(canonicalize({input:?}).id) diverged"
                );
            }
        }
    }
}

#[test]
fn distinct_directories_never_collapse() {
    let data = fixture();
    for (key, platform) in sections() {
        let probe = FixtureProbe::new(&data[key], platform);
        for pair in data[key]["mustNotEqual"].as_array().expect("mustNotEqual") {
            let left = pair["left"].as_str().expect("left");
            let right = pair["right"].as_str().expect("right");
            let name = pair["name"].as_str().unwrap_or("<unnamed>");
            let left = canonicalize_workspace(left, platform, &probe).expect("left resolves");
            let right = canonicalize_workspace(right, platform, &probe).expect("right resolves");
            assert_ne!(
                left.id.as_str(),
                right.id.as_str(),
                "[{key}] {name}: distinct directories collapsed to one id"
            );
        }
    }
}

#[test]
fn errors_are_structured_and_never_fall_back_to_a_default() {
    let data = fixture();
    for (key, platform) in sections() {
        let probe = FixtureProbe::new(&data[key], platform);
        for case in data[key]["errors"].as_array().expect("errors") {
            let input = case["input"].as_str().expect("input");
            let expected = case["expected"].as_str().expect("expected");
            let name = case["name"].as_str().unwrap_or("<unnamed>");
            let actual = canonicalize_workspace(input, platform, &probe);
            let actual = actual.expect_err(&format!(
                "[{key}] {name}: {input:?} must fail, not resolve to a fallback directory"
            ));
            let actual = match actual {
                WorkspaceError::Empty => "Empty",
                WorkspaceError::NotFound => "NotFound",
                WorkspaceError::NotADirectory => "NotADirectory",
                WorkspaceError::Unreadable => "Unreadable",
            };
            assert_eq!(actual, expected, "[{key}] {name}: wrong error variant");
        }
    }
}

#[test]
fn the_extended_length_prefix_never_escapes_into_an_id() {
    // 决定 1：`\\?\` 只允许存在于 ResolvedWorkspace::native_path。
    let data = fixture();
    let platform = Platform::Windows;
    let probe = FixtureProbe::new(&data["windows"], platform);
    for class in data["windows"]["equivalence"].as_array().expect("equivalence") {
        for input in class["inputs"].as_array().expect("inputs") {
            let input = input.as_str().expect("input");
            let resolved = canonicalize_workspace(input, platform, &probe).expect("resolves");
            let id = resolved.id.as_str();
            assert!(
                !id.starts_with(r"\\?\"),
                "id {id:?} leaked the extended-length prefix (from input {input:?})"
            );
            assert!(
                !id.contains(r"\\?\UNC\"),
                "id {id:?} leaked the verbatim UNC prefix"
            );
            assert!(
                !workspace_thread_key(&resolved.id).contains(r"\\?\"),
                "thread key for {id:?} leaked the extended-length prefix"
            );
        }
    }
}

#[test]
fn native_path_may_keep_the_extended_prefix() {
    // 反向约束：native_path 是允许保留 `\\?\` 的唯一位置，但它不得等于 id。
    let data = fixture();
    let platform = Platform::Windows;
    let probe = FixtureProbe::new(&data["windows"], platform);
    let resolved = canonicalize_workspace(r"C:\Users\DELL", platform, &probe).expect("resolves");
    assert_eq!(resolved.id.as_str(), r"C:\Users\DELL");
    assert!(
        resolved.native_path.starts_with(r"\\?\"),
        "native_path {:?} should retain the OS form for Jarvis's own IO",
        resolved.native_path
    );
}

#[test]
fn thread_key_is_a_pure_function_of_the_id() {
    // P0-1 的直接回归：同一目录的不同写法必须产出同一个 thread key，
    // 否则一次"保存"就会把历史线程孤立。
    let data = fixture();
    for (key, platform) in sections() {
        let probe = FixtureProbe::new(&data[key], platform);
        for class in data[key]["equivalence"].as_array().expect("equivalence") {
            let mut keys = class["inputs"]
                .as_array()
                .expect("inputs")
                .iter()
                .map(|input| {
                    let input = input.as_str().expect("input");
                    let resolved =
                        canonicalize_workspace(input, platform, &probe).expect("resolves");
                    workspace_thread_key(&resolved.id)
                })
                .collect::<Vec<_>>();
            keys.dedup();
            assert_eq!(
                keys.len(),
                1,
                "[{key}] one directory produced {} distinct thread keys: {keys:?}",
                keys.len()
            );
        }
    }
}

#[test]
fn unix_does_not_apply_windows_path_rules() {
    let platform = Platform::Unix;
    assert_eq!(
        normalize_workspace_path(r"/home/us\er", platform),
        r"/home/us\er",
        "a backslash is an ordinary filename character on unix"
    );
    assert_ne!(
        normalize_workspace_path("/home/user", platform),
        normalize_workspace_path("/home/User", platform),
        "unix paths are case sensitive"
    );
}
