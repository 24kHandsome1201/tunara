use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;

use super::harness::{open, unique, Fixture};

#[tokio::test]
async fn local_forward_reaches_remote_loopback() {
    let fixture = Fixture::load();
    let (ssh, _) = open(fixture.target(fixture.ed25519_auth(), &unique("local-forward"))).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = TcpStream::connect(listener.local_addr().unwrap())
        .await
        .unwrap();
    let (stream, _) = listener.accept().await.unwrap();

    let read_banner = async move {
        let mut banner = String::new();
        BufReader::new(client).read_line(&mut banner).await.unwrap();
        assert!(banner.starts_with("SSH-2.0-OpenSSH_"), "{banner:?}");
    };
    tokio::time::timeout(Duration::from_secs(10), async {
        tokio::select! {
            () = read_banner => {},
            result = ssh.forward_loopback_stream(stream, "127.0.0.1", 22) => {
                panic!("local forward ended before the OpenSSH banner: {result:?}");
            }
        }
    })
    .await
    .expect("OpenSSH banner through local forward");
    ssh.close().expect("close");
}

#[tokio::test]
async fn remote_forward_relays_to_local_loopback() {
    let fixture = Fixture::load();
    let (ssh, _) = open(fixture.target(fixture.ed25519_auth(), &unique("remote-forward"))).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = listener.local_addr().unwrap();
    let port = ssh
        .request_tcpip_forward("127.0.0.1", 0)
        .await
        .expect("OpenSSH allocated reverse-forward port");
    let (_cancel, cancelled) = watch::channel(false);
    let hub = ssh.reverse_forward_hub();
    hub.insert("127.0.0.1", port, local.ip(), local.port(), cancelled)
        .expect("register reverse-forward target");

    let local_exchange = async {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0; 5];
        stream.read_exact(&mut request).await.unwrap();
        assert_eq!(&request, b"ping\n");
        stream.write_all(b"pong\n").await.unwrap();
    };
    let command = format!(
        "exec 3<>/dev/tcp/127.0.0.1/{port} && printf 'ping\\n' >&3 && read -r reply <&3 && printf '%s\\n' \"$reply\""
    );
    let (_, reply) = tokio::time::timeout(Duration::from_secs(10), async {
        tokio::join!(local_exchange, ssh.exec(&command, 4096))
    })
    .await
    .expect("bidirectional exchange through remote forward");
    assert_eq!(reply.expect("remote loopback command"), "pong\n");
    ssh.cancel_tcpip_forward("127.0.0.1", port)
        .await
        .expect("cancel remote forward");
    ssh.close().expect("close");
}
