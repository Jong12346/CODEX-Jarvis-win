use jarvis_codex_lib::missing_thread_rollout;

#[test]
fn missing_rollout_is_a_permanent_resume_failure() {
    assert!(missing_thread_rollout(
        "no rollout found for thread id 019fd603-5ae3-7af0-95d8-d00ee7eff805"
    ));
}

#[test]
fn missing_rollout_matching_is_case_insensitive() {
    assert!(missing_thread_rollout(
        "No Rollout Found For Thread Id stale-thread"
    ));
}

#[test]
fn transient_and_permission_errors_do_not_replace_the_thread() {
    assert!(!missing_thread_rollout("request timed out"));
    assert!(!missing_thread_rollout("permission denied"));
    assert!(!missing_thread_rollout("Codex is not logged in"));
}
