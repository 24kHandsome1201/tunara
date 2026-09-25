use std::fs;
use std::path::Path;

use super::effective::{expand_value, CanonicalLookup, EffectiveConfig};
use super::import::{
    literal_jump_profile, parse_ssh_config, resolve_config, resolve_config_with_lookup,
};
use super::patterns::{glob_match, ssh_pattern_match, PATTERN_MAX_OPERATIONS};
use super::profile::SshHostProfile;
use super::resolver::{ssh_config_tokens, ConfigResolver, LocatedDirective, ResolverLimits};
use super::temp_path;
use crate::modules::ssh::auth::AuthMethod;

#[test]
fn parse_ssh_config_static_hosts_with_hostnames() {
    let raw = "\
Host prod
  HostName prod.example.com
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_prod

Host dev
  HostName 10.0.0.5
  User root
";
    let result = parse_ssh_config(raw);
    assert_eq!(result.imported.len(), 2);
    assert_eq!(result.skipped, 0);

    let prod = result
        .imported
        .iter()
        .find(|p| p.id == "ssh-config-prod")
        .unwrap();
    assert_eq!(prod.host, "prod.example.com");
    assert_eq!(prod.user, "deploy");
    assert_eq!(prod.port, 2222);
    assert_eq!(prod.identity_file, "~/.ssh/id_prod");
    assert_eq!(prod.auth_method, Some(AuthMethod::Key));
    assert_eq!(prod.label, "prod");

    let dev = result
        .imported
        .iter()
        .find(|p| p.id == "ssh-config-dev")
        .unwrap();
    assert_eq!(dev.host, "10.0.0.5");
    assert_eq!(dev.user, "root");
    assert_eq!(dev.port, 22); // absent → default
    assert_eq!(dev.auth_method, None);
}

#[test]
fn parse_ssh_config_hostname_defaults_to_alias() {
    let raw = "Host mybox\n  User alice\n";
    let result = parse_ssh_config(raw);
    assert_eq!(result.imported.len(), 1);
    // No HostName → host is the alias itself (openssh semantics).
    assert_eq!(result.imported[0].host, "mybox");
    assert_eq!(result.imported[0].label, "mybox");
}

#[test]
fn parse_ssh_config_applies_host_patterns_and_match() {
    let raw = "\
Host *
  User wildcard

Host real
  HostName real.example.com

Match host *.internal
  User matchuser

Host another
  HostName another.example.com
";
    let result = parse_ssh_config(raw);
    assert_eq!(result.imported.len(), 2);
    assert!(result
        .imported
        .iter()
        .all(|profile| profile.user == "wildcard"));
}

#[test]
fn parse_ssh_config_multi_alias_host_block() {
    let raw = "\
Host alpha beta
  HostName shared.example.com
  User shared
";
    let result = parse_ssh_config(raw);
    assert_eq!(result.imported.len(), 2);
    for p in &result.imported {
        assert_eq!(p.host, "shared.example.com");
        assert_eq!(p.user, "shared");
    }
}

#[test]
fn parse_ssh_config_malformed_port_fails_closed() {
    let raw = "Host badport\n  HostName x\n  Port notanumber\n";
    let result = parse_ssh_config(raw);
    assert!(result.imported.is_empty());
    assert_eq!(result.diagnostics[0].alias, "badport");
    assert_eq!(result.diagnostics[0].line, 3);
    assert_eq!(result.diagnostics[0].code, "invalid_port");
    assert_eq!(result.diagnostics[0].directive, "Port");
}

#[test]
fn parse_ssh_config_ignores_comments_and_include() {
    let raw = "\
# This is a comment
Include ~/.ssh/conf.d/*

Host real
  HostName real.example.com
  # inline comment after Host
  User real
";
    let result = parse_ssh_config(raw);
    assert!(result.imported.is_empty());
    // Include may change first-value resolution for every alias and must
    // not be flattened into an apparently direct profile.
    assert_eq!(result.skipped, 1);
    assert!(result.diagnostics[0].source.ends_with("/config"));
    assert_eq!(result.diagnostics[0].line, 2);
    assert_eq!(result.diagnostics[0].alias, "real");
    assert_eq!(result.diagnostics[0].code, "include_no_matches");
    assert_eq!(result.diagnostics[0].directive, "Include");
}

#[test]
fn parse_ssh_config_skips_hosts_with_unsupported_connection_semantics() {
    let raw = "\
Host direct
  HostName direct.example.com
  User deploy

Host bastion-only
  HostName private.example.com
  ProxyJump jump.example.com
  User deploy

Host aliased-key
  HostName host.example.com
  HostKeyAlias canonical.example.com
";
    let result = parse_ssh_config(raw);
    assert_eq!(result.imported.len(), 1);
    assert_eq!(result.imported[0].label, "direct");
    assert_eq!(result.skipped, 2);
}

#[test]
fn parse_ssh_config_handles_inline_comments_quotes_and_equals() {
    let raw = r#"
Host="quoted host" other # two aliases, not a comment in quotes
  HostName = real.example.com # trailing comment
  User "deploy_user"
  IdentityFile "~/.ssh/id with spaces"
"#;
    let result = parse_ssh_config(raw);
    assert_eq!(result.imported.len(), 2);
    let quoted = result
        .imported
        .iter()
        .find(|profile| profile.label == "quoted host")
        .expect("quoted alias imported");
    assert_eq!(quoted.host, "real.example.com");
    assert_eq!(quoted.user, "deploy_user");
    assert_eq!(quoted.identity_file, "~/.ssh/id with spaces");
}

#[test]
fn tokenizer_preserves_mid_token_comments_unknown_escapes_and_equals_separator() {
    assert_eq!(
        ssh_config_tokens("HostName foo#bar # comment").unwrap(),
        vec!["HostName", "foo#bar"]
    );
    assert_eq!(
        ssh_config_tokens(r"IdentityFile ~/.ssh/id\q").unwrap(),
        vec!["IdentityFile", r"~/.ssh/id\q"]
    );
    let separated = parse_ssh_config("Host target\n  HostName =target.example\n");
    assert_eq!(separated.imported[0].host, "target.example");
}

#[test]
fn parse_ssh_config_skips_unfinished_quoted_lines() {
    let result = parse_ssh_config("Host good\n  HostName good.example\nHost \"broken\n");
    assert!(result.imported.is_empty());
    assert_eq!(result.skipped, 1);
    assert_eq!(result.diagnostics[0].alias, "good");
    assert_eq!(result.diagnostics[0].line, 3);
}

#[test]
fn parse_ssh_config_resolves_safe_single_hop_alias() {
    let result = parse_ssh_config(
        "Host jump\n  HostName jump.example\n  User ops\n\nHost target\n  HostName private.example\n  ProxyJump jump\n",
    );
    assert_eq!(result.skipped, 0);
    assert_eq!(result.imported.len(), 2);
    let target = result
        .imported
        .iter()
        .find(|profile| profile.label == "target")
        .unwrap();
    assert_eq!(target.proxy_jump_profile_id, "ssh-config-jump");
}

#[test]
fn parse_ssh_config_creates_deterministic_literal_jump_profile() {
    let raw = "Host target\n  HostName private.example\n  ProxyJump ops@jump.example:2222\n";
    let first = parse_ssh_config(raw);
    let second = parse_ssh_config(raw);
    assert_eq!(first.skipped, 0);
    assert_eq!(first.imported.len(), 2);
    let target = first
        .imported
        .iter()
        .find(|profile| profile.label == "target")
        .unwrap();
    let jump = first
        .imported
        .iter()
        .find(|profile| profile.id == target.proxy_jump_profile_id)
        .unwrap();
    assert_eq!(jump.host, "jump.example");
    assert_eq!(jump.port, 2222);
    assert_eq!(jump.user, "ops");
    assert_eq!(first.imported[0].id, second.imported[0].id);
}

#[test]
fn parse_ssh_config_rejects_multi_hop_chain_and_cycle_per_alias() {
    let result = parse_ssh_config(
        "Host a\n  ProxyJump b\nHost b\n  ProxyJump a\nHost many\n  ProxyJump a,b\n",
    );
    assert!(result.imported.is_empty());
    assert!(result
        .diagnostics
        .iter()
        .any(|item| item.alias == "a" && item.code == "proxy_jump_chain_unsupported"));
    assert!(result
        .diagnostics
        .iter()
        .any(|item| item.alias == "b" && item.code == "proxy_jump_chain_unsupported"));
    assert!(result
        .diagnostics
        .iter()
        .any(|item| item.alias == "many" && item.code == "proxy_jump_multi_hop"));
}

#[test]
fn parse_ssh_config_rejects_global_unknown_and_token_semantics() {
    let global = parse_ssh_config("User global\nHost target\n  HostName target.example\n");
    assert_eq!(global.imported[0].user, "global");

    let token = parse_ssh_config("Host target\n  HostName %n.example\n");
    assert!(token.imported.is_empty());
    assert_eq!(
        token.diagnostics[0].code,
        "hostname_percent_token_unsupported"
    );
}

#[test]
fn parse_ssh_config_keeps_first_scalar_and_rejects_additive_identity() {
    let scalar =
        parse_ssh_config("Host target\n  HostName first.example\n  HostName second.example\n");
    assert_eq!(scalar.imported[0].host, "first.example");

    let identities =
        parse_ssh_config("Host target\n  IdentityFile ~/.ssh/one\n  IdentityFile ~/.ssh/two\n");
    assert!(identities.imported.is_empty());
    assert_eq!(
        identities.diagnostics[0].code,
        "multiple_identity_files_unsupported"
    );
}

#[test]
fn parse_ssh_config_imports_certificate_with_private_key() {
    let result = parse_ssh_config(
        "Host certified\n  HostName certified.example\n  IdentityFile ~/.ssh/id_ed25519\n  CertificateFile ~/.ssh/id_ed25519-cert.pub\n",
    );
    assert_eq!(result.skipped, 0);
    assert_eq!(result.imported.len(), 1);
    assert_eq!(result.imported[0].auth_method, Some(AuthMethod::Key));
    assert_eq!(result.imported[0].identity_file, "~/.ssh/id_ed25519");
    assert_eq!(
        result.imported[0].certificate_file,
        "~/.ssh/id_ed25519-cert.pub"
    );
}

#[test]
fn parse_ssh_config_rejects_certificate_without_private_key() {
    let result = parse_ssh_config(
        "Host certified\n  HostName certified.example\n  CertificateFile ~/.ssh/id_ed25519-cert.pub\n",
    );
    assert!(result.imported.is_empty());
    assert_eq!(result.skipped, 1);
    assert!(result.diagnostics[0].source.ends_with("/config"));
    assert_eq!(result.diagnostics[0].line, 3);
    assert_eq!(result.diagnostics[0].alias, "certified");
    assert_eq!(
        result.diagnostics[0].code,
        "certificate_requires_identity_file"
    );
    assert_eq!(result.diagnostics[0].directive, "CertificateFile");
}

#[test]
fn parse_ssh_config_rejects_multiple_certificate_files() {
    let result = parse_ssh_config(
        "Host certified\n  IdentityFile ~/.ssh/id_ed25519\n  CertificateFile ~/.ssh/one-cert.pub\n  CertificateFile ~/.ssh/two-cert.pub\n",
    );
    assert!(result.imported.is_empty());
    assert_eq!(result.diagnostics[0].line, 4);
    assert_eq!(
        result.diagnostics[0].code,
        "multiple_certificate_files_unsupported"
    );
    assert_eq!(result.diagnostics[0].directive, "CertificateFile");
}

#[test]
fn parse_ssh_config_rejects_dangling_or_ambiguous_jump_profiles() {
    let invalid = parse_ssh_config("Host jump\n  Port bad\nHost target\n  ProxyJump jump\n");
    assert!(invalid.imported.is_empty());
    assert!(invalid
        .diagnostics
        .iter()
        .any(|item| item.alias == "target" && item.code == "proxy_jump_invalid_alias"));

    assert!(literal_jump_profile("user@host:22:33").is_none());
    let parsed = literal_jump_profile("a@b@host:22").unwrap();
    assert_eq!(parsed.user, "a@b");
    assert_eq!(parsed.host, "host");
}

#[test]
fn resolver_expands_includes_in_order_with_provenance_and_bounds() {
    let root = temp_path("includes").parent().unwrap().to_path_buf();
    fs::create_dir_all(root.join("conf.d")).unwrap();
    fs::write(root.join("config"), "Include conf.d/*\n").unwrap();
    fs::write(root.join("conf.d/20-b"), "Host target\n  User second\n").unwrap();
    fs::write(root.join("conf.d/10-a"), "Host target\n  User first\n").unwrap();
    let result = resolve_config(
        &root.join("config"),
        &root,
        "test-user",
        &[],
        ResolverLimits::default(),
    );
    assert_eq!(result.imported[0].user, "first");

    fs::write(root.join("conf.d/10-a"), "Include config\nHost target\n").unwrap();
    let cycle = resolve_config(
        &root.join("config"),
        &root,
        "test-user",
        &[],
        ResolverLimits::default(),
    );
    assert_eq!(cycle.diagnostics[0].code, "include_cycle");
    assert!(cycle.diagnostics[0].source.ends_with("/conf.d/10-a"));
    assert_eq!(cycle.diagnostics[0].line, 1);
    assert_eq!(cycle.diagnostics[0].directive, "Include");

    fs::write(root.join("config"), "Host target\nInclude conf.d/*\n").unwrap();
    let limited = resolve_config(
        &root.join("config"),
        &root,
        "test-user",
        &[],
        ResolverLimits {
            depth: 8,
            files: 1,
            bytes: 1024,
            ..ResolverLimits::default()
        },
    );
    assert_eq!(limited.diagnostics[0].code, "include_file_limit");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn literal_include_paths_and_failed_utf8_reads_consume_budgets() {
    let root = temp_path("include-accounting")
        .parent()
        .unwrap()
        .to_path_buf();
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("one"), "").unwrap();
    fs::write(root.join("two"), "").unwrap();
    fs::write(root.join("config"), "Include one two\nHost target\n").unwrap();
    let paths = resolve_config(
        &root.join("config"),
        &root,
        "local-user",
        &[],
        ResolverLimits {
            expanded_paths: 1,
            ..ResolverLimits::default()
        },
    );
    assert!(paths.imported.is_empty());
    assert!(paths
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "include_expanded_path_limit"));

    fs::write(root.join("bad-one"), [0xff, 0xff, 0xff, 0xff]).unwrap();
    fs::write(root.join("bad-two"), [0xff, 0xff, 0xff, 0xff]).unwrap();
    let root_config = "Include bad-one bad-two\nHost target\n";
    let config_path = root.join("config");
    fs::write(&config_path, root_config).unwrap();
    let mut resolver = ConfigResolver::new(
        &config_path,
        &root,
        ResolverLimits {
            bytes: root_config.len() + 6,
            ..ResolverLimits::default()
        },
    )
    .unwrap();
    resolver.parse_file(&config_path, 0, None, Vec::new());
    assert_eq!(resolver.bytes, root_config.len() + 4);
    assert!(resolver
        .blocks
        .iter()
        .flat_map(|block| &block.hazards)
        .any(|(_, code)| code == "include_byte_limit"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn patterns_matches_and_unsafe_active_blocks_fail_closed() {
    let result = parse_ssh_config(
        "Host * !blocked\n  User common\nHost blocked good\n  HostName %h.example\nMatch originalhost good\n  Port 2222\nHost never\n  ProxyCommand dangerous\n",
    );
    let good = result.imported.iter().find(|p| p.label == "good").unwrap();
    assert_eq!(good.host, "good.example");
    assert_eq!(good.user, "common");
    assert_eq!(good.port, 2222);
    assert!(result
        .imported
        .iter()
        .any(|p| p.label == "blocked" && p.user.is_empty()));
    assert!(result
        .diagnostics
        .iter()
        .any(|d| d.alias == "never" && d.directive == "ProxyCommand"));

    let exec = parse_ssh_config("Host target\nMatch exec true\n  User unsafe\n");
    assert_eq!(exec.diagnostics[0].code, "match_exec_unsupported");
    assert_eq!(exec.diagnostics[0].line, 2);
}

#[test]
fn inactive_include_and_unsafe_blocks_do_not_poison_other_aliases() {
    let result = parse_ssh_config(
        "Host missing\n  Include does-not-exist\n  ProxyCommand dangerous\nHost safe\n  HostName safe.example\nMatch originalhost absent exec dangerous\n  User unsafe\n",
    );
    let safe = result.imported.iter().find(|p| p.label == "safe").unwrap();
    assert_eq!(safe.host, "safe.example");
    assert!(result.diagnostics.iter().all(|d| d.alias != "safe"));
    assert!(result
        .diagnostics
        .iter()
        .any(|d| d.alias == "missing" && d.code == "include_read_failed"));

    let dynamic = parse_ssh_config("Host target\n  Include conf/%h\n");
    assert_eq!(
        dynamic.diagnostics[0].code,
        "include_dynamic_expansion_unsupported"
    );
    let matched =
        parse_ssh_config("Host target\nMatch originalhost target\n  Include conf/target\n");
    assert_eq!(
        matched.diagnostics[0].code,
        "include_match_context_unsupported"
    );
}

#[test]
fn ssh_patterns_treat_brackets_literally_and_include_globs_do_not() {
    assert!(ssh_pattern_match("web[0-9]", "web[0-9]", false).unwrap());
    assert!(!ssh_pattern_match("web[0-9]", "web7", false).unwrap());
    assert!(ssh_pattern_match("WEB?", "web7", false).unwrap());
    assert!(glob_match("web[0-9]", "web7").unwrap());
    assert!(!glob_match("WEB[a-c]", "webB").unwrap());
}

#[test]
fn pattern_evaluation_is_bounded_and_fails_the_import_closed() {
    let patterns = std::iter::repeat_n("no-match", PATTERN_MAX_OPERATIONS)
        .collect::<Vec<_>>()
        .join(" ");
    let result = parse_ssh_config(&format!(
        "Host target\n  HostName target.example\nHost {patterns}\n"
    ));
    assert!(result.imported.is_empty());
    assert!(result
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "pattern_operation_limit"));

    assert_eq!(
        glob_match(&format!("[{}]", "a".repeat(PATTERN_MAX_OPERATIONS)), "a").unwrap_err(),
        "include_pattern_operation_limit"
    );
}

#[test]
fn safe_tokens_expand_and_unknown_or_environment_tokens_reject() {
    let safe = parse_ssh_config(
        "Host box\n  User alice\n  Port 2200\n  IdentityFile ~/.ssh/%n-%r-%p-%%\n",
    );
    assert_eq!(safe.imported[0].identity_file, "~/.ssh/box-alice-2200-%");
    for value in ["$HOME/key", "%x"] {
        let result = parse_ssh_config(&format!("Host box\n  IdentityFile {value}\n"));
        assert!(result.imported.is_empty());
    }

    let alias = "a".repeat(600);
    let host = parse_ssh_config(&format!("Host {alias}\n  HostName %h%h\n"));
    assert!(host.imported.is_empty());
    assert_eq!(host.diagnostics[0].code, "expanded_value_too_long");

    let effective = EffectiveConfig {
        host_name: Some((
            "h".repeat(1_024),
            LocatedDirective {
                source: "test".into(),
                line: 1,
                key: "HostName".into(),
                values: Vec::new(),
            },
        )),
        ..EffectiveConfig::default()
    };
    assert_eq!(
        expand_value("%h%h%h%h%h", "box", &effective, Path::new("~"), "local").unwrap_err(),
        "expanded_value_too_long"
    );
}

#[test]
fn include_restores_outer_selector_and_anchors_nested_relative_paths() {
    let root = temp_path("include-scope").parent().unwrap().to_path_buf();
    fs::create_dir_all(root.join("conf.d")).unwrap();
    fs::write(
        root.join("config"),
        "Host target\n  Include conf.d/fragment\n  User outer\nHost *\n  Include conf.d/nested\n",
    )
    .unwrap();
    fs::write(
        root.join("conf.d/fragment"),
        "Host child\n  User child-user\n",
    )
    .unwrap();
    fs::write(root.join("conf.d/nested"), "Include shared\n").unwrap();
    fs::write(root.join("shared"), "Host shared\n  User shared-user\n").unwrap();

    let result = resolve_config(
        &root.join("config"),
        &root,
        "local-user",
        &[],
        ResolverLimits::default(),
    );
    let target = result
        .imported
        .iter()
        .find(|profile| profile.label == "target")
        .unwrap();
    assert_eq!(target.user, "outer");
    assert!(!result
        .imported
        .iter()
        .any(|profile| profile.label == "child"));
    assert!(result
        .imported
        .iter()
        .any(|profile| profile.label == "shared" && profile.user == "shared-user"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn match_observes_expanded_hostname_and_supports_final_phase() {
    let matched = parse_ssh_config(
        "Host box\n  HostName %h.example\nMatch host box.example\n  User matched\n",
    );
    assert_eq!(matched.imported[0].host, "box.example");
    assert_eq!(matched.imported[0].user, "matched");

    let user_tilde = parse_ssh_config("Host box\n  User ~\n");
    assert_eq!(user_tilde.diagnostics[0].code, "user_expansion_unsupported");

    let final_phase =
        parse_ssh_config("Host box\nMatch final\n  User unsafe\nMatch canonical\n  Port 2202\n");
    assert_eq!(final_phase.imported[0].user, "unsafe");
    assert_eq!(final_phase.imported[0].port, 2202);

    let final_hostname = parse_ssh_config(
        "CanonicalizeHostname no\nHost box\nMatch final\n  HostName evil.example\n",
    );
    assert_eq!(final_hostname.imported[0].host, "box");

    for selector in ["Match host final", "Match !final"] {
        let no_reparse = parse_ssh_config(&format!(
            "Host box\n  HostName renamed\nHost renamed\n  Port 2202\n{selector}\n"
        ));
        let profile = no_reparse
            .imported
            .iter()
            .find(|profile| profile.label == "box")
            .unwrap();
        assert_eq!(profile.port, 22);
    }

    let empty = parse_ssh_config("Host box\nMatch\n  HostName unsafe.example\n");
    assert!(empty.imported.is_empty());
    assert_eq!(empty.diagnostics[0].code, "match_invalid_arguments");

    for invalid_match in [
        "Match host box final all",
        "Match host box originalhost box all",
    ] {
        let invalid = parse_ssh_config(&format!("Host box\n{invalid_match}\n  User attacker\n"));
        assert!(invalid.imported.is_empty());
        assert!(invalid
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "match_invalid_arguments"));
    }

    assert_eq!(
        expand_value(
            "%u",
            "box",
            &EffectiveConfig::default(),
            Path::new("~"),
            "local%user",
        )
        .unwrap(),
        "local%user"
    );
}

#[test]
fn canonicalization_reparses_with_first_value_semantics() {
    let root = temp_path("canonical-two-pass")
        .parent()
        .unwrap()
        .to_path_buf();
    fs::create_dir_all(&root).unwrap();
    let config_path = root.join("config");
    fs::write(
        &config_path,
        "CanonicalizeHostname yes\nCanonicalDomains example.com\nCanonicalizeFallbackLocal no\nCanonicalizeMaxDots 1\nCanonicalizePermittedCNAMEs none\nHost box\n  User first\nHost box.example.com\n  Port 2201\nMatch canonical host box.example.com\n  IdentityFile ~/.ssh/canonical\n  User second\nMatch final\n  CertificateFile ~/.ssh/canonical-cert.pub\n",
    )
    .unwrap();
    let result = resolve_config_with_lookup(
        &config_path,
        &root,
        "local-user",
        &[],
        ResolverLimits::default(),
        &|host| {
            Ok((host == "box.example.com.").then(|| CanonicalLookup {
                canonical_name: Some("box.example.com".into()),
            }))
        },
    );
    let profile = result
        .imported
        .iter()
        .find(|profile| profile.label == "box")
        .unwrap_or_else(|| panic!("canonical import failed: {:?}", result.diagnostics));
    assert_eq!(profile.host, "box.example.com");
    assert_eq!(profile.user, "first");
    assert_eq!(profile.port, 2201);
    assert_eq!(
        profile.identity_file,
        root.join(".ssh/canonical").display().to_string()
    );
    assert_eq!(
        profile.certificate_file,
        root.join(".ssh/canonical-cert.pub").display().to_string()
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn canonicalization_skip_fallback_and_cname_boundaries_fail_closed() {
    let max_dots = parse_ssh_config(
        "CanonicalizeHostname yes\nCanonicalDomains invalid\nCanonicalizeFallbackLocal no\nCanonicalizeMaxDots 0\nHost box.example\nMatch canonical\n  User canonical\n",
    );
    let profile = max_dots
        .imported
        .iter()
        .find(|profile| profile.label == "box.example")
        .unwrap();
    assert_eq!(profile.host, "box.example");
    assert_eq!(profile.user, "canonical");

    let fallback = parse_ssh_config(
        "CanonicalizeHostname yes\nCanonicalDomains invalid\nCanonicalizeFallbackLocal no\nHost definitely-not-resolvable-tunara\n",
    );
    assert!(fallback.imported.is_empty());
    assert!(fallback
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "canonicalization_failed"));

    let invalid_while_disabled =
        parse_ssh_config("CanonicalizeHostname no\nCanonicalizeFallbackLocal maybe\nHost box\n");
    assert!(invalid_while_disabled.imported.is_empty());
    assert_eq!(
        invalid_while_disabled.diagnostics[0].code,
        "canonicalize_fallback_local_invalid"
    );

    let root = temp_path("canonical-cname").parent().unwrap().to_path_buf();
    fs::create_dir_all(&root).unwrap();
    let config_path = root.join("config");
    fs::write(
        &config_path,
        "CanonicalizeHostname yes\nCanonicalDomains example.com\nCanonicalizeFallbackLocal no\nCanonicalizePermittedCNAMEs *.example.com:target.example.com\nHost cname\nHost target.example.com\n  Port 2223\n",
    )
    .unwrap();
    let cname = resolve_config_with_lookup(
        &config_path,
        &root,
        "local-user",
        &[],
        ResolverLimits::default(),
        &|host| {
            Ok((host == "cname.example.com.").then(|| CanonicalLookup {
                canonical_name: Some("target.example.com.".into()),
            }))
        },
    );
    let cname_profile = cname
        .imported
        .iter()
        .find(|profile| profile.label == "cname")
        .unwrap();
    assert_eq!(cname_profile.host, "target.example.com");
    assert_eq!(cname_profile.port, 2223);

    fs::write(
        &config_path,
        "CanonicalizeHostname yes\nCanonicalDomains none\nCanonicalizeFallbackLocal yes\nCanonicalizePermittedCNAMEs *\nHost cname\nHost target.example.com\n  Port 2223\n",
    )
    .unwrap();
    let bare_cname = resolve_config_with_lookup(
        &config_path,
        &root,
        "local-user",
        &[],
        ResolverLimits::default(),
        &|host| {
            Ok((host == "cname").then(|| CanonicalLookup {
                canonical_name: Some("target.example.com".into()),
            }))
        },
    );
    let bare_profile = bare_cname
        .imported
        .iter()
        .find(|profile| profile.label == "cname")
        .unwrap();
    assert_eq!(bare_profile.host, "target.example.com");
    assert_eq!(bare_profile.port, 2223);

    fs::write(
        &config_path,
        "CanonicalizeHostname yes\nCanonicalDomains example.com\nCanonicalizeFallbackLocal no\nCanonicalizePermittedCNAMEs *\nHost cname\n",
    )
    .unwrap();
    let no_fallback = resolve_config_with_lookup(
        &config_path,
        &root,
        "local-user",
        &[],
        ResolverLimits::default(),
        &|host| {
            Ok((host == "cname").then(|| CanonicalLookup {
                canonical_name: Some("target.example.com".into()),
            }))
        },
    );
    assert!(no_fallback.imported.is_empty());
    assert_eq!(no_fallback.diagnostics[0].code, "canonicalization_failed");

    fs::write(
        &config_path,
        "CanonicalizeHostname yes\nCanonicalDomains none\nCanonicalizeFallbackLocal yes\nCanonicalizePermittedCNAMEs *\nHost missing\n",
    )
    .unwrap();
    let bare_missing = resolve_config_with_lookup(
        &config_path,
        &root,
        "local-user",
        &[],
        ResolverLimits::default(),
        &|_| Ok(None),
    );
    assert!(bare_missing.imported.is_empty());
    assert_eq!(bare_missing.diagnostics[0].code, "canonicalization_failed");

    fs::write(
        &config_path,
        "CanonicalizeHostname yes\nCanonicalDomains example.com\nHost 123 box.\n",
    )
    .unwrap();
    let anchored = resolve_config_with_lookup(
        &config_path,
        &root,
        "local-user",
        &[],
        ResolverLimits::default(),
        &|host| {
            Ok((host == "box.").then(|| CanonicalLookup {
                canonical_name: Some("box.".into()),
            }))
        },
    );
    assert!(anchored
        .imported
        .iter()
        .any(|profile| profile.label == "123" && profile.host == "123"));
    assert!(anchored
        .imported
        .iter()
        .any(|profile| profile.label == "box." && profile.host == "box"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn declared_final_pass_fields_match_openssh_g() {
    let root = temp_path("ssh-g-final").parent().unwrap().to_path_buf();
    fs::create_dir_all(&root).unwrap();
    let config_path = root.join("config");
    fs::write(
        &config_path,
        "CanonicalizeHostname no\nHost box\n  User first\nMatch final host box\n  Port 2202\n",
    )
    .unwrap();
    let ours = resolve_config(
        &config_path,
        &root,
        "local-user",
        &[],
        ResolverLimits::default(),
    );
    let profile = ours
        .imported
        .iter()
        .find(|profile| profile.label == "box")
        .unwrap();
    let output = match std::process::Command::new("ssh")
        .args(["-G", "-F"])
        .arg(&config_path)
        .arg("box")
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => {
            fs::remove_dir_all(root).unwrap();
            return;
        }
    };
    let rendered = String::from_utf8(output.stdout).unwrap();
    let field = |name: &str| {
        rendered.lines().find_map(|line| {
            let (key, value) = line.split_once(' ')?;
            (key == name).then_some(value)
        })
    };
    assert_eq!(field("hostname"), Some(profile.host.as_str()));
    assert_eq!(field("user"), Some(profile.user.as_str()));
    assert_eq!(field("port"), Some("2202"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn include_rejects_non_regular_files_and_proxy_jump_none_is_direct() {
    let root = temp_path("include-regular").parent().unwrap().to_path_buf();
    fs::create_dir_all(root.join("directory")).unwrap();
    fs::write(root.join("config"), "Host target\n  Include directory\n").unwrap();
    let invalid = resolve_config(
        &root.join("config"),
        &root,
        "local-user",
        &[],
        ResolverLimits::default(),
    );
    assert_eq!(invalid.diagnostics[0].code, "include_not_regular_file");
    fs::remove_dir_all(root).unwrap();

    let routed = parse_ssh_config("Host jump\n  ProxyJump none\nHost target\n  ProxyJump jump\n");
    let target = routed
        .imported
        .iter()
        .find(|profile| profile.label == "target")
        .unwrap();
    assert_eq!(target.proxy_jump_profile_id, "ssh-config-jump");
    assert_eq!(
        routed
            .imported
            .iter()
            .filter(|profile| profile.id == target.proxy_jump_profile_id)
            .count(),
        1
    );
}

#[test]
fn proxy_jump_rejects_aliases_that_cannot_be_materialized() {
    for invalid_jump in [
        "Host jump\n  HostName bad/host\n",
        "Host jump\n  User bad/user\n",
        "Host jump\n  IdentityFile bad\u{1}path\n",
    ] {
        let result = parse_ssh_config(&format!(
            "{invalid_jump}Host target\n  HostName target.example\n  ProxyJump jump\n"
        ));
        assert!(!result
            .imported
            .iter()
            .any(|profile| profile.label == "target"));
        assert!(result.diagnostics.iter().any(|diagnostic| {
            diagnostic.alias == "target" && diagnostic.code == "proxy_jump_invalid_alias"
        }));
    }

    let expanded_none = parse_ssh_config("Host none\n  ProxyJump %n\n");
    assert!(expanded_none.imported.is_empty());
    assert_eq!(expanded_none.diagnostics[0].code, "proxy_jump_cycle");
}

#[test]
fn saved_jump_ids_must_have_one_owner_across_namespaces() {
    let root = temp_path("jump-owner").parent().unwrap().to_path_buf();
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join("config"),
        "Host other\n  HostName imported.example\nHost target\n  ProxyJump bastion\n",
    )
    .unwrap();
    let saved = SshHostProfile {
        id: "ssh-config-other".into(),
        label: "bastion".into(),
        host: "saved.example".into(),
        port: 22,
        user: "saved-user".into(),
        ..SshHostProfile::default()
    };
    let collision = resolve_config(
        &root.join("config"),
        &root,
        "local-user",
        std::slice::from_ref(&saved),
        ResolverLimits::default(),
    );
    assert!(!collision
        .imported
        .iter()
        .any(|profile| profile.label == "target"));
    assert!(collision.diagnostics.iter().any(|diagnostic| {
        diagnostic.alias == "target" && diagnostic.code == "proxy_jump_invalid_saved_profile"
    }));

    let mut self_collision = saved.clone();
    self_collision.id = "ssh-config-target".into();
    let self_reference = resolve_config(
        &root.join("config"),
        &root,
        "local-user",
        std::slice::from_ref(&self_collision),
        ResolverLimits::default(),
    );
    assert!(!self_reference
        .imported
        .iter()
        .any(|profile| profile.label == "target"));

    let mut duplicate = saved.clone();
    duplicate.label = "other-label".into();
    fs::write(root.join("config"), "Host target\n  ProxyJump bastion\n").unwrap();
    let duplicate_ids = resolve_config(
        &root.join("config"),
        &root,
        "local-user",
        &[saved, duplicate],
        ResolverLimits::default(),
    );
    assert!(duplicate_ids.imported.is_empty());
    assert_eq!(
        duplicate_ids.diagnostics[0].code,
        "proxy_jump_invalid_saved_profile"
    );
    fs::remove_dir_all(root).unwrap();
}
