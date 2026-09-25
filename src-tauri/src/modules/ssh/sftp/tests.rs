use super::*;

#[test]
fn refresh_observation_requires_every_authoritative_attribute() {
    let complete = FileObservationV1 {
        kind: FileObservationKindV1::File,
        size: Some(7),
        mode: Some(0o644),
        modified_at: Some(1_000),
    };
    assert!(observation_completely_matches(&complete, &complete));
    let unknown = FileObservationV1 {
        modified_at: None,
        ..complete.clone()
    };
    assert!(!observation_completely_matches(&unknown, &complete));
    assert!(!observation_completely_matches(&complete, &unknown));
}

#[test]
fn refresh_wire_is_camel_case_and_tagged() {
    let value = serde_json::to_value(ReadIfChangedResultV1::Unchanged {
        observation: FileObservationV1 {
            kind: FileObservationKindV1::File,
            size: Some(1),
            mode: Some(0o600),
            modified_at: Some(2),
        },
    })
    .unwrap();
    assert_eq!(value["status"], "unchanged");
    assert_eq!(value["observation"]["modifiedAt"], 2);
}

#[test]
fn refresh_view_deserializes_camel_case_line_limit() {
    let view: super::ReadIfChangedViewV1 =
        serde_json::from_value(serde_json::json!({ "kind": "head", "lineLimit": 500 })).unwrap();
    assert!(matches!(
        view,
        super::ReadIfChangedViewV1::Head { line_limit: 500 }
    ));
}

#[test]
fn remote_directory_mtime_is_normalized_to_epoch_milliseconds() {
    assert_eq!(remote_mtime_millis(1_700_000_000), 1_700_000_000_000);
    assert_eq!(remote_mtime_millis(0), 0);
}
#[test]
fn remote_edit_paths_require_absolute_non_traversing_file_paths() {
    assert!(validate_remote_edit_path("/srv/app/README.md").is_ok());
    assert!(validate_remote_edit_path("/srv/可爱动物/说明 '一'.md").is_ok());
    for invalid in [
        "relative.md",
        "/srv/app/../secret",
        "/",
        "/srv/app/bad\nname",
        "/srv/app/bad\rname",
    ] {
        assert!(
            validate_remote_edit_path(invalid).is_err(),
            "accepted invalid path {invalid:?}"
        );
    }
}

#[test]
fn remote_temp_is_a_hidden_sibling_and_never_the_target() {
    let target = "/srv/app/可爱 animal.md";
    let temporary = remote_sibling_temp_path(target, 3).expect("temp path");
    let second = remote_sibling_temp_path(target, 3).expect("second temp path");
    assert!(temporary.starts_with("/srv/app/.可爱 animal.md.tunara-"));
    assert!(temporary.ends_with("-3.tmp"));
    assert_ne!(temporary, target);
    assert_ne!(temporary, second);
    assert_eq!(Path::new(&temporary).parent(), Path::new(target).parent());
    let nonce = temporary
        .strip_prefix("/srv/app/.可爱 animal.md.tunara-")
        .and_then(|value| value.strip_suffix("-3.tmp"))
        .expect("nonce");
    assert_eq!(nonce.len(), 32);
    assert!(nonce.bytes().all(|byte| byte.is_ascii_hexdigit()));
}
