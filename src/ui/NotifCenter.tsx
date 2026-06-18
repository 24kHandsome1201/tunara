// NotifCenter — 通知中心下拉
// 失败=红持久 + 完成=绿

import { type Notification } from "./types";

interface NotifCenterProps {
  notifications: Notification[];
  onClose: () => void;
}

export function NotifCenter({ notifications, onClose }: NotifCenterProps) {
  return (
    <>
      {/* 遮罩（点外部关闭） */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 100,
        }}
      />

      {/* 通知面板 */}
      <div
        style={{
          position: "fixed",
          top: "var(--h-titlebar)",
          right: 12,
          width: 320,
          background: "var(--c-bg-white)",
          border: "1px solid var(--c-border-2)",
          borderRadius: "var(--r-card)",
          boxShadow: "var(--shadow-notif)",
          zIndex: 101,
          overflow: "hidden",
          animation: "toastIn 0.3s ease",
        }}
      >
        {/* 头部 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "10px 14px",
            borderBottom: "1px solid var(--c-border-1)",
          }}
        >
          <span
            style={{
              fontSize: "var(--fs-body)",
              fontWeight: 600,
              color: "var(--c-text-primary)",
            }}
          >
            通知
          </span>
          <button
            onClick={onClose}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 16,
              color: "var(--c-text-4)",
              lineHeight: 1,
              padding: "2px 4px",
              borderRadius: "var(--r-btn)",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--c-bg-hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            ✕
          </button>
        </div>

        {/* 通知列表 */}
        <div>
          {notifications.length === 0 ? (
            <div
              style={{
                padding: "20px 14px",
                textAlign: "center",
                fontSize: "var(--fs-body)",
                color: "var(--c-text-5)",
              }}
            >
              暂无通知
            </div>
          ) : (
            notifications.map((n) => (
              <div
                key={n.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--c-border-1)",
                }}
              >
                {/* 类型图标 */}
                <div
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: n.type === "error" ? "var(--c-error-bg)" : "var(--c-success-bg)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    marginTop: 1,
                  }}
                >
                  {n.type === "error" ? (
                    <span style={{ fontSize: 10, color: "var(--c-error)" }}>✕</span>
                  ) : (
                    <span style={{ fontSize: 10, color: "var(--c-success)" }}>✓</span>
                  )}
                </div>

                {/* 内容 */}
                <div style={{ flex: 1 }}>
                  {n.sessionTitle && (
                    <div
                      style={{
                        fontSize: "var(--fs-secondary)",
                        color: "var(--c-text-4)",
                        marginBottom: 2,
                      }}
                    >
                      {n.sessionTitle}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: "var(--fs-body)",
                      color: n.type === "error" ? "var(--c-error)" : "var(--c-text-2)",
                      fontWeight: n.type === "error" ? 500 : 400,
                    }}
                  >
                    {n.message}
                  </div>
                </div>

                {/* 持久徽标（失败项） */}
                {n.type === "error" && (
                  <span
                    style={{
                      fontSize: "var(--fs-badge)",
                      color: "var(--c-error)",
                      background: "var(--c-error-bg)",
                      borderRadius: "var(--r-pill)",
                      padding: "2px 6px",
                      flexShrink: 0,
                    }}
                  >
                    失败
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
