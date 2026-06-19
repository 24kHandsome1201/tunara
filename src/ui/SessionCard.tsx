import { useState } from "react";
import { type Session, type SessionStatus, deriveStatus, deriveDuration, deriveTitle } from "./types";

// ── Agent 品牌 logo SVG（来自 Warp 开源资产） ──

function ClaudeIcon({ size }: { size: number }) {
  const s = Math.round(size * 0.55);
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M4.705 15.956l4.718-2.648.079-.23-.079-.128h-.23l-.79-.049-2.695-.073-2.338-.097-2.264-.121-.571-.122L0 11.785l.055-.353.48-.321.685.06 1.518.103 2.277.158 1.651.097 2.447.255h.389l.054-.158-.134-.097-.103-.098-2.355-1.596-2.55-1.688-1.336-.97-.722-.493-.364-.461-.158-1.008.656-.722.88.06.225.061.892.686 1.906 1.475 2.49 1.834.365.303.146-.103.018-.073-.164-.273-1.354-2.447-1.445-2.49-.643-1.032-.17-.619c-.061-.255-.103-.467-.103-.728l.747-1.014.413-.134.996.134.419.364.619 1.415 1.002 2.228 1.554 3.03.455.898.243.832.091.254h.158V9.01l.128-1.706.236-2.094.231-2.696.079-.759.376-.91.747-.492.583.28.48.686-.067.443-.285 1.852-.558 2.902-.365 1.943h.212l.243-.243.984-1.305 1.651-2.064.728-.82.85-.904.547-.431h1.032l.759 1.13-.34 1.165-1.063 1.348-.88 1.14-1.263 1.7-.79 1.36.073.11.188-.019 2.854-.607 1.542-.28 1.84-.315.831.388.091.395-.328.807-1.967.486-2.307.461-3.436.814-.043.03.049.061 1.548.146.662.036 1.621.024 3.017.225.79.522.473.637-.079.486-1.214.619-1.64-.389-3.824-.91-1.312-.328h-.182l-.018.109 1.093 1.069 2.004 1.81 2.507 2.331.128.577-.322.455-.34-.049-2.204-1.657-.85-.747-1.925-1.621h-.128v.17l.444.65 2.343 3.521.122 1.081-.17.352-.607.213-.668-.122-1.372-1.924-1.414-2.167-1.142-1.943-.14.079-.674 7.255-.315.37-.729.28-.607-.462-.322-.747.322-1.475.389-1.925.316-1.53.285-1.9.17-.632-.012-.043-.14.018-1.433 1.967-2.18 2.945-1.724 1.845-.413.164-.716-.37.067-.662.4-.589 2.386-3.036 1.44-1.882.929-1.087-.006-.158h-.055l-6.338 4.117-1.13.146-.485-.455.06-.747.231-.243 1.906-1.311-.006.006z" fill="currentColor"/>
    </svg>
  );
}

function CodexIcon({ size }: { size: number }) {
  const s = Math.round(size * 0.55);
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M22.282 9.821a7.13 7.13 0 00-.272-2.511 7.198 7.198 0 00-3.026-3.411 7.16 7.16 0 00-3.728-.99 7.2 7.2 0 00-5.764 2.1A7.173 7.173 0 004.98 4.182a7.15 7.15 0 00-4 2.9A7.2 7.2 0 00.196 10.751a7.18 7.18 0 001.53 3.427 7.136 7.136 0 00-.275 4.357 7.2 7.2 0 002.04 3.475 7.16 7.16 0 007.77 1.99 7.147 7.147 0 005.77-4.206 7.158 7.158 0 004.033-5.1 7.18 7.18 0 00-1.52-3.422 7.18 7.18 0 001.737-1.451zM13.26 22.43a5.631 5.631 0 01-2.876-1.042l.142-.08 4.778-2.76a.78.78 0 00.393-.676v-6.737l1.716 1.169.014.02v5.582a5.66 5.66 0 01-4.167 4.524zM3.599 18.304a5.63 5.63 0 01-.535-3.014l.142.085 4.783 2.76a.775.775 0 00.78 0l5.843-3.369v2.332l-.009.016-4.84 2.791a5.66 5.66 0 01-6.164-.601zM2.341 7.896a5.622 5.622 0 012.365-1.973v5.677a.77.77 0 00.388.673l5.814 3.365-2.02 1.169-.012.002-4.83-2.787A5.66 5.66 0 012.34 7.896zm16.596 3.855L13.104 8.364l2.015-1.164.012-.001 4.83 2.791a5.659 5.659 0 01.385 9.105V12.418a.77.77 0 00-.408-.667zm1.711-3.023l-.142-.085-4.774-2.782a.78.78 0 00-.783 0l-5.838 3.37V6.897l.009-.016 4.83-2.787a5.66 5.66 0 018.698 5.634zM8.307 12.863l-2.02-1.164-.012-.021V6.074a5.66 5.66 0 017.337-4.053l-.142.08-4.778 2.758a.78.78 0 00-.393.68l-.005 6.724zm1.098-2.365L12.006 9l2.607 1.5v3l-2.598 1.5-2.607-1.5-.003-3z" fill="currentColor"/>
    </svg>
  );
}

function AmpIcon({ size }: { size: number }) {
  const s = Math.round(size * 0.55);
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M11.932 11.666l2.966 11.106-2.691.718-2.139-8-.884 5.858-1.966-1.975 5.876-5.848-7.992-2.132.719-2.692 11.11 2.966z" fill="currentColor"/>
      <path d="M16.233 7.356l2.967 11.106-2.69.719-2.553-9.55-9.552-2.553.718-2.691 11.11 2.966z" fill="currentColor"/>
      <path d="M20.555 3.048l2.966 11.105-2.69.719-2.553-9.55-9.552-2.548.718-2.692 11.11 2.966z" fill="currentColor"/>
    </svg>
  );
}

function GeminiIcon({ size }: { size: number }) {
  const s = Math.round(size * 0.55);
  return (
    <svg width={s} height={s} viewBox="0 0 25 25" fill="none">
      <path d="M19.6435 22.6696V24.0261H4.40873V22.6696H19.6435ZM22.6696 19.6435V4.40873C22.6696 2.73747 21.3148 1.38265 19.6435 1.38264H4.40873C2.73747 1.38264 1.38265 2.73747 1.38264 4.40873V19.6435C1.38264 21.3148 2.73747 22.6696 4.40873 22.6696V24.0261C1.98828 24.0261 0.026123 22.064 0.026123 19.6435V4.40873C0.0261234 2.0072 1.95774 0.0568147 4.35207 0.0264797L4.40873 0.026123H19.6435L19.7002 0.0264797C22.0945 0.0568151 24.0261 2.0072 24.0261 4.40873V19.6435L24.0258 19.7002C23.9954 22.0945 22.045 24.0261 19.6435 24.0261V22.6696C21.3148 22.6696 22.6696 21.3148 22.6696 19.6435Z" fill="currentColor"/>
      <path d="M16.8522 10.5131L7.25221 5.89569V8.60873L14.9739 12.3392L7.25221 16.0435V18.8348L16.8522 14.1913V10.5131Z" fill="currentColor"/>
    </svg>
  );
}

function CopilotIcon({ size }: { size: number }) {
  const s = Math.round(size * 0.55);
  return (
    <svg width={s} height={s} viewBox="0 0 128 128" fill="none">
      <path fillRule="evenodd" clipRule="evenodd" d="M111.688 83.968C108.245 89.949 88.252 104.062 64 104.062C39.748 104.062 19.755 89.949 16.312 83.968C16.061 83.53 15.979 83.031 15.979 82.526V71.879C15.979 71.437 16.047 70.999 16.211 70.589C17.7 66.85 21.599 61.419 26.631 59.962C27.299 58.249 28.287 55.746 29.209 53.897C29.054 52.483 29 51.025 29 49.551C29 44.227 30.129 39.558 33.529 36.08C35.117 34.456 37.088 33.21 39.425 32.274C45.022 27.726 52.992 23.901 63.914 23.901C74.835 23.901 82.978 27.726 88.575 32.274C90.912 33.21 92.883 34.456 94.471 36.08C97.872 39.558 99 44.227 99 49.551C99 51.025 98.946 52.483 98.791 53.897C99.713 55.746 100.701 58.249 101.369 59.962C106.401 61.419 110.3 66.85 111.789 70.589C111.953 70.999 112.021 71.437 112.021 71.879V82.526C112.021 83.031 111.939 83.53 111.688 83.968ZM67.253 48.261C67.083 46.935 67.002 45.747 67 44.686V44.602C67.005 41.524 67.678 39.522 68.752 38.291C70.117 36.73 72.938 35.533 78.883 36.176C84.906 36.828 88.273 38.323 90.181 40.275C92.029 42.165 93 44.992 93 49.551C93 54.395 92.302 57.257 90.767 58.998C89.308 60.653 86.434 62 80.139 62C75.299 62 72.533 60.426 70.764 58.249C68.864 55.912 67.796 52.488 67.253 48.261ZM60.747 48.261C60.917 46.934 60.998 45.747 61.001 44.686V44.602C60.995 41.524 60.322 39.521 59.248 38.291C57.883 36.73 55.062 35.533 49.117 36.176C43.094 36.828 39.728 38.323 37.819 40.275C35.971 42.165 35 44.992 35 49.551C35 54.395 35.698 57.257 37.233 58.998C38.693 60.653 41.567 62 47.861 62C52.701 62 55.467 60.426 57.236 58.249C59.136 55.912 60.205 52.488 60.747 48.261ZM64.689 59.998C64.459 60 64.919 59.998 64.689 59.998C64.459 59.998 63.541 60 63.311 59.998C62.888 60.708 62.417 61.388 61.893 62.033C58.814 65.822 54.218 68 47.861 68C40.962 68 35.905 66.564 32.732 62.966L32 62.966V89.302C37.739 92.421 50.058 98.018 64 98.018C77.942 98.018 90.261 92.421 96 89.302V62.966L95.268 62.966C92.095 66.564 87.039 68 80.139 68C73.782 68 69.186 65.822 66.107 62.033C65.583 61.388 65.112 60.708 64.689 59.998Z" fill="currentColor"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M74 73C76.209 73 78 74.791 78 77V85C78 87.209 76.209 89 74 89C71.791 89 70 87.209 70 85V77C70 74.791 71.791 73 74 73Z" fill="currentColor"/>
      <path fillRule="evenodd" clipRule="evenodd" d="M54 73C56.209 73 58 74.791 58 77V85C58 87.209 56.209 89 54 89C51.791 89 50 87.209 50 85V77C50 74.791 51.791 73 54 73Z" fill="currentColor"/>
    </svg>
  );
}

function CursorIcon({ size }: { size: number }) {
  const s = Math.round(size * 0.55);
  return (
    <svg width={s} height={s} viewBox="0 0 467 533" fill="none">
      <path d="M457.43 125.94L244.42 2.96c-6.84-3.95-15.28-3.95-22.12 0L9.3 125.94c-5.75 3.32-9.3 9.46-9.3 16.11v247.99c0 6.65 3.55 12.79 9.3 16.11l213.01 122.98c6.84 3.95 15.28 3.95 22.12 0l213.01-122.98c5.75-3.32 9.3-9.46 9.3-16.11V142.05c0-6.65-3.55-12.79-9.3-16.11zM444.05 151.99l-205.63 356.16c-1.39 2.4-5.06 1.42-5.06-1.36V273.58c0-4.66-2.49-8.97-6.53-11.31L24.87 145.67c-2.4-1.39-1.42-5.06 1.36-5.06h411.26c5.84 0 9.49 6.33 6.57 11.39z" fill="currentColor"/>
    </svg>
  );
}

function DroidIcon({ size }: { size: number }) {
  const s = Math.round(size * 0.55);
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <g clipPath="url(#droid-clip)">
        <path d="M17.262 4.163a.202.202 0 00-.211-.167.202.202 0 00-.19.213c.616-1.5.889-2.7.449-3.203C16.328-.81 11.666 1.841 10.179 2.739a.202.202 0 00-.265-.054.202.202 0 00-.199-.154c-.625-1.497-1.282-2.538-1.948-2.583C5.802-.17 4.58 5.053 4.163 6.738a.202.202 0 00-.167.211.202.202 0 00-.213.19c-1.5-.616-2.7-.889-3.203-.449C-.81 7.672 1.841 12.334 2.739 13.821a.202.202 0 00-.054.265.202.202 0 00-.154.199c-1.497.625-2.538 1.282-2.583 1.948-.118 1.765 5.053 3.188 6.739 3.604a.202.202 0 00.211.167.202.202 0 00.19-.213c-1.616 1.5.889 2.7-.449 3.203 1.162 1.333 5.825-1.319 7.311-2.216a.202.202 0 00.265.054.202.202 0 00.199.154c.625 1.497 1.282 2.538 1.948 2.583 1.765.12 3.188-5.05 3.604-6.736a.202.202 0 00.167-.211.202.202 0 00.213-.19c1.5.616 2.7.889 3.203.449 1.333-1.162-1.319-5.825-2.216-7.311a.202.202 0 00.054-.265.202.202 0 00.154-.199c1.497-.625 2.538-1.282 2.583-1.948.12-1.765-5.05-3.188-6.736-3.604z" fill="currentColor"/>
      </g>
      <defs>
        <clipPath id="droid-clip"><rect width="24" height="24" fill="white"/></clipPath>
      </defs>
    </svg>
  );
}

function OpenCodeIcon({ size }: { size: number }) {
  const s = Math.round(size * 0.55);
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none">
      <path d="M16.4 4.8H6.8V19.2H16.4V4.8ZM21.2 24H2V0H21.2V24Z" fill="currentColor"/>
    </svg>
  );
}

function PiIcon({ size }: { size: number }) {
  const s = Math.round(size * 0.55);
  return (
    <svg width={s} height={s} viewBox="165 165 470 470" fill="none">
      <path fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" fill="currentColor"/>
      <path d="M517.36 400H634.72V634.72H517.36Z" fill="currentColor"/>
    </svg>
  );
}

function AuggieIcon({ size }: { size: number }) {
  const s = Math.round(size * 0.55);
  return (
    <svg width={s} height={s} viewBox="0 24 512 441" fill="none">
      <path d="M78.844 464.762c-8.453 0-15.573-1.451-21.359-4.339-5.77-2.888-10.144-7.289-13.076-13.095-2.932-5.807-4.436-12.912-4.436-21.255v-86.028c0-10.605-2.125-18.321-6.329-23.135-4.234-4.798-11.742-7.334-22.507-7.579-3.35 0-6.034-1.253-8.066-3.804C1.008 303.005 0 300.087 0 296.832c0-3.53 1.008-6.448 3.071-8.725 2.048-2.277 4.762-3.53 8.066-3.774 10.765-.26 18.273-2.781 22.507-7.579 4.235-4.798 6.329-12.392 6.329-22.752v-86.028c0-12.637 3.35-22.249 10.005-28.804 6.654-6.555 16.287-9.856 28.866-9.856H181.5c3.862 0 7.042 1.146 9.617 3.408 2.559 2.277 3.862 5.195 3.862 8.694 0 3.301-1.086 6.128-3.257 8.542-2.172 2.414-5.057 3.622-8.671 3.622H87.732c-5.413 0-9.508 1.39-12.316 4.171-2.823 2.781-4.234 7.075-4.234 12.912v86.425c0 7.579-1.551 14.455-4.623 20.644-3.07 6.204-7.181 11.063-12.316 14.623-5.134 3.53-11.137 5.302-18.07 5.302v-1.528c6.933 0 12.936 1.773 18.07 5.303 5.135 3.529 9.245 8.404 12.316 14.623 3.072 6.188 4.623 13.064 4.623 20.643v86.808c0 5.837 1.411 10.115 4.234 12.911 2.823 2.812 6.934 4.172 12.316 4.172h95.318c3.583 0 6.468 1.207 8.671 3.606 2.202 2.414 3.257 5.257 3.257 8.542s-1.272 6.097-3.862 8.511c-2.575 2.414-5.771 3.606-9.617 3.606H78.844v-.092Z" fill="currentColor"/>
      <path d="M330.501 464.768c-3.862 0-7.042-1.207-9.617-3.606-2.575-2.414-3.863-5.256-3.863-8.511 0-3.255 1.086-6.128 3.258-8.542 2.171-2.414 5.057-3.606 8.671-3.606h95.317c5.414 0 9.509-1.36 12.316-4.171 2.823-2.781 4.235-7.075 4.235-12.912v-86.808c0-7.579 1.551-14.455 4.622-20.643 3.071-6.204 7.182-11.063 12.316-14.623 5.134-3.53 11.137-5.303 18.071-5.303v1.528c-6.934 0-12.937-1.772-18.071-5.302-5.134-3.53-9.245-8.404-12.316-14.623-3.071-6.189-4.622-13.065-4.622-20.644v-86.425c0-5.807-1.412-10.1-4.235-12.912-2.823-2.781-6.933-4.171-12.316-4.171H328.95c-3.583 0-6.469-1.208-8.671-3.622-2.172-2.384-3.258-5.241-3.258-8.542 0-3.529 1.272-6.417 3.863-8.694 2.559-2.277 5.755-3.407 9.617-3.407h102.654c12.58 0 22.181 3.3 28.867 9.855 6.685 6.556 10.005 16.167 10.005 28.804v86.028c0 10.36 2.125 17.969 6.328 22.752 4.235 4.798 11.742 7.334 22.507 7.579 3.351.244 6.034 1.497 8.066 3.774 2.063 2.277 3.071 5.195 3.071 8.725 0 3.301-1.008 6.189-3.071 8.695-2.032 2.521-4.762 3.804-8.066 3.804-10.765.245-18.257 2.781-22.507 7.579-4.234 4.798-6.328 12.5-6.328 23.135v86.028c0 8.358-1.474 15.418-4.437 21.255-2.962 5.837-7.305 10.176-13.076 13.095-5.785 2.888-12.905 4.339-21.359 4.339H330.501v.092Z" fill="currentColor"/>
      <path d="M356.885 329.738c18.691 0 33.846-14.929 33.846-33.342 0-18.412-15.155-33.341-33.846-33.341-18.691 0-33.846 14.929-33.846 33.341 0 18.413 15.155 33.342 33.846 33.342Z" fill="currentColor"/>
      <path d="M167.305 329.738c18.691 0 33.846-14.929 33.846-33.342 0-18.412-15.155-33.341-33.846-33.341-18.691 0-33.846 14.929-33.846 33.341 0 18.413 15.155 33.342 33.846 33.342Z" fill="currentColor"/>
      <path d="M244.477 32.846l-2.59 68.135c0 3.82-3.661 5.73-10.983 5.73-7.321 0-10.982-1.91-10.982-5.73-.651-16.976-1.178-30.148-1.613-39.484-.217-9.55-.434-16.35-.651-20.384-.217-4.034-.326-6.479-.326-7.32v-1.268c0-4.874 4.529-7.319 13.572-7.319 9.044 0 13.573 2.552 13.573 7.64Zm54.941 0-2.59 68.135c0 3.82-3.661 5.73-10.982 5.73-7.322 0-10.982-1.91-10.982-5.73-.652-16.976-1.179-30.148-1.613-39.484-.218-9.55-.435-16.35-.652-20.384-.217-4.034-.326-6.479-.326-7.32v-1.268c0-4.874 4.53-7.319 13.573-7.319s13.572 2.552 13.572 7.64Z" fill="currentColor"/>
    </svg>
  );
}

const AGENT_ICONS: Record<string, React.FC<{ size: number }>> = {
  CC: ClaudeIcon,
  CX: CodexIcon,
  AM: AmpIcon,
  GM: GeminiIcon,
  CP: CopilotIcon,
  CR: CursorIcon,
  DR: DroidIcon,
  OC: OpenCodeIcon,
  PI: PiIcon,
  AG: AuggieIcon,
};

// ── AgentBadge 保留导出（被 AgentView / NewAgent 引用） ──

export function AgentBadge({ agent, size = 22, disabled }: { agent?: string; size?: number; disabled?: boolean }) {
  if (!agent) return null;
  const badgeStyle = (code: string): React.CSSProperties => ({
    background: disabled ? "var(--c-bg-3)" : `var(--c-agent-${code}-bg)`,
    border: `1px solid ${disabled ? "var(--c-border-2)" : `var(--c-agent-${code}-border)`}`,
    color: disabled ? "var(--c-text-5)" : `var(--c-agent-${code}-text)`,
  });
  const codeMap: Record<string, string> = {
    CC: "cc", CX: "cx", AM: "am", GM: "gm", CP: "cp", CR: "cr", DR: "dr", OC: "oc", PI: "pi", AG: "ag",
  };
  const styleMap: Record<string, React.CSSProperties> = Object.fromEntries(
    Object.entries(codeMap).map(([k, v]) => [k, badgeStyle(v)])
  );
  const Icon = AGENT_ICONS[agent];

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "var(--r-badge)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        ...(styleMap[agent] ?? styleMap.CC),
      }}
    >
      {Icon ? <Icon size={size} /> : <span style={{ fontSize: "var(--fs-badge)", fontWeight: 700, fontFamily: "var(--font-mono)" }}>{agent}</span>}
    </div>
  );
}

// ── 圆形图标（Warp 风格：圆底 + 图标 + 状态点叠加） ──

const AGENT_CIRCLE_STYLES: Record<string, { bg: string; color: string }> = {
  CC: { bg: "#D97706", color: "#ffffff" },
  CX: { bg: "#000000", color: "#ffffff" },
  AM: { bg: "#F34E3F", color: "#ffffff" },
  GM: { bg: "#4285F4", color: "#ffffff" },
  CP: { bg: "#8534F3", color: "#ffffff" },
  CR: { bg: "#26251E", color: "#ffffff" },
  DR: { bg: "#ffffff", color: "#000000" },
  OC: { bg: "#808080", color: "#ffffff" },
  PI: { bg: "#ffffff", color: "#000000" },
  AG: { bg: "#ffffff", color: "#000000" },
};

function StatusDot({ status }: { status: SessionStatus }) {
  if (status === "done") return null;
  const color =
    status === "running" ? "var(--c-accent)" :
    status === "fresh" ? "var(--c-success)" :
    "var(--c-error)";
  return (
    <span
      style={{
        position: "absolute",
        bottom: -1,
        right: -1,
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        border: "2px solid var(--c-bg-white)",
        animation: status === "running" ? "pulseDot 1.3s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function SessionIcon({ session, status }: { session: Session; status: SessionStatus }) {
  const size = 28;

  if (session.kind === "agent" && session.agent) {
    const style = AGENT_CIRCLE_STYLES[session.agent] ?? AGENT_CIRCLE_STYLES.CC;
    const Icon = AGENT_ICONS[session.agent];
    return (
      <div style={{ position: "relative", flexShrink: 0 }}>
        <div
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            background: style.bg,
            color: style.color,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {Icon ? <Icon size={size} /> : (
            <span style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--font-mono)" }}>
              {session.agent.charAt(0)}
            </span>
          )}
        </div>
        <StatusDot status={status} />
      </div>
    );
  }

  return (
    <div style={{ position: "relative", flexShrink: 0 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: "var(--c-bg-3)",
          color: "var(--c-text-4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      </div>
      <StatusDot status={status} />
    </div>
  );
}

// ── 状态标签 ──

function StatusTag({ status, duration }: { status: SessionStatus; duration: string }) {
  if (status === "running") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
        <span style={{ fontSize: "var(--fs-meta-sm)", color: "var(--c-accent)", fontWeight: 600 }}>
          运行中
        </span>
        {duration && (
          <span style={{ fontSize: "var(--fs-meta-sm)", color: "var(--c-text-5)" }}>
            {duration}
          </span>
        )}
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
        <span style={{ fontSize: "var(--fs-meta-sm)", color: "var(--c-error)", fontWeight: 600 }}>
          失败
        </span>
        {duration && (
          <span style={{ fontSize: "var(--fs-meta-sm)", color: "var(--c-text-5)" }}>
            {duration}
          </span>
        )}
      </div>
    );
  }
  if (status === "fresh") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
        <span style={{ fontSize: "var(--fs-meta-sm)", color: "var(--c-success)", fontWeight: 600 }}>
          已完成
        </span>
        {duration && (
          <span style={{ fontSize: "var(--fs-meta-sm)", color: "var(--c-text-5)" }}>
            {duration}
          </span>
        )}
      </div>
    );
  }
  return null;
}

// ── SessionCard 主组件 ──

interface SessionCardProps {
  session: Session;
  active: boolean;
  onClick: () => void;
  onClose?: () => void;
}

export function SessionCard({ session, active, onClick, onClose }: SessionCardProps) {
  const [hovered, setHovered] = useState(false);
  const status = deriveStatus(session);
  const duration = deriveDuration(session);
  const { primary, subtitle, isCommand } = deriveTitle(session);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        padding: active ? "8px 10px 8px 14px" : "8px 10px",
        borderRadius: "var(--r-card)",
        cursor: "pointer",
        userSelect: "none",
        background: active ? "var(--c-bg-white)" : hovered ? "var(--c-bg-hover)" : "transparent",
        border: active ? "1px solid var(--c-border-2)" : "1px solid transparent",
        boxShadow: active ? "var(--shadow-card)" : "none",
        outline: "none",
        transition: "background 0.12s",
      }}
    >
      {/* 激活态左侧 accent 条 */}
      {active && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: "50%",
            transform: "translateY(-50%)",
            width: 3,
            height: "60%",
            minHeight: 18,
            background: "var(--c-accent)",
            borderRadius: "0 2px 2px 0",
          }}
        />
      )}

      {/* hover 关闭按钮 */}
      {hovered && onClose && (
        <span
          role="button"
          tabIndex={0}
          title="关闭"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onClose(); } }}
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 18,
            height: 18,
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 13,
            lineHeight: 1,
            color: "var(--c-text-5)",
            cursor: "pointer",
            zIndex: 2,
          }}
          className="hover-close"
        >
          ×
        </span>
      )}

      {/* 主体：图标 + 文字 */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <SessionIcon session={session} status={status} />

        <div style={{ flex: 1, minWidth: 0, paddingTop: 1 }}>
          {/* 第一行：动态标题 */}
          <div
            style={{
              fontSize: "var(--fs-body)",
              fontWeight: 600,
              color: "var(--c-text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontFamily: isCommand ? "var(--font-mono)" : "var(--font-ui)",
              lineHeight: 1.3,
            }}
          >
            {primary}
          </div>

          {/* 第二行：subtitle */}
          <div
            style={{
              fontSize: "var(--fs-meta-sm)",
              color: "var(--c-text-5)",
              fontFamily: "var(--font-mono)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              marginTop: 2,
              lineHeight: 1.3,
            }}
          >
            {subtitle}
          </div>

          {/* 第三行：状态（仅 running / failed / fresh） */}
          <StatusTag status={status} duration={duration} />
        </div>
      </div>

      {/* 运行中不定进度条 */}
      {status === "running" && (
        <div
          style={{
            marginTop: 6,
            height: 2,
            borderRadius: 1,
            background: "var(--c-bg-3)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: "40%",
              background: "var(--c-accent)",
              borderRadius: 1,
              animation: "indeterminate 1.4s ease-in-out infinite",
            }}
          />
        </div>
      )}
    </div>
  );
}
