use super::*;

#[tokio::test]
async fn stalled_ssh_stage_returns_a_named_timeout() {
    let result: Result<(), String> = await_stage(
        "test stage",
        Duration::from_millis(1),
        std::future::pending::<Result<(), &str>>(),
    )
    .await;
    assert!(matches!(result, Err(ref e) if e.contains("test stage timed out")));
}
